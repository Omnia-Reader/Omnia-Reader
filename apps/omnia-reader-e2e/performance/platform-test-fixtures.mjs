import { attachProfileSetDigest } from './performance-contract.mjs';
import { PLATFORM_PROFILE_IDS } from './platform-contract.mjs';
import {
  BRANCH_IDS,
  COUNTER_IDS,
  DISTRIBUTION_IDS,
  profileSetFixture,
} from './test-fixtures.mjs';

export function profileSetV1Fixture() {
  return profileSetFixture();
}

export function profileSetV2Fixture() {
  const v1 = profileSetFixture();
  return attachProfileSetDigest({
    ...v1,
    schemaVersion: 2,
    profileSetId: 'multi-format-performance-v2',
    measurement: {
      ...v1.measurement,
      branchIds: [...BRANCH_IDS],
      distributionIds: [...DISTRIBUTION_IDS],
      zeroToleranceCounters: [...COUNTER_IDS],
    },
    profiles: PLATFORM_PROFILE_IDS[2].map((id) => ({
      id,
      platform: id.replace(/-v2$/, ''),
      driver: `run-${id.replace(/-v2$/, '')}`,
      qualification: 'complete',
      unresolvedRequirements: [],
      requirements: {
        'dataset.recipeDigest': v1.dataset.recipeDigest,
        'environment.profileMarker': id,
        'source.nodeVersion': 'v26.5.0',
        'source.packageLockSha256': `sha256:${'b'.repeat(64)}`,
      },
    })),
  });
}
