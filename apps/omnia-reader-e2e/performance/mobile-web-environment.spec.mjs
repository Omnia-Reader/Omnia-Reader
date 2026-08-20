/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMobileWebSamplingIdentity,
  captureMobileWebObservations,
  createMobileWebEnvironment,
} from './mobile-web-environment.mjs';
import { attachProfileSetDigest } from './performance-contract.mjs';
import { profileSetV2Fixture } from './platform-test-fixtures.mjs';

test('binds mobile web evidence to exact emulator Chrome and host identity', () => {
  const profileSet = mobileProfileSetFixture();
  const environment = createMobileWebEnvironment({
    profileSet,
    profileId: 'mobile-web-v2',
    git: { commit: 'c'.repeat(40), dirty: false },
    observations: observationFixture(),
  });

  assert.equal(environment.profileId, 'mobile-web-v2');
  assert.equal(environment.values['runtime.chromeVersion'], '144.0.7559.31');
  assert.equal(environment.values['environment.viewportWidth'], 1080);
  assert.equal(environment.values['environment.externalNetworkDisabled'], true);
  assert.equal(environment.values['environment.cpuQuota'], 2);
  assertMobileWebSamplingIdentity(environment, structuredClone(environment));
});

test('rejects Chrome package/CDP disagreement and unsafe device state', () => {
  const profileSet = mobileProfileSetFixture();
  for (const mutate of [
    (value) => {
      value.cdp.browser = 'Chrome/143.0.0.0';
    },
    (value) => {
      value.chrome.packageName = 'org.chromium.chrome';
    },
    (value) => {
      value.chrome.apkSha256 = 'invalid';
    },
    (value) => {
      value.battery.level = 74;
    },
    (value) => {
      value.batterySaver = true;
    },
    (value) => {
      value.externalNetworkDisabled = false;
    },
    (value) => {
      value.viewport.densityDpi = 0;
    },
  ]) {
    const observations = observationFixture();
    mutate(observations);
    assert.throws(() =>
      createMobileWebEnvironment({
        profileSet,
        profileId: 'mobile-web-v2',
        git: { commit: 'c'.repeat(40), dirty: false },
        observations,
      }),
    );
  }
});

test('rejects resource and runtime drift between qualification and sampling', () => {
  const profileSet = mobileProfileSetFixture();
  const expected = createMobileWebEnvironment({
    profileSet,
    profileId: 'mobile-web-v2',
    git: { commit: 'c'.repeat(40), dirty: false },
    observations: observationFixture(),
  });
  for (const [key, value] of [
    ['environment.memoryLimitBytes', 2_147_483_648],
    ['environment.avdSnapshotSha256', `sha256:${'e'.repeat(64)}`],
    ['runtime.chromeLongVersionCode', '143000000'],
    ['environment.densityDpi', 440],
  ]) {
    const current = structuredClone(expected);
    current.values[key] = value;
    assert.throws(
      () => assertMobileWebSamplingIdentity(expected, current),
      /identity drift/,
    );
  }
});

