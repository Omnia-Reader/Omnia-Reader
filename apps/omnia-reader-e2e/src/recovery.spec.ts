import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createMalformedPdfFixture } from './publication-fixtures';

const browserFailures = new WeakMap<
  import('@playwright/test').Page,
  string[]
>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page) ?? []).toEqual([]);
});

test('rejects a malformed PDF without retaining an unusable library entry', async ({
  page,
}) => {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'broken-publication.pdf',
    mimeType: 'application/pdf',
    buffer: createMalformedPdfFixture(),
  });

  await expect(page.getByRole('alert')).toContainText(/invalid pdf/i);
  await expect(
    page.getByText('broken-publication', { exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('broken-publication', { exact: true }),
  ).toHaveCount(0);
});

test('inspects and exports a lossless quarantined record', async ({ page }) => {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const transaction = database.transaction('books', 'readwrite');
    transaction.objectStore('books').put({
      id: 'corrupt-book',
      title: 'Damaged local metadata',
      bytes: new Uint8Array([0, 1, 2, 255]),
    });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('error', () => reject(transaction.error));
      transaction.addEventListener('abort', () => reject(transaction.error));
    });
    database.close();
  });

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(
    page.getByRole('heading', { name: 'Recovered local data', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Book metadata failed schema validation', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Original key: corrupt-book')).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .withTags([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22a',
      'wcag22aa',
    ])
    .analyze();
  expect(
    accessibility.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recovered data' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const document = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    schemaVersion: number;
    recordCount: number;
    records: {
      storeName: string;
      reason: string;
      value: unknown;
    }[];
  };

  expect(download.suggestedFilename()).toMatch(
    /^omnia-reader-quarantine-\d{4}-\d{2}-\d{2}\.omnia-quarantine\.json$/,
  );
  expect(document.schemaVersion).toBe(1);
  expect(document.recordCount).toBe(1);
  expect(document.records[0]).toMatchObject({
    storeName: 'books',
    reason: 'Book metadata failed schema validation',
  });
  expect(JSON.stringify(document.records[0].value)).toContain('AAEC/w==');
  await expect(
    page.getByText('Recovery data exported with 1 quarantined record.'),
  ).toBeVisible();
});
