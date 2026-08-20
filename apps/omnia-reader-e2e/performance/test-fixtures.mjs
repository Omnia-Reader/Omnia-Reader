import { attachProfileSetDigest } from './performance-contract.mjs';

export const PROFILE_IDS = [
  'desktop-web-v1',
  'mobile-web-v1',
  'packaged-desktop-v1',
  'android-v1',
];

export const BRANCH_IDS = [
  'add-local-success',
  'add-local-failure',
  'associate-success',
  'associate-failure',
  'detach-success',
  'detach-failure',
  'delete-success',
  'delete-failure',
  'reconcile-success',
  'reconcile-failure',
  'replace-success',
  'replace-failure',
  'restore-success',
  'restore-failure',
];

export const DISTRIBUTION_IDS = [
  'filter',
  'open-epub',
  'open-pdf',
  'switch-epub-to-pdf',
  'switch-pdf-to-epub',
];

export const COUNTER_IDS = [
  'consoleErrors',
  'missingAcknowledgements',
  'overlappingEngines',
  'wrongResults',
];

export function profileSetFixture() {
  return attachProfileSetDigest({
    schemaVersion: 1,
    profileSetId: 'multi-format-performance-v1',
    dataset: {
      recipeId: 'multi-format-management-v1',
      seed: 'omnia-reader-multi-format-v1',
      logicalBooks: 1_000,
      exactVariants: 2_000,
      formats: ['epub', 'pdf'],
      logicalChangeHistory: 500,
      recipeDigest: `sha256:${'a'.repeat(64)}`,
    },
    measurement: {
      acknowledgementThresholdMs: 1_000,
      finalThresholdMs: 2_000,
      minimumAcknowledgementSamples: 20,
      warmupSamples: 20,
      minimumFinalSamples: 200,
      maximumSamplesPerCollection: 10_000,
      minimumWithinTargetRatio: 0.95,
      branchIds: [...BRANCH_IDS],
      distributionIds: [...DISTRIBUTION_IDS],
      zeroToleranceCounters: [...COUNTER_IDS],
    },
    profiles: PROFILE_IDS.map((id) => ({
      id,
      platform: id.replace(/-v1$/, ''),
      driver: `run-${id.replace(/-v1$/, '')}`,
      qualification: 'complete',
      unresolvedRequirements: [],
      requirements: {
        'dataset.recipeDigest': `sha256:${'a'.repeat(64)}`,
        'environment.arch': 'x64',
        'environment.profileMarker': id,
        'source.nodeVersion': 'v26.5.0',
        'source.packageLockSha256': `sha256:${'b'.repeat(64)}`,
      },
    })),
  });
}

export function environmentFixture(
  profileSet,
  profileId = 'desktop-web-v1',
  overrides = {},
) {
  const profile = profileSet.profiles.find((entry) => entry.id === profileId);
  return {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId,
    intent: 'primary',
    availability: 'available',
    unavailableReasons: [],
    git: { commit: 'c'.repeat(40), dirty: false },
    driver: profile.driver,
    values: { ...profile.requirements },
    ...overrides,
  };
}

export function rawResultFixture(
  profileSet,
  profileId = 'desktop-web-v1',
  overrides = {},
) {
  const counters = Object.fromEntries(
    profileSet.measurement.zeroToleranceCounters.map((id) => [id, 0]),
  );
  return {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId,
    command: `performance-${profileId}`,
    recordedAt: '2026-08-20T08:00:00.000Z',
    environment: environmentFixture(profileSet, profileId),
    acknowledgements: profileSet.measurement.branchIds.map((branchId) => ({
      branchId,
      samplesMs: Array(20).fill(100),
    })),
    distributions: profileSet.measurement.distributionIds.map(
      (distributionId) => ({
        distributionId,
        warmupsMs: Array(20).fill(100),
        samplesMs: Array(200).fill(100),
      }),
    ),
    counters,
    ...overrides,
  };
}
