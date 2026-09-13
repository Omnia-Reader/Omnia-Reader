import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertArtifactProvenance } from './artifact-identity.mjs';
import { connectExternalTauriAutomation } from './management-automation.mjs';
import {
  EvidenceValidationError,
  assertEnvironmentRecord,
  assertEvidenceOutputName,
  assertProfileSet,
  canonicalStringify,
  readJsonFile,
} from './performance-contract.mjs';
import {
  createPackagedDesktopEnvironment,
  launchPackagedDesktopEnvironment,
  preparePackagedDesktopApplication,
} from './packaged-desktop-environment.mjs';
import { assertManagementWorkload } from './management-workload.mjs';
import { evaluatePreflight } from './profile-preflight.mjs';
import { captureHostConstraints } from './sampling-identity.mjs';
import {
  PlatformProcessError,
  PlatformQualificationError,
  runOwnedPlatformProcess,
  runQualifiedPlatformLifecycle,
} from './platform-lifecycle.mjs';

const DEFAULT_PROCESS_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const STARTUP_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const MAXIMUM_PROCESS_ENTRIES = 65_536;
const MAXIMUM_DIAGNOSTIC_BYTES = 32 * 1024;
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const DEFAULT_PROFILE_PATH = join(
  REPOSITORY_ROOT,
  'specs/001-multi-format-books/performance/profiles-v2.json',
);
const DEFAULT_RESULTS_ROOT = join(
  REPOSITORY_ROOT,
  'specs/001-multi-format-books/performance/results',
);

export class PackagedDesktopQualificationError extends Error {
  constructor(preflight) {
    super(
      `packaged-desktop-v2 is not qualified for primary measurement: ${preflight.status}`,
    );
    this.name = 'PackagedDesktopQualificationError';
    this.preflight = preflight;
  }
}

export class PackagedDesktopProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PackagedDesktopProcessError';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
    this.timedOut = details.timedOut === true;
    this.aborted = details.aborted === true;
    this.childPid = details.childPid ?? null;
  }
}

class PackagedDesktopUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackagedDesktopUnavailableError';
    this.code = code;
  }
}

export async function runQualifiedPackagedDesktopMeasurement(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  if (options.environment?.profileId !== 'packaged-desktop-v2') {
    throw new EvidenceValidationError(
      'must select packaged-desktop-v2',
      'options.environment.profileId',
    );
  }
  try {
    return await runQualifiedPlatformLifecycle({
      ...options,
      expectedProfileId: 'packaged-desktop-v2',
    });
  } catch (error) {
    if (error instanceof PlatformQualificationError) {
      throw new PackagedDesktopQualificationError(error.preflight);
    }
    throw error;
  }
}

