import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MANDATORY_SYNC_GATE_IDS = Object.freeze([
  'deterministic-sync',
  'browser-convergence-chromium',
  'browser-convergence-firefox',
  'browser-convergence-webkit',
  'sync-performance-staging',
  'gateway-redis-lifecycle',
  'packaged-sync-linux',
  'packaged-sync-windows',
  'packaged-sync-macos',
  'packaged-sync-android-emulator',
  'live-github-conformance',
  'sync-observability',
  'container-security',
  'artifact-integrity',
  'canary-rollback',
  'sync-accessibility',
]);

export const REPORTABLE_SYNC_GATE_IDS = Object.freeze([
  'packaged-sync-android-device',
]);

const ALL_GATE_IDS = new Set([
  ...MANDATORY_SYNC_GATE_IDS,
  ...REPORTABLE_SYNC_GATE_IDS,
]);
const MANDATORY_GATE_IDS = new Set(MANDATORY_SYNC_GATE_IDS);
const BROWSER_GATE_PREFIX = 'browser-convergence-';
const PACKAGED_GATE_PREFIX = 'packaged-sync-';
const BROWSERS = new Set(['chromium', 'firefox', 'webkit']);
const PROVIDERS = new Set(['git', 'mega', 'provider-neutral']);
const EVIDENCE_RESULTS = new Set(['candidate', 'accepted', 'rejected']);
const RUN_RESULTS = new Set(['passed', 'failed']);
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 64;
const MAX_ENVIRONMENTS = 64;
const MAX_RUNS = 10_000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const CONFIDENTIAL_FIELDS = new Set([
  'account',
  'accountid',
  'accountname',
  'accesskey',
  'accesstoken',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'errorbody',
  'oauthcode',
  'providercookie',
  'providersession',
  'publicationbytes',
  'publicationcontent',
  'rawerror',
  'refreshtoken',
  'repositoryid',
  'repositoryname',
  'repositoryowner',
  'secret',
  'secrets',
  'sessionstate',
  'transferurl',
]);

export function validateSyncEvidence(evidence) {
  validateSyncEvidenceSchema(evidence);
  const decision = aggregateValidatedEvidence(evidence);
  if (evidence.result !== 'candidate') {
    assert(
      evidence.result === decision.result,
      `Sync evidence declares ${evidence.result} but aggregate evidence is ${decision.result}.`,
    );
  }
  return evidence;
}

export function aggregateSyncEvidence(evidence) {
  validateSyncEvidenceSchema(evidence);
  return aggregateValidatedEvidence(evidence);
}

export async function loadSyncEvidence(filePath) {
  const contents = await readFile(filePath);
  assert(
    contents.byteLength <= MAX_EVIDENCE_BYTES,
    `Sync evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`,
  );
  let evidence;
  try {
    evidence = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error('Sync evidence is not valid JSON.', { cause: error });
  }
  return validateSyncEvidence(evidence);
}

function validateSyncEvidenceSchema(evidence) {
  assertNoConfidentialFields(evidence);
  assertRecord(evidence, 'Sync evidence');
  assertExactKeys(
    evidence,
    [
      'schemaVersion',
      'candidate',
      'artifacts',
      'environments',
      'runs',
      'unavailableGates',
      'startedAt',
      'completedAt',
      'result',
    ],
    'Sync evidence',
  );
  assert(evidence.schemaVersion === 1, 'schemaVersion must be 1.');
  validateCandidate(evidence.candidate);
  validateArtifacts(evidence.artifacts);
  validateEnvironments(evidence.environments);

  const startedAt = timestamp(evidence.startedAt, 'startedAt');
  const completedAt = timestamp(evidence.completedAt, 'completedAt');
  assert(completedAt >= startedAt, 'completedAt must not precede startedAt.');

  validateRuns(evidence.runs, startedAt, completedAt);
  validateUnavailableGates(evidence.unavailableGates);
  assert(
    EVIDENCE_RESULTS.has(evidence.result),
    'result must be candidate, accepted, or rejected.',
  );
}

function validateCandidate(candidate) {
  assertRecord(candidate, 'candidate');
  assertExactKeys(candidate, ['commit', 'release'], 'candidate');
  assert(
    typeof candidate.commit === 'string' && FULL_COMMIT.test(candidate.commit),
    'candidate.commit must be a full lowercase Git commit.',
  );
  assertIdentifier(candidate.release, 'candidate.release');
}

