import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const LOOPBACK_CDP_ENDPOINT = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/;

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
