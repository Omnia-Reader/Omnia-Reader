import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertSyncReleaseEvidence } from './assert-sync-release-evidence.mjs';
import { writeSyncReleaseCandidate } from './write-sync-release-candidate.mjs';

test('binds downloaded evidence to the requested result and candidate', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-assert-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'candidate.json');
  await writeSyncReleaseCandidate({
    outputPath,
    candidateCommit: 'a'.repeat(40),
    candidateRelease: '0.1.0-rc.1',
    webDigest: `sha256:${'b'.repeat(64)}`,
    gatewayDigest: `sha256:${'c'.repeat(64)}`,
    completedAt: '2026-09-12T22:00:00.000Z',
  });

  const evidence = await assertSyncReleaseEvidence({
    evidencePath: outputPath,
    expectedResult: 'candidate',
    expectedCommit: 'a'.repeat(40),
    expectedRelease: '0.1.0-rc.1',
  });
  assert.equal(evidence.artifacts.length, 2);
  await assert.rejects(
    assertSyncReleaseEvidence({
      evidencePath: outputPath,
      expectedResult: 'accepted',
      expectedCommit: 'a'.repeat(40),
      expectedRelease: '0.1.0-rc.1',
    }),
    /must be accepted/,
  );
});

test('rejects malformed and mismatched downloaded evidence', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-assert-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'evidence.json');
  await writeFile(outputPath, '{}');
  await assert.rejects(
    assertSyncReleaseEvidence({
      evidencePath: outputPath,
      expectedResult: 'rejected',
      expectedCommit: 'a'.repeat(40),
      expectedRelease: '0.1.0-rc.1',
    }),
    /missing required field/,
  );
});