export async function runPackagedDesktopMeasurementProcess(options) {
  assertProcessOptions(options);
  const {
    profileSet,
    environment,
    resultsRoot,
    outputName,
    launch,
    recapture,
    cleanup,
    command,
    arguments: arguments_ = [],
    cwd = process.cwd(),
    environmentVariables = {},
    temporaryRoot = tmpdir(),
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
    signal,
    workload,
  } = options;

  return runQualifiedPackagedDesktopMeasurement({
    profileSet,
    environment,
    resultsRoot,
    outputName,
    launch,
    recapture,
    cleanup,
    signal,
    measure: async ({ session }) => {
      const automation = await assertOwnedAutomationSession(session);
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(
        join(temporaryRoot, 'omnia-packaged-desktop-'),
      );
      const rawResultPath = join(directory, 'raw-result.json');
      const profilePath = join(directory, 'profile-set.json');
      const environmentPath = join(directory, 'environment.json');
      const workloadPath = join(directory, 'workload.json');
      try {
        await Promise.all([
          writeCanonicalFile(profilePath, profileSet),
          writeCanonicalFile(environmentPath, environment),
          writeCanonicalFile(workloadPath, assertManagementWorkload(workload)),
        ]);
        await runPackagedOwnedProcess({
          command,
          arguments: arguments_,
          cwd,
          environmentVariables: {
            ...environmentVariables,
            PERFORMANCE_PACKAGED_DESKTOP_ENDPOINT: automation.endpoint,
            PERFORMANCE_PACKAGED_DESKTOP_SESSION_ID: automation.sessionId,
            PERFORMANCE_PACKAGED_DESKTOP_RAW_RESULT: rawResultPath,
            PERFORMANCE_PACKAGED_DESKTOP_PROFILE_SET: profilePath,
            PERFORMANCE_PACKAGED_DESKTOP_ENVIRONMENT: environmentPath,
            PERFORMANCE_PACKAGED_DESKTOP_WORKLOAD: workloadPath,
          },
          timeoutMs,
          signal,
        });
        return await readJsonFile(rawResultPath);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });
}

export async function runPackagedDesktopSmokeProcess(options) {
  assertSmokeOptions(options);
  const profileSet = assertProfileSet(options.profileSet);
  const environment = assertEnvironmentRecord(options.environment, profileSet);
  if (environment.profileId !== 'packaged-desktop-v2') {
    throw new EvidenceValidationError(
      'must select packaged-desktop-v2',
      'options.environment.profileId',
    );
  }
  const preflight = evaluatePreflight(profileSet, environment);
  if (preflight.status !== 'READY' || preflight.mayMeasure !== true) {
    throw new PackagedDesktopQualificationError(preflight);
  }
  let session;
  let failure;
  let cleanupFailure;
  try {
    assertSignalActive(options.signal);
    session = await options.launch({
      profileSet,
      environment,
      signal: options.signal,
    });
    assertSignalActive(options.signal);
    assertSameEnvironment(
      environment,
      await options.recapture({
        profileSet,
        environment,
        session,
        phase: 'before-smoke',
        signal: options.signal,
      }),
      profileSet,
    );
    if (typeof session?.runSmoke !== 'function') {
      throw new EvidenceValidationError(
        'must expose external-driver smoke',
        'session.runSmoke',
      );
    }
    await session.runSmoke();
    assertSignalActive(options.signal);
    assertSameEnvironment(
      environment,
      await options.recapture({
        profileSet,
        environment,
        session,
        phase: 'after-smoke',
        signal: options.signal,
      }),
      profileSet,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await options.cleanup({
        profileSet,
        environment,
        session,
        failure,
        signal: options.signal,
      });
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (failure && cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      `${failure instanceof Error ? failure.message : failure}; cleanup failed`,
    );
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return {
    preflight,
    marker: {
      schemaVersion: 1,
      status: 'SMOKE_PASS',
      profileSetId: profileSet.profileSetId,
      profileSetDigest: profileSet.profileSetDigest,
      profileId: 'packaged-desktop-v2',
    },
    exitCode: 0,
  };
}

export function parsePackagedDesktopCliArguments(arguments_) {
  const options = {
    profilePath: DEFAULT_PROFILE_PATH,
    resultsRoot: DEFAULT_RESULTS_ROOT,
    outputName: 'packaged-desktop-v2.json',
    timeoutMs: DEFAULT_PROCESS_TIMEOUT_MS,
    artifactPath: process.env['OMNIA_PACKAGED_DESKTOP_ARTIFACT'],
    provenancePath: process.env['OMNIA_PACKAGED_DESKTOP_PROVENANCE'],
    tauriDriverPath: process.env['OMNIA_TAURI_DRIVER'],
    nativeDriverPath: process.env['OMNIA_WEBKIT_WEBDRIVER'],
    driverPort: 4444,
    nativeDriverPort: 4445,
    smoke: false,
  };
  const setters = {
    '--artifact': (value) => (options.artifactPath = resolve(value)),
    '--provenance': (value) => (options.provenancePath = resolve(value)),
    '--tauri-driver': (value) => (options.tauriDriverPath = resolve(value)),
    '--native-driver': (value) => (options.nativeDriverPath = resolve(value)),
    '--driver-port': (value) => (options.driverPort = Number(value)),
    '--native-driver-port': (value) =>
      (options.nativeDriverPort = Number(value)),
    '--output': (value) => (options.outputName = value),
    '--timeout-ms': (value) => (options.timeoutMs = Number(value)),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === '--smoke') {
      options.smoke = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!Object.hasOwn(setters, option) || value === undefined) {
      throw packagedUsageError();
    }
    setters[option](value);
    index += 1;
  }
  assertEvidenceOutputName(options.outputName);
  for (const [name, value, maximum] of [
    ['timeoutMs', options.timeoutMs, 86_400_000],
    ['driverPort', options.driverPort, 65_535],
    ['nativeDriverPort', options.nativeDriverPort, 65_535],
  ]) {
    const minimum = name === 'timeoutMs' ? 1 : 1_024;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new EvidenceValidationError(
        `must be an integer from ${minimum} through ${maximum}`,
        `arguments.${name}`,
      );
    }
  }
  if (options.driverPort === options.nativeDriverPort) {
    throw new EvidenceValidationError(
      'driver and native-driver ports must be distinct',
      'arguments.nativeDriverPort',
    );
  }
  for (const name of [
    'artifactPath',
    'provenancePath',
    'tauriDriverPath',
    'nativeDriverPath',
  ]) {
    const value = options[name];
    if (typeof value === 'string' && value.length > 0) {
      if (value.length > 4_096 || value.includes('\0')) {
        throw new EvidenceValidationError('must be a bounded path', name);
      }
      options[name] = resolve(value);
    }
  }
  return options;
}

export async function runPackagedDesktopCli(arguments_) {
  const options = parsePackagedDesktopCliArguments(arguments_);
  try {
    const profileSet = assertProfileSet(
      await readJsonFile(options.profilePath),
    );
    const profile = profileSet.profiles.find(
      ({ id }) => id === 'packaged-desktop-v2',
    );
    if (!profile) {
      throw new EvidenceValidationError(
        'packaged-desktop-v2 is missing',
        'profileSet.profiles',
      );
    }
    const missing = missingLivePrerequisites(options);
    if (missing.length > 0) {
      return writeUnavailable(
        'PACKAGED_DESKTOP_PREREQUISITE_MISSING',
        `Missing exact packaged-desktop prerequisites: ${missing.join(', ')}`,
      );
    }
    if (platform() !== 'linux' || arch() !== 'x64') {
      return writeUnavailable(
        'PACKAGED_DESKTOP_HOST_UNSUPPORTED',
        `Packaged desktop requires Linux x64; observed ${platform()} ${arch()}`,
      );
    }
    await Promise.all([
      assertRequiredFile(options.artifactPath, 'release artifact'),
      assertRequiredFile(options.provenancePath, 'artifact provenance'),
    ]);
    const provenance = assertArtifactProvenance(
      await readJsonFile(options.provenancePath),
    );
    const git = captureGitState();
    if (provenance.source.commit !== git.commit) {
      throw new EvidenceValidationError(
        'provenance source commit does not match the current checkout',
        'provenance.source.commit',
      );
    }
    const prepared = await preparePackagedDesktopApplication({
      sourcePath: options.artifactPath,
      destinationRoot: tmpdir(),
      provenance,
      platform: platform(),
      architecture: arch(),
    });
    const controller = new AbortController();
    const onSignal = (name) => {
      if (!controller.signal.aborted) controller.abort(new Error(name));
    };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    try {
      const captureEnvironment = async () => {
        const currentGit = captureGitState();
        if (currentGit.commit !== provenance.source.commit) {
          throw new EvidenceValidationError(
            'provenance source commit drift detected',
            'provenance.source.commit',
          );
        }
        return createPackagedDesktopEnvironment({
          profileSet,
          profileId: 'packaged-desktop-v2',
          git: currentGit,
          observations: await capturePackagedDesktopObservations({
            options,
            provenance,
          }),
        });
      };
      const environment = await captureEnvironment();
      const lifecycle = {
        profileSet,
        environment,
        signal: controller.signal,
        launch: () =>
          launchLivePackagedDesktopSession({
            options,
            environment,
            applicationPath: prepared.applicationPath,
          }),
        recapture: async ({ session }) => {
          await session.assertRunning();
          return captureEnvironment();
        },
        cleanup: async ({ session }) => session?.cleanup(),
      };
      if (options.smoke) {
        const outcome = await runPackagedDesktopSmokeProcess(lifecycle);
        process.stdout.write(`${canonicalStringify(outcome.marker)}\n`);
        return outcome.exitCode;
      }
      const preflight = evaluatePreflight(profileSet, environment);
      if (preflight.status !== 'READY' || preflight.mayMeasure !== true) {
        throw new PackagedDesktopQualificationError(preflight);
      }
      return writeUnavailable(
        'PACKAGED_DESKTOP_PRIMARY_RUNNER_UNAVAILABLE',
        'The external-WebDriver primary workload runner is not yet available',
      );
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await prepared.cleanup();
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      error.code === 'ENOENT' &&
      resolve(error.path ?? '') === options.profilePath
    ) {
      return writeUnavailable(
        'PROFILE_SET_MISSING',
        `Reviewed profile set is unavailable at ${options.profilePath}`,
      );
    }
    if (error instanceof PackagedDesktopQualificationError) {
      process.stdout.write(`${canonicalStringify(error.preflight)}\n`);
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof PackagedDesktopUnavailableError) {
      return writeUnavailable(error.code, error.message);
    }
    throw error;
  }
}

async function assertOwnedAutomationSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new EvidenceValidationError(
      'must be an owned automation session',
      'session',
    );
  }
  if (typeof session.assertRunning !== 'function') {
    throw new EvidenceValidationError(
      'must expose assertRunning',
      'session.assertRunning',
    );
  }
  await session.assertRunning();
  const endpoint = assertLoopbackEndpoint(session.endpoint);
  if (
    typeof session.sessionId !== 'string' ||
    session.sessionId.length < 1 ||
    session.sessionId.length > 256 ||
    !/^[A-Za-z0-9._-]+$/.test(session.sessionId)
  ) {
    throw new EvidenceValidationError(
      'must be a bounded WebDriver session id',
      'session.sessionId',
    );
  }
  return { endpoint, sessionId: session.sessionId };
}

function assertProcessOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  assertEvidenceOutputName(options.outputName);
  for (const name of ['launch', 'recapture', 'cleanup']) {
    if (typeof options[name] !== 'function') {
      throw new EvidenceValidationError(
        'must be a function',
        `options.${name}`,
      );
    }
  }
  if (typeof options.command !== 'string' || options.command.length === 0) {
    throw new EvidenceValidationError(
      'must be a non-empty executable path',
      'options.command',
    );
  }
  if (
    options.arguments !== undefined &&
    (!Array.isArray(options.arguments) ||
      !options.arguments.every((argument) => typeof argument === 'string'))
  ) {
    throw new EvidenceValidationError(
      'must contain only strings',
      'options.arguments',
    );
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 86_400_000)
  ) {
    throw new EvidenceValidationError(
      'must be an integer from 1 through 86400000',
      'options.timeoutMs',
    );
  }
}

function assertSmokeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  for (const name of ['launch', 'recapture', 'cleanup']) {
    if (typeof options[name] !== 'function') {
      throw new EvidenceValidationError(
        'must be a function',
        `options.${name}`,
      );
    }
  }
}

function assertSameEnvironment(expected, current, profileSet) {
  const validated = assertEnvironmentRecord(current, profileSet);
  if (canonicalStringify(validated) !== canonicalStringify(expected)) {
    throw new EvidenceValidationError(
      'packaged-desktop identity drift detected',
      'environment',
    );
  }
}

