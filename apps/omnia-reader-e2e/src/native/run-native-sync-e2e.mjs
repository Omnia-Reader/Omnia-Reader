import { spawnSync } from 'node:child_process';
import { link, lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVER_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_DRIVER_OUTPUT_BYTES = 4 * 1024 * 1024;
const TRANSFER_BYTES = 25 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_RSS_DELTA_BYTES = 64 * 1024 * 1024;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOSTS = new Set(['linux', 'windows', 'macos', 'android-emulator']);
const PERSISTENCE_MODES = new Set(['protected', 'session-only']);
const CANARY_LOCATIONS = [
  'headers',
  'ipc',
  'logs',
  'reports',
  'storage',
  'synchronizedRecords',
];

export async function runNativeSyncJourney({
  driverPath,
  outputPath,
  host,
  runId,
  candidateCommit,
  candidateRelease,
  artifactDigest,
  secretCanary,
  protectedRunner,
  executeDriver = executeControlDriver,
  now = () => new Date(),
}) {
  assert(protectedRunner === true, 'A protected packaged runner is required.');
  assert(
    typeof driverPath === 'string' && isAbsolute(driverPath),
    'OMNIA_NATIVE_SYNC_CONTROL_DRIVER must be an absolute path.',
  );
  assert(HOSTS.has(host), 'Packaged host is invalid.');
  assert(SAFE_IDENTIFIER.test(runId), 'Packaged run ID is invalid.');
  assert(FULL_COMMIT.test(candidateCommit), 'Candidate commit is invalid.');
  assert(
    SAFE_IDENTIFIER.test(candidateRelease),
    'Candidate release is invalid.',
  );
  assert(SHA256_DIGEST.test(artifactDigest), 'Artifact digest is invalid.');
  assert(
    typeof secretCanary === 'string' && secretCanary.length >= 16,
    'A non-empty protected secret canary is required.',
  );
  assert(
    typeof outputPath === 'string' && outputPath.length > 0,
    'A packaged evidence output path is required.',
  );
  const destination = resolve(outputPath);
  await assertOutputAbsent(destination);

  const request = deepFreeze({
    schemaVersion: 1,
    host,
    runId,
    candidate: { commit: candidateCommit, release: candidateRelease },
    artifactDigest,
    limits: {
      transferBytes: TRANSFER_BYTES,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      maxRssDeltaBytes: MAX_RSS_DELTA_BYTES,
    },
  });
  const startedAt = now().toISOString();
  const checks = {};
  try {
    for (const [operation, name] of [
      ['relative-route-failure', 'relativeRoute'],
      ['broker-connection', 'broker'],
      ['offline-reading', 'offline'],
      ['restart-continuity', 'restart'],
      ['reauthentication', 'reauthentication'],
      ['bounded-transfer-retry', 'transfer'],
      ['secret-canary-scan', 'canary'],
    ]) {
      checks[name] = await executeStep({
        driverPath,
        executeDriver,
        request,
        operation,
        secretCanary,
      });
    }
  } finally {
    checks.cleanup = await executeStep({
      driverPath,
      executeDriver,
      request,
      operation: 'scoped-cleanup',
      secretCanary,
    });
  }
  const completedAt = now().toISOString();
  const report = {
    schemaVersion: 1,
    host,
    runId,
    candidate: structuredClone(request.candidate),
    artifactDigest,
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    checks,
    result: 'passed',
  };
  const validated = validateNativeSyncEvidence(report, request);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await atomicWrite(destination, validated);
  return validated;
}

async function executeStep({
  driverPath,
  executeDriver,
  request,
  operation,
  secretCanary,
}) {
  const raw = await executeDriver(
    driverPath,
    deepFreeze({ ...request, operation }),
  );
  assert(typeof raw === 'string', 'Packaged driver output must be text.');
  assert(
    !canaryEncodings(secretCanary).some((encoded) => raw.includes(encoded)),
    'Packaged driver output contains the protected secret canary.',
  );
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Packaged driver returned invalid JSON during ${operation}.`,
    );
  }
}

export function validateNativeSyncEvidence(report, request) {
  assertRecord(report, 'Packaged sync report');
  assertExactKeys(
    report,
    [
      'schemaVersion',
      'host',
      'runId',
      'candidate',
      'artifactDigest',
      'startedAt',
      'completedAt',
      'durationMs',
      'checks',
      'result',
    ],
    'Packaged sync report',
  );
  assert(report.schemaVersion === 1, 'Report schemaVersion must be 1.');
  assert(
    report.host === request.host,
    'Report host does not match the request.',
  );
  assert(
    report.runId === request.runId,
    'Report run ID does not match the request.',
  );
  assertCandidate(report.candidate, request.candidate);
  assert(
    report.artifactDigest === request.artifactDigest,
    'Report artifact digest does not match the request.',
  );
  const startedAt = timestamp(report.startedAt, 'Report startedAt');
  const completedAt = timestamp(report.completedAt, 'Report completedAt');
  assert(completedAt >= startedAt, 'Report completion precedes its start.');
  assert(
    Number.isSafeInteger(report.durationMs) &&
      report.durationMs === completedAt - startedAt,
    'Report duration does not match its timestamps.',
  );
  assert(report.result === 'passed', 'Packaged sync report did not pass.');
  assertChecks(report.checks, request.limits);
  assertNoConfidentialFields(report);
  return deepFreeze(structuredClone(report));
}

function assertChecks(checks, limits) {
  assertRecord(checks, 'Packaged sync checks');
  assertExactKeys(
    checks,
    [
      'relativeRoute',
      'broker',
      'offline',
      'restart',
      'reauthentication',
      'transfer',
      'canary',
      'cleanup',
    ],
    'Packaged sync checks',
  );
  assertPassed(checks.relativeRoute, 'Relative-route check', [
    'failedAsExpected',
  ]);
  assert(
    checks.relativeRoute.failedAsExpected === true,
    'Packaged relative routes must fail before broker use.',
  );

  assertPassed(checks.broker, 'Broker check', [
    'connected',
    'persistenceMode',
    'restartRequiresReauthentication',
  ]);
  assert(checks.broker.connected === true, 'Native broker did not connect.');
  assert(
    PERSISTENCE_MODES.has(checks.broker.persistenceMode),
    'Native persistence mode is invalid.',
  );
  assert(
    checks.broker.restartRequiresReauthentication ===
      (checks.broker.persistenceMode === 'session-only'),
    'Native persistence status is inconsistent.',
  );

  assertPassed(checks.offline, 'Offline check', [
    'publicationReadable',
    'localMutationPreserved',
    'pendingOperationPreserved',
  ]);
  for (const field of [
    'publicationReadable',
    'localMutationPreserved',
    'pendingOperationPreserved',
  ]) {
    assert(checks.offline[field] === true, `Offline ${field} was not proven.`);
  }

  assertPassed(checks.restart, 'Restart check', [
    'publicationReadable',
    'localMutationPreserved',
    'pendingOperationPreserved',
    'sessionContinuity',
  ]);
  assert(
    checks.restart.publicationReadable === true &&
      checks.restart.localMutationPreserved === true &&
      checks.restart.pendingOperationPreserved === true,
    'Restart did not preserve local-first state.',
  );
  assert(
    checks.restart.sessionContinuity ===
      (checks.broker.persistenceMode === 'protected'),
    'Restart authority does not match the declared persistence mode.',
  );

  assertPassed(checks.reauthentication, 'Reauthentication check', [
    'required',
    'completed',
  ]);
  assert(
    checks.reauthentication.required ===
      checks.broker.restartRequiresReauthentication,
    'Reauthentication requirement does not match broker status.',
  );
  assert(
    checks.reauthentication.completed === true,
    'Required recovery did not complete.',
  );

  assertPassed(checks.transfer, 'Transfer check', [
    'bytes',
    'attempts',
    'interrupted',
    'wholeTransferRetry',
    'cancelled',
    'progressMonotonic',
    'maxBufferedBytes',
    'rssDeltaBytes',
    'duplicateAcknowledgements',
    'danglingReferences',
  ]);
  assert(
    checks.transfer.bytes === limits.transferBytes,
    'Transfer size is invalid.',
  );
  assert(
    Number.isSafeInteger(checks.transfer.attempts) &&
      checks.transfer.attempts >= 2,
    'Whole-transfer retry was not observed.',
  );
  for (const field of [
    'interrupted',
    'wholeTransferRetry',
    'cancelled',
    'progressMonotonic',
  ]) {
    assert(
      checks.transfer[field] === true,
      `Transfer ${field} was not proven.`,
    );
  }
  assert(
    Number.isSafeInteger(checks.transfer.maxBufferedBytes) &&
      checks.transfer.maxBufferedBytes >= 0 &&
      checks.transfer.maxBufferedBytes <= limits.maxBufferedBytes,
    'Transfer exceeded the unacknowledged buffer limit.',
  );
  assert(
    Number.isSafeInteger(checks.transfer.rssDeltaBytes) &&
      checks.transfer.rssDeltaBytes >= 0 &&
      checks.transfer.rssDeltaBytes <= limits.maxRssDeltaBytes,
    'Transfer exceeded the incremental RSS limit.',
  );
  assert(
    checks.transfer.duplicateAcknowledgements === 0 &&
      checks.transfer.danglingReferences === 0,
    'Transfer left duplicate acknowledgements or dangling references.',
  );

  assertPassed(checks.canary, 'Canary check', ['id', 'locations']);
  assert(checks.canary.id === 'native-sync-secret', 'Canary ID is invalid.');
  assertRecord(checks.canary.locations, 'Canary locations');
  assertExactKeys(
    checks.canary.locations,
    CANARY_LOCATIONS,
    'Canary locations',
  );
  for (const location of CANARY_LOCATIONS) {
    assert(
      checks.canary.locations[location] === false,
      `Secret canary was detected in ${location}.`,
    );
  }

  assertPassed(checks.cleanup, 'Cleanup check', [
    'driverStopped',
    'destinationRemoved',
    'processesStopped',
  ]);
  assert(
    checks.cleanup.driverStopped === true &&
      checks.cleanup.destinationRemoved === true &&
      checks.cleanup.processesStopped === true,
    'Packaged journey cleanup was incomplete.',
  );
}

function assertPassed(value, label, fields) {
  assertRecord(value, label);
  assertExactKeys(value, ['result', ...fields], label);
  assert(value.result === 'passed', `${label} did not pass.`);
}

function assertCandidate(actual, expected) {
  assertRecord(actual, 'Report candidate');
  assertExactKeys(actual, ['commit', 'release'], 'Report candidate');
  assert(
    actual.commit === expected.commit && actual.release === expected.release,
    'Report candidate does not match the request.',
  );
}

function assertNoConfidentialFields(value, path = 'report') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoConfidentialFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
    assert(
      ![
        'account',
        'cookie',
        'credential',
        'rawerror',
        'repository',
        'secret',
        'token',
        'transferurl',
      ].some((term) => normalized.includes(term)),
      `${path} contains confidential field ${key}.`,
    );
    assertNoConfidentialFields(entry, `${path}.${key}`);
  }
}

function executeControlDriver(executable, request) {
  const result = spawnSync(executable, [], {
    encoding: 'utf8',
    input: `${JSON.stringify(request)}\n`,
    maxBuffer: MAX_DRIVER_OUTPUT_BYTES,
    shell: false,
    timeout: DRIVER_TIMEOUT_MS,
  });
  assert(
    !result.error && result.status === 0,
    'Packaged synchronization control driver failed.',
  );
  assert(
    Buffer.byteLength(result.stdout) <= MAX_DRIVER_OUTPUT_BYTES,
    'Packaged driver output is too large.',
  );
  return result.stdout;
}

function canaryEncodings(value) {
  const buffer = Buffer.from(value, 'utf8');
  return [
    value,
    encodeURIComponent(value),
    new URLSearchParams({ value }).toString().slice('value='.length),
    buffer.toString('base64'),
    buffer.toString('base64url'),
  ].filter((entry, index, values) => values.indexOf(entry) === index);
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

async function assertOutputAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Packaged synchronization evidence already exists.');
}

function timestamp(value, label) {
  assert(
    typeof value === 'string' &&
      UTC_TIMESTAMP.test(value) &&
      new Date(value).toISOString() === value,
    `${label} is invalid.`,
  );
  return Date.parse(value);
}

function assertExactKeys(value, required, label) {
  const expected = [...required].sort();
  const actual = Object.keys(value).sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} fields are invalid.`,
  );
}

function assertRecord(value, label) {
  assert(isRecord(value), `${label} must be an object.`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  await runNativeSyncJourney({
    driverPath: process.env['OMNIA_NATIVE_SYNC_CONTROL_DRIVER'],
    outputPath:
      process.env['OMNIA_NATIVE_SYNC_EVIDENCE'] ??
      'dist/native-sync-evidence/report.json',
    host: process.env['OMNIA_NATIVE_SYNC_HOST'],
    runId: process.env['OMNIA_NATIVE_SYNC_RUN_ID'],
    candidateCommit: process.env['OMNIA_NATIVE_SYNC_CANDIDATE_COMMIT'],
    candidateRelease: process.env['OMNIA_NATIVE_SYNC_CANDIDATE_RELEASE'],
    artifactDigest: process.env['OMNIA_NATIVE_SYNC_ARTIFACT_DIGEST'],
    secretCanary: process.env['OMNIA_NATIVE_SYNC_SECRET_CANARY'],
    protectedRunner: process.env['OMNIA_NATIVE_SYNC_PROTECTED_RUNNER'] === '1',
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
