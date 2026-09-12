/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runNativeSyncJourney,
  validateNativeSyncEvidence,
} from './run-native-sync-e2e.mjs';

const request = {
  schemaVersion: 1,
  operation: 'run-packaged-sync-conformance',
  host: 'linux',
  runId: 'native-run-1',
  candidate: { commit: 'a'.repeat(40), release: '0.1.0-rc.1' },
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  limits: {
    transferBytes: 25 * 1024 * 1024,
    maxBufferedBytes: 8 * 1024 * 1024,
    maxRssDeltaBytes: 64 * 1024 * 1024,
  },
};

test('accepts complete local-first packaged conformance evidence', () => {
  const report = passingReport();
  assert.deepEqual(validateNativeSyncEvidence(report, request), report);
});

test('wires protected conformance behind an explicit native journey gate', async () => {
  const nativeRunner = await readFile(
    new URL('./run-native-e2e.mjs', import.meta.url),
    'utf8',
  );
  assert.match(nativeRunner, /OMNIA_NATIVE_SYNC_E2E.*=== '1'/);
  assert.match(nativeRunner, /run-native-sync-e2e\.mjs/);
  assert.ok(
    nativeRunner.indexOf('await main();') <
      nativeRunner.indexOf("OMNIA_NATIVE_SYNC_E2E'] === '1'"),
  );
});

test('binds the protected driver request and writes no-replace evidence', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-native-sync-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'report.json');
  const observedRequests = [];
  const executeDriver = async (_path, value) => {
    observedRequests.push(value);
    return JSON.stringify(checkForOperation(value.operation));
  };
  let nowCall = 0;
  const options = {
    driverPath: '/protected/native-sync-driver',
    outputPath,
    host: request.host,
    runId: request.runId,
    candidateCommit: request.candidate.commit,
    candidateRelease: request.candidate.release,
    artifactDigest: request.artifactDigest,
    secretCanary: 'unique-protected-canary',
    protectedRunner: true,
    executeDriver,
    now: () =>
      new Date(
        nowCall++ % 2 === 0
          ? '2026-09-12T22:00:00.000Z'
          : '2026-09-12T22:01:00.000Z',
      ),
  };

  await runNativeSyncJourney(options);
  assert.equal(
    JSON.stringify(observedRequests).includes(options.secretCanary),
    false,
  );
  assert.deepEqual(
    observedRequests.slice(0, 8).map(({ operation }) => operation),
    [
      'relative-route-failure',
      'broker-connection',
      'offline-reading',
      'restart-continuity',
      'reauthentication',
      'bounded-transfer-retry',
      'secret-canary-scan',
      'scoped-cleanup',
    ],
  );
  assert.deepEqual(
    JSON.parse(await readFile(outputPath, 'utf8')),
    passingReport(),
  );
  const callsBeforeReplacement = observedRequests.length;
  await assert.rejects(
    runNativeSyncJourney(options),
    /evidence already exists/,
  );
  assert.equal(observedRequests.length, callsBeforeReplacement);
});

test('rejects unprotected execution and secret-bearing driver output', async () => {
  const options = {
    driverPath: '/protected/native-sync-driver',
    outputPath: '/unused/report.json',
    host: request.host,
    runId: request.runId,
    candidateCommit: request.candidate.commit,
    candidateRelease: request.candidate.release,
    artifactDigest: request.artifactDigest,
    secretCanary: 'unique-protected-canary',
    protectedRunner: false,
    executeDriver: async (_path, value) =>
      JSON.stringify(checkForOperation(value.operation)),
  };
  await assert.rejects(
    runNativeSyncJourney(options),
    /protected packaged runner/,
  );
  await assert.rejects(
    runNativeSyncJourney({
      ...options,
      protectedRunner: true,
      executeDriver: async (_path, value) =>
        `unique-protected-canary${JSON.stringify(checkForOperation(value.operation))}`,
    }),
    /contains the protected secret canary/,
  );
  await assert.rejects(
    runNativeSyncJourney({
      ...options,
      protectedRunner: true,
      executeDriver: async (_path, value) =>
        `${Buffer.from(options.secretCanary).toString('base64')} ${JSON.stringify(checkForOperation(value.operation))}`,
    }),
    /contains the protected secret canary/,
  );
});

