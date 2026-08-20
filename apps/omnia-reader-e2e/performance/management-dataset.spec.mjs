/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import JSZip from 'jszip';
import {
  createManagementSeedBatch,
  createPerformanceEpubTemplate,
  prepareManagementBranchDataset,
  seedManagementDataset,
} from './management-dataset.mjs';
import { MANAGEMENT_BRANCHES } from './management-branches.mjs';
import { createManagementWorkload } from './management-workload.mjs';

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

test('generates deterministic unique valid publication bytes and records', async () => {
  const workload = createManagementWorkload();
  const template = await createPerformanceEpubTemplate();
  const independentlyGeneratedTemplate = await createPerformanceEpubTemplate();
  const first = createManagementSeedBatch(workload, template, 0, 2);
  const second = createManagementSeedBatch(
    workload,
    independentlyGeneratedTemplate,
    0,
    2,
  );

  assert.deepEqual(first, second);
  assert.equal(first.books.length, 4);
  assert.equal(first.binaries.length, 4);
  assert.equal(first.logicalBooks.length, 2);
  assert.equal(new Set(first.books.map(({ id }) => id)).size, 4);
  assert.equal(first.logicalBooks[0].variants.epub, first.books[0].id);
  assert.equal(first.logicalBooks[0].variants.pdf, first.books[1].id);

  const epub = Buffer.from(first.binaries[0].bytesBase64, 'base64');
  const archive = await JSZip.loadAsync(epub);
  assert.equal(
    Object.keys(archive.files).some((path) => path.endsWith('/')),
    false,
  );
  assert.equal(
    await archive.file('mimetype').async('text'),
    'application/epub+zip',
  );
  assert.match(
    await archive.file('OEBPS/chapter.xhtml').async('text'),
    /Chapter One/,
  );
  const pdf = Buffer.from(first.binaries[1].bytesBase64, 'base64');
  assert.match(pdf.toString('utf8'), /^%PDF-1\.4/);
  assert.match(pdf.toString('utf8'), /%%EOF\n$/);
});

test('seeds the exact schema-v9 inventory and 500-change history', async () => {
  await page.route('http://omnia.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Management dataset test</title>',
    }),
  );
  await page.goto('http://omnia.test/');
  await initializeTestDatabases(page);
  const workload = createManagementWorkload();

  const summary = await seedManagementDataset(page, workload, {
    batchSize: 50,
  });

  assert.deepEqual(summary, {
    workloadDigest: workload.workloadDigest,
    logicalBooks: 1_000,
    exactVariants: 2_000,
    logicalChangeHistory: 500,
  });
  assert.deepEqual(await databaseCounts(page), {
    books: 2_000,
    binaries: 2_000,
    logicalBooks: 1_000,
    reconciliations: 0,
    operations: 500,
    revisions: 500,
  });
});

test('prepares twenty isolated fixtures for every management branch in one transaction', async () => {
  const fixturePage = await browser.newPage();
  await fixturePage.route('http://omnia-branches.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Management branch fixtures</title>',
    }),
  );
  await fixturePage.goto('http://omnia-branches.test/');
  await initializeTestDatabases(fixturePage);
  const workload = createManagementWorkload();
  await seedManagementDataset(fixturePage, workload);
  assert.equal((await databaseCounts(fixturePage)).binaries, 2_000);
  const binaryKeysBefore = await storedBinaryKeys(fixturePage);

  const fixtures = await prepareManagementBranchDataset(fixturePage, workload);

  assert.deepEqual(
    Object.keys(fixtures),
    MANAGEMENT_BRANCHES.map(({ id }) => id),
  );
  for (const branch of MANAGEMENT_BRANCHES) {
    assert.equal(fixtures[branch.id].length, 20);
  }
  assert.equal(fixtures['add-local-success'][0].ordinal, 0);
  assert.equal(fixtures['replace-failure'][19].ordinal, 239);
  assert.equal(fixtures['restore-success'][0].ordinal, null);
  assert.equal(fixtures['restore-failure'][19].ordinal, null);
  assert.deepEqual(
    await storedBinaryPresence(fixturePage, [
      fixtures['add-local-success'][0].pdf.record.id,
      fixtures['replace-success'][0].epub.record.id,
    ]),
    [false, false],
  );
  const removedBinaryIds = [
    ...fixtures['add-local-success'].map(({ pdf }) => pdf.record.id),
    ...fixtures['add-local-failure'].map(({ pdf }) => pdf.record.id),
    ...fixtures['replace-success'].map(({ epub }) => epub.record.id),
    ...fixtures['replace-failure'].map(({ epub }) => epub.record.id),
  ];
  assert.equal(new Set(removedBinaryIds).size, 80);
  assert.equal(
    (await storedBinaryPresence(fixturePage, removedBinaryIds)).filter(
      (present) => !present,
    ).length,
    80,
  );
  const binaryKeysAfter = await storedBinaryKeys(fixturePage);
  assert.equal(
    binaryKeysAfter.filter((key) => !binaryKeysBefore.includes(key)).length,
    0,
  );
  assert.equal(
    binaryKeysBefore.filter((key) => !binaryKeysAfter.includes(key)).length,
    80,
  );
  assert.deepEqual(await databaseCounts(fixturePage), {
    books: 1_960,
    binaries: 1_920,
    logicalBooks: 1_040,
    reconciliations: 40,
    operations: 500,
    revisions: 500,
  });
  await fixturePage.close();
});

