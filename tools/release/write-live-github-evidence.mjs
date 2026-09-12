import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSyncEvidence } from './verify-sync-evidence.mjs';

const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_BYTES = 1024 * 1024;
const SUMMARY_NAME = 'live-github-summary.json';
const EVIDENCE_NAME = 'live-github-evidence.json';

export async function writeLiveGitHubEvidence({
  reportPath,
  scanPath,
  outputDirectory,
  candidateCommit,
  candidateRelease,
  artifactDigest,
}) {
  assert(FULL_COMMIT.test(candidateCommit), 'Candidate commit is invalid.');
  assert(
    SAFE_IDENTIFIER.test(candidateRelease),
    'Candidate release is invalid.',
  );
  assert(
    SHA256_DIGEST.test(artifactDigest),
    'Candidate artifact digest is invalid.',
  );
  const report = await readJson(
    reportPath,
    MAX_REPORT_BYTES,
    'Playwright report',
  );
  const scan = await readJson(scanPath, MAX_SCAN_BYTES, 'Canary scan');
  const observation = liveGitHubObservation(report, scan);

  const summary = {
    schemaVersion: 1,
    gateId: 'live-github-conformance',
    candidate: {
      commit: candidateCommit,
      release: candidateRelease,
      artifactDigest,
    },
    environment: 'sync-staging-v1',
    result: observation.result,
    startedAt: observation.startedAt,
    completedAt: observation.completedAt,
    durationMs: observation.durationMs,
    canary: { id: 'live-github-secret', present: false },
    throttle: observation.throttle,
  };
  const evidence = validateSyncEvidence({
    schemaVersion: 1,
    candidate: { commit: candidateCommit, release: candidateRelease },
    artifacts: [{ name: 'staging', digest: artifactDigest }],
    environments: [{ id: 'sync-staging', profile: 'sync-staging-v1' }],
    runs:
      observation.result === 'unavailable'
        ? []
        : [
            {
              gateId: 'live-github-conformance',
              provider: 'git',
              scenario: 'protected-live-conformance',
              platform: 'web',
              browser: 'chromium',
              attempt: 1,
              startedAt: observation.startedAt,
              completedAt: observation.completedAt,
              durationMs: observation.durationMs,
              result: observation.result,
              artifact: SUMMARY_NAME,
            },
          ],
    unavailableGates:
      observation.result === 'unavailable'
        ? [
            {
              gateId: 'live-github-conformance',
              reason: 'safe-throttle-unavailable',
            },
          ]
        : [],
    startedAt: observation.startedAt,
    completedAt: observation.completedAt,
    result: 'candidate',
  });

  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const summaryPath = join(output, SUMMARY_NAME);
  const evidencePath = join(output, EVIDENCE_NAME);
  await atomicWrite(summaryPath, summary);
  try {
    await atomicWrite(evidencePath, evidence);
  } catch (error) {
    await unlink(summaryPath).catch(() => undefined);
    throw error;
  }
  return {
    summary,
    evidence,
    summaryPath,
    evidencePath,
  };
}

