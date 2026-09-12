const PROFILE_ID = 'sync-staging-v1';
const MAX_DURATION_MS = 60_000;
const MAX_ATTEMPTS = 10_000;

export class SyncPerformanceValidationError extends Error {
  constructor(message, path = 'syncPerformance') {
    super(`${path}: ${message}`);
    this.name = 'SyncPerformanceValidationError';
    this.path = path;
  }
}

export function assertSyncPerformanceProfile(value) {
  assertRecord(value, 'profile');
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'profileId',
      'provider',
      'devices',
      'resources',
      'network',
      'synchronization',
      'measurement',
    ],
    'profile',
  );
  assertEqual(value.schemaVersion, 1, 'profile.schemaVersion');
  assertEqual(value.profileId, PROFILE_ID, 'profile.profileId');
  assertEqual(value.provider, 'git', 'profile.provider');
  assertEqual(value.devices, 2, 'profile.devices');
  assertFixedRecord(
    value.resources,
    { logicalCpu: 2, memoryMiB: 4096 },
    'profile.resources',
  );
  assertFixedRecord(
    value.network,
    {
      roundTripTimeMs: 100,
      downloadKilobitsPerSecond: 10_000,
      uploadKilobitsPerSecond: 10_000,
      packetLossPercent: 0,
    },
    'profile.network',
  );
  assertFixedRecord(
    value.synchronization,
    { readingStateQuietPeriodMs: 1000, remoteRevisionPollMs: 10_000 },
    'profile.synchronization',
  );
  assertFixedRecord(
    value.measurement,
    {
      warmupAttempts: 20,
      measuredAttempts: 200,
      manualSyncTargetMs: 2000,
      minimumWithinTargetRatio: 0.95,
      remoteVisibilityTargetMs: 15_000,
    },
    'profile.measurement',
  );
  return value;
}

export async function runSyncPerformanceMeasurements(options) {
  assertRecord(options, 'options');
  const profile = assertSyncPerformanceProfile(options.profile);
  assertQualification(options.qualification, profile);
  if (typeof options.measureTwoDeviceAttempt !== 'function') {
    throw new SyncPerformanceValidationError(
      'must be a function',
      'options.measureTwoDeviceAttempt',
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  if (typeof now !== 'function') {
    throw new SyncPerformanceValidationError(
      'must be a function',
      'options.now',
    );
  }

  const startedAt = canonicalTimestamp(now(), 'result.startedAt');
  const warmups = await collectAttempts({
    count: profile.measurement.warmupAttempts,
    phase: 'warmup',
    profile,
    measure: options.measureTwoDeviceAttempt,
    now,
  });
  const samples = await collectAttempts({
    count: profile.measurement.measuredAttempts,
    phase: 'measurement',
    profile,
    measure: options.measureTwoDeviceAttempt,
    now,
  });
  const summary = summarize(samples, profile);

  return {
    schemaVersion: 1,
    profileId: profile.profileId,
    provider: profile.provider,
    devices: profile.devices,
    profile: copyProfile(profile),
    qualification: {
      profileId: options.qualification.profileId,
      provider: options.qualification.provider,
      devices: options.qualification.devices,
      resources: { ...options.qualification.resources },
      network: { ...options.qualification.network },
      synchronization: { ...options.qualification.synchronization },
    },
    startedAt,
    completedAt: canonicalTimestamp(now(), 'result.completedAt'),
    warmups,
    samples,
    summary,
  };
}

function copyProfile(profile) {
  return {
    ...profile,
    resources: { ...profile.resources },
    network: { ...profile.network },
    synchronization: { ...profile.synchronization },
    measurement: { ...profile.measurement },
  };
}

async function collectAttempts({ count, phase, profile, measure, now }) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ATTEMPTS) {
    throw new SyncPerformanceValidationError(
      `must be an integer from 1 through ${MAX_ATTEMPTS}`,
      `${phase}.count`,
    );
  }
  const samples = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    const startedAt = canonicalTimestamp(
      now(),
      `${phase}[${attempt}].startedAt`,
    );
    const measured = await measure({ phase, attempt, profile });
    const sample = assertMeasurementSample(measured, `${phase}[${attempt}]`);
    samples.push({
      attempt,
      startedAt,
      completedAt: canonicalTimestamp(
        now(),
        `${phase}[${attempt}].completedAt`,
      ),
      ...sample,
    });
  }
  return samples;
}

