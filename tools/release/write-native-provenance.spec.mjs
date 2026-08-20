import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertArtifactProvenance } from '../../apps/omnia-reader-e2e/performance/artifact-identity.mjs';
import { writeNativeProvenance } from './write-native-provenance.mjs';

const ownedDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...ownedDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  ownedDirectories.clear();
});

test('writes deterministic exact AppImage provenance and checksums', async () => {
  const first = await workspaceFixture('omnia-provenance-first-');
  const second = await workspaceFixture('omnia-provenance-second-');
  const firstResult = await writeFixtureProvenance(first);
  const secondResult = await writeFixtureProvenance(second);

  const firstText = await readFile(firstResult.provenancePath, 'utf8');
  const secondText = await readFile(secondResult.provenancePath, 'utf8');
  assert.equal(firstText, secondText);
  const provenance = assertArtifactProvenance(JSON.parse(firstText));
  assert.equal(provenance.artifact.kind, 'linux-appimage');
  assert.equal(provenance.artifact.fileName, first.artifactName);
  assert.equal(provenance.artifact.sha256, digest(first.bytes));
  assert.equal(provenance.source.commit, 'c'.repeat(40));
  assert.equal(
    provenance.source.packageLockSha256,
    digest(await readFile(join(first.root, 'package-lock.json'))),
  );
  assert.equal(
    provenance.source.cargoLockSha256,
    digest(await readFile(join(first.root, 'Cargo.lock'))),
  );
  assert.equal(provenance.toolchain.node, 'v26.5.0');
  assert.equal(provenance.toolchain.rust, '1.89.0');
  assert.equal(provenance.toolchain.tauri, '2.11.4');

  const sums = await readFile(firstResult.checksumsPath, 'utf8');
  const provenanceDigest = createHash('sha256').update(firstText).digest('hex');
  assert.equal(
    sums,
    `${digest(first.bytes).slice(7)}  ${first.artifactName}\n${provenanceDigest}  ${first.artifactName}.provenance.json\n`,
  );
});

test('rejects raw ELF substitutions and inconsistent release versions', async () => {
  const rawElf = await workspaceFixture('omnia-provenance-raw-elf-');
  const rawBytes = Buffer.from(rawElf.bytes);
  rawBytes.fill(0, 8, 11);
  await writeFile(rawElf.artifactPath, rawBytes);
  await assert.rejects(writeFixtureProvenance(rawElf), /AppImage type-2/);
  await assert.rejects(access(rawElf.outputDirectory), { code: 'ENOENT' });

  const wrongArchitecture = await workspaceFixture(
    'omnia-provenance-architecture-',
  );
  const armBytes = Buffer.from(wrongArchitecture.bytes);
  armBytes.writeUInt16LE(0xb7, 18);
  await writeFile(wrongArchitecture.artifactPath, armBytes);
  await assert.rejects(
    writeFixtureProvenance(wrongArchitecture),
    /x86_64 AppImage/,
  );
  await assert.rejects(access(wrongArchitecture.outputDirectory), {
    code: 'ENOENT',
  });

  const mismatched = await workspaceFixture('omnia-provenance-version-');
  await writeFile(
    join(mismatched.root, 'src-tauri/tauri.conf.json'),
    JSON.stringify({
      productName: 'Omnia Reader',
      version: '0.2.0',
      identifier: 'io.github.omniareader.reader',
    }),
  );
  await assert.rejects(writeFixtureProvenance(mismatched), /versions differ/);
  await assert.rejects(access(mismatched.outputDirectory), { code: 'ENOENT' });
});

test('rejects control characters in checksum filenames', async () => {
  const fixture = await workspaceFixture('omnia-provenance-filename-', {
    artifactName: 'Omnia Reader\nforged.AppImage',
  });
  await assert.rejects(writeFixtureProvenance(fixture), /control characters/);
  await assert.rejects(access(fixture.outputDirectory), { code: 'ENOENT' });
});

test('requires an explicit artifact in CLI mode', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./write-native-provenance.mjs', import.meta.url))],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--artifact is required/);
});

