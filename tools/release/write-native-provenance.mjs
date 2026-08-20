import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertArtifactProvenance } from '../../apps/omnia-reader-e2e/performance/artifact-identity.mjs';

const APPIMAGE_HEADER = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41, 0x49, 0x02,
]);
const DEBUG_MARKERS = [
  Buffer.from('tauri-plugin-wdio-webdriver'),
  Buffer.from('native-e2e'),
];
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const ELF_MACHINE_OFFSET = 18;
const ELF_X86_64_MACHINE = 0x3e;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export async function writeNativeProvenance({
  workspaceRoot,
  artifactPath,
  outputDirectory,
  gitState,
  rustVersion,
} = {}) {
  const root = resolve(requiredString(workspaceRoot, 'workspaceRoot'));
  const rootRealPath = await realpath(root);
  const artifact = resolve(root, requiredString(artifactPath, 'artifactPath'));
  const bundleRoot = resolve(root, 'src-tauri/target/release/bundle/appimage');
  assert(
    dirname(artifact) === bundleRoot,
    'artifactPath must be one exact file under src-tauri/target/release/bundle/appimage',
  );
  const bundleRootRealPath = await realpath(bundleRoot);
  assert(
    (await realpath(dirname(artifact))) === bundleRootRealPath,
    'artifactPath must resolve under the approved bundle/appimage directory',
  );

  const artifactStats = await lstat(artifact, { bigint: true });
  assert(
    artifactStats.isFile() && !artifactStats.isSymbolicLink(),
    'artifactPath must be a regular file and not a symbolic link',
  );
  assert(
    artifactStats.size > 0n && artifactStats.size <= BigInt(MAX_ARTIFACT_BYTES),
    `artifactPath must contain between 1 and ${MAX_ARTIFACT_BYTES} bytes`,
  );

  const sourceWasProvided = gitState !== undefined;
  const source = gitState ?? readGitState(root);
  assertGitState(source);
  assert(
    !source.dirty,
    'native provenance requires a clean, non-dirty Git source',
  );

  const [packageJsonBytes, packageLockBytes, tauriConfigBytes, cargoLockBytes] =
    await Promise.all([
      readBoundedFile(join(root, 'package.json'), 'package.json'),
      readBoundedFile(join(root, 'package-lock.json'), 'package-lock.json'),
      readBoundedFile(
        join(root, 'src-tauri/tauri.conf.json'),
        'src-tauri/tauri.conf.json',
      ),
      readBoundedFile(join(root, 'Cargo.lock'), 'Cargo.lock'),
    ]);
  const packageJson = parseJson(packageJsonBytes, 'package.json');
  const packageLock = parseJson(packageLockBytes, 'package-lock.json');
  const tauriConfig = parseJson(tauriConfigBytes, 'src-tauri/tauri.conf.json');
  const packageVersion = coherentVersion({
    'package.json': packageJson.version,
    'package-lock.json': packageLock.version,
    'package-lock.json root': packageLock.packages?.['']?.version,
    'tauri.conf.json': tauriConfig.version,
  });
  const packageId = requiredString(
    tauriConfig.identifier,
    'tauri.conf.json identifier',
  );
  const productName = requiredString(
    tauriConfig.productName,
    'tauri.conf.json productName',
  );
  const tauriVersion = requiredString(
    packageLock.packages?.['node_modules/@tauri-apps/cli']?.version,
    'package-lock.json Tauri CLI version',
  );
  const rust = normalizeRustVersion(rustVersion ?? readRustVersion(root));
  const fileName = basename(artifact);
  assert(fileName.endsWith('.AppImage'), 'artifactPath must name an AppImage');
  assert(
    !/[\u0000-\u001f\u007f]/.test(fileName),
    'artifactPath filename must not contain control characters',
  );
  assert(
    fileName === `${productName}_${packageVersion}_amd64.AppImage`,
    'artifactPath filename must match the Tauri product, version, and amd64 target',
  );

  const artifactIdentity = await inspectAppImage(artifact, artifactStats);
  if (!sourceWasProvided) {
    const finalSource = readGitState(root);
    assert(
      finalSource.commit === source.commit && !finalSource.dirty,
      'Git source changed while native provenance was generated',
    );
  }
  const provenance = assertArtifactProvenance({
    schemaVersion: 1,
    provenanceId: `native-${artifactIdentity.sha256.slice(7)}`,
    artifact: {
      kind: 'linux-appimage',
      fileName,
      sizeBytes: artifactIdentity.sizeBytes,
      sha256: artifactIdentity.sha256,
      releaseMode: 'release',
      debuggable: false,
      packageId,
      packageVersion,
      target: 'x86_64-linux',
      signerSha256: null,
    },
    source: {
      commit: source.commit,
      dirty: false,
      packageLockSha256: sha256Digest(packageLockBytes),
      cargoLockSha256: sha256Digest(cargoLockBytes),
    },
    toolchain: {
      node: process.version,
      rust,
      tauri: tauriVersion,
    },
  });
  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  const provenanceName = `${fileName}.provenance.json`;
  const checksumsText = `${artifactIdentity.sha256.slice(7)}  ${fileName}\n${sha256Hex(Buffer.from(provenanceText))}  ${provenanceName}\n`;

  const output = resolve(
    root,
    outputDirectory ?? join(root, 'dist/native-provenance'),
  );
  assertPathInside(root, output, 'outputDirectory');
  await assertExistingPathSegmentsAreNotLinks(root, output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const outputStats = await lstat(output);
  assert(
    outputStats.isDirectory() && !outputStats.isSymbolicLink(),
    'outputDirectory must be a real directory and not a symbolic link',
  );
  assertPathInside(rootRealPath, await realpath(output), 'outputDirectory');

  const provenancePath = join(output, provenanceName);
  const checksumsPath = join(output, 'SHA256SUMS');
  let provenanceCreated = false;
  try {
    await writeNoReplace(provenancePath, provenanceText);
    provenanceCreated = true;
    await writeNoReplace(checksumsPath, checksumsText);
  } catch (error) {
    if (provenanceCreated) {
      await unlink(provenancePath).catch(() => undefined);
    }
    throw error;
  }

  return { provenancePath, checksumsPath, provenance };
}

async function inspectAppImage(path, pathStats) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    assert(
      before.isFile() && sameFileIdentity(before, pathStats),
      'artifactPath changed before inspection',
    );
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const header = Buffer.alloc(ELF_MACHINE_OFFSET + 2);
    let headerBytes = 0;
    let carry = Buffer.alloc(0);
    let position = 0;
    while (position < Number(before.size)) {
      const requested = Math.min(
        buffer.byteLength,
        Number(before.size) - position,
      );
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      assert(bytesRead > 0, 'AppImage ended before its inspected size');
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (headerBytes < header.byteLength) {
        const copied = Math.min(header.byteLength - headerBytes, bytesRead);
        chunk.copy(header, headerBytes, 0, copied);
        headerBytes += copied;
      }
      const searchable = Buffer.concat([carry, chunk]);
      assert(
        !DEBUG_MARKERS.some((marker) => searchable.includes(marker)),
        'AppImage contains embedded debug automation markers',
      );
      const carryBytes =
        Math.max(...DEBUG_MARKERS.map((marker) => marker.length)) - 1;
      carry = searchable.subarray(Math.max(0, searchable.length - carryBytes));
      position += bytesRead;
    }
    assert(
      headerBytes === header.byteLength &&
        header.subarray(0, APPIMAGE_HEADER.length).equals(APPIMAGE_HEADER),
      'artifactPath is not an ELF AppImage type-2 file',
    );
    assert(
      header.readUInt16LE(ELF_MACHINE_OFFSET) === ELF_X86_64_MACHINE,
      'artifactPath must contain an x86_64 AppImage',
    );
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(path, { bigint: true });
    assert(
      sameFileIdentity(before, after) && sameFileIdentity(after, currentPath),
      'artifactPath changed while provenance was generated',
    );
    return {
      sizeBytes: Number(before.size),
      sha256: `sha256:${digest.digest('hex')}`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedFile(path, label) {
  const stats = await lstat(path);
  assert(
    stats.isFile() && !stats.isSymbolicLink(),
    `${label} must be a regular file`,
  );
  assert(
    stats.size > 0 && stats.size <= MAX_METADATA_BYTES,
    `${label} exceeds its size bound`,
  );
  return readFile(path);
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    assert(
      value && typeof value === 'object' && !Array.isArray(value),
      `${label} must contain an object`,
    );
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function coherentVersion(versions) {
  const entries = Object.entries(versions);
  for (const [label, version] of entries) {
    assert(
      typeof version === 'string' && SEMVER_PATTERN.test(version),
      `${label} has an invalid release version`,
    );
  }
  const expected = entries[0][1];
  assert(
    entries.every(([, version]) => version === expected),
    `release versions differ: ${entries.map(([label, version]) => `${label}=${String(version)}`).join(', ')}`,
  );
  return expected;
}

function readGitState(root) {
  const commit = commandOutput(
    'git',
    ['rev-parse', 'HEAD'],
    root,
    'Git commit',
  );
  const status = commandOutput(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    root,
    'Git status',
  );
  return { commit, dirty: status.length > 0 };
}

function assertGitState(value) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'gitState must be an object',
  );
  assert(
    GIT_SHA_PATTERN.test(value.commit),
    'gitState.commit must be a full lowercase Git SHA',
  );
  assert(typeof value.dirty === 'boolean', 'gitState.dirty must be boolean');
}

function readRustVersion(root) {
  return commandOutput('rustc', ['--version'], root, 'Rust version');
}

function normalizeRustVersion(value) {
  const version = requiredString(value, 'rustVersion');
  const match = version.match(/^(?:rustc\s+)?([^\s]+)(?:\s|$)/);
  assert(match, 'rustVersion has an invalid format');
  return match[1];
}

function commandOutput(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert(
    result.status === 0,
    `${label} command failed with exit code ${String(result.status)}`,
  );
  return result.stdout.trim();
}

async function assertExistingPathSegmentsAreNotLinks(root, destination) {
  const pathFromRoot = relative(root, destination);
  let current = root;
  for (const segment of pathFromRoot.split('/').filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) return;
    assert(
      !stats.isSymbolicLink(),
      'outputDirectory must not traverse symbolic links',
    );
  }
}

