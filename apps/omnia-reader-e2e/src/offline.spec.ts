import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { createEpubFixture, createPdfFixture } from './publication-fixtures';
import {
  canonicalInventoryFields,
  recoveryMatrixRows,
  rowsOwnedBy,
} from './recovery-compatibility-matrix';
import {
  canonicalRecoveryInventory,
  clearStoredPublicationBinaries,
} from './canonical-recovery-inventory';

interface OfflineScenario {
  profileName: string;
  fileName: string;
  mimeType: string;
  format: 'epub' | 'pdf';
  title: string;
  publication: () => Buffer | Promise<Buffer>;
  navigateAndAwaitDurableProgress(page: Page): Promise<void>;
  expectRestoredPosition(page: Page): Promise<void>;
}

const scenarios: readonly OfflineScenario[] = [
  {
    profileName: 'pdf',
    fileName: 'offline-fixture.pdf',
    mimeType: 'application/pdf',
    format: 'pdf',
    title: 'Omnia PDF Fixture',
    publication: () => createPdfFixture(),
    navigateAndAwaitDurableProgress: async (page) => {
      await expect(
        page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
      ).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await expect(
        page.locator('.pdfViewer .page[data-page-number="2"] canvas'),
      ).toBeVisible();
      await expect.poll(() => storedProgressPage(page)).toBe(2);
    },
    expectRestoredPosition: async (page) => {
      await expect(
        page.locator('.pdfViewer .page[data-page-number="2"] canvas'),
      ).toBeVisible();
    },
  },
  {
    profileName: 'epub',
    fileName: 'offline-fixture.epub',
    mimeType: 'application/epub+zip',
    format: 'epub',
    title: 'Omnia EPUB Fixture',
    publication: () => createEpubFixture(),
    navigateAndAwaitDurableProgress: async (page) => {
      await expectEpubChapter(page, 'Chapter One');
      await ensureTableOfContentsOpen(page);
      await page.getByRole('button', { name: /^\d+\s+Chapter Two$/ }).click();
      await expectEpubChapter(page, 'Chapter Two');
      await expect
        .poll(() => storedProgressHref(page))
        .toContain('chapter-2.xhtml');
    },
    expectRestoredPosition: (page) => expectEpubChapter(page, 'Chapter Two'),
  },
];

test('records all six committed-offline restart recovery rows', async () => {
  const rows = rowsOwnedBy(recoveryMatrixRows, 'offline');
  expect(rows).toHaveLength(6);
  expect(rows.every(({ expectedState }) => expectedState === 'after')).toBe(
    true,
  );
});

test('cold-starts stored PDF and EPUB positions while fully offline', async ({
  baseURL,
}, testInfo) => {
  // Angular only registers its service worker in a production build served
  // from a secure origin; the matrix inventory above remains browser-neutral.
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PWA_E2E'] !== '1',
    'Run against the production service-worker build with PWA_E2E=1',
  );
  test.setTimeout(90_000);
  expect(scenarios).toHaveLength(2);
  const resolvedBaseURL = requireBaseURL(baseURL);

  for (const scenario of scenarios) {
    await verifyColdOfflineRestore(testInfo, resolvedBaseURL, scenario);
  }
});

test('cold-starts an offline EPUB and PDF association with canonical state intact', async ({
  baseURL,
}, testInfo) => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PWA_E2E'] !== '1',
    'Run against the production service-worker build with PWA_E2E=1',
  );
  test.setTimeout(90_000);
  const restartedInventory = await verifyOfflineOperationRestart(
    testInfo,
    requireBaseURL(baseURL),
    {
      profileName: 'association',
      apply: associateOfflineFormats,
      expectAfterRestart: expectAssociatedFormatsReadable,
    },
  );
  expect(restartedInventory['membership'] as readonly unknown[]).toHaveLength(
    1,
  );
});

