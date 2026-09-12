import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSyncEvidence } from './verify-sync-evidence.mjs';

const RESULTS = new Set(['candidate', 'accepted', 'rejected']);
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export async function assertSyncReleaseEvidence({
  evidencePath,
  expectedResult,
  expectedCommit,
  expectedRelease,
}) {
  assert(RESULTS.has(expectedResult), 'Expected evidence result is invalid.');
  assert(FULL_COMMIT.test(expectedCommit), 'Expected commit is invalid.');
  assert(SAFE_IDENTIFIER.test(expectedRelease), 'Expected release is invalid.');
  const evidence = await loadSyncEvidence(evidencePath);
  assert(
    evidence.result === expectedResult,
    `Synchronization evidence must be ${expectedResult}.`,
  );
  assert(
    evidence.candidate.commit === expectedCommit &&
      evidence.candidate.release === expectedRelease,
    'Synchronization evidence does not match the dispatched candidate.',
  );
  return evidence;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [
    evidencePath,
    expectedResult,
    expectedCommit,
    expectedRelease,
    ...extra
  ] = process.argv.slice(2);
  assert(
    evidencePath &&
      expectedResult &&
      expectedCommit &&
      expectedRelease &&
      extra.length === 0,
    'Usage: assert-sync-release-evidence.mjs <evidence.json> <candidate|accepted|rejected> <commit> <release>',
  );
  await assertSyncReleaseEvidence({
    evidencePath,
    expectedResult,
    expectedCommit,
    expectedRelease,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