function assertSignalActive(signal) {
  if (signal?.aborted) {
    throw new PackagedDesktopProcessError(
      'Packaged desktop smoke was aborted',
      { aborted: true },
    );
  }
}

function missingLivePrerequisites(options) {
  return [
    ['OMNIA_PACKAGED_DESKTOP_ARTIFACT', options.artifactPath],
    ['OMNIA_PACKAGED_DESKTOP_PROVENANCE', options.provenancePath],
    ['OMNIA_TAURI_DRIVER', options.tauriDriverPath],
    ['OMNIA_WEBKIT_WEBDRIVER', options.nativeDriverPath],
  ]
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([name]) => name);
}

async function capturePackagedDesktopObservations({ options, provenance }) {
  const constraints = await captureHostConstraints({
    readText: (path) => readFile(path, 'utf8'),
    listDirectory: (path) => readdir(path),
  }).catch((error) => {
    throw new PackagedDesktopUnavailableError(
      'PACKAGED_DESKTOP_HOST_CONSTRAINTS_UNAVAILABLE',
      `Exact host constraints are unavailable: ${boundedMessage(error)}`,
    );
  });
  const [tauriDriverVersion, nativeDriverVersion, cargoLock, packageLock] =
    await Promise.all([
      executableVersion(options.tauriDriverPath, 'tauri-driver'),
      executableVersion(options.nativeDriverPath, 'native WebDriver'),
      readFile(join(REPOSITORY_ROOT, 'src-tauri/Cargo.lock')),
      readFile(join(REPOSITORY_ROOT, 'package-lock.json')),
    ]);
  const cargoLockSha256 = sha256Digest(cargoLock);
  const packageLockSha256 = sha256Digest(packageLock);
  if (
    cargoLockSha256 !== provenance.source.cargoLockSha256 ||
    packageLockSha256 !== provenance.source.packageLockSha256 ||
    provenance.toolchain.node !== process.version
  ) {
    throw new EvidenceValidationError(
      'provenance source or Node identity drift detected',
      'provenance.source',
    );
  }
  const wryVersion = cargoPackageVersion(cargoLock.toString('utf8'), 'wry');
  const constraintScope = await readUnifiedCgroup('self');
  return {
    artifact: {
      kind: provenance.artifact.kind,
      sizeBytes: provenance.artifact.sizeBytes,
      sha256: provenance.artifact.sha256,
    },
    host: {
      operatingSystem: platform(),
      kernel: release(),
      architecture: arch(),
      constraintScope,
      cpuQuota: constraints.cpuQuota,
      memoryLimitBytes: constraints.memoryLimitBytes,
      powerMode: constraints.powerMode,
    },
    runtime: {
      wryVersion,
      webkitVersion: semanticVersion(nativeDriverVersion, 'native WebDriver'),
      tauriDriverVersion: semanticVersion(tauriDriverVersion, 'tauri-driver'),
      nativeDriverVersion: semanticVersion(
        nativeDriverVersion,
        'native WebDriver',
      ),
    },
    source: {
      nodeVersion: process.version,
      packageLockSha256,
      cargoLockSha256,
    },
  };
}

