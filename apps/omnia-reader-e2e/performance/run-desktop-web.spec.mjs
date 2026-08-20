/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DesktopQualificationError,
  runQualifiedDesktopMeasurement,
} from './run-desktop-web.mjs';
import {
  environmentFixture,
  profileSetFixture,
  rawResultFixture,
} from './test-fixtures.mjs';

test('refuses non-READY profiles before invoking the measurement runtime', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet, 'desktop-web-v1', {
    git: { commit: 'c'.repeat(40), dirty: true },
  });
  let measurementCalls = 0;
  const resultsRoot = await mkdtemp(join(tmpdir(), 'omnia-desktop-refusal-'));

  await assert.rejects(
    runQualifiedDesktopMeasurement({
      profileSet,
      environment,
      resultsRoot,
      outputName: 'refused.json',
      measure: async () => {
        measurementCalls += 1;
        return rawResultFixture(profileSet);
      },
    }),
    (error) =>
      error instanceof DesktopQualificationError &&
      error.preflight.status === 'SUPPLEMENTAL',
  );
  assert.equal(measurementCalls, 0);
  await assert.rejects(readFile(join(resultsRoot, 'refused.json')), {
    code: 'ENOENT',
  });
});

test('evaluates and atomically writes one complete passing desktop result', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);
  const resultsRoot = await mkdtemp(join(tmpdir(), 'omnia-desktop-pass-'));
  const raw = rawResultFixture(profileSet, 'desktop-web-v1', { environment });

  const outcome = await runQualifiedDesktopMeasurement({
    profileSet,
    environment,
    resultsRoot,
    outputName: 'desktop-pass.json',
    measure: async () => raw,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.disposition, 'PASS');
  assert.equal(outcome.preflight.status, 'READY');
  assert.equal(outcome.outputPath, join(resultsRoot, 'desktop-pass.json'));
  assert.deepEqual(
    JSON.parse(await readFile(outcome.outputPath, 'utf8')),
    outcome.result,
  );
});

test('preserves threshold FAIL as valid evidence with exit code two', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);
  const resultsRoot = await mkdtemp(join(tmpdir(), 'omnia-desktop-fail-'));
  const raw = rawResultFixture(profileSet, 'desktop-web-v1', { environment });
  raw.distributions[0].samplesMs.fill(2_001);

  const outcome = await runQualifiedDesktopMeasurement({
    profileSet,
    environment,
    resultsRoot,
    outputName: 'desktop-fail.json',
    measure: async () => raw,
  });

  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.result.disposition, 'FAIL');
  assert.deepEqual(
    JSON.parse(await readFile(outcome.outputPath, 'utf8')),
    outcome.result,
  );
});

test('rejects environment drift, invalid raw evidence, and unconfined output', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);

  const drifted = rawResultFixture(profileSet, 'desktop-web-v1', {
    environment: {
      ...environment,
      git: { commit: 'd'.repeat(40), dirty: false },
    },
  });
  await assert.rejects(
    runQualifiedDesktopMeasurement({
      profileSet,
      environment,
      resultsRoot: await mkdtemp(join(tmpdir(), 'omnia-desktop-drift-')),
      outputName: 'drift.json',
      measure: async () => drifted,
    }),
    /environment changed after preflight/,
  );

  const invalid = rawResultFixture(profileSet, 'desktop-web-v1', {
    environment,
  });
  invalid.acknowledgements.pop();
  const invalidRoot = await mkdtemp(join(tmpdir(), 'omnia-desktop-invalid-'));
  const invalidOutcome = await runQualifiedDesktopMeasurement({
    profileSet,
    environment,
    resultsRoot: invalidRoot,
    outputName: 'invalid.json',
    measure: async () => invalid,
  });
  assert.equal(invalidOutcome.exitCode, 2);
  assert.equal(invalidOutcome.result.disposition, 'FAIL');

  await assert.rejects(
    runQualifiedDesktopMeasurement({
      profileSet,
      environment,
      resultsRoot: await mkdtemp(join(tmpdir(), 'omnia-desktop-path-')),
      outputName: '../escape.json',
      measure: async () =>
        rawResultFixture(profileSet, 'desktop-web-v1', { environment }),
    }),
    /output must stay inside/,
  );
});
