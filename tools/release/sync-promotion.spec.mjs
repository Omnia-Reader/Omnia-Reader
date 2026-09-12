import assert from 'node:assert/strict';
import test from 'node:test';

import { MANDATORY_SYNC_GATE_IDS } from './verify-sync-evidence.mjs';
import {
  acceptSyncCandidate,
  canarySyncCandidate,
  createPromotionCommandDriver,
  rollbackSyncCandidate,
  stageSyncCandidate,
} from './sync-promotion.mjs';

test('stages and canaries the exact candidate digests without a build or tag', async () => {
  const requests = [];
  const deploy = recordingDriver(requests);
  const evidence = candidateEvidence();

  const staging = await stageSyncCandidate({ evidence, deploy });
  const canary = await canarySyncCandidate({
    evidence,
    staging,
    deploy,
  });

  assert.equal(staging.phase, 'staging');
  assert.equal(canary.phase, 'canary');
  assert.deepEqual(
    requests.map(({ phase, mode }) => ({ phase, mode })),
    [
      { phase: 'staging', mode: 'promote' },
      { phase: 'canary', mode: 'promote' },
    ],
  );
  for (const request of requests) {
    assert.deepEqual(request.candidate, evidence.candidate);
    assert.deepEqual(request.artifacts, evidence.artifacts);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.artifacts), true);
    assert.equal(Object.hasOwn(request, 'build'), false);
    for (const artifact of request.artifacts) {
      assert.deepEqual(Object.keys(artifact).sort(), ['digest', 'name']);
      assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
    }
  }

  const reordered = await stageSyncCandidate({
    evidence,
    deploy: async (request) => ({
      ...receiptFor(request),
      candidate: {
        release: request.candidate.release,
        commit: request.candidate.commit,
      },
      artifacts: [...request.artifacts]
        .reverse()
        .map(({ name, digest }) => ({ digest, name })),
    }),
  });
  assert.equal(reordered.result, 'passed');
});

