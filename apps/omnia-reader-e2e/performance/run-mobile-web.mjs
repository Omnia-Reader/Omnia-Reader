import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  EvidenceValidationError,
  assertEnvironmentRecord,
  assertEvidenceOutputName,
  assertProfileSet,
  canonicalStringify,
  readJsonFile,
} from './performance-contract.mjs';
import {
  assertManagementWorkload,
  createManagementWorkload,
} from './management-workload.mjs';
import { createMobileWebEnvironment } from './mobile-web-environment.mjs';
import { launchMobileWebSession } from './mobile-web-live-session.mjs';
import { evaluatePreflight } from './profile-preflight.mjs';
import {
  PlatformProcessError,
  PlatformQualificationError,
  runOwnedPlatformProcess,
  runQualifiedPlatformLifecycle,
} from './platform-lifecycle.mjs';

const DEFAULT_PROCESS_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const LOOPBACK_CDP_ENDPOINT = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/;
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

export class MobileWebQualificationError extends Error {
  constructor(preflight) {
    super(
      `mobile-web-v2 is not qualified for primary measurement: ${preflight.status}`,
    );
    this.name = 'MobileWebQualificationError';
    this.preflight = preflight;
  }
}

export class MobileWebProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MobileWebProcessError';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
    this.timedOut = details.timedOut === true;
    this.aborted = details.aborted === true;
    this.childPid = details.childPid ?? null;
  }
}

export class MobileWebUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MobileWebUnavailableError';
    this.code = code;
  }
}

export async function runQualifiedMobileWebMeasurement(options) {
  assertMobileLifecycleOptions(options);
  const {
    profileSet,
    environment,
    resultsRoot,
    outputName,
    launch,
    recapture,
    measure,
    cleanup,
    signal,
  } = options;
  assertEvidenceOutputName(outputName);
  if (environment?.profileId !== 'mobile-web-v2') {
    throw new EvidenceValidationError(
      'must select mobile-web-v2',
      'options.environment.profileId',
    );
  }

  try {
    return await runQualifiedPlatformLifecycle({
      profileSet,
      environment,
      expectedProfileId: 'mobile-web-v2',
      resultsRoot,
      outputName,
      launch,
      recapture,
      measure,
      cleanup,
      signal,
    });
  } catch (error) {
    if (error instanceof PlatformQualificationError) {
      throw new MobileWebQualificationError(error.preflight);
    }
    throw error;
  }
}