test('captures live serial-scoped Android and CDP observations', async () => {
  const outputs = new Map([
    ['getprop ro.build.fingerprint', 'google/sdk/device:user/dev-keys\n'],
    ['getprop ro.product.cpu.abi', 'x86_64\n'],
    ['wm size', 'Physical size: 1080x2340\n'],
    ['wm density', 'Physical density: 420\n'],
    [
      'dumpsys battery',
      'AC powered: false\nUSB powered: false\nWireless powered: false\nlevel: 75\n',
    ],
    ['settings get global low_power', '0\n'],
    ['settings get global airplane_mode_on', '1\n'],
    ['cmd wifi status', 'Wi-Fi is disabled\n'],
    [
      'dumpsys package com.android.chrome',
      'versionCode=14407559031 minSdk=29\nversionName=144.0.7559.31\n',
    ],
    [
      'pm path com.android.chrome',
      'package:/data/app/~~abc==/com.android.chrome-xyz==/base.apk\npackage:/data/app/~~abc==/com.android.chrome-xyz==/split_config.apk\n',
    ],
  ]);
  const seenPaths = [];
  const observations = await captureMobileWebObservations({
    adb: {
      serial: 'emulator-5580',
      shell: async (arguments_) => ({
        stdout: outputs.get(arguments_.join(' ')),
        stderr: '',
        exitCode: 0,
      }),
    },
    staticIdentity: {
      avdImage: 'system-images;android-36.1;google_apis_playstore;x86_64@4',
      avdSnapshotSha256: `sha256:${'d'.repeat(64)}`,
      deviceClass: 'pixel-4a-class',
      resources: { cpuQuota: 2, memoryLimitBytes: 4_294_967_296 },
      source: {
        nodeVersion: 'v26.5.0',
        packageLockSha256: `sha256:${'b'.repeat(64)}`,
      },
    },
    fetchCdpVersion: async () => ({
      browser: 'Chrome/144.0.7559.31',
      protocolVersion: '1.3',
    }),
    hashChromeApks: async (paths) => {
      seenPaths.push(...paths);
      return `sha256:${'a'.repeat(64)}`;
    },
  });

  assert.deepEqual(seenPaths, [
    '/data/app/~~abc==/com.android.chrome-xyz==/base.apk',
    '/data/app/~~abc==/com.android.chrome-xyz==/split_config.apk',
  ]);
  assert.deepEqual(observations, observationFixture());
});

function mobileProfileSetFixture() {
  const profileSet = profileSetV2Fixture();
  const profile = profileSet.profiles.find(({ id }) => id === 'mobile-web-v2');
  profile.requirements = {
    'dataset.recipeDigest': profileSet.dataset.recipeDigest,
    'environment.arch': 'x86_64',
    'environment.avdImage':
      'system-images;android-36.1;google_apis_playstore;x86_64@4',
    'environment.avdSnapshotSha256': `sha256:${'d'.repeat(64)}`,
    'environment.battery': 'simulated-75-percent',
    'environment.batterySaver': false,
    'environment.buildFingerprint': 'google/sdk/device:user/dev-keys',
    'environment.cpuQuota': 2,
    'environment.densityDpi': 420,
    'environment.device': 'pixel-4a-class',
    'environment.emulatorSerial': 'emulator-5580',
    'environment.externalNetworkDisabled': true,
    'environment.memoryLimitBytes': 4_294_967_296,
    'environment.viewportHeight': 2340,
    'environment.viewportWidth': 1080,
    'runtime.cdpProtocolVersion': '1.3',
    'runtime.chromeApkSha256': `sha256:${'a'.repeat(64)}`,
    'runtime.chromeLongVersionCode': '14407559031',
    'runtime.chromePackage': 'com.android.chrome',
    'runtime.chromeVersion': '144.0.7559.31',
    'source.nodeVersion': 'v26.5.0',
    'source.packageLockSha256': `sha256:${'b'.repeat(64)}`,
  };
  return attachProfileSetDigest(profileSet);
}

function observationFixture() {
  return {
    serial: 'emulator-5580',
    avdImage: 'system-images;android-36.1;google_apis_playstore;x86_64@4',
    avdSnapshotSha256: `sha256:${'d'.repeat(64)}`,
    deviceClass: 'pixel-4a-class',
    buildFingerprint: 'google/sdk/device:user/dev-keys',
    abi: 'x86_64',
    viewport: { width: 1080, height: 2340, densityDpi: 420 },
    battery: { level: 75, charging: false },
    batterySaver: false,
    externalNetworkDisabled: true,
    chrome: {
      packageName: 'com.android.chrome',
      versionName: '144.0.7559.31',
      longVersionCode: '14407559031',
      apkSha256: `sha256:${'a'.repeat(64)}`,
    },
    cdp: { browser: 'Chrome/144.0.7559.31', protocolVersion: '1.3' },
    resources: { cpuQuota: 2, memoryLimitBytes: 4_294_967_296 },
    source: {
      nodeVersion: 'v26.5.0',
      packageLockSha256: `sha256:${'b'.repeat(64)}`,
    },
  };
}