test('forces scoped cleanup after an intermediate driver failure', async () => {
  const operations = [];
  await assert.rejects(
    runNativeSyncJourney({
      driverPath: '/protected/native-sync-driver',
      outputPath: '/unused/report.json',
      host: request.host,
      runId: request.runId,
      candidateCommit: request.candidate.commit,
      candidateRelease: request.candidate.release,
      artifactDigest: request.artifactDigest,
      secretCanary: 'unique-protected-canary',
      protectedRunner: true,
      executeDriver: async (_path, value) => {
        operations.push(value.operation);
        if (value.operation === 'offline-reading') {
          throw new Error('simulated driver failure');
        }
        return JSON.stringify(checkForOperation(value.operation));
      },
    }),
    /simulated driver failure/,
  );
  assert.equal(operations.at(-1), 'scoped-cleanup');
});

test('rejects weak restart, retry, resource, and cleanup claims', () => {
  for (const mutate of [
    (report) => {
      report.checks.offline.pendingOperationPreserved = false;
    },
    (report) => {
      report.checks.restart.sessionContinuity = true;
    },
    (report) => {
      report.checks.transfer.attempts = 1;
    },
    (report) => {
      report.checks.transfer.maxBufferedBytes = 8 * 1024 * 1024 + 1;
    },
    (report) => {
      report.checks.transfer.rssDeltaBytes = 64 * 1024 * 1024 + 1;
    },
    (report) => {
      report.checks.canary.locations.ipc = true;
    },
    (report) => {
      report.checks.cleanup.destinationRemoved = false;
    },
  ]) {
    const report = passingReport();
    mutate(report);
    assert.throws(() => validateNativeSyncEvidence(report, request));
  }
});

test('rejects mismatched identity and confidential report fields', () => {
  const mismatched = passingReport();
  mismatched.candidate.commit = 'c'.repeat(40);
  assert.throws(
    () => validateNativeSyncEvidence(mismatched, request),
    /candidate does not match/,
  );

  const confidential = passingReport();
  confidential.checks.offline.credential = 'not-allowed';
  assert.throws(
    () => validateNativeSyncEvidence(confidential, request),
    /fields are invalid|confidential field/,
  );
});

function passingReport() {
  return {
    schemaVersion: 1,
    host: request.host,
    runId: request.runId,
    candidate: structuredClone(request.candidate),
    artifactDigest: request.artifactDigest,
    startedAt: '2026-09-12T22:00:00.000Z',
    completedAt: '2026-09-12T22:01:00.000Z',
    durationMs: 60_000,
    checks: {
      relativeRoute: { result: 'passed', failedAsExpected: true },
      broker: {
        result: 'passed',
        connected: true,
        persistenceMode: 'session-only',
        restartRequiresReauthentication: true,
      },
      offline: {
        result: 'passed',
        publicationReadable: true,
        localMutationPreserved: true,
        pendingOperationPreserved: true,
      },
      restart: {
        result: 'passed',
        publicationReadable: true,
        localMutationPreserved: true,
        pendingOperationPreserved: true,
        sessionContinuity: false,
      },
      reauthentication: {
        result: 'passed',
        required: true,
        completed: true,
      },
      transfer: {
        result: 'passed',
        bytes: 25 * 1024 * 1024,
        attempts: 2,
        interrupted: true,
        wholeTransferRetry: true,
        cancelled: true,
        progressMonotonic: true,
        maxBufferedBytes: 8 * 1024 * 1024,
        rssDeltaBytes: 64 * 1024 * 1024,
        duplicateAcknowledgements: 0,
        danglingReferences: 0,
      },
      canary: {
        result: 'passed',
        id: 'native-sync-secret',
        locations: {
          headers: false,
          ipc: false,
          logs: false,
          reports: false,
          storage: false,
          synchronizedRecords: false,
        },
      },
      cleanup: {
        result: 'passed',
        driverStopped: true,
        destinationRemoved: true,
        processesStopped: true,
      },
    },
    result: 'passed',
  };
}

function checkForOperation(operation) {
  const checks = passingReport().checks;
  const byOperation = {
    'relative-route-failure': checks.relativeRoute,
    'broker-connection': checks.broker,
    'offline-reading': checks.offline,
    'restart-continuity': checks.restart,
    reauthentication: checks.reauthentication,
    'bounded-transfer-retry': checks.transfer,
    'secret-canary-scan': checks.canary,
    'scoped-cleanup': checks.cleanup,
  };
  assert.ok(byOperation[operation], `Unexpected operation ${operation}`);
  return byOperation[operation];
}
