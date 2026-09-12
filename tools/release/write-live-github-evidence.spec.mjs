import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  liveGitHubObservation,
  writeLiveGitHubEvidence,
} from './write-live-github-evidence.mjs';

const candidate = {
  candidateCommit: 'a'.repeat(40),
  candidateRelease: '0.1.0-rc.1',
  artifactDigest: `sha256:${'b'.repeat(64)}`,
};

test('writes a sanitized passing live GitHub gate for the exact candidate', async (context) => {
  const fixture = await evidenceFixture(context);
  const result = await writeLiveGitHubEvidence({ ...fixture, ...candidate });

  assert.equal(result.summary.result, 'passed');
  assert.equal(result.summary.throttle, 'observed');
  assert.equal(result.evidence.runs[0].gateId, 'live-github-conformance');
  assert.equal(result.evidence.runs[0].result, 'passed');
  assert.deepEqual(result.evidence.unavailableGates, []);
  assert.equal(
    JSON.parse(await readFile(result.evidencePath, 'utf8')).candidate.commit,
    candidate.candidateCommit,
  );
});

test('records safe throttle absence as unavailable instead of passed', () => {
  const report = playwrightReport('passed', [
    {
      type: 'live-github-throttling',
      description: 'UNAVAILABLE: staging does not expose a safe throttle',
    },
  ]);
  assert.equal(
    liveGitHubObservation(report, passingScan()).result,
    'unavailable',
  );
});

test('records test or scan failure without copying raw errors', () => {
  const report = playwrightReport('failed');
  report.suites[0].specs[0].tests[0].results[0].errors = [
    { message: 'provider secret must never be copied' },
  ];
  const observation = liveGitHubObservation(report, passingScan());
  assert.equal(observation.result, 'failed');
  assert.equal(JSON.stringify(observation).includes('provider secret'), false);

  const failedScan = { ...passingScan(), result: 'failed' };
  assert.equal(
    liveGitHubObservation(playwrightReport('passed'), failedScan).result,
    'failed',
  );
});

test('rejects skipped, retried, malformed, and canary-positive reports', () => {
  assert.throws(
    () => liveGitHubObservation(playwrightReport('skipped'), passingScan()),
    /may not skip/,
  );
  const retried = playwrightReport('passed');
  retried.suites[0].specs[0].tests[0].results.push({
    status: 'passed',
    duration: 1,
    annotations: [],
  });
  assert.throws(
    () => liveGitHubObservation(retried, passingScan()),
    /retries are not allowed/,
  );
  assert.throws(
    () =>
      liveGitHubObservation(playwrightReport('passed'), {
        ...passingScan(),
        canaries: [{ id: 'live-github-secret', present: true }],
      }),
    /detected/,
  );
});

test('rejects mutable or unsafe candidate identity', async (context) => {
  const fixture = await evidenceFixture(context);
  await assert.rejects(
    writeLiveGitHubEvidence({
      ...fixture,
      ...candidate,
      artifactDigest: 'latest',
    }),
    /artifact digest/,
  );
});

test('refuses to replace append-only sanitized evidence', async (context) => {
  const fixture = await evidenceFixture(context);
  const first = await writeLiveGitHubEvidence({ ...fixture, ...candidate });
  const before = await readFile(first.evidencePath, 'utf8');
  await assert.rejects(
    writeLiveGitHubEvidence({ ...fixture, ...candidate }),
    /EEXIST/,
  );
  assert.equal(await readFile(first.evidencePath, 'utf8'), before);
});

async function evidenceFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-live-evidence-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, 'report.json');
  const scanPath = join(directory, 'scan.json');
  await writeFile(reportPath, JSON.stringify(playwrightReport('passed')));
  await writeFile(scanPath, JSON.stringify(passingScan()));
  return {
    reportPath,
    scanPath,
    outputDirectory: join(directory, 'output'),
  };
}

function playwrightReport(status, annotations = []) {
  return {
    stats: {
      startTime: '2026-09-12T20:00:00.000Z',
      duration: 1250,
      expected: status === 'passed' ? 1 : 0,
      skipped: status === 'skipped' ? 1 : 0,
      unexpected: status === 'failed' ? 1 : 0,
      flaky: 0,
    },
    suites: [
      {
        title: 'sync-live-github.spec.ts',
        specs: [
          {
            tests: [
              {
                status: status === 'passed' ? 'expected' : status,
                annotations,
                results: [
                  {
                    status,
                    duration: 1250,
                    retry: 0,
                    startTime: '2026-09-12T20:00:01.000Z',
                    annotations,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function passingScan() {
  return {
    schemaVersion: 1,
    result: 'passed',
    canaries: [{ id: 'live-github-secret', present: false }],
  };
}