test('cold-starts an offline detach with canonical state intact', async ({
  baseURL,
}, testInfo) => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PWA_E2E'] !== '1',
    'Run against the production service-worker build with PWA_E2E=1',
  );
  test.setTimeout(90_000);
  await verifyOfflineOperationRestart(testInfo, requireBaseURL(baseURL), {
    profileName: 'detach',
    apply: async (page) => {
      await associateOfflineFormats(page);
      const card = page
        .getByTestId('library-book')
        .filter({ hasText: 'Omnia EPUB Fixture' });
      await card
        .getByRole('button', {
          name: 'Separate PDF from Omnia EPUB Fixture',
        })
        .click();
      await page
        .getByRole('dialog', { name: 'Separate the PDF version?' })
        .getByRole('button', { name: 'Separate format' })
        .click();
      await expect(page.getByTestId('library-status')).toContainText(
        'PDF was separated from “Omnia EPUB Fixture”',
      );
      await expect(page.getByTestId('library-book')).toHaveCount(2);
    },
    expectAfterRestart: expectDetachedFormatsReadable,
  });
});

test('cold-starts an offline non-last deletion with canonical state intact', async ({
  baseURL,
}, testInfo) => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PWA_E2E'] !== '1',
    'Run against the production service-worker build with PWA_E2E=1',
  );
  test.setTimeout(90_000);
  await verifyOfflineOperationRestart(testInfo, requireBaseURL(baseURL), {
    profileName: 'delete-non-last',
    apply: async (page) => {
      await associateOfflineFormats(page);
      const card = page
        .getByTestId('library-book')
        .filter({ hasText: 'Omnia EPUB Fixture' });
      await card
        .getByRole('button', { name: 'Remove PDF for Omnia EPUB Fixture' })
        .click();
      await page
        .getByRole('dialog', {
          name: 'Remove the PDF version of “Omnia PDF Fixture”?',
        })
        .getByRole('button', { name: 'Remove book' })
        .click();
      await expect(page.getByTestId('library-status')).toContainText(
        '“Omnia PDF Fixture” removed',
      );
      await expect(page.getByTestId('library-book')).toHaveCount(1);
      await expect(card.getByRole('button', { name: /^PDF\b/ })).toHaveCount(0);
    },
    expectAfterRestart: expectRemainingEpubReadable,
  });
});

test('cold-starts an offline preferred-format change with canonical state intact', async ({
  baseURL,
}, testInfo) => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PWA_E2E'] !== '1',
    'Run against the production service-worker build with PWA_E2E=1',
  );
  test.setTimeout(90_000);
  const restartedInventory = await verifyOfflineOperationRestart(
    testInfo,
    requireBaseURL(baseURL),
    {
      profileName: 'preference',
      apply: async (page) => {
        await associateOfflineFormats(page);
        await page
          .getByTestId('library-book')
          .getByRole('button', { name: /^PDF\b/ })
          .click();
        await expectPdfFirstPage(page);
        await page.getByRole('link', { name: 'Library', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: 'Library', exact: true }),
        ).toBeVisible();
      },
      expectAfterRestart: async (page) => {
        await page
          .getByRole('button', {
            name: 'Open Omnia EPUB Fixture in its preferred format',
          })
          .click();
        await expectPdfFirstPage(page);
      },
    },
  );
  expect(restartedInventory['preferredFormat']).toEqual([
    expect.objectContaining({ preferredFormat: 'pdf' }),
  ]);
});

test('cold-starts an offline exact-source replacement with canonical state intact', async ({
  baseURL,
}, testInfo) => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PWA_E2E'] !== '1',
    'Run against the production service-worker build with PWA_E2E=1',
  );
  test.setTimeout(90_000);
  await verifyOfflineOperationRestart(testInfo, requireBaseURL(baseURL), {
    profileName: 'exact-source-replacement',
    apply: async (page) => {
      const pdf = await createPdfFixture();
      await importFile(page, {
        name: 'offline-replacement.pdf',
        mimeType: 'application/pdf',
        buffer: pdf,
        title: 'Omnia PDF Fixture',
      });
      await clearStoredPublicationBinaries(page);
      await page.reload();
      const replace = page.getByRole('button', {
        name: 'Replace PDF for Omnia PDF Fixture from this device',
      });
      await expect(replace).toBeVisible();
      const chooser = page.waitForEvent('filechooser');
      await replace.click();
      await (
        await chooser
      ).setFiles({
        name: 'offline-replacement-copy.pdf',
        mimeType: 'application/pdf',
        buffer: pdf,
      });
      await expect(page.getByTestId('library-status')).toContainText(
        'PDF for “Omnia PDF Fixture” was restored from this device.',
      );
    },
    expectAfterRestart: async (page) => {
      await page
        .getByTestId('library-book')
        .getByRole('button', { name: /^PDF\b/ })
        .click();
      await expectPdfFirstPage(page);
    },
  });
});

