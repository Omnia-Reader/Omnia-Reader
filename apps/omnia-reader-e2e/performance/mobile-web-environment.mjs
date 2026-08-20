import {
  EvidenceValidationError,
  assertBoolean,
  assertEnvironmentRecord,
  assertExactKeys,
  assertOneOf,
  assertProfileSet,
  assertRecord,
  assertSafeInteger,
  assertString,
  canonicalStringify,
} from './performance-contract.mjs';
import { emulatorSerialForPort } from './android-emulator-controller.mjs';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EMULATOR_SERIAL_PATTERN = /^emulator-(\d{4})$/;
const CHROME_VERSION_PATTERN = /^\d+(?:\.\d+){3}$/;
const LONG_VERSION_CODE_PATTERN = /^\d{1,32}$/;

export async function captureMobileWebObservations(options) {
  assertRecord(options, 'capture.options');
  assertExactKeys(
    options,
    ['adb', 'staticIdentity', 'fetchCdpVersion', 'hashChromeApks'],
    'capture.options',
  );
  const { adb } = options;
  if (
    !adb ||
    typeof adb !== 'object' ||
    typeof adb.serial !== 'string' ||
    typeof adb.shell !== 'function'
  ) {
    throw new EvidenceValidationError(
      'must be a serial-scoped ADB session',
      'capture.options.adb',
    );
  }
  if (
    typeof options.fetchCdpVersion !== 'function' ||
    typeof options.hashChromeApks !== 'function'
  ) {
    throw new EvidenceValidationError(
      'CDP and APK probes must be functions',
      'capture.options',
    );
  }
  const staticIdentity = assertStaticIdentity(options.staticIdentity);
  const [
    fingerprintResult,
    abiResult,
    sizeResult,
    densityResult,
    batteryResult,
    saverResult,
    airplaneResult,
    wifiResult,
    packageResult,
    pathsResult,
    cdp,
  ] = await Promise.all([
    adb.shell(['getprop', 'ro.build.fingerprint']),
    adb.shell(['getprop', 'ro.product.cpu.abi']),
    adb.shell(['wm', 'size']),
    adb.shell(['wm', 'density']),
    adb.shell(['dumpsys', 'battery']),
    adb.shell(['settings', 'get', 'global', 'low_power']),
    adb.shell(['settings', 'get', 'global', 'airplane_mode_on']),
    adb.shell(['cmd', 'wifi', 'status']),
    adb.shell(['dumpsys', 'package', 'com.android.chrome']),
    adb.shell(['pm', 'path', 'com.android.chrome']),
    options.fetchCdpVersion(),
  ]);
  const apkPaths = parsePackagePaths(pathsResult.stdout);
  const apkSha256 = await options.hashChromeApks(apkPaths);
  const battery = parseBattery(batteryResult.stdout);
  return assertMobileWebObservations({
    serial: adb.serial,
    ...staticIdentity,
    buildFingerprint: oneLine(fingerprintResult.stdout, 'build fingerprint'),
    abi: oneLine(abiResult.stdout, 'ABI'),
    viewport: {
      ...parseViewport(sizeResult.stdout),
      densityDpi: parseDensity(densityResult.stdout),
    },
    battery,
    batterySaver: parseBinarySetting(saverResult.stdout, 'Battery Saver') === 1,
    externalNetworkDisabled:
      parseBinarySetting(airplaneResult.stdout, 'airplane mode') === 1 &&
      /Wi-?Fi is disabled/i.test(wifiResult.stdout),
    chrome: {
      packageName: 'com.android.chrome',
      ...parseChromePackage(packageResult.stdout),
      apkSha256,
    },
    cdp,
  });
}

