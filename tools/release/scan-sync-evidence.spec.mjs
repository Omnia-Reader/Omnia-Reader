import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import {
  SYNC_EVIDENCE_TARGET_KINDS,
  canariesFromEnvironment,
  scanSyncEvidence,
} from './scan-sync-evidence.mjs';

const secret = 'sync-secret-canary-9f6e2a4d';
const scannerPath = fileURLToPath(
  new URL('./scan-sync-evidence.mjs', import.meta.url),
);

test('reports clean trace, IPC, log, report, redirect, evidence, and synchronized records', async (t) => {
  const root = await evidenceRoot(t);

  const result = await scanSyncEvidence({
    root,
    canaries: [{ id: 'oauth-canary', value: secret }],
  });

  assert.equal(result.result, 'passed');
  assert.equal(result.scannedFiles, SYNC_EVIDENCE_TARGET_KINDS.length);
  assert.deepEqual(
    result.targets.map(({ kind }) => kind),
    [...SYNC_EVIDENCE_TARGET_KINDS],
  );
  assert.deepEqual(result.canaries, [{ id: 'oauth-canary', present: false }]);
  assert.deepEqual(result.detections, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

for (const kind of [
  'trace',
  'ipc',
  'log',
  'report',
  'redirect',
  'evidence',
  'synchronized-record',
]) {
  test(`detects a canary in ${kind} artifacts without returning its value`, async (t) => {
    const root = await evidenceRoot(t);
    await writeFile(join(root, kind, 'leak.txt'), `prefix:${secret}:suffix`);

    const result = await scanSyncEvidence({
      root,
      canaries: [{ id: 'session-canary', value: secret }],
    });

    assert.equal(result.result, 'failed');
    assert.deepEqual(result.canaries, [
      { id: 'session-canary', present: true },
    ]);
    assert.deepEqual(result.detections, [
      {
        canaryId: 'session-canary',
        target: kind,
        fileId: result.detections[0].fileId,
        encoding: 'literal',
      },
    ]);
    assert.match(result.detections[0].fileId, /^[a-f0-9]{16}$/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  });
}

test('detects percent-encoded and base64 canary variants in binary artifacts', async (t) => {
  const root = await evidenceRoot(t);
  const urlSecret = 'oauth+/secret?canary=ab12cd34';
  const binarySecret = 'binary-secret-canary-e8b5c2a1';
  const formSecret = 'form secret canary 7a3c9e1b';
  await writeFile(
    join(root, 'redirect', 'callback.txt'),
    `omnia-reader://callback?value=${encodeURIComponent(urlSecret)}`,
  );
  await writeFile(
    join(root, 'trace', 'network.bin'),
    Buffer.from(binarySecret).toString('base64'),
  );
  await writeFile(
    join(root, 'report', 'form.txt'),
    new URLSearchParams({ canary: formSecret }).toString(),
  );

  const result = await scanSyncEvidence({
    root,
    canaries: [
      { id: 'oauth-canary', value: urlSecret },
      { id: 'cookie-canary', value: binarySecret },
      { id: 'form-canary', value: formSecret },
    ],
  });

  assert.equal(result.result, 'failed');
  assert.deepEqual(
    result.detections.map(({ canaryId, target, encoding }) => ({
      canaryId,
      target,
      encoding,
    })),
    [
      {
        canaryId: 'cookie-canary',
        target: 'trace',
        encoding: 'base64',
      },
      {
        canaryId: 'form-canary',
        target: 'report',
        encoding: 'form-encoded',
      },
      {
        canaryId: 'oauth-canary',
        target: 'redirect',
        encoding: 'percent-encoded',
      },
    ],
  );
});

test('detects canaries inside compressed Playwright-style trace archives', async (t) => {
  const root = await evidenceRoot(t);
  const archive = new JSZip();
  archive.file('trace.network', `request-header:${secret}`);
  const bytes = await archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  await writeFile(join(root, 'trace', 'trace.zip'), bytes);

  const result = await scanSyncEvidence({
    root,
    canaries: [{ id: 'trace-canary', value: secret }],
  });

  assert.equal(result.result, 'failed');
  assert.equal(result.scannedArchiveEntries, 1);
  assert.deepEqual(
    result.detections.map(({ canaryId, target, encoding }) => ({
      canaryId,
      target,
      encoding,
    })),
    [{ canaryId: 'trace-canary', target: 'trace', encoding: 'literal' }],
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('fails closed for missing target classes and symbolic links', async (t) => {
  const root = await evidenceRoot(t);
  await rm(join(root, 'ipc'), { recursive: true });
  await assert.rejects(
    () =>
      scanSyncEvidence({
        root,
        canaries: [{ id: 'oauth-canary', value: secret }],
      }),
    /required ipc target is missing/,
  );

  await mkdir(join(root, 'ipc'));
  await writeFile(join(root, 'ipc', 'clean.json'), '{"status":"passed"}\n');
  await writeFile(join(root, 'outside.txt'), 'clean');
  await symlink(join(root, 'outside.txt'), join(root, 'log', 'linked.txt'));
  await assert.rejects(
    () =>
      scanSyncEvidence({
        root,
        canaries: [{ id: 'oauth-canary', value: secret }],
      }),
    /symbolic links are not allowed/,
  );
});

test('rejects archive traversal before scanning extracted contents', async (t) => {
  const root = await evidenceRoot(t);
  const archive = new JSZip();
  archive.file('../outside.txt', secret);
  await writeFile(
    join(root, 'trace', 'unsafe.zip'),
    await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );

  await assert.rejects(
    () =>
      scanSyncEvidence({
        root,
        canaries: [{ id: 'trace-canary', value: secret }],
      }),
    /unsafe archive entry path/,
  );
});

test('loads unique bounded canaries from a protected environment value', () => {
  assert.deepEqual(
    canariesFromEnvironment(
      JSON.stringify({ oauth: secret, cookie: 'cookie-canary-2c4d6e8f' }),
    ),
    [
      { id: 'cookie', value: 'cookie-canary-2c4d6e8f' },
      { id: 'oauth', value: secret },
    ],
  );
  assert.throws(
    () => canariesFromEnvironment(JSON.stringify({ short: 'too-short' })),
    /short must contain at least 16 UTF-8 bytes/,
  );
  assert.throws(() => canariesFromEnvironment('{'), /must be a JSON object/);
});

test('CLI emits only sanitized results and exits non-zero on detection', async (t) => {
  const root = await evidenceRoot(t);
  const environment = {
    ...process.env,
    OMNIA_SYNC_SECRET_CANARIES: JSON.stringify({ oauth: secret }),
  };
  const clean = spawnSync(process.execPath, [scannerPath, root], {
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).result, 'passed');

  await writeFile(join(root, 'ipc', 'leak.txt'), secret);
  const leaked = spawnSync(process.execPath, [scannerPath, root], {
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(leaked.status, 1, leaked.stderr);
  assert.equal(JSON.parse(leaked.stdout).result, 'failed');
  assert.doesNotMatch(`${leaked.stdout}${leaked.stderr}`, new RegExp(secret));
});

async function evidenceRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'omnia-sync-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    SYNC_EVIDENCE_TARGET_KINDS.map(async (kind) => {
      await mkdir(join(root, kind), { recursive: true });
      await writeFile(join(root, kind, 'clean.json'), '{"status":"passed"}\n');
    }),
  );
  return root;
}