function validateArtifacts(artifacts) {
  assertArray(artifacts, 'artifacts', 1, MAX_ARTIFACTS);
  const names = new Set();
  artifacts.forEach((artifact, index) => {
    const path = `artifacts[${index}]`;
    assertRecord(artifact, path);
    assertExactKeys(artifact, ['name', 'digest'], path);
    assertIdentifier(artifact.name, `${path}.name`);
    assert(
      !names.has(artifact.name),
      `artifacts contains duplicate artifact name ${artifact.name}.`,
    );
    names.add(artifact.name);
    assert(
      typeof artifact.digest === 'string' &&
        SHA256_DIGEST.test(artifact.digest),
      `${path}.digest must be an immutable SHA-256 digest.`,
    );
  });
}

function validateEnvironments(environments) {
  assertArray(environments, 'environments', 0, MAX_ENVIRONMENTS);
  const ids = new Set();
  environments.forEach((environment, index) => {
    const path = `environments[${index}]`;
    assertRecord(environment, path);
    assertExactKeys(environment, ['id', 'profile'], path);
    assertIdentifier(environment.id, `${path}.id`);
    assertIdentifier(environment.profile, `${path}.profile`);
    assert(
      !ids.has(environment.id),
      `environments contains duplicate id ${environment.id}.`,
    );
    ids.add(environment.id);
  });
}

function validateRuns(runs, evidenceStartedAt, evidenceCompletedAt) {
  assertArray(runs, 'runs', 0, MAX_RUNS);
  const identities = new Set();
  runs.forEach((run, index) => {
    const path = `runs[${index}]`;
    assertRecord(run, path);
    assertExactKeys(
      run,
      [
        'gateId',
        'provider',
        'scenario',
        'platform',
        'attempt',
        'startedAt',
        'completedAt',
        'durationMs',
        'result',
        'artifact',
      ],
      path,
      ['browser', 'host'],
    );
    assertGateId(run.gateId, `${path}.gateId`);
    assert(PROVIDERS.has(run.provider), `${path}.provider is unsupported.`);
    assertIdentifier(run.scenario, `${path}.scenario`);
    assertIdentifier(run.platform, `${path}.platform`);
    if (run.browser !== undefined) {
      assert(BROWSERS.has(run.browser), `${path}.browser is unsupported.`);
    }
    if (run.host !== undefined) {
      assertIdentifier(run.host, `${path}.host`);
    }
    validateGateDimensions(run, path);
    assert(
      Number.isSafeInteger(run.attempt) && run.attempt > 0,
      `${path}.attempt must be a positive safe integer.`,
    );
    const startedAt = timestamp(run.startedAt, `${path}.startedAt`);
    const completedAt = timestamp(run.completedAt, `${path}.completedAt`);
    assert(
      completedAt >= startedAt,
      `${path}.completedAt must not precede startedAt.`,
    );
    assert(
      startedAt >= evidenceStartedAt && completedAt <= evidenceCompletedAt,
      `${path} timestamps must be inside the evidence interval.`,
    );
    assert(
      Number.isSafeInteger(run.durationMs) && run.durationMs >= 0,
      `${path}.durationMs must be a non-negative safe integer.`,
    );
    assert(
      run.durationMs === completedAt - startedAt,
      `${path}.durationMs must match its timestamp interval.`,
    );
    assert(RUN_RESULTS.has(run.result), `${path}.result is unsupported.`);
    assertRelativeArtifact(run.artifact, `${path}.artifact`);

    const identity = [
      run.gateId,
      run.provider,
      run.scenario,
      run.platform,
      run.browser ?? '',
      run.host ?? '',
      run.attempt,
    ].join('\u0000');
    assert(!identities.has(identity), `${path} has a duplicate run identity.`);
    identities.add(identity);
  });
}

function validateGateDimensions(run, path) {
  if (run.gateId.startsWith(BROWSER_GATE_PREFIX)) {
    const expectedBrowser = run.gateId.slice(BROWSER_GATE_PREFIX.length);
    assert(
      run.browser === expectedBrowser,
      `${path}.browser must match ${run.gateId}.`,
    );
  }
  if (run.gateId.startsWith(PACKAGED_GATE_PREFIX)) {
    const expectedHost = run.gateId.slice(PACKAGED_GATE_PREFIX.length);
    assert(run.host === expectedHost, `${path}.host must match ${run.gateId}.`);
  }
}

function validateUnavailableGates(unavailableGates) {
  assertArray(unavailableGates, 'unavailableGates', 0, ALL_GATE_IDS.size);
  const ids = new Set();
  unavailableGates.forEach((gate, index) => {
    const path = `unavailableGates[${index}]`;
    assertRecord(gate, path);
    assertExactKeys(gate, ['gateId', 'reason'], path);
    assertGateId(gate.gateId, `${path}.gateId`);
    assertIdentifier(gate.reason, `${path}.reason`);
    assert(
      !ids.has(gate.gateId),
      `unavailableGates contains duplicate gate ${gate.gateId}.`,
    );
    ids.add(gate.gateId);
  });
}

