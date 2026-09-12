import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeSyncReleaseCandidate } from './write-sync-release-candidate.mjs';

const valid = {
  candidateCommit: 'a'.repeat(40),
  candidateRelease: '0.1.0-rc.1',
  webDigest: `sha256:${'b'.repeat(64)}`,
  gatewayDigest: `sha256:${'c'.repeat(64)}`,
  completedAt: '2026-09-12T22:00:00.000Z',
};

test('writes an immutable two-image candidate manifest', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-release-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'candidate.json');
  const evidence = await writeSyncReleaseCandidate({ ...valid, outputPath });

  assert.deepEqual(evidence.artifacts, [
    { name: 'gateway', digest: valid.gatewayDigest },
    { name: 'web', digest: valid.webDigest },
  ]);
  assert.equal(evidence.result, 'candidate');
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidence);
});

test('rejects mutable identities and refuses evidence replacement', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-release-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'candidate.json');

  await assert.rejects(
    writeSyncReleaseCandidate({
      ...valid,
      outputPath,
      webDigest: 'latest',
    }),
    /Web image digest/,
  );
  await writeSyncReleaseCandidate({ ...valid, outputPath });
  await assert.rejects(
    writeSyncReleaseCandidate({ ...valid, outputPath }),
    /EEXIST/,
  );
});
