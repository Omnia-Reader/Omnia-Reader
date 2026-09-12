import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { publicationBinaryEvidence } from './canonical-recovery-inventory';
import { SimulatedSyncGateway } from './simulated-sync-gateway';
import {
  monitorSyncBrowserFailures,
  selectSyncProvider,
} from './sync-test-helpers';

test.use({ serviceWorkers: 'block' });

interface CorpusDocument {
  path: string;
  value: Record<string, unknown>;
}

interface CorpusObject {
  path: string;
  mediaType: string;
  size: number;
  sha256: string;
  base64: string;
}

interface SyncCorpus {
  corpusVersion: number;
  schema: string;
  expectedOutcome: string;
  documents: CorpusDocument[];
  objects: CorpusObject[];
}

interface PointerCorpus {
  corpusVersion: number;
  expectedOutcome: string;
  cases: { name: string; content: string }[];
}

const fixtureRoot = join(
  workspaceRoot,
  'apps/omnia-reader-e2e/src/fixtures/sync-compatibility',
);

test('restores the current corpus and verifies its immutable publication', async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const corpus = await readCorpus('current-v2.json');
  const root = requiredDocument(corpus, '.omnia-reader/manifest.json');
  const book = requiredBook(corpus);
  const object = requiredObject(corpus);
  const bytes = Buffer.from(object.base64, 'base64');

  expect(corpus).toMatchObject({
    corpusVersion: 1,
    schema: 'current-v2',
    expectedOutcome: 'restore',
  });
  expectRootManifest(root.value, 2, true);
  expectBookManifest(book.value, object.path);
  expect(object.path).toBe(book.value['objectPath']);
  expect(object.mediaType).toBe(book.value['mediaType']);
  expect(bytes).toHaveLength(object.size);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(object.sha256);

  await expectCorpusRestore(context, page, corpus);
});

test('migrates and restores the legacy corpus', async ({ context, page }) => {
  test.setTimeout(60_000);
  const corpus = await readCorpus('legacy-v1.json');
  const root = requiredDocument(corpus, '.omnia-reader/manifest.json');
  const book = requiredBook(corpus);
  const object = requiredObject(corpus);

  expect(corpus).toMatchObject({
    corpusVersion: 1,
    schema: 'legacy-v1',
    expectedOutcome: 'migrate-and-restore',
  });
  expectRootManifest(root.value, 1, false);
  expectBookManifest(book.value, object.path);
  expect(book.value['objectPath']).toBe(object.path);
  expect(Buffer.from(object.base64, 'base64')).toHaveLength(object.size);

  const gateway = await expectCorpusRestore(context, page, corpus);
  expect(
    gateway
      .documentPaths()
      .some((path) => path.startsWith('.omnia-reader/v1/')),
  ).toBe(false);
  expect(
    gateway.objectPaths().some((path) => path.startsWith('.omnia-reader/v1/')),
  ).toBe(false);
  expect(gateway.documentPaths()).toContain(
    '.omnia-reader/library/Corpus Book--fe7749d6680c/book.json',
  );
});

test('rejects the future-schema and malformed-pointer corpora', async () => {
  const future = await readCorpus('future-v3.json');
  const root = requiredDocument(future, '.omnia-reader/manifest.json');
  const pointers = await readJson<PointerCorpus>('malformed-lfs-pointers.json');

  expect(future.expectedOutcome).toBe('reject-without-mutation');
  expectRootManifest(root.value, 3, true);
  expect(pointers).toMatchObject({
    corpusVersion: 1,
    expectedOutcome: 'reject',
  });
  expect(pointers.cases).toHaveLength(5);
  expect(pointers.cases.map(({ name }) => name)).toEqual([
    'missing version',
    'wrong algorithm',
    'invalid digest',
    'negative size',
    'unexpected field',
  ]);
  expect(new Set(pointers.cases.map(({ content }) => content)).size).toBe(5);
});

async function readCorpus(name: string): Promise<SyncCorpus> {
  return readJson<SyncCorpus>(name);
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureRoot, name), 'utf8')) as T;
}

function requiredDocument(corpus: SyncCorpus, path: string): CorpusDocument {
  const document = corpus.documents.find(
    (candidate) => candidate.path === path,
  );
  expect(document, `Missing corpus document: ${path}`).toBeDefined();
  return document as CorpusDocument;
}

function requiredBook(corpus: SyncCorpus): CorpusDocument {
  const document = corpus.documents.find(({ path }) =>
    path.endsWith('/book.json'),
  );
  expect(document, 'Missing corpus book manifest').toBeDefined();
  return document as CorpusDocument;
}

function requiredObject(corpus: SyncCorpus): CorpusObject {
  expect(corpus.objects).toHaveLength(1);
  return corpus.objects[0] as CorpusObject;
}

function expectBookManifest(
  value: Record<string, unknown>,
  expectedObjectPath: string,
): void {
  expect(value).toMatchObject({
    schemaVersion: 2,
    format: 'pdf',
    mediaType: 'application/pdf',
    size: 1876,
    objectPath: expectedObjectPath,
  });
  expect(value['bookId']).toBe(`sha256:${value['sha256'] as string}`);
  expect(value['sha256']).toMatch(/^[a-f0-9]{64}$/);
}

function expectRootManifest(
  value: Record<string, unknown>,
  schemaVersion: number,
  hasLogicalBooks: boolean,
): void {
  expect(value).toMatchObject({
    schemaVersion,
    application: 'omnia-reader',
    publicationIdentity: 'sha256',
  });
  expect(value['features']).toEqual(
    expect.arrayContaining(['annotations', 'bookmarks', 'books', 'progress']),
  );
  expect((value['features'] as string[]).includes('logical-books')).toBe(
    hasLogicalBooks,
  );
}

async function expectCorpusRestore(
  context: import('@playwright/test').BrowserContext,
  page: import('@playwright/test').Page,
  corpus: SyncCorpus,
): Promise<SimulatedSyncGateway> {
  const gateway = new SimulatedSyncGateway('git');
  for (const document of corpus.documents) {
    gateway.seedDocument(
      document.path,
      `${JSON.stringify(document.value, null, 2)}\n`,
    );
  }
  for (const object of corpus.objects) {
    gateway.seedObject(object.path, Buffer.from(object.base64, 'base64'), {
      mediaType: object.mediaType,
      size: object.size,
      sha256: object.sha256,
    });
  }
  await gateway.install(context);
  const failures = monitorSyncBrowserFailures(page);

  await page.goto('/settings/sync');
  await selectSyncProvider(page, /^Git \+ LFS/);
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  await page.goto('/library');
  await expect(page.getByText('Corpus Book', { exact: true })).toBeVisible();
  await expect
    .poll(() => publicationBinaryEvidence(page))
    .toEqual([
      {
        bookId:
          'sha256:fe7749d6680cd9b49b1e67868e82c8e183e75486d00b6becdd598819333fa3fb',
        size: 1876,
        sha256:
          'fe7749d6680cd9b49b1e67868e82c8e183e75486d00b6becdd598819333fa3fb',
      },
    ]);
  expect(failures()).toEqual([]);
  return gateway;
}