async function launchLivePackagedDesktopSession({
  options,
  environment,
  applicationPath,
}) {
  const endpoint = `http://127.0.0.1:${options.driverPort}`;
  const nativeEndpoint = `http://127.0.0.1:${options.nativeDriverPort}`;
  let automation;
  const owned = await launchPackagedDesktopEnvironment({
    applicationPath,
    endpoint,
    constraintScope: environment.values['environment.constraintScope'],
    endpointAvailable,
    cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
    start: async () => {
      if (await endpointAvailable(nativeEndpoint)) {
        throw new EvidenceValidationError(
          'stale native automation endpoint is already available',
          'options.nativeDriverPort',
        );
      }
      const diagnostics = boundedDiagnostics();
      const driver = spawn(
        options.tauriDriverPath,
        [
          '--port',
          String(options.driverPort),
          '--native-port',
          String(options.nativeDriverPort),
          '--native-driver',
          options.nativeDriverPath,
        ],
        {
          cwd: REPOSITORY_ROOT,
          detached: true,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      driver.stdout.on('data', diagnostics.append);
      driver.stderr.on('data', diagnostics.append);
      try {
        await waitForEndpoint(endpoint, driver, diagnostics);
        automation = await connectExternalTauriAutomation({
          endpoint,
          applicationPath,
        });
        const applicationPid = await waitForApplicationPid(applicationPath);
        return {
          applicationPid,
          observeProcesses: () => observeExactApplication(applicationPath),
          close: () => automation.close(),
          terminate: async () => {
            await terminateOwnedProcessGroup(driver);
            if (await endpointAvailable(nativeEndpoint)) {
              throw new Error(
                'Owned native WebDriver endpoint survived cleanup',
              );
            }
          },
        };
      } catch (error) {
        await automation?.close().catch(() => undefined);
        await terminateOwnedProcessGroup(driver).catch(() => undefined);
        throw new Error(
          `${boundedMessage(error)}; owned driver diagnostics: ${diagnostics.value()}`,
          { cause: error },
        );
      }
    },
  });
  return {
    ...owned,
    sessionId: automation.sessionId,
    async runSmoke() {
      await owned.assertRunning();
      await automation.assertLibraryReady();
      const value = `packaged-smoke-${process.pid}`;
      await automation.fill('#library-search', value);
      await automation.waitForScript(
        `const search = document.querySelector('#library-search');
         const empty = [...document.querySelectorAll('h2')]
           .some((heading) => heading.textContent?.trim() === 'No books found');
         return search?.value === arguments[0] && empty;`,
        [value],
        { timeoutMs: 30_000, description: 'packaged library search result' },
      );
      await owned.assertRunning();
    },
  };
}

async function executableVersion(path, label) {
  await assertExecutablePath(path, label);
  const result = spawnSync(path, ['--version'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new PackagedDesktopUnavailableError(
      'PACKAGED_DESKTOP_RUNTIME_VERSION_UNAVAILABLE',
      `${label} version is unavailable: ${boundedMessage(result.error ?? result.stderr)}`,
    );
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!output || output.length > 4_096) {
    throw new EvidenceValidationError('must return one bounded version', label);
  }
  return output;
}

async function assertExecutablePath(path, label) {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path.length > 4_096 ||
    path.includes('\0')
  ) {
    throw new EvidenceValidationError(
      'must be one bounded absolute executable path',
      label,
    );
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new PackagedDesktopUnavailableError(
        'PACKAGED_DESKTOP_PREREQUISITE_MISSING',
        `${label} is unavailable at ${path}`,
      );
    }
    throw error;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o111) === 0 ||
    (await realpath(path)) !== path
  ) {
    throw new EvidenceValidationError(
      'must be a real executable file and not a symbolic link',
      label,
    );
  }
}