export async function runMobileWebMeasurementProcess(options) {
  assertMobileProcessOptions(options);
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

  return runQualifiedMobileWebMeasurement({
    profileSet,
    environment,
    resultsRoot,
    outputName,
    signal,
    launch,
    recapture,
    cleanup,
    measure: async ({ session }) => {
      const cdpEndpoint = assertOwnedCdpSession(session);
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(temporaryRoot, 'omnia-mobile-web-'));
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
        await runMobileOwnedProcess({
          command,
          arguments: arguments_,
          cwd,
          environmentVariables: {
            ...environmentVariables,
            PERFORMANCE_MOBILE_CDP_ENDPOINT: cdpEndpoint,
            PERFORMANCE_MOBILE_RAW_RESULT: rawResultPath,
            PERFORMANCE_MOBILE_PROFILE_SET: profilePath,
            PERFORMANCE_MOBILE_ENVIRONMENT: environmentPath,
            PERFORMANCE_MOBILE_WORKLOAD: workloadPath,
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

export async function runMobileWebSmokeProcess(options) {
  assertMobileProcessOptions({ ...options, workload: undefined });
  const profileSet = assertProfileSet(options.profileSet);
  const environment = assertEnvironmentRecord(options.environment, profileSet);
  if (environment.profileId !== 'mobile-web-v2') {
    throw new EvidenceValidationError(
      'must select mobile-web-v2',
      'options.environment.profileId',
    );
  }
  const preflight = evaluatePreflight(profileSet, environment);
  if (preflight.status !== 'READY' || preflight.mayMeasure !== true) {
    throw new MobileWebQualificationError(preflight);
  }
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  let session;
  let failure;
  let cleanupFailure;
  let marker;
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
    const cdpEndpoint = assertOwnedCdpSession(session);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(temporaryRoot, 'omnia-mobile-smoke-'));
    const markerPath = join(directory, 'smoke-result.json');
    try {
      await runMobileOwnedProcess({
        command: options.command,
        arguments: options.arguments ?? [],
        cwd: options.cwd ?? process.cwd(),
        environmentVariables: {
          ...(options.environmentVariables ?? {}),
          PERFORMANCE_MOBILE_CDP_ENDPOINT: cdpEndpoint,
          PERFORMANCE_MOBILE_SMOKE_RESULT: markerPath,
          PERFORMANCE_MOBILE_PROFILE_SET_ID: profileSet.profileSetId,
          PERFORMANCE_MOBILE_PROFILE_SET_DIGEST: profileSet.profileSetDigest,
        },
        timeoutMs: options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
        signal: options.signal,
      });
      marker = await readJsonFile(markerPath);
      assertSmokeMarker(marker, profileSet);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
  return { preflight, marker, exitCode: 0 };
}

export async function runMobileWebCli(arguments_) {
  const options = parseMobileWebCliArguments(arguments_);
  let profileSet;
  try {
    profileSet = assertProfileSet(await readJsonFile(options.profilePath));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return writeUnavailable(
        'PROFILE_SET_MISSING',
        `Reviewed profile set is unavailable at ${options.profilePath}`,
      );
    }
    throw error;
  }
  const profile = profileSet.profiles.find(({ id }) => id === 'mobile-web-v2');
  if (!profile) {
    throw new EvidenceValidationError(
      'mobile-web-v2 is missing',
      'profileSet.profiles',
    );
  }
  const git = captureGitState();
  const environment = assertEnvironmentRecord(
    {
      schemaVersion: 1,
      profileSetId: profileSet.profileSetId,
      profileSetDigest: profileSet.profileSetDigest,
      profileId: profile.id,
      intent: 'primary',
      availability: 'available',
      unavailableReasons: [],
      git,
      driver: profile.driver,
      values: { ...profile.requirements },
    },
    profileSet,
  );
  const configuration = resolveLiveConfiguration(options, environment);
  const workload = createManagementWorkload();
  const controller = new AbortController();
  const onSignal = (name) => {
    if (!controller.signal.aborted) controller.abort(new Error(name));
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const lifecycle = {
      profileSet,
      environment,
      temporaryRoot: configuration.temporaryRoot,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      command: platform() === 'win32' ? 'npx.cmd' : 'npx',
      cwd: REPOSITORY_ROOT,
      launch: () =>
        launchMobileWebSession({
          configuration,
          environment,
          signal: controller.signal,
        }),
      recapture: async ({ session }) => {
        session.assertRunning();
        const observations = await session.captureObservations();
        return createMobileWebEnvironment({
          profileSet,
          profileId: 'mobile-web-v2',
          git: captureGitState(),
          observations,
        });
      },
      cleanup: async ({ session }) => session?.cleanup(),
    };
    if (options.smoke) {
      const outcome = await runMobileWebSmokeProcess({
        ...lifecycle,
        arguments: playwrightArguments('performance-mobile-web-smoke.spec.ts'),
        environmentVariables: {
          PERFORMANCE_MOBILE_WEB_SMOKE: '1',
          PERFORMANCE_MOBILE_APPLICATION_URL: `http://127.0.0.1:${configuration.applicationPort}`,
        },
      });
      process.stdout.write(`${canonicalStringify(outcome.marker)}\n`);
      return outcome.exitCode;
    }
    const outcome = await runMobileWebMeasurementProcess({
      ...lifecycle,
      workload,
      resultsRoot: options.resultsRoot,
      outputName: options.outputName,
      arguments: playwrightArguments('performance-mobile-web.spec.ts'),
      environmentVariables: {
        PERFORMANCE_MOBILE_WEB: '1',
        PERFORMANCE_MOBILE_APPLICATION_URL: `http://127.0.0.1:${configuration.applicationPort}`,
      },
    });
    process.stdout.write(`${canonicalStringify(outcome.result)}\n`);
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof MobileWebQualificationError) {
      process.stdout.write(`${canonicalStringify(error.preflight)}\n`);
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof MobileWebUnavailableError) {
      return writeUnavailable(error.code, error.message);
    }
    if (error instanceof MobileWebProcessError) {
      if (error.stdout) process.stderr.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
    }
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

export function parseMobileWebCliArguments(arguments_) {
  const options = {
    profilePath: DEFAULT_PROFILE_PATH,
    resultsRoot: DEFAULT_RESULTS_ROOT,
    outputName: 'mobile-web-v2.json',
    timeoutMs: DEFAULT_PROCESS_TIMEOUT_MS,
    sdkRoot: process.env['ANDROID_SDK_ROOT'] ?? process.env['ANDROID_HOME'],
    baselineDirectory: process.env['OMNIA_PERFORMANCE_AVD_BASELINE'],
    avdName: process.env['OMNIA_PERFORMANCE_AVD_NAME'],
    snapshotName: process.env['OMNIA_PERFORMANCE_AVD_SNAPSHOT'],
    emulatorPort: undefined,
    applicationPort: 4200,
    cdpPort: 9222,
    smoke: false,
  };
  const setters = {
    '--sdk-root': (value) => (options.sdkRoot = value),
    '--avd-baseline': (value) => (options.baselineDirectory = value),
    '--avd-name': (value) => (options.avdName = value),
    '--snapshot': (value) => (options.snapshotName = value),
    '--emulator-port': (value) => (options.emulatorPort = Number(value)),
    '--application-port': (value) => (options.applicationPort = Number(value)),
    '--cdp-port': (value) => (options.cdpPort = Number(value)),
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
      throw mobileUsageError();
    }
    setters[option](value);
    index += 1;
  }
  assertEvidenceOutputName(options.outputName);
  for (const [name, value] of [
    ['timeoutMs', options.timeoutMs],
    ['applicationPort', options.applicationPort],
    ['cdpPort', options.cdpPort],
  ]) {
    const maximum = name === 'timeoutMs' ? 86_400_000 : 65_535;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new EvidenceValidationError(
        `must be an integer from 1 through ${maximum}`,
        `arguments.${name}`,
      );
    }
  }
  if (
    options.emulatorPort !== undefined &&
    (!Number.isSafeInteger(options.emulatorPort) ||
      options.emulatorPort < 5_554 ||
      options.emulatorPort > 5_682 ||
      options.emulatorPort % 2 !== 0)
  ) {
    throw new EvidenceValidationError(
      'must be an even emulator port from 5554 through 5682',
      'arguments.emulatorPort',
    );
  }
  return options;
}

function resolveLiveConfiguration(options, environment) {
  const missing = [];
  const sdkRoot = boundedOptional(options.sdkRoot, 'ANDROID_SDK_ROOT', missing);
  const baselineDirectory = boundedOptional(
    options.baselineDirectory,
    'OMNIA_PERFORMANCE_AVD_BASELINE',
    missing,
  );
  const avdName = options.avdName ?? environment.values['environment.avdName'];
  const snapshotName =
    options.snapshotName ?? environment.values['environment.avdSnapshotName'];
  const expectedSerial = environment.values['environment.emulatorSerial'];
  const expectedPort =
    typeof expectedSerial === 'string'
      ? Number(/^emulator-(\d{4})$/.exec(expectedSerial)?.[1])
      : Number.NaN;
  const emulatorPort = options.emulatorPort ?? expectedPort;
  if (missing.length > 0) {
    throw new MobileWebUnavailableError(
      'MOBILE_WEB_PREREQUISITE_MISSING',
      `Missing exact mobile-web prerequisites: ${missing.join(', ')}`,
    );
  }
  return {
    sdkRoot,
    repositoryRoot: REPOSITORY_ROOT,
    avdName,
    baselineDirectory,
    snapshotName,
    emulatorPort,
    applicationPort: options.applicationPort,
    cdpPort: options.cdpPort,
    temporaryRoot: tmpdir(),
  };
}

function boundedOptional(value, name, missing) {
  if (typeof value !== 'string' || value.length === 0) {
    missing.push(name);
    return '';
  }
  if (value.length > 4_096 || value.includes('\0')) {
    throw new EvidenceValidationError('must be a bounded path', name);
  }
  return resolve(value);
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
    shell: false,
  });
  if (result.status !== 0) {
    throw new EvidenceValidationError(
      result.stderr.trim() || 'Git evidence is unavailable',
      'git',
    );
  }
  return result.stdout;
}

function writeUnavailable(code, message) {
  process.stdout.write(
    `${canonicalStringify({
      schemaVersion: 1,
      profileId: 'mobile-web-v2',
      status: 'UNVERIFIED',
      mayMeasure: false,
      reasons: [{ code, path: 'mobile-web', message: message.slice(0, 512) }],
    })}\n`,
  );
  process.stderr.write(`${message}\n`);
  return 1;
}

function mobileUsageError() {
  return new EvidenceValidationError(
    'usage: run-mobile-web.mjs [--smoke] [--sdk-root <path>] [--avd-baseline <path>] [--avd-name <name>] [--snapshot <name>] [--emulator-port <port>] [--application-port <port>] [--cdp-port <port>] [--output <name.json>] [--timeout-ms <milliseconds>]',
    'arguments',
  );
}

function playwrightArguments(specification) {
  return [
    'playwright',
    'test',
    '--config',
    'apps/omnia-reader-e2e/playwright.config.ts',
    '--project=chromium',
    '--workers=1',
    specification,
  ];
}

function assertMobileLifecycleOptions(options) {
  assertRecordOptions(options);
  for (const name of ['launch', 'recapture', 'measure', 'cleanup']) {
    if (typeof options[name] !== 'function') {
      throw new EvidenceValidationError(
        'must be a function',
        `options.${name}`,
      );
    }
  }
}

function assertMobileProcessOptions(options) {
  assertRecordOptions(options);
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 86_400_000
  ) {
    throw new EvidenceValidationError(
      'must be an integer from 1 through 86400000',
      'options.timeoutMs',
    );
  }
}

function assertRecordOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
}

