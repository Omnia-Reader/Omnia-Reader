import { expect, test, type Page } from '@playwright/test';
import { seedManagementDataset } from '../performance/management-dataset.mjs';
import { measurePageAction } from '../performance/page-measurement.mjs';
import { createManagementWorkload } from '../performance/management-workload.mjs';
import { createEpubFixture, createPdfFixture } from './publication-fixtures';

test('measures labelled management feedback and unpooled open/switch states', async ({
  page,
  browserName,
}) => {
  // This reduced journey proves measurement orchestration only. It never meets
  // the frozen dataset/sample contract and must not be reported as primary
  // performance evidence.
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PERFORMANCE_MANAGEMENT_SMOKE'] !== '1',
    'Run with the dedicated performance-management-smoke target',
  );
  test.setTimeout(120_000);
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(browserName !== 'chromium', 'The desktop profile uses Chromium');

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await importPublication(
    page,
    'performance-management.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );

  const addPdf = page.getByRole('button', {
    name: 'Add PDF for Omnia EPUB Fixture',
  });
  const invalidAdd = await measurePageAction(
    page,
    {
      activation: { event: 'change', selector: 'input[type="file"]' },
      acknowledgement: {
        selector:
          'button[aria-label="Add PDF for Omnia EPUB Fixture"]:disabled',
      },
      finalState: { selector: '[role="alert"]' },
      timeoutMs: 20_000,
    },
    async () => {
      const chooserPromise = page.waitForEvent('filechooser');
      await addPdf.click();
      const chooser = await chooserPromise;
      await chooser.setFiles({
        name: 'performance-invalid.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\ninvalid'),
      });
    },
  );
  expect(invalidAdd.acknowledgementMs).toBeGreaterThanOrEqual(0);
  expect(invalidAdd.finalResultMs).toBeGreaterThanOrEqual(
    invalidAdd.acknowledgementMs,
  );
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('library-book')).toHaveCount(1);

  const validAdd = await measurePageAction(
    page,
    {
      activation: { event: 'change', selector: 'input[type="file"]' },
      acknowledgement: {
        selector:
          'button[aria-label="Add PDF for Omnia EPUB Fixture"]:disabled',
      },
      finalState: {
        selector: '[data-format-badge="pdf"][aria-label^="PDF (open)"]',
      },
      timeoutMs: 20_000,
    },
    async () => {
      const chooserPromise = page.waitForEvent('filechooser');
      await addPdf.click();
      const chooser = await chooserPromise;
      await chooser.setFiles({
        name: 'performance-management.pdf',
        mimeType: 'application/pdf',
        buffer: createPdfFixture(),
      });
    },
  );
  expect(validAdd.finalResultMs).toBeGreaterThanOrEqual(
    validAdd.acknowledgementMs,
  );
  await expect(page.getByTestId('library-book')).toHaveCount(1);

  const search = page.getByRole('searchbox', { name: 'Search library' });
  const filter = await measurePageAction(
    page,
    {
      activation: {
        event: 'input',
        selector: '#library-search',
      },
      acknowledgement: { selector: '#no-library-results' },
      finalState: { selector: '#no-library-results' },
      timeoutMs: 5_000,
    },
    () => search.fill('not in the performance library'),
  );
  expect(filter.finalResultMs).toBeGreaterThanOrEqual(filter.acknowledgementMs);
  await search.fill('');
  await expect(page.getByTestId('library-book')).toHaveCount(1);

  const openEpub = await measurePageAction(
    page,
    {
      activation: {
        event: 'click',
        selector: 'button[aria-label^="EPUB (open)"]',
      },
      acknowledgement: {
        selector: '[aria-live="polite"] .mat-mdc-progress-spinner',
      },
      finalState: {
        selector: '[data-testid="publication-viewport"] iframe',
      },
      timeoutMs: 20_000,
    },
    () =>
      page
        .getByTestId('library-book')
        .getByRole('button', { name: /^EPUB\b/ })
        .click(),
  );
  expect(openEpub.finalResultMs).toBeGreaterThanOrEqual(
    openEpub.acknowledgementMs,
  );
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible();

  const switchToPdf = await measurePageAction(
    page,
    readerSwitchSpec('pdf'),
    () =>
      page
        .getByRole('group', { name: 'Reading format' })
        .getByRole('button', { name: /^PDF\b/ })
        .click(),
  );
  expect(switchToPdf.finalResultMs).toBeGreaterThanOrEqual(
    switchToPdf.acknowledgementMs,
  );
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  await expect(
    page.getByTestId('publication-viewport').locator('iframe'),
  ).toHaveCount(0);

  const switchToEpub = await measurePageAction(
    page,
    readerSwitchSpec('epub'),
    () =>
      page
        .getByRole('group', { name: 'Reading format' })
        .getByRole('button', { name: /^EPUB\b/ })
        .click(),
  );
  expect(switchToEpub.finalResultMs).toBeGreaterThanOrEqual(
    switchToEpub.acknowledgementMs,
  );
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible();
  await expect(page.locator('.pdfViewer canvas')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test('loads the exact full-cardinality dataset through repository validation', async ({
  page,
  browserName,
}) => {
  // This is a setup/integration proof, not sampled primary evidence.
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PERFORMANCE_MANAGEMENT_DATASET_SMOKE'] !== '1',
    'Run with the dedicated performance-management-dataset-smoke target',
  );
  test.setTimeout(180_000);
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(browserName !== 'chromium', 'The desktop profile uses Chromium');

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');
  const workload = createManagementWorkload();
  const summary = await seedManagementDataset(page, workload);
  expect(summary).toEqual({
    workloadDigest: workload.workloadDigest,
    logicalBooks: 1_000,
    exactVariants: 2_000,
    logicalChangeHistory: 500,
  });
  await page.reload();

  const cards = page.getByTestId('library-book');
  await expect(cards).toHaveCount(1_000, { timeout: 60_000 });
  const firstVerified = [...workload.items].sort((left, right) =>
    left.logicalBookId.localeCompare(right.logicalBookId),
  )[0];
  const firstCard = cards.filter({
    has: page.getByRole('heading', {
      name: firstVerified.title,
      exact: true,
    }),
  });
  await expect(
    firstCard.getByRole('button', { name: /^EPUB \(open\)/ }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    firstCard.getByRole('button', { name: /^PDF \(open\)/ }),
  ).toBeVisible({ timeout: 60_000 });
  await firstCard.getByRole('button', { name: /^EPUB \(open\)/ }).click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole('group', { name: 'Reading format' })
    .getByRole('button', { name: /^PDF\b/ })
    .click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId('publication-viewport').locator('iframe'),
  ).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

function readerSwitchSpec(format: 'epub' | 'pdf') {
  return {
    activation: {
      event: 'click' as const,
      selector: `[aria-label="Reading format"] button[aria-label^="${format.toUpperCase()}"]`,
    },
    acknowledgement: {
      selector: '[aria-live="polite"] .mat-mdc-progress-spinner',
    },
    finalState: {
      selector:
        format === 'epub'
          ? '[data-testid="publication-viewport"] iframe'
          : '.pdfViewer .page[data-page-number="1"] canvas',
    },
    timeoutMs: 20_000,
  };
}

async function importPublication(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
  expectedTitle: string,
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType, buffer });
  await expect(page.getByText(expectedTitle, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
}
