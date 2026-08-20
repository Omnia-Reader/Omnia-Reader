import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  createManagementSampleFixture,
  prepareManagementBranchDataset,
  seedManagementDataset,
} from '../performance/management-dataset.mjs';
import {
  MANAGEMENT_BRANCHES,
  MANAGEMENT_DISTRIBUTIONS,
} from '../performance/management-branches.mjs';
import {
  PageMeasurementError,
  measurePageAction,
} from '../performance/page-measurement.mjs';
import {
  canonicalStringify,
  readJsonFile,
} from '../performance/performance-contract.mjs';
import { runPrimaryManagementMeasurement } from '../performance/primary-management-run.mjs';
import { captureSamplingIdentity } from '../performance/sampling-identity.mjs';
import { createManagementWorkload } from '../performance/management-workload.mjs';
import {
  createManagementRestoreBackup,
  runManagementBranchSample,
} from './management-branch-driver';
import { runManagementDistributionSample } from './management-distribution-driver';
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

test('exercises every management branch through labelled product controls', async ({
  page,
  browserName,
}) => {
  // This one-sample-per-branch journey proves real UI reachability and failure
  // setup. It remains supplemental and cannot satisfy primary cardinality.
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PERFORMANCE_MANAGEMENT_BRANCH_SMOKE'] !== '1',
    'Run with the dedicated performance-management-branch-smoke target',
  );
  test.setTimeout(600_000);
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(browserName !== 'chromium', 'The desktop profile uses Chromium');

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');
  const workload = createManagementWorkload();
  await seedManagementDataset(page, workload);
  const fixtures = await prepareManagementBranchDataset(page, workload);
  const distributionFixture = await createManagementSampleFixture(
    workload,
    900,
  );
  const backup = await createManagementRestoreBackup(
    fixtures['detach-failure'][0],
  );
  await page.reload();
  await expect(page.getByTestId('library-book')).toHaveCount(1_040, {
    timeout: 60_000,
  });
  for (const branch of MANAGEMENT_BRANCHES) {
    await test.step(branch.id, async () => {
      const measurement = await runManagementBranchSample(
        page,
        branch,
        fixtures[branch.id][0],
        backup,
      );
      expect(measurement.acknowledgementMs).toBeGreaterThanOrEqual(0);
      expect(measurement.finalResultMs).toBeGreaterThanOrEqual(
        measurement.acknowledgementMs,
      );
    });
  }
  for (const distribution of MANAGEMENT_DISTRIBUTIONS) {
    await test.step(distribution.id, async () => {
      const measurement = await runManagementDistributionSample(
        page,
        distribution,
        distributionFixture,
      );
      expect(measurement.finalResultMs).toBeGreaterThanOrEqual(0);
    });
  }
  expect(consoleErrors).toEqual([]);
});

test('writes the complete qualified desktop management result', async ({
  page,
  browser,
  browserName,
}) => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PERFORMANCE_DESKTOP_WEB'] !== '1',
    'Run through the qualified performance-desktop-web launcher',
  );
  test.setTimeout(4 * 60 * 60 * 1_000);
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(browserName !== 'chromium', 'The desktop profile uses Chromium');

  const profilePath = requiredEnvironmentPath(
    'PERFORMANCE_DESKTOP_PROFILE_SET',
  );
  const environmentPath = requiredEnvironmentPath(
    'PERFORMANCE_DESKTOP_ENVIRONMENT',
  );
  const workloadPath = requiredEnvironmentPath('PERFORMANCE_DESKTOP_WORKLOAD');
  const rawResultPath = requiredEnvironmentPath(
    'PERFORMANCE_DESKTOP_RAW_RESULT',
  );
  const [profileSet, environment, workload] = await Promise.all([
    readJsonFile(profilePath),
    readJsonFile(environmentPath),
    readJsonFile(workloadPath),
  ]);
  const [width, height] = String(environment.values['environment.viewport'])
    .split('x')
    .map(Number);
  await page.setViewportSize({ width, height });

  const consoleErrors: string[] = [];
  let missingAcknowledgements = 0;
  let wrongResults = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await installOverlapCounter(page);

  await page.goto('/');
  await seedManagementDataset(page, workload);
  const fixtures = await prepareManagementBranchDataset(page, workload);
  const distributionFixture = await createManagementSampleFixture(
    workload,
    900,
  );
  const backup = await createManagementRestoreBackup(
    fixtures['detach-failure'][0],
  );
  await page.reload();
  await expect(page.getByTestId('library-book')).toHaveCount(1_040, {
    timeout: 60_000,
  });

  const samplingIdentity = await captureSamplingIdentity({
    profileSet,
    environment,
    workload,
    browserName,
    browserVersion: browser.version(),
    viewport: page.viewportSize(),
    deviceScaleFactor: await page.evaluate(() => window.devicePixelRatio),
  });
  const counted = async <Result>(operation: () => Promise<Result>) => {
    try {
      return await operation();
    } catch (error) {
      const missingAcknowledgement = error instanceof PageMeasurementError;
      missingAcknowledgements += Number(missingAcknowledgement);
      wrongResults += Number(!missingAcknowledgement);
      throw error;
    }
  };
  const result = await runPrimaryManagementMeasurement({
    profileSet,
    environment,
    workload,
    samplingIdentity,
    command:
      'npx nx run omnia-reader-e2e:e2e -- --project=chromium --workers=1 performance-management.spec.ts',
    runBranchSample: ({ branch, sampleIndex }) =>
      counted(() =>
        runManagementBranchSample(
          page,
          branch,
          fixtures[branch.id][sampleIndex],
          backup,
        ),
      ),
    runDistributionSample: ({ distribution }) =>
      counted(() =>
        runManagementDistributionSample(
          page,
          distribution,
          distributionFixture,
        ),
      ),
    readCounters: async () => ({
      consoleErrors: consoleErrors.length,
      missingAcknowledgements,
      overlappingEngines: await readOverlapCounter(page),
      wrongResults,
    }),
  });
  await writeFile(rawResultPath, `${canonicalStringify(result)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
});

function requiredEnvironmentPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function installOverlapCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storageKey = 'omnia.performance.overlapping-engines';
    const start = () => {
      let overlapping = false;
      const inspect = () => {
        const current =
          document.querySelector(
            '[data-testid="publication-viewport"] iframe',
          ) !== null && document.querySelector('.pdfViewer canvas') !== null;
        if (current && !overlapping) {
          const count = Number(sessionStorage.getItem(storageKey) ?? '0');
          sessionStorage.setItem(storageKey, String(count + 1));
        }
        overlapping = current;
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      inspect();
    };
    if (document.documentElement) start();
    else addEventListener('DOMContentLoaded', start, { once: true });
  });
}

function readOverlapCounter(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(
      sessionStorage.getItem('omnia.performance.overlapping-engines') ?? '0',
    ),
  );
}

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
