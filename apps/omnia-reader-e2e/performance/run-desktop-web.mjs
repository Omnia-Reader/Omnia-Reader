import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvidenceValidationError,
  assertEvidenceOutputName,
  atomicWriteEvidence,
  canonicalStringify,
  readJsonFile,
} from './performance-contract.mjs';
import { evaluateRawResult } from './performance-evidence.mjs';
import {
  captureCurrentEnvironment,
  evaluatePreflight,
} from './validate-profile.mjs';
import {
  assertManagementWorkload,
  createManagementWorkload,
} from './management-workload.mjs';

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const TERMINATION_GRACE_MS = 1_000;
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const DEFAULT_PROFILE_PATH = join(
  REPOSITORY_ROOT,
  'specs/001-multi-format-books/performance/profiles-v1.json',
);
const DEFAULT_RESULTS_ROOT = join(
  REPOSITORY_ROOT,
  'specs/001-multi-format-books/performance/results',
);

export class DesktopQualificationError extends Error {
  constructor(preflight) {
    super(
      `desktop-web-v1 is not qualified for primary measurement: ${preflight.status}`,
    );
    this.name = 'DesktopQualificationError';
    this.preflight = preflight;
  }
}

export class MeasurementProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MeasurementProcessError';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
    this.timedOut = details.timedOut === true;
    this.aborted = details.aborted === true;
    this.childPid = details.childPid ?? null;
  }
}

export async function runQualifiedDesktopMeasurement(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  const { profileSet, environment, resultsRoot, outputName, measure } = options;
  assertEvidenceOutputName(outputName);
  if (typeof measure !== 'function') {
    throw new EvidenceValidationError(
      'must be a measurement function',
      'options.measure',
    );
  }
  if (environment?.profileId !== 'desktop-web-v1') {
    throw new EvidenceValidationError(
      'must select desktop-web-v1',
      'options.environment.profileId',
    );
  }

  const preflight = evaluatePreflight(profileSet, environment);
  if (preflight.status !== 'READY' || preflight.mayMeasure !== true) {
    throw new DesktopQualificationError(preflight);
  }

  const rawResult = await measure({ profileSet, environment, preflight });
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
  const result = evaluateRawResult(profileSet, rawResult);
  if (!['PASS', 'FAIL'].includes(result.disposition)) {
    throw new EvidenceValidationError(
      'qualified primary measurement must evaluate to PASS or FAIL',
      'result.disposition',
    );
  }
  const outputPath = await atomicWriteEvidence(resultsRoot, outputName, result);
  return {
    preflight,
    result,
    outputPath,
    exitCode: result.disposition === 'PASS' ? 0 : 2,
  };
}

