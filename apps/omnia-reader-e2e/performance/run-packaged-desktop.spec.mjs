/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */
/* eslint-disable playwright/no-conditional-in-test -- Contract cases inject distinct failure modes. */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { canonicalStringify } from './performance-contract.mjs';
import { createManagementWorkload } from './management-workload.mjs';
import { profileSetV2Fixture } from './platform-test-fixtures.mjs';
import {
  PackagedDesktopProcessError,
  parsePackagedDesktopCliArguments,
  runPackagedDesktopMeasurementProcess,
} from './run-packaged-desktop.mjs';
import { environmentFixture, rawResultFixture } from './test-fixtures.mjs';

const ownedDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...ownedDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  ownedDirectories.clear();
});

test('confines packaged CLI profiles and results to the committed contract', () => {
  const options = parsePackagedDesktopCliArguments([]);
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  assert.equal(
    options.profilePath,
    join(
      repositoryRoot,
      'specs/001-multi-format-books/performance/profiles-v2.json',
    ),
  );
  assert.equal(
    options.resultsRoot,
    join(repositoryRoot, 'specs/001-multi-format-books/performance/results'),
  );
  assert.throws(
    () => parsePackagedDesktopCliArguments(['--profile', '/tmp/forged.json']),
    /usage: run-packaged-desktop\.mjs/,
  );
  assert.throws(
    () =>
      parsePackagedDesktopCliArguments([
        '--results-root',
        '/tmp/unapproved-results',
      ]),
    /usage: run-packaged-desktop\.mjs/,
  );
  assert.equal(parsePackagedDesktopCliArguments(['--smoke']).smoke, true);
});

