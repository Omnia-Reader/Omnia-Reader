import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import {
  SerialScopedAdb,
  assertExclusiveEmulatorDevices,
  emulatorSerialForPort,
  prepareDisposableAvd,
} from './android-emulator-controller.mjs';
import {
  EvidenceValidationError,
  canonicalStringify,
} from './performance-contract.mjs';
import { captureMobileWebObservations } from './mobile-web-environment.mjs';
import { PLATFORM_LIMITS } from './platform-contract.mjs';
import { runOwnedPlatformProcess } from './platform-lifecycle.mjs';
import { captureHostConstraints } from './sampling-identity.mjs';

const COMMAND_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 180_000;
const CDP_TIMEOUT_MS = 30_000;
const APK_MAXIMUM_BYTES = 1024 * 1024 * 1024;
const AVD_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export async function launchMobileWebSession(options) {
  assertSessionOptions(options);
  const { configuration, environment, signal } = options;
  const dependencies = {
    captureConstraints: () =>
      captureHostConstraints({
        readText: (path) => readFile(path, 'utf8'),
        listDirectory: (path) => readdir(path),
      }),
    packageLockSha256: () =>
      sha256File(join(configuration.repositoryRoot, 'package-lock.json')),
    fetchCdpVersion: (endpoint) => fetchCdpVersion(endpoint, signal),
    hashChromeApks: (adbPath, serial, paths) =>
      hashChromeApks(adbPath, serial, paths, signal),
    ...(options.dependencies ?? {}),
  };
  const values = environment.values;
  const serial = emulatorSerialForPort(configuration.emulatorPort);
  requireEqual(serial, values['environment.emulatorSerial'], 'emulator serial');
  requireEqual(
    configuration.avdName,
    values['environment.avdName'],
    'AVD name',
  );
  requireEqual(
    configuration.snapshotName,
    values['environment.avdSnapshotName'],
    'AVD snapshot name',
  );

  const sdkRoot = resolve(configuration.sdkRoot);
  const adbPath = join(sdkRoot, 'platform-tools', executableName('adb'));
  const emulatorPath = join(sdkRoot, 'emulator', executableName('emulator'));
  const run = (command, arguments_) =>
    runTextCommand(command, arguments_, signal);
  const preexisting = await run(adbPath, ['devices', '-l']);
  assertNoEmulatorDevices(preexisting.stdout);
  const prepared = await prepareDisposableAvd({
    avdName: configuration.avdName,
    baselineDirectory: configuration.baselineDirectory,
    expectedDigest: requiredString(
      values['environment.avdSnapshotSha256'],
      'environment.avdSnapshotSha256',
    ),
    temporaryRoot: configuration.temporaryRoot,
  });

  let emulator;
  let adb;
  try {
    const versionResult = await run(emulatorPath, ['-version']);
    const emulatorVersion = parseEmulatorVersion(versionResult.stdout);
    emulator = await startOwnedEmulator({
      emulatorPath,
      avdHome: prepared.avdHome,
      avdName: configuration.avdName,
      snapshotName: configuration.snapshotName,
      port: configuration.emulatorPort,
      signal,
    });
    adb = new SerialScopedAdb({ adbPath, serial, run });
    await waitForBoot(adb, emulator, signal);
    const devices = await run(adbPath, ['devices', '-l']);
    assertExclusiveEmulatorDevices(devices.stdout, serial);
    await configureGuest(adb);
    await adb.reverse(
      `tcp:${configuration.applicationPort}`,
      `tcp:${configuration.applicationPort}`,
    );
    await adb.forward(
      `tcp:${configuration.cdpPort}`,
      'localabstract:chrome_devtools_remote',
    );
    await launchChrome(adb, configuration.applicationPort);
    const cdpEndpoint = `http://127.0.0.1:${configuration.cdpPort}`;
    await waitForCdp(cdpEndpoint, signal, dependencies.fetchCdpVersion);

    const captureObservations = async () => {
      const constraints = await dependencies.captureConstraints();
      return captureMobileWebObservations({
        adb,
        staticIdentity: {
          avdName: configuration.avdName,
          avdImage: requiredString(
            values['environment.avdImage'],
            'environment.avdImage',
          ),
          avdSnapshotName: configuration.snapshotName,
          avdSnapshotSha256: prepared.manifest.digest,
          emulatorVersion,
          deviceClass: requiredString(
            values['environment.device'],
            'environment.device',
          ),
          resources: {
            cpuQuota: constraints.cpuQuota,
            memoryLimitBytes: constraints.memoryLimitBytes,
          },
          source: {
            nodeVersion: process.version,
            packageLockSha256: await dependencies.packageLockSha256(),
          },
        },
        fetchCdpVersion: () => dependencies.fetchCdpVersion(cdpEndpoint),
        hashChromeApks: (paths) =>
          dependencies.hashChromeApks(adbPath, serial, paths),
      });
    };
    let closed = false;
    return {
      cdpEndpoint,
      serial,
      captureObservations,
      assertRunning: () => emulator.assertRunning(),
      cleanup: async () => {
        if (closed) return;
        closed = true;
        const failures = [];
        try {
          await adb.cleanup();
        } catch (error) {
          failures.push(error);
        }
        try {
          await emulator.terminate();
        } catch (error) {
          failures.push(error);
        }
        try {
          await rm(prepared.avdHome, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Unable to clean the owned mobile-web session',
          );
        }
      },
    };
  } catch (error) {
    const failures = [error];
    if (adb) {
      try {
        await adb.cleanup();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (emulator) {
      try {
        await emulator.terminate();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    try {
      await rm(prepared.avdHome, { recursive: true, force: true });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'Mobile-web launch and cleanup failed');
  }
}

export function mobileEmulatorArguments(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'emulator.options');
  }
  for (const key of ['avdName', 'snapshotName']) {
    if (
      typeof options[key] !== 'string' ||
      !AVD_TOKEN_PATTERN.test(options[key])
    ) {
      throw new EvidenceValidationError(
        'must be a bounded AVD token',
        `emulator.${key}`,
      );
    }
  }
  emulatorSerialForPort(options.port);
  return [
    '-avd',
    options.avdName,
    '-port',
    String(options.port),
    '-snapshot',
    options.snapshotName,
    '-no-snapshot-save',
    '-no-boot-anim',
    '-no-audio',
    '-no-window',
  ];
}

async function configureGuest(adb) {
  await adb.shell(['dumpsys', 'battery', 'unplug']);
  await adb.shell(['dumpsys', 'battery', 'set', 'level', '75']);
  await adb.shell(['settings', 'put', 'global', 'low_power', '0']);
  await adb.shell(['settings', 'put', 'global', 'airplane_mode_on', '1']);
  await adb.shell([
    'am',
    'broadcast',
    '-a',
    'android.intent.action.AIRPLANE_MODE',
    '--ez',
    'state',
    'true',
  ]);
  await adb.shell(['svc', 'wifi', 'disable']);
}

async function launchChrome(adb, applicationPort) {
  await adb.shell(['am', 'force-stop', 'com.android.chrome']);
  await adb.shell([
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `http://127.0.0.1:${applicationPort}`,
    'com.android.chrome',
  ]);
}

async function waitForBoot(adb, emulator, signal) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    assertNotAborted(signal);
    emulator.assertRunning();
    try {
      const result = await adb.shell(['getprop', 'sys.boot_completed']);
      if (result.stdout.trim() === '1') return;
    } catch (error) {
      lastError = error;
    }
    await delay(500, signal);
  }
  throw new EvidenceValidationError(
    `emulator boot timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
    'emulator.boot',
  );
}

async function waitForCdp(endpoint, signal, fetchVersion) {
  const deadline = Date.now() + CDP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    assertNotAborted(signal);
    try {
      await fetchVersion(endpoint);
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(250, signal);
  }
  throw new EvidenceValidationError(
    `Chrome CDP timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
    'chrome.cdp',
  );
}

