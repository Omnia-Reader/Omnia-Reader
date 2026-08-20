/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import JSZip from 'jszip';
import {
  createManagementSeedBatch,
  createPerformanceEpubTemplate,
  seedManagementDataset,
} from './management-dataset.mjs';
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
  const first = createManagementSeedBatch(workload, template, 0, 2);
  const second = createManagementSeedBatch(workload, template, 0, 2);

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
    operations: 500,
    revisions: 500,
  });
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
      const [books, binaries, logicalBooks, operations, revisions] =
        await Promise.all([
          count(library, 'books'),
          count(library, 'binaries'),
          count(library, 'logicalBooks'),
          count(sync, 'operations'),
          count(sync, 'revisions'),
        ]);
      return { books, binaries, logicalBooks, operations, revisions };
    } finally {
      library.close();
      sync.close();
    }
  });
}
