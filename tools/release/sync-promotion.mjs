import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  loadSyncEvidence,
  validateSyncEvidence,
} from './verify-sync-evidence.mjs';

const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const DRIVER_TIMEOUT_MS = 15 * 60 * 1000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_FAILURE_CODE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

export async function stageSyncCandidate({ evidence, deploy }) {
  validatePromotableEvidence(evidence, 'staging');
  return executeDeployment({
    evidence,
    phase: 'staging',
    mode: 'promote',
    deploy,
  });
}

export async function canarySyncCandidate({ evidence, staging, deploy }) {
  validatePromotableEvidence(evidence, 'canary');
  validateCheckpoint(staging, {
    evidence,
    phase: 'staging',
    mode: 'promote',
    requirePassed: true,
    label: 'staging',
  });
  return executeDeployment({
    evidence,
    phase: 'canary',
    mode: 'promote',
    deploy,
  });
}

export async function acceptSyncCandidate({ evidence, canary, deploy }) {
  validateSyncEvidence(evidence);
  assert(
    evidence.result === 'accepted',
    'Production acceptance requires accepted synchronization evidence.',
  );
  validateCheckpoint(canary, {
    evidence,
    phase: 'canary',
    mode: 'promote',
    requirePassed: true,
    label: 'canary',
  });
  return executeDeployment({
    evidence,
    phase: 'production',
    mode: 'promote',
    deploy,
  });
}

export async function rollbackSyncCandidate({
  failedEvidence,
  previousAcceptedEvidence,
  deploy,
}) {
  validateSyncEvidence(failedEvidence);
  validateSyncEvidence(previousAcceptedEvidence);
  assert(
    failedEvidence.result === 'rejected',
    'Rollback requires rejected synchronization evidence for the active candidate.',
  );
  assert(
    previousAcceptedEvidence.result === 'accepted',
    'The rollback target requires accepted synchronization evidence.',
  );
  assert(
    !sameCandidate(failedEvidence, previousAcceptedEvidence),
    'The rollback target must differ from the failed candidate.',
  );
  return executeDeployment({
    evidence: previousAcceptedEvidence,
    phase: 'production',
    mode: 'rollback',
    replaces: failedEvidence.candidate,
    deploy,
  });
}

export function createPromotionCommandDriver(executable) {
  assert(
    typeof executable === 'string' && isAbsolute(executable),
    'OMNIA_SYNC_PROMOTION_DRIVER must be an absolute executable path.',
  );
  return async (request) => {
    const result = spawnSync(executable, [], {
      encoding: 'utf8',
      input: `${JSON.stringify(request)}\n`,
      maxBuffer: MAX_CHECKPOINT_BYTES,
      shell: false,
      timeout: DRIVER_TIMEOUT_MS,
    });
    assert(
      !result.error && result.status === 0,
      `Synchronization promotion driver failed during ${request.phase}.`,
    );
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `Synchronization promotion driver returned invalid JSON during ${request.phase}.`,
      );
    }
  };
}

async function executeDeployment({ evidence, phase, mode, replaces, deploy }) {
  assert(
    typeof deploy === 'function',
    'A synchronization promotion driver is required.',
  );
  const request = deepFreeze({
    schemaVersion: 1,
    phase,
    mode,
    candidate: structuredClone(evidence.candidate),
    artifacts: structuredClone(evidence.artifacts),
    ...(replaces ? { replaces: structuredClone(replaces) } : {}),
  });
  let receipt;
  try {
    receipt = await deploy(request);
  } catch {
    throw new Error(`Synchronization promotion driver failed during ${phase}.`);
  }
  validateReceipt(receipt, request);
  return deepFreeze(structuredClone(receipt));
}

function validatePromotableEvidence(evidence, phase) {
  validateSyncEvidence(evidence);
  assert(
    evidence.result !== 'rejected',
    `Rejected synchronization evidence cannot enter ${phase}.`,
  );
}

function validateCheckpoint(checkpoint, expected) {
  const request = {
    schemaVersion: 1,
    phase: expected.phase,
    mode: expected.mode,
    candidate: expected.evidence.candidate,
    artifacts: expected.evidence.artifacts,
  };
  try {
    validateReceipt(checkpoint, request);
  } catch {
    throw new Error(
      `The ${expected.label} checkpoint does not match the candidate.`,
    );
  }
  assert(
    !expected.requirePassed || checkpoint.result === 'passed',
    `The ${expected.label} checkpoint did not pass.`,
  );
}

