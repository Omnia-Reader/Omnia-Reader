/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  assertArtifactProvenance,
  copyVerifiedArtifact,
} from './artifact-identity.mjs';

const ownedDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...ownedDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  ownedDirectories.clear();
});

test('validates release provenance and copies exact bytes exclusively', async () => {
  const root = await temporaryDirectory('omnia-artifact-valid-');
  const sourcePath = join(root, 'omnia-reader.AppImage');
  const bytes = Buffer.from('exact release artifact');
  await writeFile(sourcePath, bytes);
  const provenance = provenanceFixture('omnia-reader.AppImage', bytes);
  assert.equal(assertArtifactProvenance(provenance), provenance);

  const destinationRoot = join(root, 'owned');
  const result = await copyVerifiedArtifact({
    sourcePath,
    destinationRoot,
    provenance,
  });

  assert.equal(
    result.path,
    join(destinationRoot, provenance.artifact.fileName),
  );
  assert.deepEqual(await readFile(result.path), bytes);
  await assert.rejects(
    copyVerifiedArtifact({ sourcePath, destinationRoot, provenance }),
    /already exists/,
  );
});

test('rejects debug, dirty, malformed, and mismatched provenance', () => {
  const bytes = Buffer.from('release');
  for (const mutate of [
    (value) => {
      value.artifact.releaseMode = 'debug';
    },
    (value) => {
      value.artifact.debuggable = true;
    },
    (value) => {
      value.source.dirty = true;
    },
    (value) => {
      value.artifact.sha256 = 'not-a-digest';
    },
    (value) => {
      value.unexpected = true;
    },
  ]) {
    const provenance = provenanceFixture('reader.apk', bytes);
    mutate(provenance);
    assert.throws(() => assertArtifactProvenance(provenance));
  }
});

test('rejects changed artifact bytes and removes the partial owned copy', async () => {
  const root = await temporaryDirectory('omnia-artifact-mismatch-');
  const sourcePath = join(root, 'omnia-reader.deb');
  const approved = Buffer.from('approved bytes');
  const provenance = provenanceFixture('omnia-reader.deb', approved);
  await writeFile(sourcePath, Buffer.from('changed bytes!'));
  const destinationRoot = join(root, 'owned');

  await assert.rejects(
    copyVerifiedArtifact({ sourcePath, destinationRoot, provenance }),
    /digest does not match/,
  );
  await assert.rejects(
    readFile(join(destinationRoot, provenance.artifact.fileName)),
    { code: 'ENOENT' },
  );

  const wrongSize = provenanceFixture(
    'omnia-reader.deb',
    Buffer.from('changed bytes!'),
  );
  wrongSize.artifact.sizeBytes += 1;
  await assert.rejects(
    copyVerifiedArtifact({
      sourcePath,
      destinationRoot,
      provenance: wrongSize,
    }),
    /size does not match/,
  );
});

test('detects source-path replacement while copying from the opened file', async () => {
  const root = await temporaryDirectory('omnia-artifact-toctou-');
  const sourcePath = join(root, 'omnia-reader.AppImage');
  const approved = Buffer.alloc(32 * 1024 * 1024, 0x5a);
  await writeFile(sourcePath, approved);
  const provenance = provenanceFixture('omnia-reader.AppImage', approved);
  const destinationRoot = join(root, 'owned');

  const copying = copyVerifiedArtifact({
    sourcePath,
    destinationRoot,
    provenance,
  });
  await waitForFile(join(destinationRoot, provenance.artifact.fileName));
  await rename(sourcePath, join(root, 'original.AppImage'));
  await writeFile(sourcePath, Buffer.alloc(approved.byteLength, 0x31));

  await assert.rejects(copying, /source changed while it was copied/);
  await assert.rejects(
    readFile(join(destinationRoot, provenance.artifact.fileName)),
    { code: 'ENOENT' },
  );
});

test(
  'rejects symbolic-link artifact sources',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await temporaryDirectory('omnia-artifact-symlink-');
    const bytes = Buffer.from('release');
    const target = join(root, 'target.AppImage');
    const sourcePath = join(root, 'omnia-reader.AppImage');
    await writeFile(target, bytes);
    await symlink(target, sourcePath);

    await assert.rejects(
      copyVerifiedArtifact({
        sourcePath,
        destinationRoot: join(root, 'owned'),
        provenance: provenanceFixture('omnia-reader.AppImage', bytes),
      }),
      /regular file|symbolic link/,
    );
  },
);

function provenanceFixture(fileName, bytes) {
  return {
    schemaVersion: 1,
    provenanceId: 'omnia-native-release-v1',
    artifact: {
      kind: fileName.endsWith('.apk') ? 'android-apk' : 'linux-appimage',
      fileName,
      sizeBytes: bytes.byteLength,
      sha256: digest(bytes),
      releaseMode: 'release',
      debuggable: false,
      packageId: 'io.github.omniareader.reader',
      packageVersion: '0.1.0',
      target: fileName.endsWith('.apk')
        ? 'x86_64-linux-android'
        : 'x86_64-linux',
      signerSha256: fileName.endsWith('.apk')
        ? `sha256:${'d'.repeat(64)}`
        : null,
    },
    source: {
      commit: 'c'.repeat(40),
      dirty: false,
      packageLockSha256: `sha256:${'a'.repeat(64)}`,
      cargoLockSha256: `sha256:${'b'.repeat(64)}`,
    },
    toolchain: {
      node: 'v26.5.0',
      rust: '1.89.0',
      tauri: '2.8.5',
    },
  };
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}

async function waitForFile(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
