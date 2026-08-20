/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */
/* eslint-disable playwright/no-conditional-in-test -- Contract cases inject distinct failure modes. */

import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { canonicalStringify } from './performance-contract.mjs';
import { createManagementWorkload } from './management-workload.mjs';
import {
  launchMobileWebSession,
  mobileEmulatorArguments,
} from './mobile-web-live-session.mjs';
import { canonicalAvdManifest } from './android-emulator-controller.mjs';
import { profileSetV2Fixture } from './platform-test-fixtures.mjs';
import {
  MobileWebProcessError,
  parseMobileWebCliArguments,
  runMobileWebMeasurementProcess,
  runMobileWebSmokeProcess,
} from './run-mobile-web.mjs';
import { environmentFixture, rawResultFixture } from './test-fixtures.mjs';

const ownedDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...ownedDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  ownedDirectories.clear();
});

test('confines mobile CLI profiles and results to the committed contract', () => {
  const options = parseMobileWebCliArguments([]);
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  assert.equal(
    options.profilePath,
    join(
      repositoryRoot,
      'specs/001-multi-format-books/performance/profiles-v2.json',
    ),
  );
  assert.equal(
    options.resultsRoot,
    join(repositoryRoot, 'specs/001-multi-format-books/performance/results'),
  );
  assert.throws(
    () => parseMobileWebCliArguments(['--profile', '/tmp/forged.json']),
    /usage: run-mobile-web\.mjs/,
  );
  assert.throws(
    () =>
      parseMobileWebCliArguments(['--results-root', '/tmp/unapproved-results']),
    /usage: run-mobile-web\.mjs/,
  );
  assert.throws(
    () => parseMobileWebCliArguments(['--emulator-port', '5581']),
    /even emulator port/,
  );
  assert.equal(parseMobileWebCliArguments(['--smoke']).smoke, true);
});

test('launches only one exact snapshot without saving emulator mutations', () => {
  assert.deepEqual(
    mobileEmulatorArguments({
      avdName: 'omnia_performance',
      snapshotName: 'omnia-performance-v1',
      port: 5580,
    }),
    [
      '-avd',
      'omnia_performance',
      '-port',
      '5580',
      '-snapshot',
      'omnia-performance-v1',
      '-no-snapshot-save',
      '-no-boot-anim',
      '-no-audio',
      '-no-window',
    ],
  );
  assert.throws(
    () =>
      mobileEmulatorArguments({
        avdName: '../foreign',
        snapshotName: 'approved',
        port: 5580,
      }),
    /bounded AVD token/,
  );
});

test(
  'launches, probes, and cleans one disposable emulator session',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await temporaryDirectory('omnia-mobile-live-fixture-');
    const sdkRoot = join(root, 'sdk');
    const baseline = join(root, 'approved.avd');
    const marker = join(root, 'emulator.started');
    await mkdir(join(sdkRoot, 'platform-tools'), { recursive: true });
    await mkdir(join(sdkRoot, 'emulator'), { recursive: true });
    await mkdir(join(baseline, 'snapshots', 'omnia-performance-v1'), {
      recursive: true,
    });
    await writeFile(join(baseline, 'config.ini'), 'hw.ramSize=4096\n');
    await writeFile(join(baseline, 'userdata-qemu.img'), 'guest');
    await writeFile(
      join(baseline, 'snapshots', 'omnia-performance-v1', 'snapshot.pb'),
      'snapshot',
    );
    const adbPath = join(sdkRoot, 'platform-tools', 'adb');
    const emulatorPath = join(sdkRoot, 'emulator', 'emulator');
    await writeFile(adbPath, fakeAdbSource(), { mode: 0o700 });
    await writeFile(emulatorPath, fakeEmulatorSource(), { mode: 0o700 });
    await chmod(adbPath, 0o700);
    await chmod(emulatorPath, 0o700);
    const manifest = await canonicalAvdManifest(baseline);
    const previousMarker = process.env['FAKE_EMULATOR_MARKER'];
    process.env['FAKE_EMULATOR_MARKER'] = marker;
    let constraintCaptures = 0;
    let lockCaptures = 0;
    let session;
    try {
      session = await launchMobileWebSession({
        configuration: {
          sdkRoot,
          repositoryRoot: root,
          avdName: 'omnia_performance',
          baselineDirectory: baseline,
          snapshotName: 'omnia-performance-v1',
          emulatorPort: 5580,
          applicationPort: 4200,
          cdpPort: 9222,
          temporaryRoot: root,
        },
        environment: {
          values: {
            'environment.emulatorSerial': 'emulator-5580',
            'environment.avdName': 'omnia_performance',
            'environment.avdSnapshotName': 'omnia-performance-v1',
            'environment.avdSnapshotSha256': manifest.digest,
            'environment.avdImage':
              'system-images;android-36.1;google_apis_playstore;x86_64@4',
            'environment.device': 'pixel-4a-class',
          },
        },
        dependencies: {
          captureConstraints: async () => ({
            cpuQuota: 2,
            memoryLimitBytes:
              ++constraintCaptures === 1 ? 4_294_967_296 : 2_147_483_648,
          }),
          packageLockSha256: async () =>
            `sha256:${(++lockCaptures === 1 ? 'b' : 'c').repeat(64)}`,
          fetchCdpVersion: async () => ({
            browser: 'Chrome/144.0.7559.31',
            protocolVersion: '1.3',
          }),
          hashChromeApks: async () => `sha256:${'a'.repeat(64)}`,
        },
      });
      const observations = await session.captureObservations();
      assert.equal(observations.serial, 'emulator-5580');
      assert.equal(observations.avdSnapshotSha256, manifest.digest);
      assert.equal(observations.emulatorVersion, '36.3.10.0');
      assert.equal(observations.chrome.versionName, '144.0.7559.31');
      const recaptured = await session.captureObservations();
      assert.equal(recaptured.resources.memoryLimitBytes, 2_147_483_648);
      assert.equal(
        recaptured.source.packageLockSha256,
        `sha256:${'c'.repeat(64)}`,
      );
      assert.doesNotThrow(() => session.assertRunning());
    } finally {
      await session?.cleanup();
      if (previousMarker === undefined)
        delete process.env['FAKE_EMULATOR_MARKER'];
      else process.env['FAKE_EMULATOR_MARKER'] = previousMarker;
    }
    assert.throws(() => session.assertRunning(), /emulator exited/);
  },
);