async function assertRequiredFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new PackagedDesktopUnavailableError(
        'PACKAGED_DESKTOP_PREREQUISITE_MISSING',
        `${label} is unavailable at ${path}`,
      );
    }
    throw error;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (await realpath(path)) !== path
  ) {
    throw new EvidenceValidationError(
      'must be a real file and not a symbolic link',
      label,
    );
  }
}

function cargoPackageVersion(lock, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `(?:^|\\n)\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "([^"]+)"`,
    'u',
  ).exec(lock);
  if (!match) {
    throw new EvidenceValidationError(
      `must identify ${packageName} in Cargo.lock`,
      'source.cargoLock',
    );
  }
  return semanticVersion(match[1], packageName);
}

function semanticVersion(value, label) {
  const match = String(value).match(
    /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u,
  );
  if (!match) {
    throw new EvidenceValidationError('must contain a semantic version', label);
  }
  return match[0];
}

function captureGitState() {
  const commit = runGit(['rev-parse', 'HEAD']).trim();
  const dirty =
    runGit(['status', '--porcelain', '--untracked-files=normal']).trim()
      .length > 0;
  return { commit, dirty };
}

function runGit(arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new EvidenceValidationError(
      result.stderr?.trim() || 'Git evidence is unavailable',
      'git',
    );
  }
  return result.stdout;
}

