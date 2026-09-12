import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MANDATORY_SYNC_GATE_IDS,
  aggregateSyncEvidence,
  loadSyncEvidence,
  validateSyncEvidence,
} from './verify-sync-evidence.mjs';

const fixtureUrl = new URL('./fixtures/sync-evidence/', import.meta.url);

test('validates the versioned candidate, rejected, and unavailable fixtures', async () => {
  for (const name of ['candidate.json', 'rejected.json', 'unavailable.json']) {
    const evidence = JSON.parse(
      await readFile(new URL(name, fixtureUrl), 'utf8'),
    );
    assert.equal(validateSyncEvidence(evidence), evidence);
  }
});

test('loads bounded JSON evidence and rejects malformed or oversized files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const validPath = join(directory, 'valid.json');
  await writeFile(validPath, JSON.stringify(draftEvidence()));
  assert.equal((await loadSyncEvidence(validPath)).result, 'candidate');

  const malformedPath = join(directory, 'malformed.json');
  await writeFile(malformedPath, '{');
  await assert.rejects(() => loadSyncEvidence(malformedPath), /not valid JSON/);

  const oversizedPath = join(directory, 'oversized.json');
  await writeFile(oversizedPath, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(
    () => loadSyncEvidence(oversizedPath),
    /exceeds 4194304/,
  );
});

test('rejects malformed schemas and candidate identities', () => {
  assert.throws(
    () => validateSyncEvidence({ ...draftEvidence(), schemaVersion: 2 }),
    /schemaVersion must be 1/,
  );
  assert.throws(
    () =>
      validateSyncEvidence({
        ...draftEvidence(),
        candidate: { commit: 'main', release: 'sync-candidate-1' },
      }),
    /candidate\.commit must be a full lowercase Git commit/,
  );
  assert.throws(
    () =>
      validateSyncEvidence({
        ...draftEvidence(),
        artifacts: [{ name: 'web', digest: 'sha256:not-a-digest' }],
      }),
    /artifacts\[0\]\.digest must be an immutable SHA-256 digest/,
  );
  assert.throws(
    () =>
      validateSyncEvidence({
        ...draftEvidence(),
        completedAt: '2026-09-12T07:59:59.000Z',
      }),
    /completedAt must not precede startedAt/,
  );
  assert.throws(
    () => validateSyncEvidence({ ...draftEvidence(), extra: true }),
    /unsupported field extra/,
  );
});

test('rejects confidential fields and unsafe linked artifact references', () => {
  assert.throws(
    () =>
      validateSyncEvidence({
        ...draftEvidence(),
        accessToken: 'provider-secret-canary',
      }),
    /confidential field accessToken/,
  );
  assert.throws(
    () =>
      validateSyncEvidence({
        ...draftEvidence(),
        runs: [
          {
            ...runForGate('deterministic-sync'),
            artifact: '../provider-report.json',
          },
        ],
      }),
    /artifact must be a confined relative path/,
  );
  assert.throws(
    () =>
      validateSyncEvidence({
        ...draftEvidence(),
        environments: [
          {
            id: 'staging',
            profile: 'sync-staging-v1',
            rawError: 'provider-controlled response',
          },
        ],
      }),
    /confidential field rawError/,
  );
});