test('refuses dirty source, debug bytes, symlinks, and artifacts outside the bundle root', async () => {
  for (const failure of ['dirty', 'debug', 'symlink', 'outside']) {
    const fixture = await workspaceFixture(`omnia-provenance-${failure}-`, {
      marker:
        failure === 'debug'
          ? 'tauri-plugin-wdio-webdriver native-e2e'
          : 'release',
    });
    let artifactPath = fixture.artifactPath;
    if (failure === 'symlink') {
      const target = join(fixture.bundleRoot, 'target.AppImage');
      await writeFile(target, fixture.bytes, { mode: 0o700 });
      await rm(artifactPath);
      await symlink(target, artifactPath);
    }
    if (failure === 'outside') {
      artifactPath = join(fixture.root, fixture.artifactName);
      await writeFile(artifactPath, fixture.bytes, { mode: 0o700 });
    }

    await assert.rejects(
      writeNativeProvenance({
        workspaceRoot: fixture.root,
        artifactPath,
        outputDirectory: fixture.outputDirectory,
        gitState: {
          commit: 'c'.repeat(40),
          dirty: failure === 'dirty',
        },
        rustVersion: '1.89.0',
      }),
      /dirty|debug automation|symbolic link|bundle\/appimage/,
    );
    await assert.rejects(access(fixture.outputDirectory), { code: 'ENOENT' });
  }
});

test('uses no-replace output and removes a partial provenance write', async () => {
  const fixture = await workspaceFixture('omnia-provenance-no-replace-');
  await mkdir(fixture.outputDirectory, { recursive: true });
  const checksumsPath = join(fixture.outputDirectory, 'SHA256SUMS');
  await writeFile(checksumsPath, 'preserve\n');

  await assert.rejects(writeFixtureProvenance(fixture), /already exists/);
  assert.equal(await readFile(checksumsPath, 'utf8'), 'preserve\n');
  await assert.rejects(
    access(
      join(fixture.outputDirectory, `${fixture.artifactName}.provenance.json`),
    ),
    { code: 'ENOENT' },
  );
});

async function writeFixtureProvenance(fixture) {
  return writeNativeProvenance({
    workspaceRoot: fixture.root,
    artifactPath: fixture.artifactPath,
    outputDirectory: fixture.outputDirectory,
    gitState: { commit: 'c'.repeat(40), dirty: false },
    rustVersion: '1.89.0',
  });
}

async function workspaceFixture(prefix, options = {}) {
  const root = await temporaryDirectory(prefix);
  const bundleRoot = join(root, 'src-tauri/target/release/bundle/appimage');
  await mkdir(bundleRoot, { recursive: true });
  const artifactName =
    options.artifactName ?? 'Omnia Reader_0.1.0_amd64.AppImage';
  const bytes = appImageBytes(options.marker ?? 'release');
  const artifactPath = join(bundleRoot, artifactName);
  await writeFile(artifactPath, bytes, { mode: 0o700 });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: '@omnia-reader/source', version: '0.1.0' }),
  );
  await writeFile(
    join(root, 'package-lock.json'),
    JSON.stringify({
      name: '@omnia-reader/source',
      version: '0.1.0',
      packages: {
        '': { name: '@omnia-reader/source', version: '0.1.0' },
        'node_modules/@tauri-apps/cli': { version: '2.11.4' },
      },
    }),
  );
  await writeFile(join(root, 'Cargo.lock'), 'cargo lock\n');
  await mkdir(join(root, 'src-tauri'), { recursive: true });
  await writeFile(
    join(root, 'src-tauri/tauri.conf.json'),
    JSON.stringify({
      productName: 'Omnia Reader',
      version: '0.1.0',
      identifier: 'io.github.omniareader.reader',
    }),
  );
  return {
    root,
    bundleRoot,
    artifactName,
    artifactPath,
    bytes,
    outputDirectory: join(root, 'dist/native-provenance'),
  };
}

function appImageBytes(marker) {
  const header = Buffer.alloc(20);
  Buffer.from([
    0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41, 0x49, 0x02,
  ]).copy(header);
  header.writeUInt16LE(0x3e, 18);
  return Buffer.concat([header, Buffer.from(marker)]);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}
