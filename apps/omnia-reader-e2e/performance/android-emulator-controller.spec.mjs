/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  SerialScopedAdb,
  assertExclusiveEmulatorDevices,
  canonicalAvdManifest,
  emulatorSerialForPort,
  prepareDisposableAvd,
} from './android-emulator-controller.mjs';

const ownedDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...ownedDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  ownedDirectories.clear();
});

test('creates a deterministic bounded manifest and detects baseline drift', async () => {
  const baseline = await avdFixture('omnia-avd-manifest-');
  const first = await canonicalAvdManifest(baseline);
  const second = await canonicalAvdManifest(baseline);
  assert.deepEqual(second, first);
  assert.equal(first.files.length, 3);

  await writeFile(join(baseline, 'config.ini'), 'hw.ramSize=4096\n');
  const drifted = await canonicalAvdManifest(baseline);
  assert.notEqual(drifted.digest, first.digest);
});

test(
  'rejects symlinks and bounded-manifest violations',
  { skip: process.platform === 'win32' },
  async () => {
    const baseline = await avdFixture('omnia-avd-hostile-');
    await symlink(
      join(baseline, 'config.ini'),
      join(baseline, 'linked-config.ini'),
    );
    await assert.rejects(canonicalAvdManifest(baseline), /symbolic link/);
    await rm(join(baseline, 'linked-config.ini'));
    await assert.rejects(
      canonicalAvdManifest(baseline, { maximumFiles: 2 }),
      /file count/,
    );
  },
);

test('copies only an approved AVD tree into disposable storage', async () => {
  const baseline = await avdFixture('omnia-avd-source-');
  const approved = await canonicalAvdManifest(baseline);
  const temporaryRoot = await temporaryDirectory('omnia-avd-owned-');

  const prepared = await prepareDisposableAvd({
    avdName: 'omnia_performance',
    baselineDirectory: baseline,
    expectedDigest: approved.digest,
    temporaryRoot,
  });

  assert.equal(prepared.manifest.digest, approved.digest);
  assert.equal(
    await readFile(join(prepared.avdDirectory, 'config.ini'), 'utf8'),
    'hw.ramSize=2048\n',
  );
  assert.match(
    await readFile(join(prepared.avdHome, 'omnia_performance.ini'), 'utf8'),
    /^path=.*omnia_performance\.avd$/m,
  );
  await writeFile(join(prepared.avdDirectory, 'config.ini'), 'owned change\n');
  assert.equal(
    await readFile(join(baseline, 'config.ini'), 'utf8'),
    'hw.ramSize=2048\n',
  );

  await assert.rejects(
    prepareDisposableAvd({
      avdName: 'omnia_performance',
      baselineDirectory: baseline,
      expectedDigest: `sha256:${'0'.repeat(64)}`,
      temporaryRoot,
    }),
    /digest does not match/,
  );
});

test('selects one exact emulator serial and rejects foreign emulators', () => {
  assert.equal(emulatorSerialForPort(5580), 'emulator-5580');
  assert.throws(
    () => emulatorSerialForPort(5581),
    /even emulator console port/,
  );

  const owned = [
    'List of devices attached',
    'emulator-5580\tdevice product:sdk model:Pixel transport_id:1',
    '',
  ].join('\n');
  assert.equal(assertExclusiveEmulatorDevices(owned, 'emulator-5580'), true);

  const foreign = `${owned.trimEnd()}\nemulator-5582\tdevice product:sdk\n`;
  assert.throws(
    () => assertExclusiveEmulatorDevices(foreign, 'emulator-5580'),
    /foreign emulator/,
  );
  assert.throws(
    () =>
      assertExclusiveEmulatorDevices(
        'List of devices attached\n',
        'emulator-5580',
      ),
    /not connected/,
  );
});

test('scopes every ADB mapping and cleanup command to the owned serial', async () => {
  const calls = [];
  const adb = new SerialScopedAdb({
    adbPath: '/sdk/platform-tools/adb',
    serial: 'emulator-5580',
    run: async (command, arguments_) => {
      calls.push([command, ...arguments_]);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  await adb.reverse('tcp:4200', 'tcp:4200');
  await adb.forward('tcp:9222', 'localabstract:chrome_devtools_remote');
  await adb.shell(['getprop', 'ro.build.fingerprint']);
  await adb.cleanup();
  await adb.cleanup();

  assert.deepEqual(calls, [
    [
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5580',
      'reverse',
      'tcp:4200',
      'tcp:4200',
    ],
    [
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5580',
      'forward',
      'tcp:9222',
      'localabstract:chrome_devtools_remote',
    ],
    [
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5580',
      'shell',
      'getprop',
      'ro.build.fingerprint',
    ],
    [
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5580',
      'forward',
      '--remove',
      'tcp:9222',
    ],
    [
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5580',
      'reverse',
      '--remove',
      'tcp:4200',
    ],
    ['/sdk/platform-tools/adb', '-s', 'emulator-5580', 'emu', 'kill'],
  ]);
  assert.equal(
    calls.some((call) => call.includes('kill-server')),
    false,
  );
  assert.equal(
    calls.some((call) => call.includes('--remove-all')),
    false,
  );
  await assert.rejects(adb.reverse('tcp:4300', 'tcp:4300'), /already closed/);
});

async function avdFixture(prefix) {
  const root = await temporaryDirectory(prefix);
  await mkdir(join(root, 'snapshots', 'approved'), { recursive: true });
  await writeFile(join(root, 'config.ini'), 'hw.ramSize=2048\n');
  await writeFile(join(root, 'userdata-qemu.img'), Buffer.from('disk image'));
  await writeFile(
    join(root, 'snapshots', 'approved', 'snapshot.pb'),
    Buffer.from('snapshot'),
  );
  return root;
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}
