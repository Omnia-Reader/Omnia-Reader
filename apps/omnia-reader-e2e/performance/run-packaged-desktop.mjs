import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvidenceValidationError,
  assertEvidenceOutputName,
  canonicalStringify,
  readJsonFile,
} from './performance-contract.mjs';
import { assertManagementWorkload } from './management-workload.mjs';
import {
  PlatformProcessError,
  PlatformQualificationError,
  runOwnedPlatformProcess,
  runQualifiedPlatformLifecycle,
} from './platform-lifecycle.mjs';

const DEFAULT_PROCESS_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
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
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new EvidenceValidationError(
        `must be an integer from 1 through ${maximum}`,
        `arguments.${name}`,
      );
    }
  }
  return options;
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
