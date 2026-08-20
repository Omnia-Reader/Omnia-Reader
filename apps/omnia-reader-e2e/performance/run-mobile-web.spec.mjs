/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */
/* eslint-disable playwright/no-conditional-in-test -- Contract cases inject distinct failure modes. */

import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { canonicalStringify } from './performance-contract.mjs';
import { createManagementWorkload } from './management-workload.mjs';
import { profileSetV2Fixture } from './platform-test-fixtures.mjs';
import {
  MobileWebProcessError,
  runMobileWebMeasurementProcess,
} from './run-mobile-web.mjs';
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

test('runs a qualified CDP child and promotes only after recapture and cleanup', async () => {
  const fixture = await qualifiedProcessFixture('omnia-mobile-pass-');
  const events = [];
  fixture.launch = async () => {
    events.push('launch');
    return { cdpEndpoint: 'http://127.0.0.1:9222' };
  };
  fixture.recapture = async ({ phase }) => {
    events.push(`recapture:${phase}`);
    return fixture.environment;
  };
  fixture.cleanup = async () => {
    events.push('cleanup');
  };
  const raw = rawResultFixture(fixture.profileSet, 'mobile-web-v2', {
    environment: fixture.environment,
  });

  const outcome = await runMobileWebMeasurementProcess({
    ...fixture,
    command: process.execPath,
    arguments: [
      '--input-type=module',
      '-e',
      "import { writeFile } from 'node:fs/promises'; if (process.env.PERFORMANCE_MOBILE_CDP_ENDPOINT !== 'http://127.0.0.1:9222') process.exit(9); await writeFile(process.env.PERFORMANCE_MOBILE_RAW_RESULT, process.env.RAW_RESULT);",
    ],
    environmentVariables: { RAW_RESULT: canonicalStringify(raw) },
    timeoutMs: 2_000,
  });

  assert.equal(outcome.exitCode, 0);
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

test('fails closed on child crash, invalid result, and CDP disconnect', async () => {
  for (const failure of ['crash', 'invalid-result', 'disconnect']) {
    const fixture = await qualifiedProcessFixture(`omnia-mobile-${failure}-`);
    let cleanupCalls = 0;
    let recaptures = 0;
    fixture.cleanup = async () => {
      cleanupCalls += 1;
    };
    fixture.recapture = async () => {
      recaptures += 1;
      if (failure === 'disconnect' && recaptures === 2) {
        throw new Error('CDP disconnected after sampling');
      }
      return fixture.environment;
    };
    const raw = rawResultFixture(fixture.profileSet, 'mobile-web-v2', {
      environment: fixture.environment,
    });
    const rawText =
      failure === 'invalid-result' ? '{not-json' : canonicalStringify(raw);
    const arguments_ =
      failure === 'crash'
        ? [
            '--input-type=module',
            '-e',
            "process.stderr.write('mobile crash'); process.exit(7);",
          ]
        : [
            '--input-type=module',
            '-e',
            "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PERFORMANCE_MOBILE_RAW_RESULT, process.env.RAW_RESULT);",
          ];

    await assert.rejects(
      runMobileWebMeasurementProcess({
        ...fixture,
        command: process.execPath,
        arguments: arguments_,
        environmentVariables: { RAW_RESULT: rawText },
        timeoutMs: 2_000,
      }),
      failure === 'crash'
        ? (error) =>
            error instanceof MobileWebProcessError && error.exitCode === 7
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

test('terminates timed-out and signalled measurement children without promotion', async () => {
  for (const reason of ['timeout', 'SIGINT', 'SIGTERM']) {
    const fixture = await qualifiedProcessFixture(
      `omnia-mobile-${reason.toLowerCase()}-`,
    );
    const pidPath = join(fixture.resultsRoot, `${reason}.pid`);
    const controller = new AbortController();
    if (reason !== 'timeout') {
      void waitForFile(pidPath).then(() => controller.abort(new Error(reason)));
    }

    await assert.rejects(
      runMobileWebMeasurementProcess({
        ...fixture,
        command: process.execPath,
        arguments: [
          '--input-type=module',
          '-e',
          "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PID_PATH, String(process.pid)); setInterval(() => {}, 1000);",
        ],
        environmentVariables: { PID_PATH: pidPath },
        signal: controller.signal,
        timeoutMs: reason === 'timeout' ? 300 : 2_000,
      }),
      (error) =>
        error instanceof MobileWebProcessError &&
        (error.timedOut || error.aborted),
    );
    const childPid = Number(await readFile(pidPath, 'utf8'));
    await assert.rejects(access(`/proc/${childPid}`, constants.F_OK), {
      code: 'ENOENT',
    });
    await assert.rejects(
      readFile(join(fixture.resultsRoot, fixture.outputName)),
      { code: 'ENOENT' },
    );
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

async function qualifiedProcessFixture(prefix) {
  const profileSet = profileSetV2Fixture();
  const environment = environmentFixture(profileSet, 'mobile-web-v2');
  return {
    profileSet,
    environment,
    workload: createManagementWorkload(),
    resultsRoot: await temporaryDirectory(`${prefix}results-`),
    outputName: 'mobile-web.json',
    temporaryRoot: await temporaryDirectory(`${prefix}temp-`),
    launch: async () => ({ cdpEndpoint: 'http://127.0.0.1:9222' }),
    recapture: async () => environment,
    cleanup: async () => undefined,
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
