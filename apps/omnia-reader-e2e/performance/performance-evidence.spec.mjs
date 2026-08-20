/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  EvidenceValidationError,
  atomicWriteEvidence,
} from './performance-contract.mjs';
import {
  aggregateResults,
  evaluateRawResult,
  distributionStatistics,
} from './performance-evidence.mjs';
import {
  PROFILE_IDS,
  environmentFixture,
  profileSetFixture,
  rawResultFixture,
} from './test-fixtures.mjs';

test('computes deterministic nearest-rank statistics from raw samples', () => {
  assert.deepEqual(distributionStatistics([1, 2, 3, 4, 100], 4), {
    count: 5,
    p50Ms: 3,
    p95Ms: 100,
    maxMs: 100,
    withinTargetRatio: 0.8,
  });
  assert.deepEqual(distributionStatistics([1, 2, 3, 4], 4), {
    count: 4,
    p50Ms: 2.5,
    p95Ms: 4,
    maxMs: 4,
    withinTargetRatio: 1,
  });
});

test('passes complete primary evidence and fails measured threshold violations', () => {
  const profileSet = profileSetFixture();
  const passing = evaluateRawResult(profileSet, rawResultFixture(profileSet));
  assert.equal(passing.disposition, 'PASS');
  assert.equal(passing.statistics.length, 5);

  const slow = rawResultFixture(profileSet);
  slow.distributions[0].samplesMs[189] = 2_001;
  slow.distributions[0].samplesMs[190] = 2_001;
  slow.distributions[0].samplesMs[191] = 2_001;
  slow.distributions[0].samplesMs[192] = 2_001;
  slow.distributions[0].samplesMs[193] = 2_001;
  slow.distributions[0].samplesMs[194] = 2_001;
  slow.distributions[0].samplesMs[195] = 2_001;
  slow.distributions[0].samplesMs[196] = 2_001;
  slow.distributions[0].samplesMs[197] = 2_001;
  slow.distributions[0].samplesMs[198] = 2_001;
  slow.distributions[0].samplesMs[199] = 2_001;
  const failed = evaluateRawResult(profileSet, slow);
  assert.equal(failed.disposition, 'FAIL');
  assert.ok(failed.reasons.some((reason) => reason.code === 'P95_EXCEEDED'));
});

test('fails incomplete evidence while rejecting duplicate, malformed, or inconsistent input', () => {
  const profileSet = profileSetFixture();
  const missing = rawResultFixture(profileSet);
  missing.acknowledgements.pop();
  assert.equal(evaluateRawResult(profileSet, missing).disposition, 'FAIL');

  const insufficient = rawResultFixture(profileSet);
  insufficient.distributions[0].samplesMs.length = 199;
  assert.equal(evaluateRawResult(profileSet, insufficient).disposition, 'FAIL');

  const duplicate = rawResultFixture(profileSet);
  duplicate.acknowledgements.push(duplicate.acknowledgements[0]);
  assert.throws(
    () => evaluateRawResult(profileSet, duplicate),
    EvidenceValidationError,
  );

  const negative = rawResultFixture(profileSet);
  negative.distributions[0].samplesMs[0] = -1;
  assert.throws(
    () => evaluateRawResult(profileSet, negative),
    EvidenceValidationError,
  );

  const inconsistent = rawResultFixture(profileSet);
  inconsistent.distributions[0].summary = {
    count: 200,
    p50Ms: 999,
    p95Ms: 999,
    maxMs: 999,
    withinTargetRatio: 1,
  };
  assert.throws(
    () => evaluateRawResult(profileSet, inconsistent),
    /producer summary/,
  );
});