test('requires unique artifact and run identities', () => {
  assert.throws(
    () =>
      validateSyncEvidence({
        ...draftEvidence(),
        artifacts: [
          ...draftEvidence().artifacts,
          {
            name: 'web',
            digest:
              'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        ],
      }),
    /duplicate artifact name web/,
  );
  const run = runForGate('deterministic-sync');
  assert.throws(
    () => validateSyncEvidence({ ...draftEvidence(), runs: [run, run] }),
    /duplicate run identity/,
  );
});

test('aggregates complete mandatory evidence and three browser attempts', () => {
  const evidence = acceptedEvidence();
  const decision = aggregateSyncEvidence(evidence);

  assert.equal(decision.result, 'accepted');
  assert.deepEqual(decision.missingGates, []);
  assert.deepEqual(decision.failedGates, []);
  assert.deepEqual(decision.unavailableGates, []);
  assert.deepEqual(decision.insufficientAttempts, []);
  assert.equal(validateSyncEvidence(evidence), evidence);

  const withReportableDeviceGap = {
    ...evidence,
    result: 'candidate',
    unavailableGates: [
      {
        gateId: 'packaged-sync-android-device',
        reason: 'physical-device-unavailable',
      },
    ],
  };
  assert.equal(
    aggregateSyncEvidence(withReportableDeviceGap).result,
    'accepted',
  );

  const withoutThirdFirefoxAttempt = {
    ...evidence,
    result: 'candidate',
    runs: evidence.runs.filter(
      (run) =>
        run.gateId !== 'browser-convergence-firefox' || run.attempt !== 3,
    ),
  };
  assert.deepEqual(
    aggregateSyncEvidence(withoutThirdFirefoxAttempt).insufficientAttempts,
    [
      {
        gateId: 'browser-convergence-firefox',
        passedAttempts: 2,
        requiredAttempts: 3,
      },
    ],
  );
  assert.equal(
    aggregateSyncEvidence(withoutThirdFirefoxAttempt).result,
    'rejected',
  );
});

test('fails closed for missing, failed, or unavailable mandatory gates', () => {
  const missing = draftEvidence();
  const missingDecision = aggregateSyncEvidence(missing);
  assert.equal(missingDecision.result, 'rejected');
  assert.deepEqual(missingDecision.missingGates, [...MANDATORY_SYNC_GATE_IDS]);

  const failed = acceptedEvidence();
  failed.result = 'candidate';
  failed.runs = failed.runs.map((run) =>
    run.gateId === 'gateway-redis-lifecycle'
      ? { ...run, result: 'failed' }
      : run,
  );
  assert.deepEqual(aggregateSyncEvidence(failed).failedGates, [
    'gateway-redis-lifecycle',
  ]);
  assert.equal(aggregateSyncEvidence(failed).result, 'rejected');

  const unavailable = acceptedEvidence();
  unavailable.result = 'candidate';
  unavailable.unavailableGates = [
    { gateId: 'packaged-sync-macos', reason: 'runner-unavailable' },
  ];
  assert.deepEqual(aggregateSyncEvidence(unavailable).unavailableGates, [
    'packaged-sync-macos',
  ]);
  assert.equal(aggregateSyncEvidence(unavailable).result, 'rejected');

  assert.throws(
    () => validateSyncEvidence({ ...unavailable, result: 'accepted' }),
    /declares accepted but aggregate evidence is rejected/,
  );
});

function draftEvidence() {
  return {
    schemaVersion: 1,
    candidate: {
      commit: '1111111111111111111111111111111111111111',
      release: 'sync-candidate-1',
    },
    artifacts: [
      {
        name: 'web',
        digest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    environments: [],
    runs: [],
    unavailableGates: [],
    startedAt: '2026-09-12T08:00:00.000Z',
    completedAt: '2026-09-12T09:00:00.000Z',
    result: 'candidate',
  };
}

function acceptedEvidence() {
  const runs = MANDATORY_SYNC_GATE_IDS.flatMap((gateId) => {
    const attempts = gateId.startsWith('browser-convergence-') ? 3 : 1;
    return Array.from({ length: attempts }, (_, index) =>
      runForGate(gateId, index + 1),
    );
  });
  return { ...draftEvidence(), runs, result: 'accepted' };
}

function runForGate(gateId, attempt = 1) {
  const browser = gateId.startsWith('browser-convergence-')
    ? gateId.slice('browser-convergence-'.length)
    : undefined;
  const packaged = gateId.startsWith('packaged-sync-');
  return {
    gateId,
    provider: 'git',
    scenario: 'release-contract',
    platform: browser ? 'web' : packaged ? 'packaged' : 'linux',
    ...(browser ? { browser } : {}),
    ...(packaged ? { host: gateId.slice('packaged-sync-'.length) } : {}),
    attempt,
    startedAt: '2026-09-12T08:00:00.000Z',
    completedAt: '2026-09-12T08:00:01.000Z',
    durationMs: 1000,
    result: 'passed',
    artifact: `${gateId}-${attempt}.json`,
  };
}