export function liveGitHubObservation(report, scan) {
  assertRecord(report, 'Playwright report');
  assertRecord(report.stats, 'Playwright report stats');
  assert(Array.isArray(report.suites), 'Playwright report suites are invalid.');
  assert(
    report.suites.length === 1,
    'Playwright report must contain only the live GitHub suite.',
  );
  const specs = report.suites
    .filter(
      (suite) => isRecord(suite) && suite.title === 'sync-live-github.spec.ts',
    )
    .flatMap((suite) => (Array.isArray(suite.specs) ? suite.specs : []));
  assert(specs.length === 1, 'Expected exactly one live GitHub specification.');
  const tests = Array.isArray(specs[0].tests) ? specs[0].tests : [];
  assert(tests.length === 1, 'Expected exactly one live GitHub test.');
  const test = tests[0];
  assertRecord(test, 'Live GitHub test');
  const results = Array.isArray(test.results) ? test.results : [];
  assert(results.length === 1, 'Live GitHub retries are not allowed.');
  const result = results[0];
  assertRecord(result, 'Live GitHub result');
  assert(result.retry === 0, 'Live GitHub retries are not allowed.');
  assert(
    result.status !== 'skipped',
    'A protected live GitHub test may not skip.',
  );
  assert(
    ['passed', 'failed', 'timedOut', 'interrupted'].includes(result.status),
    'Live GitHub result status is invalid.',
  );
  assert(
    Number.isSafeInteger(result.duration) && result.duration >= 0,
    'Live GitHub duration is invalid.',
  );

  const startedAt = timestamp(result.startTime, 'Live GitHub start time');
  const durationMs = result.duration;
  const completedAt = new Date(
    Date.parse(startedAt) + durationMs,
  ).toISOString();
  const annotations = [
    ...(Array.isArray(test.annotations) ? test.annotations : []),
    ...(Array.isArray(result.annotations) ? result.annotations : []),
  ];
  const throttleUnavailable = annotations.some(
    (annotation) =>
      isRecord(annotation) &&
      annotation.type === 'live-github-throttling' &&
      annotation.description ===
        'UNAVAILABLE: staging does not expose a safe throttle',
  );

  assertRecord(scan, 'Canary scan');
  assert(Array.isArray(scan.canaries), 'Canary scan entries are invalid.');
  assert(
    scan.schemaVersion === 1 &&
      (scan.result === 'passed' || scan.result === 'failed') &&
      scan.canaries.length === 1,
    'Canary scan result is invalid.',
  );
  const canary = scan.canaries.find(
    (entry) => isRecord(entry) && entry.id === 'live-github-secret',
  );
  assertRecord(canary, 'Live GitHub canary result');
  assert(canary.present === false, 'Live GitHub canary was detected.');
  const passed = result.status === 'passed' && scan.result === 'passed';
  return {
    result: passed
      ? throttleUnavailable
        ? 'unavailable'
        : 'passed'
      : 'failed',
    throttle: throttleUnavailable ? 'unavailable' : 'observed',
    startedAt,
    completedAt,
    durationMs,
  };
}

async function readJson(path, maximumBytes, label) {
  const contents = await readFile(path);
  assert(contents.byteLength <= maximumBytes, `${label} is too large.`);
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
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

function timestamp(value, label) {
  assert(
    typeof value === 'string' &&
      new Date(value).toISOString() === value &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
    `${label} is invalid.`,
  );
  return value;
}

function assertRecord(value, label) {
  assert(isRecord(value), `${label} must be an object.`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    assert(name?.startsWith('--') && value, 'Evidence arguments are invalid.');
    const key = name.slice(2);
    assert(!Object.hasOwn(values, key), `Duplicate argument: ${name}`);
    values[key] = value;
  }
  const expected = [
    'report',
    'scan',
    'output',
    'candidate-commit',
    'candidate-release',
    'artifact-digest',
  ];
  assert(
    Object.keys(values).length === expected.length &&
      expected.every((key) => Object.hasOwn(values, key)),
    'Usage: write-live-github-evidence.mjs --report <json> --scan <json> --output <directory> --candidate-commit <commit> --candidate-release <release> --artifact-digest <digest>',
  );
  return values;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const result = await writeLiveGitHubEvidence({
    reportPath: arguments_['report'],
    scanPath: arguments_['scan'],
    outputDirectory: arguments_['output'],
    candidateCommit: arguments_['candidate-commit'],
    candidateRelease: arguments_['candidate-release'],
    artifactDigest: arguments_['artifact-digest'],
  });
  process.stdout.write(
    `Wrote ${basename(result.summaryPath)} and ${basename(result.evidencePath)}.\n`,
  );
  if (result.summary.result !== 'passed') process.exitCode = 1;
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