export function createMobileWebEnvironment(options) {
  assertRecord(options, 'options');
  assertExactKeys(
    options,
    ['profileSet', 'profileId', 'git', 'observations'],
    'options',
  );
  const profileSet = assertProfileSet(options.profileSet);
  const profileId = assertString(
    options.profileId,
    1,
    128,
    'options.profileId',
  );
  const profile = profileSet.profiles.find(({ id }) => id === profileId);
  if (!profile || profile.platform !== 'mobile-web') {
    throw new EvidenceValidationError(
      'must select one mobile-web profile',
      'options.profileId',
    );
  }
  const observations = assertMobileWebObservations(options.observations);
  assertRecord(options.git, 'options.git');
  assertExactKeys(options.git, ['commit', 'dirty'], 'options.git');

  const candidateValues = {
    'dataset.recipeDigest': profileSet.dataset.recipeDigest,
    'environment.arch': observations.abi,
    'environment.avdImage': observations.avdImage,
    'environment.avdSnapshotSha256': observations.avdSnapshotSha256,
    'environment.battery': `simulated-${observations.battery.level}-percent`,
    'environment.batterySaver': observations.batterySaver,
    'environment.buildFingerprint': observations.buildFingerprint,
    'environment.cpuQuota': observations.resources.cpuQuota,
    'environment.densityDpi': observations.viewport.densityDpi,
    'environment.device': observations.deviceClass,
    'environment.emulatorSerial': observations.serial,
    'environment.externalNetworkDisabled': observations.externalNetworkDisabled,
    'environment.memoryLimitBytes': observations.resources.memoryLimitBytes,
    'environment.viewportHeight': observations.viewport.height,
    'environment.viewportWidth': observations.viewport.width,
    'runtime.cdpProtocolVersion': observations.cdp.protocolVersion,
    'runtime.chromeApkSha256': observations.chrome.apkSha256,
    'runtime.chromeLongVersionCode': observations.chrome.longVersionCode,
    'runtime.chromePackage': observations.chrome.packageName,
    'runtime.chromeVersion': observations.chrome.versionName,
    'source.nodeVersion': observations.source.nodeVersion,
    'source.packageLockSha256': observations.source.packageLockSha256,
  };
  const values = {};
  for (const key of Object.keys(profile.requirements)) {
    if (!Object.hasOwn(candidateValues, key)) {
      throw new EvidenceValidationError(
        'required mobile-web identity has no live observation',
        `environment.values.${key}`,
      );
    }
    values[key] = candidateValues[key];
  }
  return assertEnvironmentRecord(
    {
      schemaVersion: 1,
      profileSetId: profileSet.profileSetId,
      profileSetDigest: profileSet.profileSetDigest,
      profileId,
      intent: 'primary',
      availability: 'available',
      unavailableReasons: [],
      git: options.git,
      driver: profile.driver,
      values,
    },
    profileSet,
  );
}

export function assertMobileWebSamplingIdentity(expected, current) {
  if (canonicalStringify(expected) !== canonicalStringify(current)) {
    throw new EvidenceValidationError(
      'mobile-web sampling identity drift detected',
      'environment',
    );
  }
  return current;
}

function assertMobileWebObservations(value) {
  assertRecord(value, 'observations');
  assertExactKeys(
    value,
    [
      'serial',
      'avdImage',
      'avdSnapshotSha256',
      'deviceClass',
      'buildFingerprint',
      'abi',
      'viewport',
      'battery',
      'batterySaver',
      'externalNetworkDisabled',
      'chrome',
      'cdp',
      'resources',
      'source',
    ],
    'observations',
  );
  assertEmulatorSerial(value.serial);
  assertString(value.avdImage, 1, 512, 'observations.avdImage');
  assertDigest(value.avdSnapshotSha256, 'observations.avdSnapshotSha256');
  assertString(value.deviceClass, 1, 128, 'observations.deviceClass');
  assertString(value.buildFingerprint, 1, 512, 'observations.buildFingerprint');
  assertOneOf(value.abi, ['x86_64'], 'observations.abi');
  assertViewport(value.viewport);
  assertBattery(value.battery);
  assertBoolean(value.batterySaver, 'observations.batterySaver');
  if (value.batterySaver) {
    throw new EvidenceValidationError(
      'Battery Saver must be disabled',
      'observations.batterySaver',
    );
  }
  assertBoolean(
    value.externalNetworkDisabled,
    'observations.externalNetworkDisabled',
  );
  if (!value.externalNetworkDisabled) {
    throw new EvidenceValidationError(
      'guest external networking must be disabled',
      'observations.externalNetworkDisabled',
    );
  }
  assertChrome(value.chrome, value.cdp);
  assertResources(value.resources);
  assertSource(value.source);
  return value;
}