export async function runDesktopMeasurementProcess(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  const {
    profileSet,
    environment,
    resultsRoot,
    outputName,
    command,
    arguments: arguments_ = [],
    cwd = process.cwd(),
    environmentVariables = {},
    temporaryRoot = tmpdir(),
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
    signal,
    workload,
  } = options;
  if (typeof command !== 'string' || command.length === 0) {
    throw new EvidenceValidationError(
      'must be a non-empty executable path',
      'options.command',
    );
  }
  if (
    !Array.isArray(arguments_) ||
    !arguments_.every((argument) => typeof argument === 'string')
  ) {
    throw new EvidenceValidationError(
      'must contain only strings',
      'options.arguments',
    );
  }
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

  return runQualifiedDesktopMeasurement({
    profileSet,
    environment,
    resultsRoot,
    outputName,
    measure: async () => {
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(
        join(temporaryRoot, 'omnia-desktop-web-'),
      );
      const rawResultPath = join(directory, 'raw-result.json');
      const profilePath = join(directory, 'profile-set.json');
      const environmentPath = join(directory, 'environment.json');
      const workloadPath = join(directory, 'workload.json');
      try {
        await Promise.all([
          writeCanonicalFile(profilePath, profileSet),
          writeCanonicalFile(environmentPath, environment),
          ...(workload === undefined
            ? []
            : [
                writeCanonicalFile(
                  workloadPath,
                  assertManagementWorkload(workload),
                ),
              ]),
        ]);
        await runOwnedMeasurementChild({
          command,
          arguments: arguments_,
          cwd,
          environmentVariables: {
            ...environmentVariables,
            PERFORMANCE_DESKTOP_RAW_RESULT: rawResultPath,
            PERFORMANCE_DESKTOP_PROFILE_SET: profilePath,
            PERFORMANCE_DESKTOP_ENVIRONMENT: environmentPath,
            ...(workload === undefined
              ? {}
              : { PERFORMANCE_DESKTOP_WORKLOAD: workloadPath }),
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

export async function runDesktopWebCli(arguments_) {
  const options = parseDesktopWebCliArguments(arguments_);
  const profileSet = await readJsonFile(options.profilePath);
  const environment = options.environmentPath
    ? await readJsonFile(options.environmentPath)
    : await captureCurrentEnvironment(profileSet, 'desktop-web-v1');
  const workload = createManagementWorkload();
  assertManagementWorkload(workload);
  const controller = new AbortController();
  const onSignal = (signal) => {
    if (!controller.signal.aborted) controller.abort(new Error(signal));
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const outcome = await runDesktopMeasurementProcess({
      profileSet,
      environment,
      workload,
      resultsRoot: options.resultsRoot,
      outputName: options.outputName,
      command: platform() === 'win32' ? 'npx.cmd' : 'npx',
      arguments: [
        'nx',
        'run',
        'omnia-reader-e2e:e2e',
        '--',
        '--project=chromium',
        '--workers=1',
        'performance-management.spec.ts',
      ],
      cwd: REPOSITORY_ROOT,
      environmentVariables: { PERFORMANCE_DESKTOP_WEB: '1' },
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
    });
    process.stdout.write(`${canonicalStringify(outcome.result)}\n`);
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof DesktopQualificationError) {
      process.stdout.write(`${canonicalStringify(error.preflight)}\n`);
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof MeasurementProcessError) {
      if (error.stdout) process.stderr.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
    }
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

async function runOwnedMeasurementChild(options) {
  if (options.signal?.aborted) {
    throw new MeasurementProcessError('Measurement process was aborted', {
      aborted: true,
    });
  }
  const child = spawn(options.command, options.arguments, {
    cwd: options.cwd,
    env: { ...process.env, ...options.environmentVariables },
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
      TERMINATION_GRACE_MS,
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
      throw new MeasurementProcessError(
        'Measurement process timed out',
        details,
      );
    }
    if (aborted) {
      throw new MeasurementProcessError(
        'Measurement process was aborted',
        details,
      );
    }
    if (outcome.exitCode !== 0) {
      throw new MeasurementProcessError(
        `Measurement process exited with code ${outcome.exitCode ?? 'null'}`,
        details,
      );
    }
    return details;
  } catch (error) {
    if (error instanceof MeasurementProcessError) throw error;
    terminate(options.signal?.aborted ? 'abort' : 'error');
    throw new MeasurementProcessError(
      error instanceof Error
        ? `Unable to run measurement process: ${error.message}`
        : 'Unable to run measurement process',
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

function appendDiagnostic(current, chunk) {
  if (current.byteLength >= MAX_DIAGNOSTIC_BYTES) return current;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return Buffer.concat([
    current,
    bytes.subarray(0, MAX_DIAGNOSTIC_BYTES - current.byteLength),
  ]);
}

async function writeCanonicalFile(path, value) {
  await writeFile(path, `${canonicalStringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

export function parseDesktopWebCliArguments(arguments_) {
  const profilePath = DEFAULT_PROFILE_PATH;
  let environmentPath = null;
  const resultsRoot = DEFAULT_RESULTS_ROOT;
  let outputName = 'desktop-web-v1.json';
  let timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !['--environment', '--output', '--timeout-ms'].includes(option) ||
      value === undefined
    ) {
      throw new EvidenceValidationError(
        'usage: run-desktop-web.mjs [--environment <environment.json>] [--output <name.json>] [--timeout-ms <milliseconds>]',
        'arguments',
      );
    }
    if (option === '--environment') environmentPath = resolve(value);
    if (option === '--output') outputName = value;
    if (option === '--timeout-ms') timeoutMs = Number(value);
    index += 1;
  }
  assertEvidenceOutputName(outputName);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 86_400_000
  ) {
    throw new EvidenceValidationError(
      'must be an integer from 1 through 86400000',
      'arguments.timeoutMs',
    );
  }
  return { profilePath, environmentPath, resultsRoot, outputName, timeoutMs };
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runDesktopWebCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown desktop performance driver error';
      process.stdout.write(
        `${canonicalStringify({
          schemaVersion: 1,
          valid: false,
          error: {
            code: 'DESKTOP_DRIVER_ERROR',
            message: message.slice(0, 2_048),
          },
        })}\n`,
      );
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    });
}
