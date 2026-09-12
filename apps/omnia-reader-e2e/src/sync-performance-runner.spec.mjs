/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SyncPerformanceValidationError,
  assertSyncPerformanceProfile,
  runSyncPerformanceMeasurements,
} from './sync-performance-runner.mjs';

const profilePath = fileURLToPath(
  new URL('./sync-performance-profile.json', import.meta.url),
);

test('accepts only the fixed synchronization staging profile', async () => {
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));

  assert.equal(assertSyncPerformanceProfile(profile), profile);
  for (const drifted of [
    { ...profile, unexpected: true },
    { ...profile, devices: 1 },
    { ...profile, resources: { ...profile.resources, logicalCpu: 4 } },
    {
      ...profile,
      network: { ...profile.network, roundTripTimeMs: 0 },
    },
    {
      ...profile,
      measurement: { ...profile.measurement, warmupAttempts: 0 },
    },
    {
      ...profile,
      measurement: { ...profile.measurement, measuredAttempts: 199 },
    },
  ]) {
    assert.throws(
      () => assertSyncPerformanceProfile(drifted),
      SyncPerformanceValidationError,
    );
  }
});

test('discards 20 warm-ups and preserves 200 recomputable two-device samples', async () => {
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  const attempts = [];
  let clock = 0;
  const result = await runSyncPerformanceMeasurements({
    profile,
    qualification: exactQualification(profile),
    now: () => new Date(1_800_000_000_000 + clock++).toISOString(),
    measureTwoDeviceAttempt: async ({ phase, attempt }) => {
      attempts.push(`${phase}:${attempt}`);
      return {
        manualSyncDurationMs:
          phase === 'measurement' && attempt >= 190 ? 2100 : 1000,
        remoteVisibilityDurationMs: 12000,
        publicationTransfers: 0,
      };
    },
  });

  assert.equal(attempts.length, 220);
  assert.deepEqual(attempts.slice(0, 2), ['warmup:0', 'warmup:1']);
  assert.equal(attempts.at(-1), 'measurement:199');
  assert.equal(result.warmups.length, 20);
  assert.equal(result.samples.length, 200);
  assert.deepEqual(result.summary, {
    count: 200,
    manualSyncP95Ms: 1000,
    manualSyncWithinTargetRatio: 0.95,
    remoteVisibilityMaxMs: 12000,
    publicationTransfers: 0,
    result: 'PASS',
  });
  assert.equal(result.profileId, 'sync-staging-v1');
  assert.equal(result.provider, 'git');
  assert.equal(result.devices, 2);
  assert.deepEqual(result.profile, profile);
  assert.deepEqual(result.qualification, exactQualification(profile));
  assert.equal(result.samples[0].startedAt.endsWith('Z'), true);
  assert.equal(result.samples[0].completedAt.endsWith('Z'), true);
});

test('fails the result for latency or publication-transfer regressions', async () => {
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  const result = await runSyncPerformanceMeasurements({
    profile,
    qualification: exactQualification(profile),
    measureTwoDeviceAttempt: async ({ phase, attempt }) => ({
      manualSyncDurationMs:
        phase === 'measurement' && attempt >= 189 ? 2500 : 500,
      remoteVisibilityDurationMs:
        phase === 'measurement' && attempt === 0 ? 15001 : 5000,
      publicationTransfers: phase === 'measurement' && attempt === 1 ? 1 : 0,
    }),
  });

  assert.equal(result.summary.result, 'FAIL');
  assert.equal(result.summary.manualSyncWithinTargetRatio, 0.945);
  assert.equal(result.summary.remoteVisibilityMaxMs, 15001);
  assert.equal(result.summary.publicationTransfers, 1);
});

test('refuses unqualified environments and malformed adapter samples', async () => {
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  let attempts = 0;
  await assert.rejects(
    runSyncPerformanceMeasurements({
      profile,
      qualification: {
        ...exactQualification(profile),
        network: { ...profile.network, roundTripTimeMs: 80 },
      },
      measureTwoDeviceAttempt: async () => {
        attempts += 1;
        return validSample();
      },
    }),
    /qualification/,
  );
  assert.equal(attempts, 0);

  await assert.rejects(
    runSyncPerformanceMeasurements({
      profile,
      qualification: exactQualification(profile),
      measureTwoDeviceAttempt: async () => ({
        ...validSample(),
        remoteVisibilityDurationMs: -1,
      }),
    }),
    SyncPerformanceValidationError,
  );
});

function exactQualification(profile) {
  return {
    profileId: profile.profileId,
    provider: profile.provider,
    devices: profile.devices,
    resources: { ...profile.resources },
    network: { ...profile.network },
    synchronization: { ...profile.synchronization },
  };
}

function validSample() {
  return {
    manualSyncDurationMs: 1000,
    remoteVisibilityDurationMs: 12000,
    publicationTransfers: 0,
  };
}