test('rejects a deployment receipt whose candidate or artifact identity drifts', async () => {
  const evidence = candidateEvidence();
  await assert.rejects(
    () =>
      stageSyncCandidate({
        evidence,
        deploy: async (request) => ({
          ...receiptFor(request),
          artifacts: request.artifacts.map((artifact, index) =>
            index === 0
              ? {
                  ...artifact,
                  digest:
                    'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                }
              : artifact,
          ),
        }),
      }),
    /receipt artifacts do not match the requested digests/,
  );

  const staging = await stageSyncCandidate({
    evidence,
    deploy: recordingDriver([]),
  });
  await assert.rejects(
    () =>
      canarySyncCandidate({
        evidence: {
          ...evidence,
          candidate: {
            ...evidence.candidate,
            commit: '9999999999999999999999999999999999999999',
          },
        },
        staging,
        deploy: recordingDriver([]),
      }),
    /staging checkpoint does not match the candidate/,
  );
});

test('accepts production only after accepted evidence and a passing canary', async () => {
  const draft = candidateEvidence();
  const draftStage = await stageSyncCandidate({
    evidence: draft,
    deploy: recordingDriver([]),
  });
  const draftCanary = await canarySyncCandidate({
    evidence: draft,
    staging: draftStage,
    deploy: recordingDriver([]),
  });
  await assert.rejects(
    () =>
      acceptSyncCandidate({
        evidence: draft,
        canary: draftCanary,
        deploy: recordingDriver([]),
      }),
    /requires accepted synchronization evidence/,
  );

  const evidence = acceptedEvidence();
  const staging = await stageSyncCandidate({
    evidence,
    deploy: recordingDriver([]),
  });
  const canary = await canarySyncCandidate({
    evidence,
    staging,
    deploy: recordingDriver([]),
  });
  const requests = [];
  const production = await acceptSyncCandidate({
    evidence,
    canary,
    deploy: recordingDriver(requests),
  });

  assert.equal(production.phase, 'production');
  assert.equal(production.mode, 'promote');
  assert.deepEqual(requests[0].artifacts, evidence.artifacts);
});

test('rolls back a failed canary to the previous accepted digests only', async () => {
  const failedEvidence = candidateEvidence();
  const previous = acceptedEvidence({
    commit: '2222222222222222222222222222222222222222',
    release: 'sync-accepted-0',
    digestSeed: 'c',
  });
  const staging = await stageSyncCandidate({
    evidence: failedEvidence,
    deploy: recordingDriver([]),
  });
  const failedCanary = await canarySyncCandidate({
    evidence: failedEvidence,
    staging,
    deploy: recordingDriver([], 'failed'),
  });
  assert.equal(failedCanary.result, 'failed');
  assert.equal(failedCanary.failureCode, 'canary-threshold-exceeded');
  const rejectedEvidence = { ...failedEvidence, result: 'rejected' };

  const requests = [];
  const rollback = await rollbackSyncCandidate({
    failedEvidence: rejectedEvidence,
    previousAcceptedEvidence: previous,
    deploy: recordingDriver(requests),
  });

  assert.equal(rollback.phase, 'production');
  assert.equal(rollback.mode, 'rollback');
  assert.deepEqual(requests[0].candidate, previous.candidate);
  assert.deepEqual(requests[0].artifacts, previous.artifacts);
  assert.deepEqual(requests[0].replaces, rejectedEvidence.candidate);
  assert.equal(
    requests[0].artifacts.some(({ digest }) =>
      failedEvidence.artifacts.some(
        (failedArtifact) => failedArtifact.digest === digest,
      ),
    ),
    false,
  );
});

test('refuses rollback to unaccepted or identical candidate evidence', async () => {
  const candidate = candidateEvidence();
  const failedEvidence = { ...candidate, result: 'rejected' };
  await assert.rejects(
    () =>
      rollbackSyncCandidate({
        failedEvidence: candidate,
        previousAcceptedEvidence: acceptedEvidence({
          commit: '2222222222222222222222222222222222222222',
          release: 'sync-accepted-0',
          digestSeed: 'c',
        }),
        deploy: recordingDriver([]),
      }),
    /requires rejected synchronization evidence/,
  );
  await assert.rejects(
    () =>
      rollbackSyncCandidate({
        failedEvidence,
        previousAcceptedEvidence: candidateEvidence({
          commit: '2222222222222222222222222222222222222222',
          release: 'sync-draft-0',
          digestSeed: 'c',
        }),
        deploy: recordingDriver([]),
      }),
    /rollback target requires accepted synchronization evidence/,
  );
  await assert.rejects(
    () =>
      rollbackSyncCandidate({
        failedEvidence,
        previousAcceptedEvidence: acceptedEvidence({ digestSeed: 'c' }),
        deploy: recordingDriver([]),
      }),
    /rollback target must differ from the failed candidate/,
  );
});

test('requires an absolute promotion driver and sanitizes execution failures', async () => {
  assert.throws(
    () => createPromotionCommandDriver('relative-driver'),
    /must be an absolute executable path/,
  );
  const driver = createPromotionCommandDriver(
    new URL('./missing-promotion-driver', import.meta.url).pathname,
  );
  await assert.rejects(
    () => driver({ phase: 'staging' }),
    (error) => {
      assert.equal(
        error.message,
        'Synchronization promotion driver failed during staging.',
      );
      assert.doesNotMatch(error.message, /missing-promotion-driver/);
      return true;
    },
  );
});

function recordingDriver(requests, result = 'passed') {
  return async (request) => {
    requests.push(request);
    return receiptFor(request, result);
  };
}

function receiptFor(request, result = 'passed') {
  return {
    ...request,
    completedAt: '2026-09-12T10:00:00.000Z',
    result,
    ...(result === 'failed'
      ? { failureCode: 'canary-threshold-exceeded' }
      : {}),
  };
}

function candidateEvidence({
  commit = '1111111111111111111111111111111111111111',
  release = 'sync-candidate-1',
  digestSeed = 'a',
} = {}) {
  return {
    schemaVersion: 1,
    candidate: { commit, release },
    artifacts: [
      { name: 'web', digest: `sha256:${digestSeed.repeat(64)}` },
      {
        name: 'sync-gateway',
        digest: `sha256:${nextSeed(digestSeed).repeat(64)}`,
      },
    ],
    environments: [{ id: 'sanitized-staging', profile: 'sync-staging-v1' }],
    runs: [],
    unavailableGates: [],
    startedAt: '2026-09-12T08:00:00.000Z',
    completedAt: '2026-09-12T11:00:00.000Z',
    result: 'candidate',
  };
}

function acceptedEvidence(options) {
  const evidence = candidateEvidence(options);
  return {
    ...evidence,
    runs: MANDATORY_SYNC_GATE_IDS.flatMap((gateId) => {
      const attempts = gateId.startsWith('browser-convergence-') ? 3 : 1;
      return Array.from({ length: attempts }, (_, index) =>
        runForGate(gateId, index + 1),
      );
    }),
    result: 'accepted',
  };
}

function runForGate(gateId, attempt) {
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

function nextSeed(seed) {
  return String.fromCharCode(seed.charCodeAt(0) + 1);
}
