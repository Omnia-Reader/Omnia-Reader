import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  EvidenceValidationError,
  assertBoolean,
  assertExactKeys,
  assertOneOf,
  assertRecord,
  assertSafeInteger,
  assertString,
} from './performance-contract.mjs';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9]+(?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const ARTIFACT_KINDS = [
  'linux-deb',
  'linux-rpm',
  'linux-appimage',
  'windows-msi',
  'macos-dmg',
  'android-apk',
  'android-test-apk',
];

export function assertArtifactProvenance(value) {
  assertRecord(value, 'provenance');
  assertExactKeys(
    value,
    ['schemaVersion', 'provenanceId', 'artifact', 'source', 'toolchain'],
    'provenance',
  );
  assertEqual(value.schemaVersion, 1, 'provenance.schemaVersion');
  assertString(value.provenanceId, 1, 128, 'provenance.provenanceId');

  assertRecord(value.artifact, 'provenance.artifact');
  assertExactKeys(
    value.artifact,
    [
      'kind',
      'fileName',
      'sizeBytes',
      'sha256',
      'releaseMode',
      'debuggable',
      'packageId',
      'packageVersion',
      'target',
      'signerSha256',
    ],
    'provenance.artifact',
  );
  assertOneOf(value.artifact.kind, ARTIFACT_KINDS, 'provenance.artifact.kind');
  assertSafeFileName(value.artifact.fileName);
  assertSafeInteger(
    value.artifact.sizeBytes,
    1,
    MAX_ARTIFACT_BYTES,
    'provenance.artifact.sizeBytes',
  );
  assertDigest(value.artifact.sha256, 'provenance.artifact.sha256');
  assertEqual(
    value.artifact.releaseMode,
    'release',
    'provenance.artifact.releaseMode',
  );
  assertBoolean(value.artifact.debuggable, 'provenance.artifact.debuggable');
  assertEqual(
    value.artifact.debuggable,
    false,
    'provenance.artifact.debuggable',
  );
  assertString(
    value.artifact.packageId,
    1,
    256,
    'provenance.artifact.packageId',
  );
  assertString(
    value.artifact.packageVersion,
    1,
    128,
    'provenance.artifact.packageVersion',
  );
  assertString(value.artifact.target, 1, 128, 'provenance.artifact.target');
  if (value.artifact.signerSha256 !== null) {
    assertDigest(
      value.artifact.signerSha256,
      'provenance.artifact.signerSha256',
    );
  }

  assertRecord(value.source, 'provenance.source');
  assertExactKeys(
    value.source,
    ['commit', 'dirty', 'packageLockSha256', 'cargoLockSha256'],
    'provenance.source',
  );
  assertPattern(
    value.source.commit,
    GIT_SHA_PATTERN,
    'provenance.source.commit',
  );
  assertBoolean(value.source.dirty, 'provenance.source.dirty');
  assertEqual(value.source.dirty, false, 'provenance.source.dirty');
  assertDigest(
    value.source.packageLockSha256,
    'provenance.source.packageLockSha256',
  );
  assertDigest(
    value.source.cargoLockSha256,
    'provenance.source.cargoLockSha256',
  );

  assertToolchain(value.toolchain);
  return value;
}

export async function copyVerifiedArtifact(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  const provenance = assertArtifactProvenance(options.provenance);
  const sourcePath = resolve(
    assertString(options.sourcePath, 1, 4_096, 'options.sourcePath'),
  );
  const destinationRootInput = resolve(
    assertString(options.destinationRoot, 1, 4_096, 'options.destinationRoot'),
  );
  const sourcePathStats = await lstat(sourcePath, { bigint: true });
  if (!sourcePathStats.isFile() || sourcePathStats.isSymbolicLink()) {
    throw new EvidenceValidationError(
      'artifact source must be a regular file and not a symbolic link',
      'options.sourcePath',
    );
  }
  if (basename(sourcePath) !== provenance.artifact.fileName) {
    throw new EvidenceValidationError(
      'artifact filename does not match provenance',
      'options.sourcePath',
    );
  }

  await mkdir(destinationRootInput, { recursive: true, mode: 0o700 });
  const destinationRoot = await realpath(destinationRootInput);
  const destination = resolve(destinationRoot, provenance.artifact.fileName);
  if (dirname(destination) !== destinationRoot) {
    throw new EvidenceValidationError(
      'artifact destination must stay inside the owned directory',
      'provenance.artifact.fileName',
    );
  }

  let sourceHandle;
  let destinationHandle;
  let destinationCreated = false;
  try {
    sourceHandle = await open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await sourceHandle.stat({ bigint: true });
    assertOpenedSource(before, sourcePathStats, provenance);
    try {
      destinationHandle = await open(destination, 'wx', 0o500);
      destinationCreated = true;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'EEXIST') {
        throw new EvidenceValidationError(
          'owned artifact destination already exists',
          'destination',
        );
      }
      throw error;
    }

    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    while (position < provenance.artifact.sizeBytes) {
      const requested = Math.min(
        buffer.byteLength,
        provenance.artifact.sizeBytes - position,
      );
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead === 0) {
        throw new EvidenceValidationError(
          'artifact ended before its declared size',
          'artifact',
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const outcome = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (outcome.bytesWritten === 0) {
          throw new EvidenceValidationError(
            'artifact destination stopped accepting bytes',
            'artifact',
          );
        }
        written += outcome.bytesWritten;
      }
      position += bytesRead;
    }
    const actualDigest = `sha256:${digest.digest('hex')}`;
    if (actualDigest !== provenance.artifact.sha256) {
      throw new EvidenceValidationError(
        'artifact digest does not match provenance',
        'artifact.sha256',
      );
    }

    const after = await sourceHandle.stat({ bigint: true });
    const currentPath = await lstat(sourcePath, { bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, currentPath)
    ) {
      throw new EvidenceValidationError(
        'artifact source changed while it was copied',
        'artifact',
      );
    }
    await destinationHandle.sync();
    return { path: destination, provenance };
  } catch (error) {
    if (destinationCreated) {
      await destinationHandle?.close().catch(() => undefined);
      destinationHandle = undefined;
      await unlink(destination).catch(() => undefined);
    }
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

function assertOpenedSource(stats, pathStats, provenance) {
  if (!stats.isFile() || !sameFileIdentity(stats, pathStats)) {
    throw new EvidenceValidationError(
      'artifact source identity changed before copying',
      'artifact',
    );
  }
  if (stats.size !== BigInt(provenance.artifact.sizeBytes)) {
    throw new EvidenceValidationError(
      'artifact size does not match provenance',
      'artifact.sizeBytes',
    );
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

function assertToolchain(value) {
  assertRecord(value, 'provenance.toolchain');
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) {
    throw new EvidenceValidationError(
      'must contain between 1 and 32 tool versions',
      'provenance.toolchain',
    );
  }
  for (const [name, version] of entries) {
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new EvidenceValidationError(
        'contains an invalid tool name',
        `provenance.toolchain.${name}`,
      );
    }
    assertString(version, 1, 256, `provenance.toolchain.${name}`);
  }
}

function assertSafeFileName(value) {
  assertString(value, 1, 240, 'provenance.artifact.fileName');
  if (
    basename(value) !== value ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new EvidenceValidationError(
      'must be one safe artifact filename',
      'provenance.artifact.fileName',
    );
  }
}

function assertDigest(value, path) {
  assertPattern(value, SHA256_PATTERN, path);
}

function assertPattern(value, pattern, path) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new EvidenceValidationError(`must match ${pattern}`, path);
  }
}

function assertEqual(actual, expected, path) {
  if (!Object.is(actual, expected)) {
    throw new EvidenceValidationError(
      `expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`,
      path,
    );
  }
}
