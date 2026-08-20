import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import {
  EvidenceValidationError,
  assertEnvironmentRecord,
  assertEvidenceOutputName,
  assertProfileSet,
  atomicWriteEvidence,
  canonicalStringify,
} from './performance-contract.mjs';
import { evaluateRawResult } from './performance-evidence.mjs';
import { PLATFORM_LIMITS } from './platform-contract.mjs';
import { evaluatePreflight } from './profile-preflight.mjs';

export class PlatformQualificationError extends Error {
  constructor(profileId, preflight) {
    super(
      `${profileId} is not qualified for primary measurement: ${preflight.status}`,
    );
    this.name = 'PlatformQualificationError';
    this.preflight = preflight;
  }
}

export class PlatformProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PlatformProcessError';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
    this.timedOut = details.timedOut === true;
    this.aborted = details.aborted === true;
    this.childPid = details.childPid ?? null;
  }
}

export async function runQualifiedPlatformLifecycle(options) {
  assertOptions(options);
  const {
    expectedProfileId,
    resultsRoot,
    outputName,
    launch,
    recapture,
    measure,
    cleanup,
    signal,
  } = options;
  const profileSet = assertProfileSet(options.profileSet);
  const environment = assertEnvironmentRecord(options.environment, profileSet);
  assertEvidenceOutputName(outputName);
  if (environment.profileId !== expectedProfileId) {
    throw new EvidenceValidationError(
      `must select ${expectedProfileId}`,
      'options.environment.profileId',
    );
  }
  assertNotAborted(signal);
  const preflight = evaluatePreflight(profileSet, environment);
  if (preflight.status !== 'READY' || preflight.mayMeasure !== true) {
    throw new PlatformQualificationError(expectedProfileId, preflight);
  }

  const context = { profileSet, environment, preflight, signal };
  let session;
  let launchAttempted = false;
  let result;
  let failure;
  let cleanupFailure;
  try {
    launchAttempted = true;
    session = await launch(context);
    assertNotAborted(signal);
    await assertRecapturedEnvironment(
      await recapture({ ...context, session, phase: 'before-sampling' }),
      profileSet,
      environment,
      'before sampling',
    );
    assertNotAborted(signal);
    const rawResult = await measure({ ...context, session });
    assertNotAborted(signal);
    assertRawEnvironment(rawResult, environment);
    await assertRecapturedEnvironment(
      await recapture({ ...context, session, phase: 'after-sampling' }),
      profileSet,
      environment,
      'after sampling',
    );
    assertNotAborted(signal);
    result = evaluateRawResult(profileSet, rawResult);
    if (!['PASS', 'FAIL'].includes(result.disposition)) {
      throw new EvidenceValidationError(
        'qualified primary measurement must evaluate to PASS or FAIL',
        'result.disposition',
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    if (launchAttempted) {
      try {
        await cleanup({ ...context, session, result, failure });
      } catch (error) {
        cleanupFailure = error;
      }
    }
  }

  if (failure && cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      `${messageOf(failure)}; cleanup failed: ${messageOf(cleanupFailure)}`,
    );
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;

  const outputPath = await atomicWriteEvidence(resultsRoot, outputName, result);
  return {
    preflight,
    result,
    outputPath,
    exitCode: result.disposition === 'PASS' ? 0 : 2,
  };
}

export async function runOwnedPlatformProcess(options) {
  assertProcessOptions(options);
  if (options.signal?.aborted) {
    throw new PlatformProcessError('Platform process was aborted', {
      aborted: true,
    });
  }
  const child = spawn(options.command, options.arguments ?? [], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.environmentVariables ?? {}) },
    detached: platform() !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let aborted = false;
  let terminationTimer;
  let settled = false;

  child.stdout.on('data', (chunk) => {
    stdout = appendDiagnostic(stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = appendDiagnostic(stderr, chunk);
  });

  const terminate = (reason) => {
    if (settled || child.exitCode !== null || child.signalCode !== null) return;
    timedOut ||= reason === 'timeout';
    aborted ||= reason === 'abort';
    signalOwnedProcess(child, 'SIGTERM');
    terminationTimer = setTimeout(
      () => signalOwnedProcess(child, 'SIGKILL'),
      PLATFORM_LIMITS.terminationGraceMs,
    );
    terminationTimer.unref?.();
  };
  const timeout = setTimeout(() => terminate('timeout'), options.timeoutMs);
  timeout.unref?.();
  const onAbort = () => terminate('abort');
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    settled = true;
    const details = {
      ...outcome,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      timedOut,
      aborted,
      childPid: child.pid ?? null,
    };
    if (timedOut) {
      throw new PlatformProcessError('Platform process timed out', details);
    }
    if (aborted) {
      throw new PlatformProcessError('Platform process was aborted', details);
    }
    if (outcome.exitCode !== 0) {
      throw new PlatformProcessError(
        `Platform process exited with code ${outcome.exitCode ?? 'null'}`,
        details,
      );
    }
    return details;
  } catch (error) {
    if (error instanceof PlatformProcessError) throw error;
    terminate(options.signal?.aborted ? 'abort' : 'error');
    throw new PlatformProcessError(
      error instanceof Error
        ? `Unable to run platform process: ${error.message}`
        : 'Unable to run platform process',
      {
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        aborted: aborted || options.signal?.aborted === true,
        childPid: child.pid ?? null,
      },
    );
  } finally {
    settled = true;
    clearTimeout(timeout);
    clearTimeout(terminationTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function assertOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  for (const name of ['launch', 'recapture', 'measure', 'cleanup']) {
    if (typeof options[name] !== 'function') {
      throw new EvidenceValidationError(
        'must be a function',
        `options.${name}`,
      );
    }
  }
  if (
    typeof options.expectedProfileId !== 'string' ||
    options.expectedProfileId.length === 0
  ) {
    throw new EvidenceValidationError(
      'must be a non-empty string',
      'options.expectedProfileId',
    );
  }
  assertOptionalSignal(options.signal);
}

function assertProcessOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
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
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > PLATFORM_LIMITS.maximumTimeoutMs
  ) {
    throw new EvidenceValidationError(
      `must be an integer from 1 through ${PLATFORM_LIMITS.maximumTimeoutMs}`,
      'options.timeoutMs',
    );
  }
  if (options.cwd !== undefined && typeof options.cwd !== 'string') {
    throw new EvidenceValidationError('must be a string', 'options.cwd');
  }
  if (options.environmentVariables !== undefined) {
    if (
      !options.environmentVariables ||
      typeof options.environmentVariables !== 'object' ||
      Array.isArray(options.environmentVariables)
    ) {
      throw new EvidenceValidationError(
        'must be an object',
        'options.environmentVariables',
      );
    }
    for (const [name, value] of Object.entries(options.environmentVariables)) {
      if (!name || name.includes('\0') || typeof value !== 'string') {
        throw new EvidenceValidationError(
          'must contain safe string values',
          'options.environmentVariables',
        );
      }
    }
  }
  assertOptionalSignal(options.signal);
}

function assertOptionalSignal(signal) {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new EvidenceValidationError(
      'must be an AbortSignal',
      'options.signal',
    );
  }
}

async function assertRecapturedEnvironment(
  candidate,
  profileSet,
  expected,
  phase,
) {
  assertEnvironmentRecord(candidate, profileSet);
  if (canonicalStringify(candidate) !== canonicalStringify(expected)) {
    throw new EvidenceValidationError(
      `sampling identity drift detected ${phase}`,
      'environment',
    );
  }
}

function assertRawEnvironment(rawResult, environment) {
  if (
    !rawResult ||
    typeof rawResult !== 'object' ||
    Array.isArray(rawResult) ||
    canonicalStringify(rawResult.environment) !==
      canonicalStringify(environment)
  ) {
    throw new EvidenceValidationError(
      'environment changed after preflight',
      'result.environment',
    );
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new PlatformProcessError('Platform lifecycle was aborted', {
      aborted: true,
    });
  }
}

function appendDiagnostic(current, chunk) {
  if (current.byteLength >= PLATFORM_LIMITS.maximumDiagnosticBytes) {
    return current;
  }
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return Buffer.concat([
    current,
    bytes.subarray(
      0,
      PLATFORM_LIMITS.maximumDiagnosticBytes - current.byteLength,
    ),
  ]);
}

function signalOwnedProcess(child, signal) {
  try {
    if (platform() !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