async function initializeTestDatabases(targetPage) {
  await targetPage.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('omnia-reader', 9);
      request.addEventListener('upgradeneeded', () => {
        const database = request.result;
        database.createObjectStore('books', { keyPath: 'id' });
        database.createObjectStore('binaries', { keyPath: 'bookId' });
        const logicalBooks = database.createObjectStore('logicalBooks', {
          keyPath: 'id',
        });
        logicalBooks.createIndex('epubVariantId', 'variants.epub', {
          unique: true,
        });
        logicalBooks.createIndex('pdfVariantId', 'variants.pdf', {
          unique: true,
        });
        database.createObjectStore('logicalBookReconciliations', {
          keyPath: 'conflictId',
        });
      });
      request.addEventListener('success', () => {
        request.result.close();
        resolve();
      });
      request.addEventListener('error', () => reject(request.error));
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('omnia-reader-sync', 1);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore('operations', { keyPath: 'id' });
        request.result.createObjectStore('revisions', {
          keyPath: 'entityKey',
        });
      });
      request.addEventListener('success', () => {
        request.result.close();
        resolve();
      });
      request.addEventListener('error', () => reject(request.error));
    });
  });
}

async function databaseCounts(targetPage) {
  return targetPage.evaluate(async () => {
    const open = (name, version) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
    const count = (database, storeName) =>
      new Promise((resolve, reject) => {
        const request = database
          .transaction(storeName, 'readonly')
          .objectStore(storeName)
          .count();
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
    const library = await open('omnia-reader', 9);
    const sync = await open('omnia-reader-sync', 1);
    try {
      const [
        books,
        binaries,
        logicalBooks,
        reconciliations,
        operations,
        revisions,
      ] = await Promise.all([
        count(library, 'books'),
        count(library, 'binaries'),
        count(library, 'logicalBooks'),
        count(library, 'logicalBookReconciliations'),
        count(sync, 'operations'),
        count(sync, 'revisions'),
      ]);
      return {
        books,
        binaries,
        logicalBooks,
        reconciliations,
        operations,
        revisions,
      };
    } finally {
      library.close();
      sync.close();
    }
  });
}

async function storedBinaryPresence(targetPage, bookIds) {
  return targetPage.evaluate(async (ids) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('omnia-reader', 9);
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    try {
      return await Promise.all(
        ids.map(
          (id) =>
            new Promise((resolve, reject) => {
              const request = database
                .transaction('binaries', 'readonly')
                .objectStore('binaries')
                .get(id);
              request.addEventListener('success', () =>
                resolve(request.result !== undefined),
              );
              request.addEventListener('error', () => reject(request.error));
            }),
        ),
      );
    } finally {
      database.close();
    }
  }, bookIds);
}

async function storedBinaryKeys(targetPage) {
  return targetPage.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('omnia-reader', 9);
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database
          .transaction('binaries', 'readonly')
          .objectStore('binaries')
          .getAllKeys();
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
    } finally {
      database.close();
    }
  });
}