function assertStaticIdentity(value) {
  assertRecord(value, 'capture.staticIdentity');
  assertExactKeys(
    value,
    ['avdImage', 'avdSnapshotSha256', 'deviceClass', 'resources', 'source'],
    'capture.staticIdentity',
  );
  assertString(value.avdImage, 1, 512, 'capture.staticIdentity.avdImage');
  assertDigest(
    value.avdSnapshotSha256,
    'capture.staticIdentity.avdSnapshotSha256',
  );
  assertString(value.deviceClass, 1, 128, 'capture.staticIdentity.deviceClass');
  assertResources(value.resources);
  assertSource(value.source);
  return value;
}

function parseViewport(output) {
  const matches = [
    ...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g),
  ];
  const match = matches.at(-1);
  if (!match) {
    throw new EvidenceValidationError(
      'wm size output is malformed',
      'observations.viewport',
    );
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseDensity(output) {
  const matches = [
    ...output.matchAll(/(?:Physical|Override) density:\s*(\d+)/g),
  ];
  const match = matches.at(-1);
  if (!match) {
    throw new EvidenceValidationError(
      'wm density output is malformed',
      'observations.viewport.densityDpi',
    );
  }
  return Number(match[1]);
}

function parseBattery(output) {
  const level = /\blevel:\s*(\d+)\b/.exec(output);
  const powerMatches = [
    /AC powered:\s*(true|false)/.exec(output),
    /USB powered:\s*(true|false)/.exec(output),
    /Wireless powered:\s*(true|false)/.exec(output),
  ];
  if (!level || powerMatches.some((match) => !match)) {
    throw new EvidenceValidationError(
      'battery output is malformed',
      'observations.battery',
    );
  }
  return {
    level: Number(level[1]),
    charging: powerMatches.some((match) => match[1] === 'true'),
  };
}

function parseBinarySetting(output, name) {
  const value = output.trim();
  if (!['0', '1'].includes(value)) {
    throw new EvidenceValidationError(
      `${name} output must be 0 or 1`,
      'observations',
    );
  }
  return Number(value);
}

function parseChromePackage(output) {
  const versionName = /\bversionName=([^\s]+)/.exec(output)?.[1];
  const longVersionCode = /\bversionCode=(\d+)\b/.exec(output)?.[1];
  if (!versionName || !longVersionCode) {
    throw new EvidenceValidationError(
      'Chrome package output is malformed',
      'observations.chrome',
    );
  }
  return { versionName, longVersionCode };
}

function parsePackagePaths(output) {
  const paths = output
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const path = line.startsWith('package:')
        ? line.slice('package:'.length)
        : '';
      if (
        !/^\/(?:data\/app|system|product|vendor)\/[A-Za-z0-9._+/@=~-]+\.apk$/.test(
          path,
        ) ||
        path.includes('..') ||
        path.length > 1_024
      ) {
        throw new EvidenceValidationError(
          'Chrome package path output is malformed',
          'observations.chrome.paths',
        );
      }
      return path;
    });
  if (
    paths.length === 0 ||
    paths.length > 32 ||
    new Set(paths).size !== paths.length
  ) {
    throw new EvidenceValidationError(
      'Chrome must expose between 1 and 32 unique APK paths',
      'observations.chrome.paths',
    );
  }
  return paths;
}