async function fetchCdpVersion(endpoint, signal) {
  const response = await fetch(`${endpoint}/json/version`, {
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(5_000),
    ]),
  });
  if (!response.ok) {
    throw new EvidenceValidationError(
      `CDP version endpoint returned ${response.status}`,
      'chrome.cdp',
    );
  }
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvidenceValidationError(
      'CDP version response must be an object',
      'chrome.cdp',
    );
  }
  return {
    browser: requiredString(value.Browser, 'chrome.cdp.Browser'),
    protocolVersion: requiredString(
      value['Protocol-Version'],
      'chrome.cdp.Protocol-Version',
    ),
  };
}

async function hashChromeApks(adbPath, serial, paths, signal) {
  const descriptors = [];
  let totalBytes = 0;
  for (const path of paths) {
    const descriptor = await hashAdbFile(adbPath, serial, path, signal);
    totalBytes += descriptor.sizeBytes;
    if (totalBytes > APK_MAXIMUM_BYTES) {
      throw new EvidenceValidationError(
        'Chrome APK bytes exceed the aggregate limit',
        'chrome.apks',
      );
    }
    descriptors.push({ path, ...descriptor });
  }
  return `sha256:${createHash('sha256')
    .update(canonicalStringify(descriptors), 'utf8')
    .digest('hex')}`;
}