function validateReceipt(receipt, request) {
  assertPlainRecord(receipt, 'Promotion receipt must be an object.');
  const required = [
    'schemaVersion',
    'phase',
    'mode',
    'candidate',
    'artifacts',
    'completedAt',
    'result',
  ];
  const optional = ['replaces', 'failureCode'];
  assertExactKeys(receipt, required, optional, 'Promotion receipt');
  assert(
    receipt.schemaVersion === 1,
    'Promotion receipt schemaVersion must be 1.',
  );
  assert(
    receipt.phase === request.phase && receipt.mode === request.mode,
    'Promotion receipt phase or mode does not match the request.',
  );
  assert(
    candidateMatches(receipt.candidate, request.candidate),
    'Promotion receipt candidate does not match the request.',
  );
  assert(
    artifactsMatch(receipt.artifacts, request.artifacts),
    'Promotion receipt artifacts do not match the requested digests.',
  );
  if (request.replaces) {
    assert(
      candidateMatches(receipt.replaces, request.replaces),
      'Promotion receipt replacement identity does not match the request.',
    );
  } else {
    assert(
      receipt.replaces === undefined,
      'Promotion receipt contains an unexpected replacement identity.',
    );
  }
  assertTimestamp(receipt.completedAt, 'Promotion receipt completedAt');
  assert(
    receipt.result === 'passed' || receipt.result === 'failed',
    'Promotion receipt result must be passed or failed.',
  );
  if (receipt.result === 'failed') {
    assert(
      typeof receipt.failureCode === 'string' &&
        SAFE_FAILURE_CODE.test(receipt.failureCode),
      'Failed promotion receipt requires a sanitized failureCode.',
    );
  } else {
    assert(
      receipt.failureCode === undefined,
      'Passing promotion receipt cannot contain a failureCode.',
    );
  }
}

async function loadCheckpoint(filePath) {
  const contents = await readFile(filePath);
  assert(
    contents.byteLength <= MAX_CHECKPOINT_BYTES,
    `Promotion checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes.`,
  );
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch {
    throw new Error('Promotion checkpoint is not valid JSON.');
  }
}

function sameCandidate(left, right) {
  return candidateMatches(left.candidate, right.candidate);
}

function candidateMatches(actual, expected) {
  return (
    isPlainRecord(actual) &&
    Object.keys(actual).sort().join(',') === 'commit,release' &&
    actual.commit === expected.commit &&
    actual.release === expected.release
  );
}

function artifactsMatch(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalized = actual.map((artifact) => {
    if (
      !isPlainRecord(artifact) ||
      Object.keys(artifact).sort().join(',') !== 'digest,name'
    ) {
      return null;
    }
    return { name: artifact.name, digest: artifact.digest };
  });
  if (normalized.some((artifact) => artifact === null)) return false;
  const byName = (left, right) =>
    String(left.name).localeCompare(String(right.name));
  return (
    JSON.stringify(normalized.sort(byName)) ===
    JSON.stringify(
      expected.map(({ name, digest }) => ({ name, digest })).sort(byName),
    )
  );
}

function assertTimestamp(value, label) {
  assert(
    typeof value === 'string' && UTC_TIMESTAMP.test(value),
    `${label} must be a millisecond-precision UTC timestamp.`,
  );
  const parsed = Date.parse(value);
  assert(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value,
    `${label} must be a valid UTC timestamp.`,
  );
}

function assertExactKeys(record, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    assert(allowed.has(key), `${label} contains unsupported field ${key}.`);
  }
  for (const key of required) {
    assert(
      Object.hasOwn(record, key),
      `${label} is missing required field ${key}.`,
    );
  }
}

function assertPlainRecord(value, message) {
  assert(isPlainRecord(value), message);
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [operation, evidencePath, supportingPath, ...extra] =
    process.argv.slice(2);
  const driverPath = process.env['OMNIA_SYNC_PROMOTION_DRIVER'];
  assert(
    driverPath,
    'OMNIA_SYNC_PROMOTION_DRIVER must provide the protected deployment driver.',
  );
  const deploy = createPromotionCommandDriver(driverPath);
  let receipt;
  if (
    operation === 'stage' &&
    evidencePath &&
    !supportingPath &&
    extra.length === 0
  ) {
    receipt = await stageSyncCandidate({
      evidence: await loadSyncEvidence(evidencePath),
      deploy,
    });
  } else if (
    operation === 'canary' &&
    evidencePath &&
    supportingPath &&
    extra.length === 0
  ) {
    receipt = await canarySyncCandidate({
      evidence: await loadSyncEvidence(evidencePath),
      staging: await loadCheckpoint(supportingPath),
      deploy,
    });
  } else if (
    operation === 'accept' &&
    evidencePath &&
    supportingPath &&
    extra.length === 0
  ) {
    receipt = await acceptSyncCandidate({
      evidence: await loadSyncEvidence(evidencePath),
      canary: await loadCheckpoint(supportingPath),
      deploy,
    });
  } else if (
    operation === 'rollback' &&
    evidencePath &&
    supportingPath &&
    extra.length === 0
  ) {
    receipt = await rollbackSyncCandidate({
      failedEvidence: await loadSyncEvidence(evidencePath),
      previousAcceptedEvidence: await loadSyncEvidence(supportingPath),
      deploy,
    });
  } else {
    throw new Error(
      'Usage: sync-promotion.mjs <stage|canary|accept|rollback> <evidence.json> [checkpoint-or-accepted-evidence.json]',
    );
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.result !== 'passed') process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