async function endpointAvailable(endpoint) {
  try {
    const response = await fetch(`${endpoint}/status`, {
      signal: AbortSignal.timeout(250),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForEndpoint(endpoint, child, diagnostics) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  do {
    if (child.exitCode !== null) {
      throw new Error(
        `tauri-driver exited before startup (${child.exitCode}): ${diagnostics.value()}`,
      );
    }
    if (await endpointAvailable(endpoint)) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for owned tauri-driver at ${endpoint}`);
}

async function waitForApplicationPid(applicationPath) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  do {
    const processes = await observeExactApplication(applicationPath);
    if (processes.length === 1) return processes[0].pid;
    if (processes.length > 1) {
      throw new Error(
        'External WebDriver launched duplicate application processes',
      );
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(
    'Timed out waiting for the exact packaged application process',
  );
}

async function observeExactApplication(applicationPath) {
  const entries = await readdir('/proc');
  if (entries.length > MAXIMUM_PROCESS_ENTRIES) {
    throw new Error('Process table exceeds the bounded scan');
  }
  const processes = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      if ((await readlink(`/proc/${entry}/exe`)) === applicationPath) {
        processes.push({
          pid: Number(entry),
          executable: applicationPath,
          constraintScope: await readUnifiedCgroup(entry),
          running: true,
        });
      }
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !['EACCES', 'ENOENT', 'EPERM'].includes(error.code)
      ) {
        throw error;
      }
    }
  }
  return processes.sort((left, right) => left.pid - right.pid);
}

async function readUnifiedCgroup(pid) {
  const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8');
  const unified = membership
    .split(/\r?\n/u)
    .map((line) => line.split(':'))
    .find(
      ([hierarchy, controllers]) => hierarchy === '0' && controllers === '',
    );
  if (
    !unified ||
    unified.length !== 3 ||
    !unified[2].startsWith('/') ||
    unified[2].length > 4_096 ||
    unified[2].includes('\0')
  ) {
    throw new EvidenceValidationError(
      'requires one bounded unified cgroup-v2 membership',
      'environment.constraintScope',
    );
  }
  return unified[2];
}

async function terminateOwnedProcessGroup(child) {
  if (!child.pid) return;
  signalOwnedProcessGroup(child, 'SIGTERM');
  await childExitedWithin(child, CLEANUP_TIMEOUT_MS / 2);
  signalOwnedProcessGroup(child, 'SIGKILL');
  if (!(await childExitedWithin(child, CLEANUP_TIMEOUT_MS / 2))) {
    throw new Error('Owned tauri-driver process group survived SIGKILL');
  }
}

function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function signalOwnedProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function childExitedWithin(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolvePromise) =>
      child.once('exit', () => resolvePromise(true)),
    ),
    delay(timeoutMs).then(() => false),
  ]);
}

function boundedDiagnostics() {
  let output = '';
  return {
    append(chunk) {
      output = `${output}${String(chunk)}`.slice(-MAXIMUM_DIAGNOSTIC_BYTES);
    },
    value() {
      return output.trim() || '(no output)';
    },
  };
}

function boundedMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_048,
  );
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function runPackagedOwnedProcess(options) {
  try {
    return await runOwnedPlatformProcess(options);
  } catch (error) {
    if (error instanceof PlatformProcessError) {
      throw new PackagedDesktopProcessError(
        error.message
          .replaceAll('Platform process', 'Packaged desktop process')
          .replaceAll('platform process', 'packaged desktop process'),
        error,
      );
    }
    throw error;
  }
}

async function writeCanonicalFile(path, value) {
  await writeFile(path, `${canonicalStringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function assertLoopbackEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new EvidenceValidationError(
      'must be a bounded loopback endpoint',
      'session.endpoint',
    );
  }
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new EvidenceValidationError(
      'must be one explicit HTTP loopback endpoint',
      'session.endpoint',
    );
  }
  return endpoint.origin;
}

function packagedUsageError() {
  return new EvidenceValidationError(
    'usage: run-packaged-desktop.mjs [--smoke] [--artifact <path>] [--provenance <path>] [--tauri-driver <path>] [--native-driver <path>] [--driver-port <port>] [--native-driver-port <port>] [--output <name.json>] [--timeout-ms <milliseconds>]',
    'arguments',
  );
}

function writeUnavailable(code, message) {
  process.stdout.write(
    `${canonicalStringify({
      schemaVersion: 1,
      profileId: 'packaged-desktop-v2',
      status: 'UNVERIFIED',
      mayMeasure: false,
      reasons: [
        {
          code,
          path: 'packaged-desktop',
          message: message.slice(0, 512),
        },
      ],
    })}\n`,
  );
  process.stderr.write(`${message}\n`);
  return 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runPackagedDesktopCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown packaged desktop performance driver error';
      process.stdout.write(
        `${canonicalStringify({
          schemaVersion: 1,
          valid: false,
          error: {
            code: 'PACKAGED_DESKTOP_DRIVER_ERROR',
            message: message.slice(0, 2_048),
          },
        })}\n`,
      );
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    });
}
