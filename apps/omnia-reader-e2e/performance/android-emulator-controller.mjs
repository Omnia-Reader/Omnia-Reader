import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  EvidenceValidationError,
  assertArray,
  assertExactKeys,
  assertRecord,
  assertSafeInteger,
  assertString,
  canonicalStringify,
} from './performance-contract.mjs';
import { PLATFORM_LIMITS } from './platform-contract.mjs';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const AVD_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const EMULATOR_SERIAL_PATTERN = /^emulator-(\d{4})$/;
const TCP_ENDPOINT_PATTERN = /^tcp:(\d{1,5})$/;
const LOCAL_ABSTRACT_PATTERN = /^localabstract:[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_MANIFEST_LIMITS = Object.freeze({
  maximumFiles: 50_000,
  maximumFileBytes: 8 * 1024 * 1024 * 1024,
  maximumTotalBytes: 16 * 1024 * 1024 * 1024,
  maximumRelativePathLength: 512,
});
const HASH_CHUNK_BYTES = 1024 * 1024;

export async function canonicalAvdManifest(directory, limitOverrides = {}) {
  const root = resolve(assertString(directory, 1, 4_096, 'avd.directory'));
  const limits = assertManifestLimits(limitOverrides);
  const rootStats = await lstat(root, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new EvidenceValidationError(
      'AVD baseline must be one real directory',
      'avd.directory',
    );
  }

  const directories = [];
  const filePaths = [];
  await walkAvd(root, root, directories, filePaths, limits);
  filePaths.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  directories.sort();
  let totalBytes = 0;
  const files = [];
  for (const entry of filePaths) {
    const identity = await hashStableFile(
      entry.absolutePath,
      entry.stats,
      limits,
    );
    totalBytes += identity.sizeBytes;
    if (totalBytes > limits.maximumTotalBytes) {
      throw new EvidenceValidationError(
        'AVD baseline exceeds the total byte limit',
        'avd.files',
      );
    }
    files.push({
      path: entry.relativePath,
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
    });
  }
  const verificationDirectories = [];
  const verificationFiles = [];
  await walkAvd(root, root, verificationDirectories, verificationFiles, limits);
  verificationDirectories.sort();
  verificationFiles.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  if (
    canonicalStringify(verificationDirectories) !==
      canonicalStringify(directories) ||
    verificationFiles.length !== filePaths.length ||
    verificationFiles.some(
      (entry, index) =>
        entry.relativePath !== filePaths[index].relativePath ||
        !sameFileIdentity(entry.stats, filePaths[index].stats),
    )
  ) {
    throw new EvidenceValidationError(
      'AVD baseline changed while its manifest was captured',
      'avd',
    );
  }
  const content = { schemaVersion: 1, directories, files, totalBytes };
  return {
    ...content,
    digest: `sha256:${createHash('sha256')
      .update(canonicalStringify(content), 'utf8')
      .digest('hex')}`,
  };
}

export async function prepareDisposableAvd(options) {
  assertRecord(options, 'options');
  assertExactKeys(
    options,
    ['avdName', 'baselineDirectory', 'expectedDigest', 'temporaryRoot'],
    'options',
  );
  const avdName = assertAvdName(options.avdName);
  assertDigest(options.expectedDigest, 'options.expectedDigest');
  const baselineDirectory = resolve(
    assertString(
      options.baselineDirectory,
      1,
      4_096,
      'options.baselineDirectory',
    ),
  );
  const temporaryRoot = resolve(
    assertString(options.temporaryRoot, 1, 4_096, 'options.temporaryRoot'),
  );
  const approved = await canonicalAvdManifest(baselineDirectory);
  if (approved.digest !== options.expectedDigest) {
    throw new EvidenceValidationError(
      'AVD baseline digest does not match the approved profile',
      'options.expectedDigest',
    );
  }

  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const avdHome = await mkdtemp(join(temporaryRoot, 'omnia-avd-home-'));
  const avdDirectory = join(avdHome, `${avdName}.avd`);
  try {
    await mkdir(avdDirectory, { mode: 0o700 });
    for (const directory of approved.directories) {
      await mkdir(joinConfined(avdDirectory, directory), {
        recursive: true,
        mode: 0o700,
      });
    }
    for (const file of approved.files) {
      await copyManifestFile(
        joinConfined(baselineDirectory, file.path),
        joinConfined(avdDirectory, file.path),
        file,
      );
    }
    const manifest = await canonicalAvdManifest(avdDirectory);
    if (manifest.digest !== approved.digest) {
      throw new EvidenceValidationError(
        'disposable AVD copy does not match the approved baseline',
        'avd.copy',
      );
    }
    const registrationPath = join(avdHome, `${avdName}.ini`);
    await writeFile(
      registrationPath,
      `avd.ini.encoding=UTF-8\npath=${avdDirectory}\npath.rel=avd/${avdName}.avd\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    return { avdHome, avdDirectory, registrationPath, manifest };
  } catch (error) {
    await rm(avdHome, { recursive: true, force: true });
    throw error;
  }
}

export function emulatorSerialForPort(port) {
  assertSafeInteger(port, 5_554, 5_682, 'emulator.port');
  if (port % 2 !== 0) {
    throw new EvidenceValidationError(
      'must be an even emulator console port',
      'emulator.port',
    );
  }
  return `emulator-${port}`;
}

export function assertExclusiveEmulatorDevices(output, ownedSerial) {
  assertString(
    output,
    0,
    PLATFORM_LIMITS.maximumDiagnosticBytes,
    'adb.devices',
  );
  assertEmulatorSerial(ownedSerial);
  const entries = output
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const [serial, status] = line.trim().split(/\s+/, 3);
      if (!serial || !status) {
        throw new EvidenceValidationError(
          'contains a malformed device row',
          `adb.devices[${index}]`,
        );
      }
      return { serial, status };
    });
  const emulatorEntries = entries.filter(({ serial }) =>
    serial.startsWith('emulator-'),
  );
  const foreign = emulatorEntries.filter(
    ({ serial }) => serial !== ownedSerial,
  );
  if (foreign.length > 0) {
    throw new EvidenceValidationError(
      `foreign emulator devices are present: ${foreign.map(({ serial }) => serial).join(', ')}`,
      'adb.devices',
    );
  }
  const owned = emulatorEntries.filter(({ serial }) => serial === ownedSerial);
  if (owned.length !== 1 || owned[0].status !== 'device') {
    throw new EvidenceValidationError(
      `${ownedSerial} is not connected exactly once in device state`,
      'adb.devices',
    );
  }
  return true;
}

export class SerialScopedAdb {
  constructor(options) {
    assertRecord(options, 'adb.options');
    assertExactKeys(options, ['adbPath', 'serial', 'run'], 'adb.options');
    this.adbPath = assertString(
      options.adbPath,
      1,
      4_096,
      'adb.options.adbPath',
    );
    this.serial = assertEmulatorSerial(options.serial);
    if (typeof options.run !== 'function') {
      throw new EvidenceValidationError(
        'must be a function',
        'adb.options.run',
      );
    }
    this.run = options.run;
    this.forwards = new Set();
    this.reverses = new Set();
    this.closed = false;
  }

  async shell(arguments_) {
    this.assertOpen();
    assertCommandArguments(arguments_, 'adb.shell');
    return this.execute(['shell', ...arguments_]);
  }

  async reverse(local, remote) {
    this.assertOpen();
    assertTcpEndpoint(local, 'adb.reverse.local');
    assertTcpEndpoint(remote, 'adb.reverse.remote');
    this.assertMappingCapacity();
    if (this.reverses.has(local)) {
      throw new EvidenceValidationError(
        'owned reverse mapping already exists',
        'adb.reverse.local',
      );
    }
    const result = await this.execute(['reverse', local, remote]);
    this.reverses.add(local);
    return result;
  }

  async forward(local, remote) {
    this.assertOpen();
    assertTcpEndpoint(local, 'adb.forward.local');
    if (
      !TCP_ENDPOINT_PATTERN.test(remote) &&
      !LOCAL_ABSTRACT_PATTERN.test(remote)
    ) {
      throw new EvidenceValidationError(
        'must be a bounded tcp or localabstract endpoint',
        'adb.forward.remote',
      );
    }
    this.assertMappingCapacity();
    if (this.forwards.has(local)) {
      throw new EvidenceValidationError(
        'owned forward mapping already exists',
        'adb.forward.local',
      );
    }
    const result = await this.execute(['forward', local, remote]);
    this.forwards.add(local);
    return result;
  }

  async cleanup() {
    if (this.closed) return;
    this.closed = true;
    const failures = [];
    for (const local of [...this.forwards].reverse()) {
      try {
        await this.execute(['forward', '--remove', local]);
      } catch (error) {
        failures.push(error);
      }
    }
    this.forwards.clear();
    for (const local of [...this.reverses].reverse()) {
      try {
        await this.execute(['reverse', '--remove', local]);
      } catch (error) {
        failures.push(error);
      }
    }
    this.reverses.clear();
    try {
      await this.execute(['emu', 'kill']);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Unable to clean owned ADB resources');
    }
  }

  assertMappingCapacity() {
    if (
      this.forwards.size + this.reverses.size >=
      PLATFORM_LIMITS.maximumOwnedResources
    ) {
      throw new EvidenceValidationError(
        'owned ADB mapping limit exceeded',
        'adb.mappings',
      );
    }
  }

  assertOpen() {
    if (this.closed) {
      throw new EvidenceValidationError('ADB session is already closed', 'adb');
    }
  }

  async execute(arguments_) {
    const result = await this.run(this.adbPath, [
      '-s',
      this.serial,
      ...arguments_,
    ]);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new EvidenceValidationError(
        'runner returned an invalid result',
        'adb',
      );
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (
      Buffer.byteLength(stdout, 'utf8') >
        PLATFORM_LIMITS.maximumDiagnosticBytes ||
      Buffer.byteLength(stderr, 'utf8') > PLATFORM_LIMITS.maximumDiagnosticBytes
    ) {
      throw new EvidenceValidationError(
        'ADB diagnostics exceed the byte limit',
        'adb',
      );
    }
    if (result.exitCode !== 0) {
      throw new EvidenceValidationError(
        stderr || `ADB exited with code ${String(result.exitCode)}`,
        'adb',
      );
    }
    return { stdout, stderr, exitCode: 0 };
  }
}

async function walkAvd(root, current, directories, files, limits) {
  const directory = await opendir(current);
  const entries = [];
  for await (const entry of directory) entries.push(entry.name);
  entries.sort();
  for (const name of entries) {
    const absolutePath = join(current, name);
    const relativePath = portableRelative(root, absolutePath, limits);
    const stats = await lstat(absolutePath, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new EvidenceValidationError(
        'AVD baseline cannot contain a symbolic link',
        `avd.${relativePath}`,
      );
    }
    if (stats.isDirectory()) {
      directories.push(relativePath);
      await walkAvd(root, absolutePath, directories, files, limits);
      continue;
    }
    if (!stats.isFile()) {
      throw new EvidenceValidationError(
        'AVD baseline can contain only directories and regular files',
        `avd.${relativePath}`,
      );
    }
    if (files.length >= limits.maximumFiles) {
      throw new EvidenceValidationError(
        'AVD baseline exceeds the file count limit',
        'avd.files',
      );
    }
    files.push({ absolutePath, relativePath, stats });
  }
}

async function hashStableFile(path, pathStats, limits) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileIdentity(before, pathStats)) {
      throw new EvidenceValidationError('AVD file identity changed', path);
    }
    const sizeBytes = Number(before.size);
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes > limits.maximumFileBytes
    ) {
      throw new EvidenceValidationError(
        'AVD file exceeds the byte limit',
        path,
      );
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    while (position < sizeBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, sizeBytes - position),
        position,
      );
      if (bytesRead === 0) {
        throw new EvidenceValidationError('AVD file ended unexpectedly', path);
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(path, { bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, currentPath)
    ) {
      throw new EvidenceValidationError('AVD file changed while hashing', path);
    }
    return {
      sizeBytes,
      sha256: `sha256:${digest.digest('hex')}`,
    };
  } finally {
    await handle.close();
  }
}

async function copyManifestFile(source, destination, descriptor) {
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let destinationHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(descriptor.sizeBytes)) {
      throw new EvidenceValidationError(
        'approved AVD file changed before copy',
        source,
      );
    }
    destinationHandle = await open(destination, 'wx', 0o600);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    while (position < descriptor.sizeBytes) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, descriptor.sizeBytes - position),
        position,
      );
      if (bytesRead === 0) {
        throw new EvidenceValidationError(
          'approved AVD file ended during copy',
          source,
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (bytesWritten === 0) {
          throw new EvidenceValidationError(
            'disposable AVD stopped accepting bytes',
            destination,
          );
        }
        written += bytesWritten;
      }
      position += bytesRead;
    }
    if (`sha256:${digest.digest('hex')}` !== descriptor.sha256) {
      throw new EvidenceValidationError(
        'approved AVD file digest changed during copy',
        source,
      );
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    const currentPath = await lstat(source, { bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, currentPath)
    ) {
      throw new EvidenceValidationError(
        'approved AVD file identity changed during copy',
        source,
      );
    }
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

function assertManifestLimits(overrides) {
  assertRecord(overrides, 'avd.limits');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_MANIFEST_LIMITS, key)) {
      throw new EvidenceValidationError(
        'unknown manifest limit',
        `avd.limits.${key}`,
      );
    }
  }
  const limits = { ...DEFAULT_MANIFEST_LIMITS, ...overrides };
  assertSafeInteger(limits.maximumFiles, 1, 100_000, 'avd.limits.maximumFiles');
  assertSafeInteger(
    limits.maximumFileBytes,
    1,
    32 * 1024 * 1024 * 1024,
    'avd.limits.maximumFileBytes',
  );
  assertSafeInteger(
    limits.maximumTotalBytes,
    1,
    64 * 1024 * 1024 * 1024,
    'avd.limits.maximumTotalBytes',
  );
  assertSafeInteger(
    limits.maximumRelativePathLength,
    1,
    4_096,
    'avd.limits.maximumRelativePathLength',
  );
  return limits;
}

function portableRelative(root, path, limits) {
  const value = relative(root, path).split(sep).join('/');
  if (
    !value ||
    value.startsWith('../') ||
    value.includes('\0') ||
    value.length > limits.maximumRelativePathLength
  ) {
    throw new EvidenceValidationError(
      'contains an unsafe relative path',
      'avd',
    );
  }
  return value;
}

function joinConfined(root, relativePath) {
  const destination = resolve(root, ...relativePath.split('/'));
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new EvidenceValidationError(
      'path escapes the AVD directory',
      'avd.path',
    );
  }
  return destination;
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

function assertAvdName(value) {
  if (typeof value !== 'string' || !AVD_NAME_PATTERN.test(value)) {
    throw new EvidenceValidationError(
      'must be a safe AVD name',
      'options.avdName',
    );
  }
  return value;
}

function assertEmulatorSerial(value) {
  if (typeof value !== 'string' || !EMULATOR_SERIAL_PATTERN.test(value)) {
    throw new EvidenceValidationError(
      'must be an exact emulator serial',
      'adb.serial',
    );
  }
  emulatorSerialForPort(Number(EMULATOR_SERIAL_PATTERN.exec(value)[1]));
  return value;
}

function assertTcpEndpoint(value, path) {
  if (typeof value !== 'string' || !TCP_ENDPOINT_PATTERN.test(value)) {
    throw new EvidenceValidationError('must be a tcp endpoint', path);
  }
  const port = Number(TCP_ENDPOINT_PATTERN.exec(value)[1]);
  assertSafeInteger(port, 1, 65_535, path);
}

function assertCommandArguments(value, path) {
  assertArray(value, path);
  if (
    value.length === 0 ||
    value.length > 64 ||
    !value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= 1_024 &&
        !entry.includes('\0'),
    )
  ) {
    throw new EvidenceValidationError(
      'must contain bounded string arguments',
      path,
    );
  }
}

function assertDigest(value, path) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new EvidenceValidationError(`must match ${SHA256_PATTERN}`, path);
  }
}
