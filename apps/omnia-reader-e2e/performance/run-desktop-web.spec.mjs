/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  DesktopQualificationError,
  MeasurementProcessError,
  parseDesktopWebCliArguments,
  runDesktopMeasurementProcess,
  runQualifiedDesktopMeasurement,
} from './run-desktop-web.mjs';
import { canonicalStringify } from './performance-contract.mjs';
import { createManagementWorkload } from './management-workload.mjs';
import {
  environmentFixture,
  profileSetFixture,
  rawResultFixture,
} from './test-fixtures.mjs';

const ownedDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...ownedDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  ownedDirectories.clear();
});

test('confines CLI profile and result roots to the committed evidence contract', () => {
  const defaults = parseDesktopWebCliArguments([]);
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  assert.equal(
    defaults.profilePath,
    join(
      repositoryRoot,
      'specs/001-multi-format-books/performance/profiles-v1.json',
    ),
  );
  assert.equal(
    defaults.resultsRoot,
    join(repositoryRoot, 'specs/001-multi-format-books/performance/results'),
  );
  assert.throws(
    () =>
      parseDesktopWebCliArguments([
        '--profile',
        '/tmp/forged-performance-profile.json',
      ]),
    /usage: run-desktop-web\.mjs/,
  );
  assert.throws(
    () =>
      parseDesktopWebCliArguments([
        '--results-root',
        '/tmp/unapproved-performance-results',
      ]),
    /usage: run-desktop-web\.mjs/,
  );
});

test('refuses non-READY profiles before invoking the measurement runtime', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet, 'desktop-web-v1', {
    git: { commit: 'c'.repeat(40), dirty: true },
  });
  let measurementCalls = 0;
  const resultsRoot = await temporaryDirectory('omnia-desktop-refusal-');

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
  const resultsRoot = await temporaryDirectory('omnia-desktop-pass-');
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
  const resultsRoot = await temporaryDirectory('omnia-desktop-fail-');
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
      resultsRoot: await temporaryDirectory('omnia-desktop-drift-'),
      outputName: 'drift.json',
      measure: async () => drifted,
    }),
    /environment changed after preflight/,
  );

  const invalid = rawResultFixture(profileSet, 'desktop-web-v1', {
    environment,
  });
  invalid.acknowledgements.pop();
  const invalidRoot = await temporaryDirectory('omnia-desktop-invalid-');
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
      resultsRoot: await temporaryDirectory('omnia-desktop-path-'),
      outputName: '../escape.json',
      measure: async () =>
        rawResultFixture(profileSet, 'desktop-web-v1', { environment }),
    }),
    /output must stay inside/,
  );
});

test('runs a child-produced raw result and removes owned temporary files', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);
  const resultsRoot = await temporaryDirectory('omnia-desktop-child-pass-');
  const temporaryRoot = await temporaryDirectory('omnia-desktop-child-temp-');
  const raw = rawResultFixture(profileSet, 'desktop-web-v1', { environment });
  const workload = createManagementWorkload();

  const outcome = await runDesktopMeasurementProcess({
    profileSet,
    environment,
    workload,
    resultsRoot,
    outputName: 'desktop-child-pass.json',
    temporaryRoot,
    command: process.execPath,
    arguments: [
      '--input-type=module',
      '-e',
      "import { readFile, writeFile } from 'node:fs/promises'; const inputs = await Promise.all(['PERFORMANCE_DESKTOP_PROFILE_SET', 'PERFORMANCE_DESKTOP_ENVIRONMENT', 'PERFORMANCE_DESKTOP_WORKLOAD'].map((key) => readFile(process.env[key], 'utf8').then(JSON.parse))); if (inputs[0].profileSetId !== inputs[1].profileSetId || inputs[2].logicalBooks !== 1000) process.exit(9); await writeFile(process.env.PERFORMANCE_DESKTOP_RAW_RESULT, process.env.RAW_RESULT);",
    ],
    environmentVariables: { RAW_RESULT: canonicalStringify(raw) },
    timeoutMs: 2_000,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.disposition, 'PASS');
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('fails closed on child crash and bounds captured diagnostics', async () => {
  const fixture = qualifiedProcessFixture('omnia-desktop-child-crash-');
  await assert.rejects(
    runDesktopMeasurementProcess({
      ...(await fixture),
      command: process.execPath,
      arguments: [
        '--input-type=module',
        '-e',
        "process.stderr.write('x'.repeat(100000)); process.exit(7);",
      ],
      timeoutMs: 2_000,
    }),
    (error) =>
      error instanceof MeasurementProcessError &&
      error.exitCode === 7 &&
      error.stderr.length <= 65_536,
  );
  assert.deepEqual(await readdir((await fixture).temporaryRoot), []);
});

test('terminates timed-out and aborted child processes before cleanup', async () => {
  for (const reason of ['SIGINT', 'SIGTERM', 'timeout']) {
    const fixture = await qualifiedProcessFixture(
      `omnia-desktop-child-${reason.toLowerCase()}-`,
    );
    const pidPath = join(fixture.resultsRoot, `${reason}.pid`);
    const controller = new AbortController();
    // eslint-disable-next-line playwright/no-conditional-in-test -- Node contract iterates timeout and signal cases.
    if (reason !== 'timeout') {
      void waitForFile(pidPath).then(() => controller.abort(new Error(reason)));
    }
    await assert.rejects(
      runDesktopMeasurementProcess({
        ...fixture,
        command: process.execPath,
        arguments: [
          '--input-type=module',
          '-e',
          "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PID_PATH, String(process.pid)); setInterval(() => {}, 1000);",
        ],
        environmentVariables: { PID_PATH: pidPath },
        signal: controller.signal,
        timeoutMs: reason === 'timeout' ? 500 : 2_000,
      }),
      (error) =>
        error instanceof MeasurementProcessError &&
        (error.timedOut || error.aborted),
    );
    const childPid = Number(await readFile(pidPath, 'utf8'));
    await assert.rejects(access(`/proc/${childPid}`, constants.F_OK), {
      code: 'ENOENT',
    });
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

test('rejects invalid JSON and evaluator-forged output without promotion', async () => {
  for (const [name, rawResult] of [
    ['invalid-json', '{not-json'],
    [
      'forged-evaluation',
      canonicalStringify({
        ...rawResultFixture(profileSetFixture()),
        statistics: [],
        disposition: 'PASS',
        reasons: [],
      }),
    ],
  ]) {
    const fixture = await qualifiedProcessFixture(`omnia-desktop-${name}-`);
    await assert.rejects(
      runDesktopMeasurementProcess({
        ...fixture,
        command: process.execPath,
        arguments: [
          '--input-type=module',
          '-e',
          "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PERFORMANCE_DESKTOP_RAW_RESULT, process.env.RAW_RESULT);",
        ],
        environmentVariables: { RAW_RESULT: rawResult },
        timeoutMs: 2_000,
      }),
    );
    await assert.rejects(
      readFile(join(fixture.resultsRoot, fixture.outputName)),
      {
        code: 'ENOENT',
      },
    );
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

async function qualifiedProcessFixture(prefix) {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);
  return {
    profileSet,
    environment,
    resultsRoot: await temporaryDirectory(`${prefix}results-`),
    outputName: 'result.json',
    temporaryRoot: await temporaryDirectory(`${prefix}temp-`),
  };
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}

async function waitForFile(path) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