function oneLine(output, name) {
  const value = output.trim();
  if (!value || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new EvidenceValidationError(
      `${name} output must be one bounded line`,
      'observations',
    );
  }
  return value;
}

function assertViewport(value) {
  assertRecord(value, 'observations.viewport');
  assertExactKeys(
    value,
    ['width', 'height', 'densityDpi'],
    'observations.viewport',
  );
  assertSafeInteger(value.width, 1, 16_384, 'observations.viewport.width');
  assertSafeInteger(value.height, 1, 16_384, 'observations.viewport.height');
  assertSafeInteger(
    value.densityDpi,
    1,
    2_000,
    'observations.viewport.densityDpi',
  );
}

function assertBattery(value) {
  assertRecord(value, 'observations.battery');
  assertExactKeys(value, ['level', 'charging'], 'observations.battery');
  assertSafeInteger(value.level, 0, 100, 'observations.battery.level');
  assertBoolean(value.charging, 'observations.battery.charging');
  if (value.level !== 75 || value.charging) {
    throw new EvidenceValidationError(
      'battery must be simulated at 75 percent and not charging',
      'observations.battery',
    );
  }
}

function assertChrome(chrome, cdp) {
  assertRecord(chrome, 'observations.chrome');
  assertExactKeys(
    chrome,
    ['packageName', 'versionName', 'longVersionCode', 'apkSha256'],
    'observations.chrome',
  );
  if (chrome.packageName !== 'com.android.chrome') {
    throw new EvidenceValidationError(
      'must use the approved Chrome package',
      'observations.chrome.packageName',
    );
  }
  assertPattern(
    chrome.versionName,
    CHROME_VERSION_PATTERN,
    'observations.chrome.versionName',
  );
  assertPattern(
    chrome.longVersionCode,
    LONG_VERSION_CODE_PATTERN,
    'observations.chrome.longVersionCode',
  );
  assertDigest(chrome.apkSha256, 'observations.chrome.apkSha256');

  assertRecord(cdp, 'observations.cdp');
  assertExactKeys(cdp, ['browser', 'protocolVersion'], 'observations.cdp');
  assertString(cdp.browser, 1, 256, 'observations.cdp.browser');
  assertString(cdp.protocolVersion, 1, 64, 'observations.cdp.protocolVersion');
  if (cdp.browser !== `Chrome/${chrome.versionName}`) {
    throw new EvidenceValidationError(
      'Chrome package and CDP product versions do not agree',
      'observations.cdp.browser',
    );
  }
}

function assertResources(value) {
  assertRecord(value, 'observations.resources');
  assertExactKeys(
    value,
    ['cpuQuota', 'memoryLimitBytes'],
    'observations.resources',
  );
  assertSafeInteger(value.cpuQuota, 1, 64, 'observations.resources.cpuQuota');
  assertSafeInteger(
    value.memoryLimitBytes,
    256 * 1024 * 1024,
    64 * 1024 * 1024 * 1024,
    'observations.resources.memoryLimitBytes',
  );
}

function assertSource(value) {
  assertRecord(value, 'observations.source');
  assertExactKeys(
    value,
    ['nodeVersion', 'packageLockSha256'],
    'observations.source',
  );
  assertString(value.nodeVersion, 1, 64, 'observations.source.nodeVersion');
  assertDigest(
    value.packageLockSha256,
    'observations.source.packageLockSha256',
  );
}

function assertEmulatorSerial(value) {
  if (typeof value !== 'string' || !EMULATOR_SERIAL_PATTERN.test(value)) {
    throw new EvidenceValidationError(
      'must be an exact emulator serial',
      'observations.serial',
    );
  }
  emulatorSerialForPort(Number(EMULATOR_SERIAL_PATTERN.exec(value)[1]));
}

function assertDigest(value, path) {
  assertPattern(value, SHA256_PATTERN, path);
}

function assertPattern(value, pattern, path) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new EvidenceValidationError(`must match ${pattern}`, path);
  }
}