function assertOwnedCdpSession(session) {
  if (
    !session ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    typeof session.cdpEndpoint !== 'string' ||
    !LOOPBACK_CDP_ENDPOINT.test(session.cdpEndpoint)
  ) {
    throw new EvidenceValidationError(
      'must expose one owned loopback CDP endpoint',
      'session.cdpEndpoint',
    );
  }
  const port = Number(new URL(session.cdpEndpoint).port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new EvidenceValidationError(
      'must use a valid loopback TCP port',
      'session.cdpEndpoint',
    );
  }
  return session.cdpEndpoint;
}

function assertSameEnvironment(expected, current, profileSet) {
  const validated = assertEnvironmentRecord(current, profileSet);
  if (canonicalStringify(validated) !== canonicalStringify(expected)) {
    throw new EvidenceValidationError(
      'mobile-web identity drift detected',
      'environment',
    );
  }
}

function assertSmokeMarker(value, profileSet) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'profileId,profileSetDigest,profileSetId,schemaVersion,status' ||
    value.schemaVersion !== 1 ||
    value.status !== 'SMOKE_PASS' ||
    value.profileSetId !== profileSet.profileSetId ||
    value.profileSetDigest !== profileSet.profileSetDigest ||
    value.profileId !== 'mobile-web-v2'
  ) {
    throw new EvidenceValidationError(
      'must match the qualified mobile smoke session',
      'smokeResult',
    );
  }
}

function assertSignalActive(signal) {
  if (signal?.aborted) {
    throw new MobileWebProcessError('Mobile web smoke was aborted', {
      aborted: true,
    });
  }
}

async function runMobileOwnedProcess(options) {
  try {
    return await runOwnedPlatformProcess(options);
  } catch (error) {
    if (error instanceof PlatformProcessError) {
      throw new MobileWebProcessError(
        error.message
          .replaceAll('Platform process', 'Mobile web process')
          .replaceAll('platform process', 'mobile web process'),
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runMobileWebCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown mobile performance driver error';
      process.stdout.write(
        `${canonicalStringify({
          schemaVersion: 1,
          valid: false,
          error: {
            code: 'MOBILE_WEB_DRIVER_ERROR',
            message: message.slice(0, 2_048),
          },
        })}\n`,
      );
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    });
}