function aggregateValidatedEvidence(evidence) {
  const passedAttempts = new Map(
    MANDATORY_SYNC_GATE_IDS.map((gateId) => [gateId, new Set()]),
  );
  const failed = new Set();
  for (const run of evidence.runs) {
    if (!MANDATORY_GATE_IDS.has(run.gateId)) continue;
    if (run.result === 'failed') {
      failed.add(run.gateId);
    } else {
      passedAttempts.get(run.gateId).add(run.attempt);
    }
  }

  const unavailable = new Set(
    evidence.unavailableGates
      .map(({ gateId }) => gateId)
      .filter((gateId) => MANDATORY_GATE_IDS.has(gateId)),
  );
  const missingGates = [];
  const insufficientAttempts = [];
  for (const gateId of MANDATORY_SYNC_GATE_IDS) {
    const passed = passedAttempts.get(gateId).size;
    const required = gateId.startsWith(BROWSER_GATE_PREFIX) ? 3 : 1;
    if (passed === 0 && !failed.has(gateId) && !unavailable.has(gateId)) {
      missingGates.push(gateId);
    } else if (passed > 0 && passed < required) {
      insufficientAttempts.push({
        gateId,
        passedAttempts: passed,
        requiredAttempts: required,
      });
    }
  }

  const failedGates = orderedGateIds(failed);
  const unavailableGates = orderedGateIds(unavailable);
  return {
    result:
      missingGates.length === 0 &&
      failedGates.length === 0 &&
      unavailableGates.length === 0 &&
      insufficientAttempts.length === 0
        ? 'accepted'
        : 'rejected',
    missingGates,
    failedGates,
    unavailableGates,
    insufficientAttempts,
  };
}

function orderedGateIds(ids) {
  return MANDATORY_SYNC_GATE_IDS.filter((gateId) => ids.has(gateId));
}

function assertNoConfidentialFields(
  value,
  path = 'Sync evidence',
  seen = new Set(),
) {
  if (value === null || typeof value !== 'object') return;
  assert(!seen.has(value), `${path} must not contain cyclic data.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoConfidentialFields(entry, `${path}[${index}]`, seen),
    );
    seen.delete(value);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase();
    assert(
      !CONFIDENTIAL_FIELDS.has(normalized),
      `${path} contains confidential field ${key}.`,
    );
    assertNoConfidentialFields(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function assertExactKeys(record, required, path, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    assert(allowed.has(key), `${path} contains unsupported field ${key}.`);
  }
  for (const key of required) {
    assert(
      Object.hasOwn(record, key),
      `${path} is missing required field ${key}.`,
    );
  }
}

function assertRecord(value, path) {
  assert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
    `${path} must be an object.`,
  );
}

function assertArray(value, path, minimum, maximum) {
  assert(Array.isArray(value), `${path} must be an array.`);
  assert(
    value.length >= minimum && value.length <= maximum,
    `${path} must contain between ${minimum} and ${maximum} entries.`,
  );
}

function assertIdentifier(value, path) {
  assert(
    typeof value === 'string' && SAFE_IDENTIFIER.test(value),
    `${path} must be a bounded sanitized identifier.`,
  );
}

function assertGateId(value, path) {
  assert(
    typeof value === 'string' && ALL_GATE_IDS.has(value),
    `${path} is not a stable synchronization gate identifier.`,
  );
}

function assertRelativeArtifact(value, path) {
  assert(
    typeof value === 'string' &&
      value.length <= 512 &&
      SAFE_RELATIVE_PATH.test(value) &&
      !value.split('/').some((segment) => segment === '.' || segment === '..'),
    `${path} must be a confined relative path.`,
  );
}

function timestamp(value, path) {
  assert(
    typeof value === 'string' && UTC_TIMESTAMP.test(value),
    `${path} must be a millisecond-precision UTC timestamp.`,
  );
  const parsed = Date.parse(value);
  assert(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value,
    `${path} must be a valid UTC timestamp.`,
  );
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [filePath, ...extra] = process.argv.slice(2);
  assert(
    filePath && extra.length === 0,
    'Usage: verify-sync-evidence.mjs <manifest.json>',
  );
  const evidence = await loadSyncEvidence(filePath);
  const decision = aggregateSyncEvidence(evidence);
  process.stdout.write(
    `${JSON.stringify({ candidate: evidence.candidate, ...decision }, null, 2)}\n`,
  );
  if (decision.result !== 'accepted') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
