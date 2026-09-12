import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateSyncEvidence } from './verify-sync-evidence.mjs';

const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export async function writeSyncReleaseCandidate({
  outputPath,
  candidateCommit,
  candidateRelease,
  webDigest,
  gatewayDigest,
  completedAt = new Date().toISOString(),
}) {
  assert(FULL_COMMIT.test(candidateCommit), 'Candidate commit is invalid.');
  assert(
    SAFE_IDENTIFIER.test(candidateRelease),
    'Candidate release is invalid.',
  );
  assert(SHA256_DIGEST.test(webDigest), 'Web image digest is invalid.');
  assert(SHA256_DIGEST.test(gatewayDigest), 'Gateway image digest is invalid.');
  assertTimestamp(completedAt);

  const evidence = validateSyncEvidence({
    schemaVersion: 1,
    candidate: { commit: candidateCommit, release: candidateRelease },
    artifacts: [
      { name: 'gateway', digest: gatewayDigest },
      { name: 'web', digest: webDigest },
    ],
    environments: [],
    runs: [],
    unavailableGates: [],
    startedAt: completedAt,
    completedAt,
    result: 'candidate',
  });

  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await atomicWrite(destination, evidence);
  return evidence;
}

async function atomicWrite(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function assertTimestamp(value) {
  assert(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      new Date(value).toISOString() === value,
    'Completion timestamp is invalid.',
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    assert(name?.startsWith('--') && value, 'Invalid command arguments.');
    values[name.slice(2)] = value;
  }
  return values;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  await writeSyncReleaseCandidate({
    outputPath: values.output,
    candidateCommit: values['candidate-commit'],
    candidateRelease: values['candidate-release'],
    webDigest: values['web-digest'],
    gatewayDigest: values['gateway-digest'],
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
