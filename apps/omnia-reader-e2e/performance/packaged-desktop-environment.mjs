import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { copyVerifiedArtifact } from './artifact-identity.mjs';
import {
  EvidenceValidationError,
  assertBoolean,
  assertEnvironmentRecord,
  assertExactKeys,
  assertFiniteNumber,
  assertProfileSet,
  assertRecord,
  assertSafeInteger,
  assertString,
  canonicalStringify,
} from './performance-contract.mjs';
import { PLATFORM_LIMITS } from './platform-contract.mjs';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEBUG_AUTOMATION_MARKERS = [
  Buffer.from('tauri-plugin-wdio-webdriver'),
  Buffer.from('native-e2e'),
];

export async function preparePackagedDesktopApplication(options) {
  assertRecord(options, 'options');
  assertExactKeys(
    options,
    ['sourcePath', 'destinationRoot', 'provenance', 'platform', 'architecture'],
    'options',
  );
  const provenance = options.provenance;
  const kind = provenance?.artifact?.kind;
  if (['linux-deb', 'linux-rpm'].includes(kind)) {
    throw new EvidenceValidationError(
      'archive package formats are unsupported; use one exact AppImage',
      'options.provenance.artifact.kind',
    );
  }
  if (kind !== 'linux-appimage') {
    throw new EvidenceValidationError(
      'must identify one Linux AppImage',
      'options.provenance.artifact.kind',
    );
  }
  if (options.platform !== 'linux' || options.architecture !== 'x64') {
    throw new EvidenceValidationError(
      'packaged desktop requires a Linux x64 host',
      'options.platform',
    );
  }
  if (provenance.artifact.target !== 'x86_64-linux') {
    throw new EvidenceValidationError(
      'must target x86_64-linux',
      'options.provenance.artifact.target',
    );
  }

  const destinationRoot = resolve(
    assertString(options.destinationRoot, 1, 4_096, 'options.destinationRoot'),
  );
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const rootStats = await lstat(destinationRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new EvidenceValidationError(
      'owned destination root must be a directory and not a symbolic link',
      'options.destinationRoot',
    );
  }
  if ((await realpath(destinationRoot)) !== destinationRoot) {
    throw new EvidenceValidationError(
      'owned destination root must not traverse a symbolic link',
      'options.destinationRoot',
    );
  }

  const ownedRoot = await mkdtemp(
    join(destinationRoot, 'omnia-packaged-desktop-'),
  );
  try {
    const copied = await copyVerifiedArtifact({
      sourcePath: options.sourcePath,
      destinationRoot: ownedRoot,
      provenance,
    });
    await assertReleaseApplicationBytes(copied.path);
    let cleaned = false;
    return {
      ownedRoot,
      packagePath: copied.path,
      applicationPath: copied.path,
      provenance: copied.provenance,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(ownedRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

export function assertExclusivePackagedDesktopProcess(options) {
  assertRecord(options, 'processScope');
  assertExactKeys(
    options,
    ['applicationPath', 'constraintScope', 'processes'],
    'processScope',
  );
  const applicationPath = assertString(
    options.applicationPath,
    1,
    4_096,
    'processScope.applicationPath',
  );
  const constraintScope = assertString(
    options.constraintScope,
    1,
    4_096,
    'processScope.constraintScope',
  );
  if (
    !Array.isArray(options.processes) ||
    options.processes.length > PLATFORM_LIMITS.maximumOwnedResources
  ) {
    throw new EvidenceValidationError(
      `must contain at most ${PLATFORM_LIMITS.maximumOwnedResources} processes`,
      'processScope.processes',
    );
  }

  const matches = [];
  const pids = new Set();
  for (const [index, processRecord] of options.processes.entries()) {
    const path = `processScope.processes[${index}]`;
    assertRecord(processRecord, path);
    assertExactKeys(
      processRecord,
      ['pid', 'executable', 'constraintScope', 'running'],
      path,
    );
    const pid = assertSafeInteger(
      processRecord.pid,
      1,
      2 ** 31 - 1,
      `${path}.pid`,
    );
    if (pids.has(pid)) {
      throw new EvidenceValidationError('contains a duplicate PID', path);
    }
    pids.add(pid);
    assertString(processRecord.executable, 1, 4_096, `${path}.executable`);
    assertString(
      processRecord.constraintScope,
      1,
      4_096,
      `${path}.constraintScope`,
    );
    assertBoolean(processRecord.running, `${path}.running`);
    if (processRecord.executable === applicationPath && processRecord.running) {
      matches.push(processRecord);
    }
  }
  if (matches.length === 0) {
    throw new EvidenceValidationError(
      'application crashed or is not running',
      'processScope.processes',
    );
  }
  if (matches.length !== 1) {
    throw new EvidenceValidationError(
      'must contain exactly one application process',
      'processScope.processes',
    );
  }
  if (matches[0].constraintScope !== constraintScope) {
    throw new EvidenceValidationError(
      'application constraint scope drift detected',
      'processScope.constraintScope',
    );
  }
  return matches[0];
}

export async function launchPackagedDesktopEnvironment(options) {
  assertSessionOptions(options);
  if (await options.endpointAvailable(options.endpoint)) {
    throw new EvidenceValidationError(
      'stale automation endpoint is already available',
      'options.endpoint',
    );
  }

  const transport = await options.start({
    applicationPath: options.applicationPath,
    endpoint: options.endpoint,
  });
  assertTransport(transport);
  let cleanupPromise;

  const session = {
    applicationPid: transport.applicationPid,
    endpoint: options.endpoint,
    async assertRunning() {
      const processRecord = assertExclusivePackagedDesktopProcess({
        applicationPath: options.applicationPath,
        constraintScope: options.constraintScope,
        processes: await transport.observeProcesses(),
      });
      if (processRecord.pid !== transport.applicationPid) {
        throw new EvidenceValidationError(
          'running application PID drift detected',
          'session.applicationPid',
        );
      }
      if (!(await options.endpointAvailable(options.endpoint))) {
        throw new EvidenceValidationError(
          'owned automation endpoint is unavailable',
          'session.endpoint',
        );
      }
      return processRecord;
    },
    async cleanup() {
      cleanupPromise ??= cleanupTransport(options, transport);
      return cleanupPromise;
    },
  };

  try {
    await session.assertRunning();
    return session;
  } catch (error) {
    await session.cleanup().catch(() => undefined);
    throw error;
  }
}

async function cleanupTransport(options, transport) {
  await settleWithin(
    Promise.resolve().then(() => transport.close()),
    options.cleanupTimeoutMs,
  ).catch(() => undefined);
  await settleWithin(
    Promise.resolve().then(() => transport.terminate()),
    options.cleanupTimeoutMs,
  );
  const deadline = Date.now() + options.cleanupTimeoutMs;
  do {
    const processes = await transport.observeProcesses();
    const applicationRunning = processes.some(
      (processRecord) =>
        processRecord.executable === options.applicationPath &&
        processRecord.running === true,
    );
    if (
      !applicationRunning &&
      !(await options.endpointAvailable(options.endpoint))
    ) {
      return;
    }
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('owned packaged-desktop resources survived cleanup');
}

export function createPackagedDesktopEnvironment(options) {
  assertRecord(options, 'options');
  assertExactKeys(
    options,
    ['profileSet', 'profileId', 'git', 'observations'],
    'options',
  );
  const profileSet = assertProfileSet(options.profileSet);
  const profileId = assertString(
    options.profileId,
    1,
    128,
    'options.profileId',
  );
  const profile = profileSet.profiles.find(({ id }) => id === profileId);
  if (!profile || profile.platform !== 'packaged-desktop') {
    throw new EvidenceValidationError(
      'must select one packaged-desktop profile',
      'options.profileId',
    );
  }
  assertRecord(options.git, 'options.git');
  assertExactKeys(options.git, ['commit', 'dirty'], 'options.git');
  const observations = assertPackagedDesktopObservations(options.observations);
  const candidateValues = {
    'artifact.kind': observations.artifact.kind,
    'artifact.sha256': observations.artifact.sha256,
    'artifact.sizeBytes': observations.artifact.sizeBytes,
    'dataset.recipeDigest': profileSet.dataset.recipeDigest,
    'environment.architecture': observations.host.architecture,
    'environment.constraintScope': observations.host.constraintScope,
    'environment.cpuQuota': observations.host.cpuQuota,
    'environment.hostKernel': observations.host.kernel,
    'environment.hostOs': observations.host.operatingSystem,
    'environment.memoryLimitBytes': observations.host.memoryLimitBytes,
    'environment.powerMode': observations.host.powerMode,
    'environment.profileMarker': profileId,
    'runtime.nativeDriverVersion': observations.runtime.nativeDriverVersion,
    'runtime.tauriDriverVersion': observations.runtime.tauriDriverVersion,
    'runtime.webkitVersion': observations.runtime.webkitVersion,
    'runtime.wryVersion': observations.runtime.wryVersion,
    'source.cargoLockSha256': observations.source.cargoLockSha256,
    'source.nodeVersion': observations.source.nodeVersion,
    'source.packageLockSha256': observations.source.packageLockSha256,
  };
  const values = {};
  for (const key of Object.keys(profile.requirements)) {
    if (!Object.hasOwn(candidateValues, key)) {
      throw new EvidenceValidationError(
        'required packaged-desktop identity has no live observation',
        `environment.values.${key}`,
      );
    }
    values[key] = candidateValues[key];
  }
  return assertEnvironmentRecord(
    {
      schemaVersion: 1,
      profileSetId: profileSet.profileSetId,
      profileSetDigest: profileSet.profileSetDigest,
      profileId,
      intent: 'primary',
      availability: 'available',
      unavailableReasons: [],
      git: options.git,
      driver: profile.driver,
      values,
    },
    profileSet,
  );
}

export function assertPackagedDesktopSamplingIdentity(expected, current) {
  if (canonicalStringify(expected) !== canonicalStringify(current)) {
    throw new EvidenceValidationError(
      'packaged-desktop identity drift detected',
      'environment',
    );
  }
  return current;
}

async function assertReleaseApplicationBytes(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const header = Buffer.alloc(11);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      !header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))
    ) {
      throw new EvidenceValidationError(
        'AppImage must contain the ELF and AppImage type-2 headers',
        'artifact',
      );
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const maximumMarkerBytes = Math.max(
      ...DEBUG_AUTOMATION_MARKERS.map((marker) => marker.byteLength),
    );
    let carry = Buffer.alloc(0);
    let position = 0;
    while (true) {
      const { bytesRead: count } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (count === 0) break;
      const searchable = Buffer.concat([carry, buffer.subarray(0, count)]);
      if (
        DEBUG_AUTOMATION_MARKERS.some((marker) => searchable.includes(marker))
      ) {
        throw new EvidenceValidationError(
          'release artifact contains embedded debug automation',
          'artifact',
        );
      }
      carry = searchable.subarray(
        Math.max(0, searchable.length - maximumMarkerBytes + 1),
      );
      position += count;
    }
  } finally {
    await handle.close();
  }
}

function assertSessionOptions(options) {
  assertRecord(options, 'options');
  assertExactKeys(
    options,
    [
      'applicationPath',
      'endpoint',
      'constraintScope',
      'endpointAvailable',
      'start',
      'cleanupTimeoutMs',
    ],
    'options',
  );
  assertString(options.applicationPath, 1, 4_096, 'options.applicationPath');
  assertLoopbackEndpoint(options.endpoint);
  assertString(options.constraintScope, 1, 4_096, 'options.constraintScope');
  for (const name of ['endpointAvailable', 'start']) {
    if (typeof options[name] !== 'function') {
      throw new EvidenceValidationError(
        'must be a function',
        `options.${name}`,
      );
    }
  }
  assertSafeInteger(
    options.cleanupTimeoutMs,
    1,
    PLATFORM_LIMITS.terminationGraceMs * 10,
    'options.cleanupTimeoutMs',
  );
}

function assertTransport(value) {
  assertRecord(value, 'transport');
  assertExactKeys(
    value,
    ['applicationPid', 'observeProcesses', 'close', 'terminate'],
    'transport',
  );
  assertSafeInteger(
    value.applicationPid,
    1,
    2 ** 31 - 1,
    'transport.applicationPid',
  );
  for (const name of ['observeProcesses', 'close', 'terminate']) {
    if (typeof value[name] !== 'function') {
      throw new EvidenceValidationError(
        'must be a function',
        `transport.${name}`,
      );
    }
  }
}

function assertPackagedDesktopObservations(value) {
  assertRecord(value, 'observations');
  assertExactKeys(
    value,
    ['artifact', 'host', 'runtime', 'source'],
    'observations',
  );
  assertRecord(value.artifact, 'observations.artifact');
  assertExactKeys(
    value.artifact,
    ['kind', 'sizeBytes', 'sha256'],
    'observations.artifact',
  );
  if (value.artifact.kind !== 'linux-appimage') {
    throw new EvidenceValidationError(
      'must be linux-appimage',
      'observations.artifact.kind',
    );
  }
  assertSafeInteger(
    value.artifact.sizeBytes,
    1,
    1024 * 1024 * 1024,
    'observations.artifact.sizeBytes',
  );
  assertDigest(value.artifact.sha256, 'observations.artifact.sha256');

  assertRecord(value.host, 'observations.host');
  assertExactKeys(
    value.host,
    [
      'operatingSystem',
      'kernel',
      'architecture',
      'constraintScope',
      'cpuQuota',
      'memoryLimitBytes',
      'powerMode',
    ],
    'observations.host',
  );
  if (
    value.host.operatingSystem !== 'linux' ||
    value.host.architecture !== 'x64'
  ) {
    throw new EvidenceValidationError(
      'must identify a Linux x64 host',
      'observations.host',
    );
  }
  for (const key of ['kernel', 'constraintScope', 'powerMode']) {
    assertString(value.host[key], 1, 512, `observations.host.${key}`);
  }
  assertFiniteNumber(
    value.host.cpuQuota,
    0.01,
    1_024,
    'observations.host.cpuQuota',
  );
  assertSafeInteger(
    value.host.memoryLimitBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    'observations.host.memoryLimitBytes',
  );

  assertRecord(value.runtime, 'observations.runtime');
  assertExactKeys(
    value.runtime,
    [
      'wryVersion',
      'webkitVersion',
      'tauriDriverVersion',
      'nativeDriverVersion',
    ],
    'observations.runtime',
  );
  for (const key of Object.keys(value.runtime)) {
    assertString(value.runtime[key], 1, 256, `observations.runtime.${key}`);
  }

  assertRecord(value.source, 'observations.source');
  assertExactKeys(
    value.source,
    ['nodeVersion', 'packageLockSha256', 'cargoLockSha256'],
    'observations.source',
  );
  assertString(
    value.source.nodeVersion,
    1,
    128,
    'observations.source.nodeVersion',
  );
  assertDigest(
    value.source.packageLockSha256,
    'observations.source.packageLockSha256',
  );
  assertDigest(
    value.source.cargoLockSha256,
    'observations.source.cargoLockSha256',
  );
  return value;
}

function assertLoopbackEndpoint(value) {
  const endpoint = new URL(assertString(value, 1, 2_048, 'options.endpoint'));
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.port
  ) {
    throw new EvidenceValidationError(
      'must be one explicit HTTP loopback endpoint',
      'options.endpoint',
    );
  }
}

function assertDigest(value, path) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new EvidenceValidationError('must be a SHA-256 digest', path);
  }
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