interface OfflineOperationScenario {
  profileName: string;
  apply(page: Page): Promise<void>;
  expectAfterRestart(page: Page): Promise<void>;
}

async function verifyOfflineOperationRestart(
  testInfo: TestInfo,
  baseURL: string,
  scenario: OfflineOperationScenario,
): Promise<Record<string, unknown>> {
  const userDataDir = testInfo.outputPath(`${scenario.profileName}-profile`);
  const browserFailures: string[] = [];
  let context: BrowserContext | null = await launchPersistentContext(
    userDataDir,
    baseURL,
  );
  try {
    const page = await existingOrNewPage(context);
    monitorBrowserFailures(page, browserFailures);
    await prepareControlledPwa(page);
    await context.setOffline(true);
    await scenario.apply(page);
    const inventoryBeforeRestart = await canonicalRecoveryInventory(page);
    expect(Object.keys(inventoryBeforeRestart).sort()).toEqual(
      [...canonicalInventoryFields].sort(),
    );

    await context.close();
    context = null;
    context = await launchPersistentContext(userDataDir, baseURL);
    await context.setOffline(true);
    const offlinePage = await existingOrNewPage(context);
    monitorBrowserFailures(offlinePage, browserFailures);
    await offlinePage.goto('/');
    await expect(
      offlinePage.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();
    const inventoryAfterRestart = await canonicalRecoveryInventory(offlinePage);
    expect(inventoryAfterRestart).toEqual(inventoryBeforeRestart);
    await scenario.expectAfterRestart(offlinePage);
    expect(browserFailures).toEqual([]);
    return inventoryAfterRestart;
  } finally {
    await context?.close();
  }
}

async function associateOfflineFormats(page: Page): Promise<void> {
  const pdf = await createPdfFixture();
  await importFile(page, {
    name: 'offline-membership.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
    title: 'Omnia EPUB Fixture',
  });
  await importFile(page, {
    name: 'offline-membership.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
    title: 'Omnia PDF Fixture',
  });
  const destination = page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia EPUB Fixture' });
  const chooser = page.waitForEvent('filechooser');
  await destination
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'offline-membership-copy.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  const dialog = page.getByRole('dialog', {
    name: 'Associate an existing book',
  });
  await dialog.getByRole('radio', { name: /Omnia PDF Fixture/ }).check();
  await dialog.getByRole('button', { name: 'Associate books' }).click();
  await expect(page.getByTestId('library-book')).toHaveCount(1);
  await expect(
    destination.getByRole('button', { name: /^EPUB\b/ }),
  ).toBeVisible();
  await expect(
    destination.getByRole('button', { name: /^PDF\b/ }),
  ).toBeVisible();
}

async function expectAssociatedFormatsReadable(page: Page): Promise<void> {
  const card = page.getByTestId('library-book');
  await expect(card).toHaveCount(1);
  await openEpubAndReturnToLibrary(page, card);
  await page
    .getByTestId('library-book')
    .getByRole('button', { name: /^PDF\b/ })
    .click();
  await expectPdfFirstPage(page);
}

async function expectDetachedFormatsReadable(page: Page): Promise<void> {
  await expect(page.getByTestId('library-book')).toHaveCount(2);
  const epubCard = page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia EPUB Fixture' });
  await openEpubAndReturnToLibrary(page, epubCard);
  await page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia PDF Fixture' })
    .getByRole('button', { name: /^PDF\b/ })
    .click();
  await expectPdfFirstPage(page);
}

async function expectRemainingEpubReadable(page: Page): Promise<void> {
  const card = page.getByTestId('library-book');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: /^PDF\b/ })).toHaveCount(0);
  await card.getByRole('button', { name: /^EPUB\b/ }).click();
  await expectEpubChapter(page, 'Chapter One');
}

async function openEpubAndReturnToLibrary(
  page: Page,
  card: Locator,
): Promise<void> {
  await card.getByRole('button', { name: /^EPUB\b/ }).click();
  await expectEpubChapter(page, 'Chapter One');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
}

async function expectPdfFirstPage(page: Page): Promise<void> {
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
}

function requireBaseURL(value: string | undefined): string {
  if (!value) {
    throw new Error('The PWA test requires a string baseURL');
  }
  return value;
}

