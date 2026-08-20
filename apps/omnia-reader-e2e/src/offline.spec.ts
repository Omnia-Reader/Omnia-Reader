import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { createEpubFixture, createPdfFixture } from './publication-fixtures';
import {
  canonicalInventoryFields,
  recoveryMatrixRows,
  rowsOwnedBy,
} from './recovery-compatibility-matrix';
import { canonicalRecoveryInventory } from './canonical-recovery-inventory';

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
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);

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

async function importPublication(
  page: Page,
  scenario: OfflineScenario,
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: scenario.fileName,
    mimeType: scenario.mimeType,
    buffer: await scenario.publication(),
  });
  await expect(page.getByText(scenario.title, { exact: true })).toBeVisible();
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