test('evaluates exact primary cardinality and promotes only after cleanup', async () => {
  const fixture = await qualifiedProcessFixture('omnia-packaged-pass-');
  const events = [];
  fixture.launch = async () => {
    events.push('launch');
    return sessionFixture();
  };
  fixture.recapture = async ({ phase, session }) => {
    await session.assertRunning();
    events.push(`recapture:${phase}`);
    return fixture.environment;
  };
  fixture.cleanup = async ({ session }) => {
    events.push('cleanup');
    await session?.cleanup();
  };
  const raw = rawResultFixture(fixture.profileSet, 'packaged-desktop-v2', {
    environment: fixture.environment,
  });

  const outcome = await runPackagedDesktopMeasurementProcess({
    ...fixture,
    command: process.execPath,
    arguments: [
      '--input-type=module',
      '-e',
      "import { writeFile } from 'node:fs/promises'; if (process.env.PERFORMANCE_PACKAGED_DESKTOP_ENDPOINT !== 'http://127.0.0.1:4444' || process.env.PERFORMANCE_PACKAGED_DESKTOP_SESSION_ID !== 'fixture-session') process.exit(9); await writeFile(process.env.PERFORMANCE_PACKAGED_DESKTOP_RAW_RESULT, process.env.RAW_RESULT);",
    ],
    environmentVariables: { RAW_RESULT: canonicalStringify(raw) },
    timeoutMs: 2_000,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.acknowledgements.length, 14);
  assert.equal(outcome.result.distributions.length, 5);
  assert.deepEqual(events, [
    'launch',
    'recapture:before-sampling',
    'recapture:after-sampling',
    'cleanup',
  ]);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  assert.deepEqual(
    JSON.parse(await readFile(outcome.outputPath, 'utf8')),
    outcome.result,
  );
});

test('records incomplete cardinality as FAIL and rejects evaluator-forged output', async () => {
  const incomplete = await qualifiedProcessFixture(
    'omnia-packaged-cardinality-',
  );
  const incompleteRaw = rawResultFixture(
    incomplete.profileSet,
    'packaged-desktop-v2',
    { environment: incomplete.environment },
  );
  incompleteRaw.acknowledgements.pop();
  const incompleteOutcome = await runPackagedDesktopMeasurementProcess({
    ...incomplete,
    command: process.execPath,
    arguments: [
      '--input-type=module',
      '-e',
      "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PERFORMANCE_PACKAGED_DESKTOP_RAW_RESULT, process.env.RAW_RESULT);",
    ],
    environmentVariables: {
      RAW_RESULT: canonicalStringify(incompleteRaw),
    },
    timeoutMs: 2_000,
  });
  assert.equal(incompleteOutcome.exitCode, 2);
  assert.equal(incompleteOutcome.result.disposition, 'FAIL');

  const forged = await qualifiedProcessFixture('omnia-packaged-forged-');
  const forgedRaw = rawResultFixture(forged.profileSet, 'packaged-desktop-v2', {
    environment: forged.environment,
    disposition: 'PASS',
  });
  await assert.rejects(
    runPackagedDesktopMeasurementProcess({
      ...forged,
      command: process.execPath,
      arguments: [
        '--input-type=module',
        '-e',
        "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PERFORMANCE_PACKAGED_DESKTOP_RAW_RESULT, process.env.RAW_RESULT);",
      ],
      environmentVariables: { RAW_RESULT: canonicalStringify(forgedRaw) },
      timeoutMs: 2_000,
    }),
  );
  await assert.rejects(readFile(join(forged.resultsRoot, forged.outputName)), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readdir(forged.temporaryRoot), []);
});

test('fails closed on child crash, timeout, and automation disconnect', async () => {
  for (const failure of ['crash', 'timeout', 'disconnect']) {
    const fixture = await qualifiedProcessFixture(`omnia-packaged-${failure}-`);
    let cleanupCalls = 0;
    let recaptures = 0;
    fixture.cleanup = async ({ session }) => {
      cleanupCalls += 1;
      await session?.cleanup();
    };
    fixture.recapture = async () => {
      recaptures += 1;
      if (failure === 'disconnect' && recaptures === 2) {
        throw new Error('external WebDriver disconnected after sampling');
      }
      return fixture.environment;
    };
    const raw = rawResultFixture(fixture.profileSet, 'packaged-desktop-v2', {
      environment: fixture.environment,
    });
    const arguments_ =
      failure === 'crash'
        ? ['--input-type=module', '-e', 'process.exit(7)']
        : failure === 'timeout'
          ? ['--input-type=module', '-e', 'setInterval(() => {}, 1000)']
          : [
              '--input-type=module',
              '-e',
              "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PERFORMANCE_PACKAGED_DESKTOP_RAW_RESULT, process.env.RAW_RESULT);",
            ];

    await assert.rejects(
      runPackagedDesktopMeasurementProcess({
        ...fixture,
        command: process.execPath,
        arguments: arguments_,
        environmentVariables: { RAW_RESULT: canonicalStringify(raw) },
        timeoutMs: failure === 'timeout' ? 250 : 2_000,
      }),
      failure === 'crash'
        ? (error) =>
            error instanceof PackagedDesktopProcessError && error.exitCode === 7
        : undefined,
    );
    assert.equal(cleanupCalls, 1);
    await assert.rejects(
      readFile(join(fixture.resultsRoot, fixture.outputName)),
      { code: 'ENOENT' },
    );
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

async function qualifiedProcessFixture(prefix) {
  const profileSet = profileSetV2Fixture();
  const environment = environmentFixture(profileSet, 'packaged-desktop-v2');
  return {
    profileSet,
    environment,
    workload: createManagementWorkload(),
    resultsRoot: await temporaryDirectory(`${prefix}results-`),
    outputName: 'packaged-desktop.json',
    temporaryRoot: await temporaryDirectory(`${prefix}temp-`),
    launch: async () => sessionFixture(),
    recapture: async () => environment,
    cleanup: async ({ session }) => session?.cleanup(),
  };
}

function sessionFixture() {
  return {
    endpoint: 'http://127.0.0.1:4444',
    sessionId: 'fixture-session',
    assertRunning: async () => undefined,
    cleanup: async () => undefined,
  };
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}