function hashAdbFile(adbPath, serial, path, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(adbPath, ['-s', serial, 'exec-out', 'cat', path], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const digest = createHash('sha256');
    let sizeBytes = 0;
    let stderr = Buffer.alloc(0);
    const timeout = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      sizeBytes += chunk.length;
      if (sizeBytes > APK_MAXIMUM_BYTES) child.kill('SIGKILL');
      else digest.update(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendDiagnostic(stderr, chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        rejectPromise(new Error('Chrome APK hashing was aborted'));
      } else if (sizeBytes > APK_MAXIMUM_BYTES) {
        rejectPromise(
          new EvidenceValidationError(
            'Chrome APK exceeds the byte limit',
            'chrome.apks',
          ),
        );
      } else if (exitCode !== 0) {
        rejectPromise(
          new EvidenceValidationError(
            stderr.toString('utf8') || `ADB exited with code ${exitCode}`,
            'chrome.apks',
          ),
        );
      } else {
        resolvePromise({
          sizeBytes,
          sha256: `sha256:${digest.digest('hex')}`,
        });
      }
    });
  });
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function runTextCommand(command, arguments_, signal) {
  const result = await runOwnedPlatformProcess({
    command,
    arguments: arguments_,
    timeoutMs: COMMAND_TIMEOUT_MS,
    signal,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
}

async function startOwnedEmulator(options) {
  const child = spawn(options.emulatorPath, mobileEmulatorArguments(options), {
    detached: platform() !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ANDROID_AVD_HOME: options.avdHome },
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outcome;
  child.stdout.on('data', (chunk) => {
    stdout = appendDiagnostic(stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = appendDiagnostic(stderr, chunk);
  });
  const closed = new Promise((resolvePromise) => {
    child.once('close', (exitCode, closeSignal) => {
      outcome = { exitCode, signal: closeSignal };
      resolvePromise(outcome);
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    child.once('spawn', resolvePromise);
    child.once('error', rejectPromise);
  });
  let terminated = false;
  const terminate = async () => {
    if (terminated) return;
    terminated = true;
    if (!outcome) signalProcess(child, 'SIGTERM');
    await Promise.race([closed, delay(PLATFORM_LIMITS.terminationGraceMs)]);
    if (!outcome) signalProcess(child, 'SIGKILL');
    await closed;
  };
  const onAbort = () => void terminate();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  return {
    assertRunning() {
      if (outcome) {
        throw new EvidenceValidationError(
          `emulator exited with ${outcome.exitCode ?? outcome.signal}: ${stderr.toString('utf8') || stdout.toString('utf8')}`,
          'emulator.process',
        );
      }
    },
    async terminate() {
      options.signal?.removeEventListener('abort', onAbort);
      await terminate();
    },
  };
}

function assertNoEmulatorDevices(output) {
  const serials = output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((serial) => serial?.startsWith('emulator-'));
  if (serials.length > 0) {
    throw new EvidenceValidationError(
      `foreign emulator devices are present: ${serials.join(', ')}`,
      'adb.devices',
    );
  }
}

function parseEmulatorVersion(output) {
  const version = /Android emulator version ([0-9]+(?:\.[0-9]+){2,3})/.exec(
    output,
  )?.[1];
  return requiredString(version, 'runtime.emulatorVersion');
}

function assertSessionOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  if (
    !options.configuration ||
    typeof options.configuration !== 'object' ||
    Array.isArray(options.configuration)
  ) {
    throw new EvidenceValidationError(
      'must be an object',
      'options.configuration',
    );
  }
  if (
    !options.environment ||
    typeof options.environment !== 'object' ||
    !options.environment.values
  ) {
    throw new EvidenceValidationError(
      'must contain environment values',
      'options.environment',
    );
  }
  if (options.dependencies !== undefined) {
    const dependencies = options.dependencies;
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies)
    ) {
      throw new EvidenceValidationError(
        'must be an object',
        'options.dependencies',
      );
    }
    const allowed = new Set([
      'captureConstraints',
      'packageLockSha256',
      'fetchCdpVersion',
      'hashChromeApks',
    ]);
    for (const [name, value] of Object.entries(dependencies)) {
      if (!allowed.has(name) || typeof value !== 'function') {
        throw new EvidenceValidationError(
          'must contain only supported probe functions',
          `options.dependencies.${name}`,
        );
      }
    }
  }
  for (const key of [
    'sdkRoot',
    'repositoryRoot',
    'avdName',
    'baselineDirectory',
    'snapshotName',
    'temporaryRoot',
  ]) {
    requiredString(options.configuration[key], `configuration.${key}`);
  }
  for (const key of ['avdName', 'snapshotName']) {
    if (!AVD_TOKEN_PATTERN.test(options.configuration[key])) {
      throw new EvidenceValidationError(
        'must be a bounded AVD token',
        `configuration.${key}`,
      );
    }
  }
  for (const key of ['emulatorPort', 'applicationPort', 'cdpPort']) {
    const value = options.configuration[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
      throw new EvidenceValidationError(
        'must be a valid TCP port',
        `configuration.${key}`,
      );
    }
  }
}

function requiredString(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new EvidenceValidationError('must be a bounded string', path);
  }
  return value;
}

function requireEqual(actual, expected, name) {
  if (actual !== expected) {
    throw new EvidenceValidationError(
      `${name} does not match the qualified environment`,
      'configuration',
    );
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

function signalProcess(child, signal) {
  try {
    if (platform() !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    };
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      rejectPromise(new Error('Mobile-web session was aborted'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error('Mobile-web session was aborted');
}

function executableName(name) {
  return platform() === 'win32' ? `${name}.exe` : name;
}
