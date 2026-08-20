/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  PlatformProcessError,
  runOwnedPlatformProcess,
  runQualifiedPlatformLifecycle,
} from './platform-lifecycle.mjs';
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

test('qualifies, recaptures, evaluates, cleans, then promotes', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);
  const resultsRoot = await temporaryDirectory('omnia-platform-pass-');
  const events = [];

  const outcome = await runQualifiedPlatformLifecycle({
    profileSet,
    environment,
    expectedProfileId: 'desktop-web-v1',
    resultsRoot,
    outputName: 'result.json',
    launch: async () => {
      events.push('launch');
      return { owned: true };
    },
    recapture: async ({ phase }) => {
      events.push(`recapture:${phase}`);
      return environment;
    },
    measure: async () => {
      events.push('measure');
      return rawResultFixture(profileSet, 'desktop-web-v1', { environment });
    },
    cleanup: async () => {
      events.push('cleanup');
      await assert.rejects(readFile(join(resultsRoot, 'result.json')), {
        code: 'ENOENT',
      });
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(events, [
    'launch',
    'recapture:before-sampling',
    'measure',
    'recapture:after-sampling',
    'cleanup',
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(outcome.outputPath, 'utf8')),
    outcome.result,
  );
});

test('refuses unqualified input before launch', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet, 'desktop-web-v1', {
    git: { commit: 'c'.repeat(40), dirty: true },
  });
  let launchCalls = 0;

  await assert.rejects(
    runQualifiedPlatformLifecycle({
      profileSet,
      environment,
      expectedProfileId: 'desktop-web-v1',
      resultsRoot: await temporaryDirectory('omnia-platform-refusal-'),
      outputName: 'result.json',
      launch: async () => {
        launchCalls += 1;
      },
      recapture: async () => environment,
      measure: async () => rawResultFixture(profileSet),
      cleanup: async () => undefined,
    }),
    (error) => error.preflight?.status === 'SUPPLEMENTAL',
  );
  assert.equal(launchCalls, 0);
});

test('fails closed on sampling identity drift and cleanup failure', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);

  for (const failure of ['drift', 'cleanup']) {
    const resultsRoot = await temporaryDirectory(`omnia-platform-${failure}-`);
    let measureCalls = 0;
    let cleanupCalls = 0;
    await assert.rejects(
      runQualifiedPlatformLifecycle({
        profileSet,
        environment,
        expectedProfileId: 'desktop-web-v1',
        resultsRoot,
        outputName: 'result.json',
        launch: async () => ({ owned: true }),
        recapture: async () =>
          failure === 'drift'
            ? {
                ...environment,
                git: { commit: 'd'.repeat(40), dirty: false },
              }
            : environment,
        measure: async () => {
          measureCalls += 1;
          return rawResultFixture(profileSet, 'desktop-web-v1', {
            environment,
          });
        },
        cleanup: async () => {
          cleanupCalls += 1;
          if (failure === 'cleanup') throw new Error('cleanup failed');
        },
      }),
      failure === 'drift' ? /identity drift/ : /cleanup failed/,
    );
    assert.equal(cleanupCalls, 1);
    assert.equal(measureCalls, failure === 'drift' ? 0 : 1);
    await assert.rejects(readFile(join(resultsRoot, 'result.json')), {
      code: 'ENOENT',
    });
  }
});

test('cleans partial ownership when launch fails', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);
  let cleanupCalls = 0;

  await assert.rejects(
    runQualifiedPlatformLifecycle({
      profileSet,
      environment,
      expectedProfileId: 'desktop-web-v1',
      resultsRoot: await temporaryDirectory('omnia-platform-launch-fail-'),
      outputName: 'result.json',
      launch: async () => {
        throw new Error('launch failed after reserving resources');
      },
      recapture: async () => environment,
      measure: async () => rawResultFixture(profileSet),
      cleanup: async ({ session, failure }) => {
        cleanupCalls += 1;
        assert.equal(session, undefined);
        assert.match(failure.message, /launch failed/);
      },
    }),
    /launch failed/,
  );
  assert.equal(cleanupCalls, 1);
});

test('does not promote when cancellation arrives during measurement', async () => {
  const profileSet = profileSetFixture();
  const environment = environmentFixture(profileSet);
  const controller = new AbortController();
  const resultsRoot = await temporaryDirectory('omnia-platform-abort-');
  let cleanupCalls = 0;

  await assert.rejects(
    runQualifiedPlatformLifecycle({
      profileSet,
      environment,
      expectedProfileId: 'desktop-web-v1',
      resultsRoot,
      outputName: 'result.json',
      signal: controller.signal,
      launch: async () => ({ owned: true }),
      recapture: async () => environment,
      measure: async () => {
        controller.abort(new Error('SIGTERM'));
        return rawResultFixture(profileSet, 'desktop-web-v1', { environment });
      },
      cleanup: async () => {
        cleanupCalls += 1;
      },
    }),
    (error) => error instanceof PlatformProcessError && error.aborted,
  );
  assert.equal(cleanupCalls, 1);
  await assert.rejects(readFile(join(resultsRoot, 'result.json')), {
    code: 'ENOENT',
  });
});

test('bounds diagnostics and terminates an owned process on timeout', async () => {
  const pidPath = join(
    await temporaryDirectory('omnia-platform-process-'),
    'child.pid',
  );
  await assert.rejects(
    runOwnedPlatformProcess({
      command: process.execPath,
      arguments: [
        '--input-type=module',
        '-e',
        "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.PID_PATH, String(process.pid)); process.stderr.write('x'.repeat(100000)); setInterval(() => {}, 1000);",
      ],
      environmentVariables: { PID_PATH: pidPath },
      timeoutMs: 300,
    }),
    (error) =>
      error instanceof PlatformProcessError &&
      error.timedOut &&
      error.stderr.length <= 65_536,
  );
  const childPid = Number(await readFile(pidPath, 'utf8'));
  await assert.rejects(access(`/proc/${childPid}`, constants.F_OK), {
    code: 'ENOENT',
  });
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}