function assertMeasurementSample(value, path) {
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      'manualSyncDurationMs',
      'remoteVisibilityDurationMs',
      'publicationTransfers',
    ],
    path,
  );
  assertDuration(value.manualSyncDurationMs, `${path}.manualSyncDurationMs`);
  assertDuration(
    value.remoteVisibilityDurationMs,
    `${path}.remoteVisibilityDurationMs`,
  );
  if (
    !Number.isSafeInteger(value.publicationTransfers) ||
    value.publicationTransfers < 0 ||
    value.publicationTransfers > 1_000_000
  ) {
    throw new SyncPerformanceValidationError(
      'must be an integer from 0 through 1000000',
      `${path}.publicationTransfers`,
    );
  }
  return {
    manualSyncDurationMs: value.manualSyncDurationMs,
    remoteVisibilityDurationMs: value.remoteVisibilityDurationMs,
    publicationTransfers: value.publicationTransfers,
  };
}

function summarize(samples, profile) {
  const manual = samples
    .map(({ manualSyncDurationMs }) => manualSyncDurationMs)
    .sort((left, right) => left - right);
  const withinTarget = manual.filter(
    (duration) => duration <= profile.measurement.manualSyncTargetMs,
  ).length;
  const remoteVisibilityMaxMs = Math.max(
    ...samples.map(
      ({ remoteVisibilityDurationMs }) => remoteVisibilityDurationMs,
    ),
  );
  const publicationTransfers = samples.reduce(
    (total, sample) => total + sample.publicationTransfers,
    0,
  );
  const manualSyncWithinTargetRatio = withinTarget / samples.length;
  const manualSyncP95Ms = manual[Math.ceil(manual.length * 0.95) - 1];
  const passed =
    manualSyncWithinTargetRatio >=
      profile.measurement.minimumWithinTargetRatio &&
    remoteVisibilityMaxMs <= profile.measurement.remoteVisibilityTargetMs &&
    publicationTransfers === 0;
  return {
    count: samples.length,
    manualSyncP95Ms,
    manualSyncWithinTargetRatio,
    remoteVisibilityMaxMs,
    publicationTransfers,
    result: passed ? 'PASS' : 'FAIL',
  };
}

function assertQualification(value, profile) {
  assertRecord(value, 'qualification');
  assertExactKeys(
    value,
    [
      'profileId',
      'provider',
      'devices',
      'resources',
      'network',
      'synchronization',
    ],
    'qualification',
  );
  assertEqual(value.profileId, profile.profileId, 'qualification.profileId');
  assertEqual(value.provider, profile.provider, 'qualification.provider');
  assertEqual(value.devices, profile.devices, 'qualification.devices');
  assertFixedRecord(
    value.resources,
    profile.resources,
    'qualification.resources',
  );
  assertFixedRecord(value.network, profile.network, 'qualification.network');
  assertFixedRecord(
    value.synchronization,
    profile.synchronization,
    'qualification.synchronization',
  );
}

function assertFixedRecord(value, expected, path) {
  assertRecord(value, path);
  assertExactKeys(value, Object.keys(expected), path);
  for (const [key, expectedValue] of Object.entries(expected)) {
    assertEqual(value[key], expectedValue, `${path}.${key}`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new SyncPerformanceValidationError(
      `must contain exactly ${sortedExpected.join(', ')}`,
      path,
    );
  }
}

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncPerformanceValidationError('must be an object', path);
  }
}

function assertEqual(actual, expected, path) {
  if (actual !== expected) {
    throw new SyncPerformanceValidationError(`must equal ${expected}`, path);
  }
}

function assertDuration(value, path) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) {
    throw new SyncPerformanceValidationError(
      `must be a finite number from 0 through ${MAX_DURATION_MS}`,
      path,
    );
  }
}

function canonicalTimestamp(value, path) {
  if (typeof value !== 'string') {
    throw new SyncPerformanceValidationError(
      'must be a canonical UTC timestamp',
      path,
    );
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new SyncPerformanceValidationError(
      'must be a canonical UTC timestamp',
      path,
    );
  }
  return value;
}
