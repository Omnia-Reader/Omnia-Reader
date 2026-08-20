/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonFile } from './performance-contract.mjs';
import { createManagementWorkload } from './management-workload.mjs';
import {
  assertSamplingIdentity,
  runPrimaryManagementMeasurement,
} from './primary-management-run.mjs';
import { environmentFixture } from './test-fixtures.mjs';

test('runs the exact serial primary branch and distribution cardinality', async () => {
  const fixture = await primaryFixture();
  const branchCalls = [];
  const distributionCalls = [];

  const result = await runPrimaryManagementMeasurement({
    ...fixture,
    command: 'performance-desktop-web',
    recordedAt: () => '2026-08-20T09:00:00.000Z',
    runBranchSample: async ({ branch, sampleIndex }) => {
      branchCalls.push(`${branch.id}:${sampleIndex}`);
      return {
        acknowledgementMs: 10 + sampleIndex,
        finalResultMs: 20 + sampleIndex,
      };
    },
    runDistributionSample: async ({ distribution, phase, sampleIndex }) => {
      distributionCalls.push(`${distribution.id}:${phase}:${sampleIndex}`);
      return { finalResultMs: 30 + sampleIndex };
    },
    readCounters: async () => ({
      consoleErrors: 0,
      missingAcknowledgements: 0,
      overlappingEngines: 0,
      wrongResults: 0,
    }),
  });

  assert.equal(branchCalls.length, 14 * 20);
  assert.equal(branchCalls[0], 'add-local-success:0');
  assert.equal(branchCalls.at(-1), 'restore-failure:19');
  assert.equal(distributionCalls.length, 5 * (20 + 200));
  assert.equal(distributionCalls[0], 'filter:warmup:0');
  assert.equal(distributionCalls.at(-1), 'switch-pdf-to-epub:sample:199');
  assert.equal(result.recordedAt, '2026-08-20T09:00:00.000Z');
  assert.deepEqual(
    result.acknowledgements.map(({ branchId, samplesMs }) => [
      branchId,
      samplesMs.length,
    ]),
    fixture.profileSet.measurement.branchIds.map((branchId) => [branchId, 20]),
  );
  assert.deepEqual(
    result.distributions.map(({ distributionId, warmupsMs, samplesMs }) => [
      distributionId,
      warmupsMs.length,
      samplesMs.length,
    ]),
    fixture.profileSet.measurement.distributionIds.map((distributionId) => [
      distributionId,
      20,
      200,
    ]),
  );
  assert.deepEqual(result.counters, {
    consoleErrors: 0,
    missingAcknowledgements: 0,
    overlappingEngines: 0,
    wrongResults: 0,
  });
});

test('refuses sampling identity drift before invoking a measurement adapter', async () => {
  const fixture = await primaryFixture();
  const invalid = [
    {
      ...fixture.samplingIdentity,
      profileSetDigest: `sha256:${'0'.repeat(64)}`,
    },
    {
      ...fixture.samplingIdentity,
      git: { ...fixture.samplingIdentity.git, dirty: true },
    },
    {
      ...fixture.samplingIdentity,
      dataset: {
        ...fixture.samplingIdentity.dataset,
        workloadDigest: `sha256:${'0'.repeat(64)}`,
      },
    },
    {
      ...fixture.samplingIdentity,
      browser: { ...fixture.samplingIdentity.browser, version: '0.0.0.0' },
    },
    {
      ...fixture.samplingIdentity,
      viewport: { ...fixture.samplingIdentity.viewport, width: 1_365 },
    },
    {
      ...fixture.samplingIdentity,
      constraints: { ...fixture.samplingIdentity.constraints, cpuQuota: 3 },
    },
  ];
  let calls = 0;

  for (const samplingIdentity of invalid) {
    assert.throws(() =>
      assertSamplingIdentity(
        fixture.profileSet,
        fixture.environment,
        fixture.workload,
        samplingIdentity,
      ),
    );
    await assert.rejects(
      runPrimaryManagementMeasurement({
        ...fixture,
        samplingIdentity,
        command: 'performance-desktop-web',
        runBranchSample: async () => {
          calls += 1;
          return { acknowledgementMs: 1, finalResultMs: 2 };
        },
        runDistributionSample: async () => {
          calls += 1;
          return { finalResultMs: 2 };
        },
        readCounters: async () => ({
          consoleErrors: 0,
          missingAcknowledgements: 0,
          overlappingEngines: 0,
          wrongResults: 0,
        }),
      }),
    );
  }
  assert.equal(calls, 0);
});

test('rejects invalid adapter timings and incomplete counters', async () => {
  const fixture = await primaryFixture();
  const validCounters = async () => ({
    consoleErrors: 0,
    missingAcknowledgements: 0,
    overlappingEngines: 0,
    wrongResults: 0,
  });

  await assert.rejects(
    runPrimaryManagementMeasurement({
      ...fixture,
      command: 'performance-desktop-web',
      runBranchSample: async () => ({
        acknowledgementMs: 10,
        finalResultMs: 9,
      }),
      runDistributionSample: async () => ({ finalResultMs: 1 }),
      readCounters: validCounters,
    }),
    /finalResultMs/,
  );

  await assert.rejects(
    runPrimaryManagementMeasurement({
      ...fixture,
      command: 'performance-desktop-web',
      runBranchSample: async () => ({
        acknowledgementMs: 1,
        finalResultMs: 2,
      }),
      runDistributionSample: async () => ({ finalResultMs: Number.NaN }),
      readCounters: validCounters,
    }),
    /finalResultMs/,
  );

  await assert.rejects(
    runPrimaryManagementMeasurement({
      ...fixture,
      command: 'performance-desktop-web',
      runBranchSample: async () => ({
        acknowledgementMs: 1,
        finalResultMs: 2,
      }),
      runDistributionSample: async () => ({ finalResultMs: 2 }),
      readCounters: async () => ({ consoleErrors: 0 }),
    }),
    /counters/,
  );
});

async function primaryFixture() {
  const profileSet = await readJsonFile(
    'specs/001-multi-format-books/performance/profiles-v1.json',
  );
  const environment = environmentFixture(profileSet);
  const workload = createManagementWorkload();
  const [width, height] = environment.values['environment.viewport']
    .split('x')
    .map(Number);
  const samplingIdentity = {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId: environment.profileId,
    git: { ...environment.git },
    dataset: {
      recipeDigest: workload.recipeDigest,
      workloadDigest: workload.workloadDigest,
      logicalBooks: workload.logicalBooks,
      exactVariants: workload.exactVariants,
      logicalChangeHistory: workload.logicalChangeHistory,
    },
    browser: {
      name: environment.values['runtime.browserName'],
      version: environment.values['runtime.browserVersion'],
    },
    viewport: {
      width,
      height,
      deviceScaleFactor: environment.values['environment.deviceScaleFactor'],
    },
    constraints: {
      scope: environment.values['environment.constraintScope'],
      cpuQuota: environment.values['environment.cpuQuota'],
      memoryLimitBytes: environment.values['environment.memoryLimitBytes'],
      powerMode: environment.values['environment.powerMode'],
    },
  };
  return { profileSet, environment, workload, samplingIdentity };
}