test('runs a qualified CDP child and promotes only after recapture and cleanup', async () => {
  const fixture = await qualifiedProcessFixture('omnia-mobile-pass-');
  const events = [];
  fixture.launch = async () => {
    events.push('launch');
    return { cdpEndpoint: 'http://127.0.0.1:9222' };
  };
  fixture.recapture = async ({ phase }) => {
    events.push(`recapture:${phase}`);
    return fixture.environment;
  };
  fixture.cleanup = async () => {
    events.push('cleanup');
  };
  const raw = rawResultFixture(fixture.profileSet, 'mobile-web-v2', {
    environment: fixture.environment,
  });

  const outcome = await runMobileWebMeasurementProcess({
    ...fixture,
    command: process.execPath,
    arguments: [
      '--input-type=module',
      '-e',
      "import { writeFile } from 'node:fs/promises'; if (process.env.PERFORMANCE_MOBILE_CDP_ENDPOINT !== 'http://127.0.0.1:9222') process.exit(9); await writeFile(process.env.PERFORMANCE_MOBILE_RAW_RESULT, process.env.RAW_RESULT);",
    ],
    environmentVariables: { RAW_RESULT: canonicalStringify(raw) },
    timeoutMs: 2_000,
  });

  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(events, [
    'launch',
    'recapture:before-sampling',
    'recapture:after-sampling',
    'cleanup',
  ]);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  assert.deepEqual(
    JSON.parse(await readFile(outcome.outputPath, 'utf8')),
    outcome.result,
  );
});