async function writeNoReplace(path, contents) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`release output already exists: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    handle = undefined;
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertPathInside(root, candidate, label) {
  const child = relative(root, candidate);
  assert(
    child && !child.startsWith('..') && !isAbsolute(child),
    `${label} must stay inside workspaceRoot`,
  );
}

function requiredString(value, label) {
  assert(
    typeof value === 'string' && value.length > 0 && value.length <= 4096,
    `${label} must be a non-empty string`,
  );
  return value;
}

function sha256Digest(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  let artifactPath;
  let outputDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--artifact' || argument === '--output-directory') {
      const value = argv[index + 1];
      assert(value && !value.startsWith('--'), `${argument} requires a value`);
      if (argument === '--artifact') {
        assert(
          artifactPath === undefined,
          '--artifact may be supplied only once',
        );
        artifactPath = value;
      } else {
        assert(
          outputDirectory === undefined,
          '--output-directory may be supplied only once',
        );
        outputDirectory = value;
      }
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  assert(artifactPath, '--artifact is required');
  return { artifactPath, outputDirectory };
}

async function main() {
  const workspaceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const result = await writeNativeProvenance({
    workspaceRoot,
    ...parseArguments(process.argv.slice(2)),
  });
  process.stdout.write(`${result.provenancePath}\n${result.checksumsPath}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
