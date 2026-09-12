import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertCleanReleaseSource,
  parseReleaseArguments,
  prepareSyncEvidenceInput,
  validateReleaseSyncEvidence,
  writeReleaseOutputs,
} from './verify-release.mjs';
import { MANDATORY_SYNC_GATE_IDS } from './verify-sync-evidence.mjs';

const commit = 'a'.repeat(40);
const version = '0.1.0';

test('requires explicit, accepted evidence for the matching release candidate', () => {
  const evidence = acceptedEvidence();
  assert.equal(
    validateReleaseSyncEvidence(evidence, { commit, version }),
    evidence,
  );

  assert.throws(
    () =>
      validateReleaseSyncEvidence(
        { ...evidence, result: 'candidate' },
        { commit, version },
      ),
    /must be explicitly accepted/,
  );
  assert.throws(
    () =>
      validateReleaseSyncEvidence(evidence, {
        commit: 'b'.repeat(40),
        version,
      }),
    /commit does not match/,
  );
  assert.throws(
    () =>
      validateReleaseSyncEvidence(evidence, {
        commit,
        version: '0.2.0',
      }),
    /release does not match/,
  );
});

test('accepted evidence requires an exact clean source checkout', () => {
  assert.doesNotThrow(() => assertCleanReleaseSource(''));
  assert.throws(
    () => assertCleanReleaseSource(' M apps/omnia-reader/src/main.ts\n'),
    /requires a clean source checkout/,
  );
  assert.throws(
    () => assertCleanReleaseSource('?? untracked-release-input.json\n'),
    /requires a clean source checkout/,
  );
});

test('parses one optional synchronization evidence input fail closed', () => {
  assert.deepEqual(parseReleaseArguments([]), {
    skipBuild: false,
    syncEvidencePath: null,
  });
  assert.deepEqual(
    parseReleaseArguments(['--skip-build', '--sync-evidence', 'evidence.json']),
    { skipBuild: true, syncEvidencePath: 'evidence.json' },
  );
  assert.throws(
    () => parseReleaseArguments(['--sync-evidence']),
    /requires a file path/,
  );
  assert.throws(
    () =>
      parseReleaseArguments([
        '--sync-evidence',
        'first.json',
        '--sync-evidence',
        'second.json',
      ]),
    /may be provided only once/,
  );
  assert.throws(() => parseReleaseArguments(['--unknown']), /Unknown argument/);
});

test('clears stale generated evidence before every verifier run', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'omnia-release-stale-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const generatedPath = join(workspaceRoot, 'dist/release/sync-evidence.json');
  await mkdir(join(workspaceRoot, 'dist/release'), { recursive: true });
  await writeFile(generatedPath, '{}');

  assert.equal(await prepareSyncEvidenceInput(workspaceRoot, null), null);
  await assert.rejects(() => readFile(generatedPath), { code: 'ENOENT' });

  await writeFile(generatedPath, '{}');
  await assert.rejects(
    () => prepareSyncEvidenceInput(workspaceRoot, generatedPath),
    /must differ from the generated release output/,
  );
  await assert.rejects(() => readFile(generatedPath), { code: 'ENOENT' });
});

test('checksums canonical evidence and removes stale evidence when omitted', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'omnia-release-sync-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await mkdir(join(workspaceRoot, 'dist/apps/omnia-reader/browser'), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, 'dist/apps/sync-gateway'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, 'dist/apps/omnia-reader/browser/index.html'),
    '<!doctype html>',
  );
  await writeFile(
    join(workspaceRoot, 'dist/apps/sync-gateway/main.js'),
    'export {};',
  );

  const evidence = acceptedEvidence();
  const manifest = await writeReleaseOutputs(
    workspaceRoot,
    version,
    emptySbom('npm'),
    emptySbom('rust'),
    emptySbom('bridge'),
    evidence,
  );
  const writtenEvidence = JSON.parse(
    await readFile(
      join(workspaceRoot, 'dist/release/sync-evidence.json'),
      'utf8',
    ),
  );
  assert.deepEqual(writtenEvidence, evidence);
  assert.equal(
    manifest.files.filter(({ path }) => path === 'release/sync-evidence.json')
      .length,
    1,
  );

  const withoutEvidence = await writeReleaseOutputs(
    workspaceRoot,
    version,
    emptySbom('npm'),
    emptySbom('rust'),
    emptySbom('bridge'),
  );
  await assert.rejects(
    () => readFile(join(workspaceRoot, 'dist/release/sync-evidence.json')),
    { code: 'ENOENT' },
  );
  assert.equal(
    withoutEvidence.files.some(
      ({ path }) => path === 'release/sync-evidence.json',
    ),
    false,
  );
});

function acceptedEvidence() {
  const runs = MANDATORY_SYNC_GATE_IDS.flatMap((gateId) => {
    const attempts = gateId.startsWith('browser-convergence-') ? 3 : 1;
    return Array.from({ length: attempts }, (_, index) =>
      runForGate(gateId, index + 1),
    );
  });
  return {
    schemaVersion: 1,
    candidate: { commit, release: version },
    artifacts: [{ name: 'web', digest: `sha256:${'c'.repeat(64)}` }],
    environments: [],
    runs,
    unavailableGates: [],
    startedAt: '2026-09-12T08:00:00.000Z',
    completedAt: '2026-09-12T09:00:00.000Z',
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

function emptySbom(name) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: { type: 'application', name, version } },
    components: [],
  };
}