test('preserves valid UNVERIFIED and SUPPLEMENTAL evidence without measurements', () => {
  const profileSet = profileSetFixture();
  for (const [status, environment] of [
    [
      'UNVERIFIED',
      environmentFixture(profileSet, 'desktop-web-v1', {
        availability: 'unavailable',
        unavailableReasons: ['host unavailable'],
      }),
    ],
    [
      'SUPPLEMENTAL',
      environmentFixture(profileSet, 'desktop-web-v1', {
        intent: 'supplemental',
      }),
    ],
  ]) {
    const result = evaluateRawResult(
      profileSet,
      rawResultFixture(profileSet, 'desktop-web-v1', {
        environment,
        acknowledgements: [],
        distributions: [],
      }),
    );
    assert.equal(result.disposition, status);
    assert.deepEqual(result.statistics, []);
  }
});

test('aggregates exactly four current primary passes without pooling samples', () => {
  const profileSet = profileSetFixture();
  const results = PROFILE_IDS.map((profileId) =>
    rawResultFixture(profileSet, profileId),
  );
  const passed = aggregateResults(profileSet, results);
  assert.equal(passed.status, 'PASS');
  assert.equal(passed.results.length, 4);
  assert.equal('samplesMs' in passed, false);

  const missing = aggregateResults(profileSet, results.slice(0, 3));
  assert.equal(missing.status, 'INCOMPLETE');
  assert.ok(
    missing.blocking.some((reason) => reason.code === 'MISSING_PROFILE'),
  );

  assert.throws(
    () => aggregateResults(profileSet, [...results, results[0]]),
    /duplicate profile/,
  );

  const supplemental = rawResultFixture(profileSet, 'android-v1', {
    environment: environmentFixture(profileSet, 'android-v1', {
      intent: 'supplemental',
    }),
    acknowledgements: [],
    distributions: [],
  });
  const incomplete = aggregateResults(profileSet, [
    ...results.slice(0, 3),
    supplemental,
  ]);
  assert.equal(incomplete.status, 'INCOMPLETE');
});

test('writes canonical evidence only beneath the allowed root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnia-evidence-root-'));
  const output = await atomicWriteEvidence(root, 'result.json', { z: 1, a: 2 });
  assert.equal(output, join(root, 'result.json'));
  assert.equal(await readFile(output, 'utf8'), '{"a":2,"z":1}\n');
  await assert.rejects(
    () => atomicWriteEvidence(root, '../escape.json', { invalid: true }),
    /inside the performance results directory/,
  );
  await assert.rejects(
    () => atomicWriteEvidence(root, '..\\escape.json', { invalid: true }),
    /inside the performance results directory/,
  );
});

test('evidence CLI exits 0 only for complete passing acceptance', async () => {
  const profileSet = profileSetFixture();
  const directory = await mkdtemp(join(tmpdir(), 'omnia-evidence-test-'));
  const profilePath = join(directory, 'profiles.json');
  const resultPaths = [];
  await writeFile(profilePath, `${JSON.stringify(profileSet)}\n`);
  for (const profileId of PROFILE_IDS) {
    const path = join(directory, `${profileId}.json`);
    await writeFile(
      path,
      `${JSON.stringify(rawResultFixture(profileSet, profileId))}\n`,
    );
    resultPaths.push(path);
  }
  const command = 'apps/omnia-reader-e2e/performance/performance-evidence.mjs';

  const evaluate = spawnSync(
    process.execPath,
    [command, 'evaluate', profilePath, resultPaths[0]],
    { encoding: 'utf8' },
  );
  assert.equal(evaluate.status, 0, evaluate.stderr);
  assert.equal(JSON.parse(evaluate.stdout).disposition, 'PASS');

  const incomplete = spawnSync(
    process.execPath,
    [command, 'aggregate', profilePath, ...resultPaths.slice(0, 3)],
    { encoding: 'utf8' },
  );
  assert.equal(incomplete.status, 2, incomplete.stderr);
  assert.equal(JSON.parse(incomplete.stdout).status, 'INCOMPLETE');

  const complete = spawnSync(
    process.execPath,
    [command, 'aggregate', profilePath, ...resultPaths],
    { encoding: 'utf8' },
  );
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).status, 'PASS');
});