test('runs reduced CDP smoke without creating primary evidence', async () => {
  const fixture = await qualifiedProcessFixture('omnia-mobile-smoke-');
  const outcome = await runMobileWebSmokeProcess({
    profileSet: fixture.profileSet,
    environment: fixture.environment,
    temporaryRoot: fixture.temporaryRoot,
    launch: fixture.launch,
    recapture: fixture.recapture,
    cleanup: fixture.cleanup,
    command: process.execPath,
    arguments: [
      '--input-type=module',
      '-e',
      "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PERFORMANCE_MOBILE_SMOKE_RESULT, JSON.stringify({schemaVersion:1,status:'SMOKE_PASS',profileSetId:process.env.PERFORMANCE_MOBILE_PROFILE_SET_ID,profileSetDigest:process.env.PERFORMANCE_MOBILE_PROFILE_SET_DIGEST,profileId:'mobile-web-v2'}));",
    ],
    timeoutMs: 2_000,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.marker.status, 'SMOKE_PASS');
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  assert.deepEqual(await readdir(fixture.resultsRoot), []);
});

test('fails closed on child crash, invalid result, and CDP disconnect', async () => {
  for (const failure of ['crash', 'invalid-result', 'disconnect']) {
    const fixture = await qualifiedProcessFixture(`omnia-mobile-${failure}-`);
    let cleanupCalls = 0;
    let recaptures = 0;
    fixture.cleanup = async () => {
      cleanupCalls += 1;
    };
    fixture.recapture = async () => {
      recaptures += 1;
      if (failure === 'disconnect' && recaptures === 2) {
        throw new Error('CDP disconnected after sampling');
      }
      return fixture.environment;
    };
    const raw = rawResultFixture(fixture.profileSet, 'mobile-web-v2', {
      environment: fixture.environment,
    });
    const rawText =
      failure === 'invalid-result' ? '{not-json' : canonicalStringify(raw);
    const arguments_ =
      failure === 'crash'
        ? [
            '--input-type=module',
            '-e',
            "process.stderr.write('mobile crash'); process.exit(7);",
          ]
        : [
            '--input-type=module',
            '-e',
            "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PERFORMANCE_MOBILE_RAW_RESULT, process.env.RAW_RESULT);",
          ];

    await assert.rejects(
      runMobileWebMeasurementProcess({
        ...fixture,
        command: process.execPath,
        arguments: arguments_,
        environmentVariables: { RAW_RESULT: rawText },
        timeoutMs: 2_000,
      }),
      failure === 'crash'
        ? (error) =>
            error instanceof MobileWebProcessError && error.exitCode === 7
        : undefined,
    );
    assert.equal(cleanupCalls, 1);
    await assert.rejects(
      readFile(join(fixture.resultsRoot, fixture.outputName)),
      { code: 'ENOENT' },
    );
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

test('terminates timed-out and signalled measurement children without promotion', async () => {
  for (const reason of ['timeout', 'SIGINT', 'SIGTERM']) {
    const fixture = await qualifiedProcessFixture(
      `omnia-mobile-${reason.toLowerCase()}-`,
    );
    const pidPath = join(fixture.resultsRoot, `${reason}.pid`);
    const controller = new AbortController();
    if (reason !== 'timeout') {
      void waitForFile(pidPath).then(() => controller.abort(new Error(reason)));
    }

    await assert.rejects(
      runMobileWebMeasurementProcess({
        ...fixture,
        command: process.execPath,
        arguments: [
          '--input-type=module',
          '-e',
          "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PID_PATH, String(process.pid)); setInterval(() => {}, 1000);",
        ],
        environmentVariables: { PID_PATH: pidPath },
        signal: controller.signal,
        timeoutMs: reason === 'timeout' ? 300 : 2_000,
      }),
      (error) =>
        error instanceof MobileWebProcessError &&
        (error.timedOut || error.aborted),
    );
    const childPid = Number(await readFile(pidPath, 'utf8'));
    await assert.rejects(access(`/proc/${childPid}`, constants.F_OK), {
      code: 'ENOENT',
    });
    await assert.rejects(
      readFile(join(fixture.resultsRoot, fixture.outputName)),
      { code: 'ENOENT' },
    );
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

async function qualifiedProcessFixture(prefix) {
  const profileSet = profileSetV2Fixture();
  const environment = environmentFixture(profileSet, 'mobile-web-v2');
  return {
    profileSet,
    environment,
    workload: createManagementWorkload(),
    resultsRoot: await temporaryDirectory(`${prefix}results-`),
    outputName: 'mobile-web.json',
    temporaryRoot: await temporaryDirectory(`${prefix}temp-`),
    launch: async () => ({ cdpEndpoint: 'http://127.0.0.1:9222' }),
    recapture: async () => environment,
    cleanup: async () => undefined,
  };
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}

async function waitForFile(path) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function fakeEmulatorSource() {
  return `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
if (process.argv.includes('-version')) {
  process.stdout.write('Android emulator version 36.3.10.0\\n');
  process.exit(0);
}
await writeFile(process.env.FAKE_EMULATOR_MARKER, String(process.pid));
setInterval(() => {}, 1000);
`;
}

function fakeAdbSource() {
  return `#!/usr/bin/env node
import { existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'devices') {
  const device = existsSync(process.env.FAKE_EMULATOR_MARKER)
    ? 'emulator-5580\\tdevice product:sdk model:Pixel transport_id:1\\n'
    : '';
  process.stdout.write('List of devices attached\\n' + device);
  process.exit(0);
}
const command = args.slice(2).join(' ');
const outputs = new Map([
  ['shell getprop sys.boot_completed', '1\\n'],
  ['shell getprop ro.build.fingerprint', 'google/sdk/device:user/dev-keys\\n'],
  ['shell getprop ro.product.cpu.abi', 'x86_64\\n'],
  ['shell wm size', 'Physical size: 1080x2340\\n'],
  ['shell wm density', 'Physical density: 420\\n'],
  ['shell dumpsys battery', 'AC powered: false\\nUSB powered: false\\nWireless powered: false\\nlevel: 75\\n'],
  ['shell settings get global low_power', '0\\n'],
  ['shell settings get global airplane_mode_on', '1\\n'],
  ['shell cmd wifi status', 'Wi-Fi is disabled\\n'],
  ['shell dumpsys package com.android.chrome', 'versionCode=14407559031 minSdk=29\\nversionName=144.0.7559.31\\n'],
  ['shell pm path com.android.chrome', 'package:/data/app/~~abc==/com.android.chrome-xyz==/base.apk\\n'],
]);
process.stdout.write(outputs.get(command) ?? '');
`;
}