async function verifyColdOfflineRestore(
  testInfo: TestInfo,
  baseURL: string,
  scenario: OfflineScenario,
): Promise<void> {
  const userDataDir = testInfo.outputPath(`${scenario.profileName}-profile`);
  const browserFailures: string[] = [];
  let context: BrowserContext | null = await launchPersistentContext(
    userDataDir,
    baseURL,
  );
  try {
    const page = await existingOrNewPage(context);
    monitorBrowserFailures(page, browserFailures);
    await prepareControlledPwa(page);
    await context.setOffline(true);

    await importPublication(page, scenario);
    await openScenarioFormat(page, scenario);
    await scenario.navigateAndAwaitDurableProgress(page);
    const inventoryBeforeRestart = await canonicalRecoveryInventory(page);
    expect(Object.keys(inventoryBeforeRestart).sort()).toEqual(
      [...canonicalInventoryFields].sort(),
    );

    await context.close();
    context = null;

    context = await launchPersistentContext(userDataDir, baseURL);
    await context.setOffline(true);
    const offlinePage = await existingOrNewPage(context);
    monitorBrowserFailures(offlinePage, browserFailures);
    await offlinePage.goto('/');
    await expect(
      offlinePage.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();
    await expect(
      offlinePage.getByText(scenario.title, { exact: true }),
    ).toBeVisible();
    const inventoryAfterRestart = await canonicalRecoveryInventory(offlinePage);
    expect(inventoryAfterRestart).toEqual(inventoryBeforeRestart);

    await openScenarioFormat(offlinePage, scenario);
    await scenario.expectRestoredPosition(offlinePage);
    expect(browserFailures).toEqual([]);
  } finally {
    await context?.close();
  }
}

async function openScenarioFormat(
  page: Page,
  scenario: OfflineScenario,
): Promise<void> {
  const card = page
    .getByTestId('library-book')
    .filter({ hasText: scenario.title });
  await card
    .getByRole('button', {
      name: new RegExp(`^${scenario.format.toUpperCase()}\\b`),
    })
    .click();
}

function monitorBrowserFailures(page: Page, failures: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
}

async function launchPersistentContext(
  userDataDir: string,
  baseURL: string,
): Promise<BrowserContext> {
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  return chromium.launchPersistentContext(userDataDir, {
    baseURL,
    headless: true,
    serviceWorkers: 'allow',
    ...(executablePath ? { executablePath } : {}),
  });
}

async function existingOrNewPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? context.newPage();
}

async function prepareControlledPwa(page: Page): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
}

async function importPublication(
  page: Page,
  scenario: OfflineScenario,
): Promise<void> {
  await importFile(page, {
    name: scenario.fileName,
    mimeType: scenario.mimeType,
    buffer: await scenario.publication(),
    title: scenario.title,
  });
}

async function importFile(
  page: Page,
  publication: {
    name: string;
    mimeType: string;
    buffer: Buffer;
    title: string;
  },
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: publication.name,
    mimeType: publication.mimeType,
    buffer: publication.buffer,
  });
  await expect(
    page.getByText(publication.title, { exact: true }),
  ).toBeVisible();
}

async function ensureTableOfContentsOpen(page: Page): Promise<void> {
  const toggle = page.getByRole('button', {
    name: 'Toggle table of contents',
  });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(
    page.getByRole('complementary', { name: 'Table of contents' }),
  ).toBeVisible();
}

async function expectEpubChapter(page: Page, chapter: string): Promise<void> {
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: chapter, exact: true }),
  ).toBeVisible();
}

async function storedProgressPage(page: Page): Promise<number | null> {
  return (await storedProgress(page))?.locator?.locations?.position ?? null;
}

async function storedProgressHref(page: Page): Promise<string | null> {
  return (await storedProgress(page))?.locator?.href ?? null;
}

async function storedProgress(page: Page): Promise<{
  locator?: {
    href?: string;
    locations?: { position?: number };
  };
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const progress = await new Promise<{
      locator?: {
        href?: string;
        locations?: { position?: number };
      };
    } | null>((resolve, reject) => {
      const request = database
        .transaction('progress', 'readonly')
        .objectStore('progress')
        .getAll();
      request.addEventListener('success', () =>
        resolve(request.result[0] ?? null),
      );
      request.addEventListener('error', () => reject(request.error));
    });
    database.close();
    return progress;
  });
}
