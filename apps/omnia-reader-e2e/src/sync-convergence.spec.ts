import { createHash } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  canonicalRecoveryInventory,
  publicationBinaryEvidence,
} from './canonical-recovery-inventory';
import { createEpubFixture, createPdfFixture } from './publication-fixtures';
import {
  createEpubHighlight,
  createPdfHighlight,
  expectReaderRoute,
  openLibraryPublication,
} from './reader-state-helpers';
import {
  SimulatedSyncGateway,
  type SimulatedSyncProvider,
} from './simulated-sync-gateway';
import {
  importSyncPublication,
  monitorSyncBrowserFailures,
  selectSyncProvider,
} from './sync-test-helpers';

test.use({ serviceWorkers: 'block' });

interface SyncScenario {
  provider: SimulatedSyncProvider;
  providerButtonName: RegExp;
  name: string;
  mimeType: string;
  publicationExtension: '.pdf' | '.epub';
  title: string;
  publication: () => Buffer | Promise<Buffer>;
  navigate: (page: Page) => Promise<void>;
  createHighlight: (page: Page) => Promise<void>;
  highlightText: string;
  annotationNote: string;
  navigateToSecondDeviceState: (page: Page) => Promise<void>;
  createSecondDeviceHighlight: (page: Page) => Promise<void>;
  secondDeviceHighlightText: string;
  secondDeviceAnnotationNote: string;
  expectRestoredLocation: (page: Page) => Promise<void>;
  prepareSuccessfulSync: (
    page: Page,
    gateway: SimulatedSyncGateway,
  ) => Promise<void>;
  expectSuccessfulSync: (page: Page) => Promise<void>;
}

type PublicationScenario = Omit<
  SyncScenario,
  | 'provider'
  | 'providerButtonName'
  | 'prepareSuccessfulSync'
  | 'expectSuccessfulSync'
>;

const publicationScenarios: readonly PublicationScenario[] = [
  {
    name: 'sync-fixture.pdf',
    mimeType: 'application/pdf',
    publicationExtension: '.pdf',
    title: 'Omnia PDF Fixture',
    publication: () => createPdfFixture(),
    navigate: async (page) => {
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => storedProgressPage(page), { timeout: 20_000 })
        .toBe(2);
    },
    createHighlight: (page) =>
      createPdfHighlight(page, 2, 'Page Two', 'Synchronized PDF annotation.'),
    highlightText: 'Page Two',
    annotationNote: 'Synchronized PDF annotation.',
    navigateToSecondDeviceState: async (page) => {
      await page.keyboard.press('ArrowUp');
      await expect(
        page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
      ).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => storedProgressPage(page), { timeout: 20_000 })
        .toBe(1);
    },
    createSecondDeviceHighlight: (page) =>
      createPdfHighlight(page, 1, 'Page One', 'Second device PDF annotation.'),
    secondDeviceHighlightText: 'Page One',
    secondDeviceAnnotationNote: 'Second device PDF annotation.',
    expectRestoredLocation: async (page) => {
      await expect(
        page.locator('.pdfViewer .page[data-page-number="2"] canvas'),
      ).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => storedProgressPage(page), { timeout: 20_000 })
        .toBe(2);
    },
  },
  {
    name: 'sync-fixture.epub',
    mimeType: 'application/epub+zip',
    publicationExtension: '.epub',
    title: 'Omnia EPUB Fixture',
    publication: () => createEpubFixture(),
    navigate: async (page) => {
      await ensureTableOfContentsOpen(page);
      await page.getByRole('button', { name: /^\d+\s+Chapter Two$/ }).click();
      await expectEpubChapter(page, 'Chapter Two');
      await expect
        .poll(() => storedProgressHref(page), { timeout: 20_000 })
        .toContain('chapter-2.xhtml');
    },
    createHighlight: (page) =>
      createEpubHighlight(
        page,
        'second EPUB fixture',
        'Synchronized EPUB annotation.',
      ),
    highlightText: 'second EPUB fixture',
    annotationNote: 'Synchronized EPUB annotation.',
    navigateToSecondDeviceState: async (page) => {
      await ensureTableOfContentsOpen(page);
      await page.getByRole('button', { name: /^\d+\s+Chapter One$/ }).click();
      await expectEpubChapter(page, 'Chapter One');
      await expect
        .poll(() => storedProgressHref(page), { timeout: 20_000 })
        .toContain('chapter-1.xhtml');
    },
    createSecondDeviceHighlight: (page) =>
      createEpubHighlight(
        page,
        'first EPUB fixture',
        'Second device EPUB annotation.',
      ),
    secondDeviceHighlightText: 'first EPUB fixture',
    secondDeviceAnnotationNote: 'Second device EPUB annotation.',
    expectRestoredLocation: async (page) => {
      await expectEpubChapter(page, 'Chapter Two');
      await expect
        .poll(() => storedProgressHref(page), { timeout: 20_000 })
        .toContain('chapter-2.xhtml');
    },
  },
];

const providers: readonly Pick<
  SyncScenario,
  'provider' | 'providerButtonName'
>[] = [
  { provider: 'git', providerButtonName: /^Git \+ LFS/ },
  { provider: 'mega', providerButtonName: /^MEGA/ },
];

const scenarios: readonly SyncScenario[] = providers.flatMap((provider) =>
  publicationScenarios.map((publication) => ({
    ...publication,
    ...provider,
    prepareSuccessfulSync:
      provider.provider === 'git'
        ? verifyInterruptedGitUpload
        : noSyncPreparation,
    expectSuccessfulSync:
      provider.provider === 'git'
        ? expectRetriedGitConflict
        : noSyncStatusAssertion,
  })),
);
let completedConvergenceScenarios = 0;

test.afterAll(() => {
  if (process.env['REMOTE_SYNC_E2E'] === '1') {
    expect(completedConvergenceScenarios).toBe(scenarios.length);
  }
});

test('covers every provider and publication format in the two-device convergence matrix', () => {
  expect(
    scenarios.map(({ provider, mimeType }) => `${provider}:${mimeType}`).sort(),
  ).toEqual(
    [
      'git:application/epub+zip',
      'git:application/pdf',
      'mega:application/epub+zip',
      'mega:application/pdf',
    ].sort(),
  );
});

test('keeps an active transfer and success history scoped to its selected destination', async ({
  context,
  page,
}) => {
  const publication = await createPdfFixture();
  const git = new SimulatedSyncGateway('git', {
    holdFirstObjectUpload: true,
    expectedPublication: publication,
  });
  const mega = new SimulatedSyncGateway('mega', {
    expectedPublication: publication,
  });
  await git.install(context);
  await mega.install(context);

  await page.goto('/');
  await importSyncPublication(
    page,
    'destination-isolation.pdf',
    'application/pdf',
    publication,
    'Omnia PDF Fixture',
  );
  await page.goto('/settings/sync');
  await expect(
    page.getByRole('heading', { name: 'Library sync', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();
  await git.waitForObjectUploadStart();
  try {
    await expect(page.getByRole('button', { name: /^MEGA/ })).toBeDisabled();
    expect(mega.requestHistory()).toEqual([]);
    expect(mega.documentPaths()).toEqual([]);
    expect(mega.objectPaths()).toEqual([]);
  } finally {
    git.releaseObjectUpload();
  }
  await expect(page.getByTestId('github-library-status')).toContainText(
    'Library is up to date',
    { timeout: 30_000 },
  );
  await expect
    .poll(() => git.objectPaths().length, { timeout: 20_000 })
    .toBe(1);
  expect(mega.requestHistory()).toEqual([]);
  expect(mega.documentPaths()).toEqual([]);
  expect(mega.objectPaths()).toEqual([]);
  expect(
    await page.evaluate(() => ({
      git: localStorage.getItem('omnia-reader.auto-sync.v1.history.git'),
      mega: localStorage.getItem('omnia-reader.auto-sync.v1.history.mega'),
    })),
  ).toEqual({ git: expect.any(String), mega: null });
});

for (const scenario of scenarios) {
  test(`synchronizes an exact ${scenario.mimeType} publication and reader state between two devices through ${scenario.provider}`, async ({
    browser,
  }) => {
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip(
      process.env['REMOTE_SYNC_E2E'] !== '1',
      'Run the extended two-device provider convergence suite explicitly',
    );
    test.setTimeout(120_000);
    const evidence = await synchronizeBetweenTwoDevices(browser, scenario);
    expect(evidence.documentPaths).toContain('.omnia-reader/manifest.json');
    completedConvergenceScenarios += 1;
  });
}

async function synchronizeBetweenTwoDevices(
  browser: Browser,
  scenario: SyncScenario,
): Promise<{ documentPaths: readonly string[] }> {
  const publication = await scenario.publication();
  const gateway = new SimulatedSyncGateway(scenario.provider, {
    interruptFirstObjectUpload: scenario.provider === 'git',
    conflictFirstBookManifestWrite: scenario.provider === 'git',
    expectedPublication: publication,
  });
  const firstDevice = await createDevice(browser, gateway);
  const firstDeviceFailures = monitorSyncBrowserFailures(firstDevice.page);
  try {
    await firstDevice.page.goto('/');
    await expect(
      firstDevice.page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();
    await importSyncPublication(
      firstDevice.page,
      scenario.name,
      scenario.mimeType,
      publication,
      scenario.title,
    );
    await openLibraryPublication(firstDevice.page, scenario.title, {
      navigateToLibrary: false,
    });
    await expectInitialReaderLocation(firstDevice.page, scenario);
    await scenario.navigate(firstDevice.page);
    await createReaderState(firstDevice.page, scenario);

    await firstDevice.page.goto('/settings/sync');
    await selectSyncProvider(firstDevice.page, scenario.providerButtonName);
    const syncButton = firstDevice.page.getByRole('button', {
      name: 'Sync books and progress',
    });

    await scenario.prepareSuccessfulSync(firstDevice.page, gateway);
    await syncButton.click();
    await expect(firstDevice.page.getByRole('status')).toContainText(
      'Sync complete:',
      { timeout: 30_000 },
    );
    await scenario.expectSuccessfulSync(firstDevice.page);
    await expect(
      firstDevice.page.getByText(/0 local changes are waiting to sync/),
    ).toBeVisible();
    expect(
      gateway.documentPaths().some((path) => path.endsWith('/book.json')),
    ).toBe(true);
    expect(
      gateway.documentPaths().some((path) => path.includes('/progress/')),
    ).toBe(true);
    expect(
      gateway.documentPaths().some((path) => path.includes('/bookmarks/')),
    ).toBe(true);
    expect(
      gateway.documentPaths().some((path) => path.includes('/annotations/')),
    ).toBe(true);
    expect(
      gateway
        .objectPaths()
        .some((path) => path.endsWith(scenario.publicationExtension)),
    ).toBe(true);

    const secondDevice = await createDevice(browser, gateway);
    const secondDeviceFailures = monitorSyncBrowserFailures(secondDevice.page);
    try {
      await secondDevice.page.goto('/settings/sync');
      await selectSyncProvider(secondDevice.page, scenario.providerButtonName);
      await secondDevice.page
        .getByRole('button', { name: 'Sync books and progress' })
        .click();
      await expect(secondDevice.page.getByRole('status')).toContainText(
        'Sync complete:',
        { timeout: 30_000 },
      );

      await openLibraryPublication(secondDevice.page, scenario.title);
      await expect(
        secondDevice.page.getByText(scenario.title, { exact: true }),
      ).toBeVisible();
      await scenario.expectRestoredLocation(secondDevice.page);
      await expectRestoredReaderState(secondDevice.page, scenario);
      await scenario.navigateToSecondDeviceState(secondDevice.page);
      await createSecondDeviceReaderState(secondDevice.page, scenario);

      await synchronizeConfiguredDevice(secondDevice.page, scenario);
      expect(
        gateway.documentPaths().filter((path) => path.includes('/progress/')),
      ).toHaveLength(2);
      expect(
        gateway.documentPaths().filter((path) => path.includes('/bookmarks/')),
      ).toHaveLength(2);
      expect(
        gateway
          .documentPaths()
          .filter((path) => path.includes('/annotations/')),
      ).toHaveLength(2);

      await synchronizeConfiguredDevice(firstDevice.page, scenario);
      await openLibraryPublication(firstDevice.page, scenario.title);
      await expectConvergedReaderState(firstDevice.page, scenario);
      await openLibraryPublication(secondDevice.page, scenario.title);
      await expectConvergedReaderState(secondDevice.page, scenario);

      const concurrentUpdateNote = await updateSecondDeviceContribution(
        firstDevice.page,
        scenario,
      );
      await deleteSecondDeviceContributions(secondDevice.page, scenario);
      await synchronizeConfiguredDevice(firstDevice.page, scenario);
      await synchronizeConfiguredDevice(secondDevice.page, scenario);
      await synchronizeConfiguredDevice(firstDevice.page, scenario);
      await openLibraryPublication(firstDevice.page, scenario.title);
      await expectTombstonedReaderState(
        firstDevice.page,
        scenario,
        concurrentUpdateNote,
      );

      const authoritativeInventory = await canonicalRecoveryInventory(
        firstDevice.page,
      );
      await verifyCleanReplacementDevice(
        browser,
        gateway,
        scenario,
        publication,
        authoritativeInventory,
        concurrentUpdateNote,
      );
    } finally {
      await secondDevice.context.close();
    }

    expect(firstDeviceFailures()).toEqual([]);
    expect(secondDeviceFailures()).toEqual([]);
    return { documentPaths: gateway.documentPaths() };
  } finally {
    await firstDevice.context.close();
  }
}

async function updateSecondDeviceContribution(
  page: Page,
  scenario: SyncScenario,
): Promise<string> {
  const updatedNote = `Concurrent update: ${scenario.secondDeviceAnnotationNote}`;
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  const contribution = annotations
    .locator('article')
    .filter({ hasText: scenario.secondDeviceAnnotationNote });
  await contribution.getByRole('button', { name: 'Edit annotation' }).click();
  const editor = page.getByTestId('annotation-dashboard');
  const note = editor.getByRole('textbox', { name: 'Note' });
  await note.fill(updatedNote);
  await note.press('Control+Enter');
  await expect(editor).toBeHidden();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(annotations.getByText(updatedNote)).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  return updatedNote;
}

async function deleteSecondDeviceContributions(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await scenario.navigateToSecondDeviceState(page);
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  const bookmarks = page.getByRole('complementary', { name: 'Bookmarks' });
  const removeCurrent = bookmarks.getByRole('button', {
    name: 'Remove bookmark at current location',
  });
  await expect(removeCurrent).toBeVisible();
  await removeCurrent.click();
  await expect(
    bookmarks.getByRole('button', {
      name: 'Add bookmark at current location',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();

  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  const contribution = annotations
    .locator('article')
    .filter({ hasText: scenario.secondDeviceAnnotationNote });
  await expect(contribution).toHaveCount(1);
  await contribution.getByRole('button', { name: 'Delete annotation' }).click();
  await expect(contribution).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
}

async function expectTombstonedReaderState(
  page: Page,
  scenario: SyncScenario,
  concurrentUpdateNote: string,
): Promise<void> {
  await expectReaderRoute(page);
  await expectBookmarkCount(page, 1);
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  await expect(annotations.getByText(scenario.highlightText)).toBeVisible();
  await expect(annotations.getByText(scenario.annotationNote)).toBeVisible();
  await expect(
    annotations.getByText(scenario.secondDeviceAnnotationNote),
  ).toHaveCount(0);
  await expect(annotations.getByText(concurrentUpdateNote)).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
}

async function verifyCleanReplacementDevice(
  browser: Browser,
  gateway: SimulatedSyncGateway,
  scenario: SyncScenario,
  publication: Buffer,
  authoritativeInventory: Record<string, unknown>,
  concurrentUpdateNote: string,
): Promise<void> {
  const replacement = await createDevice(browser, gateway);
  const failures = monitorSyncBrowserFailures(replacement.page);
  try {
    await replacement.page.goto('/settings/sync');
    await selectSyncProvider(replacement.page, scenario.providerButtonName);
    await replacement.page
      .getByRole('button', { name: 'Sync books and progress' })
      .click();
    await expect(replacement.page.getByRole('status')).toContainText(
      'Sync complete:',
      { timeout: 30_000 },
    );

    const inventory = await canonicalRecoveryInventory(replacement.page);
    expect(replacementState(inventory)).toEqual(
      replacementState(authoritativeInventory),
    );
    expectInventoryCardinality(inventory);

    const sha256 = createHash('sha256').update(publication).digest('hex');
    expect(await publicationBinaryEvidence(replacement.page)).toEqual([
      {
        bookId: `sha256:${sha256}`,
        size: publication.byteLength,
        sha256,
      },
    ]);

    await openLibraryPublication(replacement.page, scenario.title);
    await expectTombstonedReaderState(
      replacement.page,
      scenario,
      concurrentUpdateNote,
    );
    expect(failures()).toEqual([]);
  } finally {
    await replacement.context.close();
  }
}

function replacementState(
  inventory: Record<string, unknown>,
): Record<string, unknown> {
  return {
    // Reader opening refreshes this local metadata timestamp even when the
    // synchronized membership and publication metadata are unchanged.
    membership: inventoryRecords(inventory, 'membership').map((record) =>
      Object.fromEntries(
        Object.entries(record).filter(
          ([field, value]) => field !== 'updatedAt' && value !== undefined,
        ),
      ),
    ),
    exactHashesAndSizes: inventory['exactHashesAndSizes'],
    progress: inventory['progress'],
    progressDocuments: inventory['progressDocuments'],
    bookmarks: inventory['bookmarks'],
    annotations: inventory['annotations'],
    tombstones: inventory['tombstones'],
  };
}

function expectInventoryCardinality(inventory: Record<string, unknown>): void {
  expect(inventoryRecords(inventory, 'membership')).toHaveLength(1);
  expect(inventoryRecords(inventory, 'exactHashesAndSizes')).toHaveLength(1);
  expect(inventoryRecords(inventory, 'progress')).toHaveLength(1);
  expect(inventoryRecords(inventory, 'bookmarks')).toHaveLength(2);
  expect(inventoryRecords(inventory, 'annotations')).toHaveLength(2);
  expect(inventoryRecords(inventory, 'tombstones')).toHaveLength(2);
  expect(
    inventoryRecords(inventory, 'bookmarks').filter(
      (record) => typeof record['deletedAt'] === 'string',
    ),
  ).toHaveLength(1);
  expect(
    inventoryRecords(inventory, 'annotations').filter(
      (record) => typeof record['deletedAt'] === 'string',
    ),
  ).toHaveLength(1);
}

function inventoryRecords(
  inventory: Record<string, unknown>,
  field: string,
): readonly Record<string, unknown>[] {
  const records = inventory[field];
  expect(Array.isArray(records), `${field} must be an array`).toBe(true);
  return records as readonly Record<string, unknown>[];
}

async function createReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await expectReaderRoute(page);
  await addBookmark(page);
  await scenario.createHighlight(page);
  await expectAnnotations(page, [
    scenario.highlightText,
    scenario.annotationNote,
  ]);
}

async function createSecondDeviceReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await expectReaderRoute(page);
  await addBookmark(page);
  await scenario.createSecondDeviceHighlight(page);
  await expectAnnotations(page, [
    scenario.secondDeviceHighlightText,
    scenario.secondDeviceAnnotationNote,
  ]);
}

async function addBookmark(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  const bookmarks = page.getByRole('complementary', { name: 'Bookmarks' });
  await bookmarks
    .getByRole('button', { name: 'Add bookmark at current location' })
    .click();
  await expect(
    bookmarks.getByRole('button', {
      name: 'Remove bookmark at current location',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
}

async function expectAnnotations(
  page: Page,
  expectedTexts: readonly string[],
): Promise<void> {
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  for (const expectedText of expectedTexts) {
    await expect(annotations.getByText(expectedText)).toBeVisible();
  }
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
}

async function expectRestoredReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await expectReaderRoute(page);
  await expectBookmarkCount(page, 1);
  await expectAnnotations(page, [
    scenario.highlightText,
    scenario.annotationNote,
  ]);
}

async function expectConvergedReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await expectReaderRoute(page);
  await expectBookmarkCount(page, 2);
  await expectAnnotations(page, [
    scenario.highlightText,
    scenario.annotationNote,
    scenario.secondDeviceHighlightText,
    scenario.secondDeviceAnnotationNote,
  ]);
}

async function expectBookmarkCount(page: Page, count: number): Promise<void> {
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  const bookmarks = page.getByRole('complementary', { name: 'Bookmarks' });
  await expect(
    bookmarks.getByRole('button', { name: /^Delete bookmark / }),
  ).toHaveCount(count);
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
}

async function synchronizeConfiguredDevice(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await page.goto('/settings/sync');
  await selectSyncProvider(page, scenario.providerButtonName);
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  await expect(
    page.getByText(/0 local changes are waiting to sync/),
  ).toBeVisible();
}

async function verifyInterruptedGitUpload(
  page: Page,
  gateway: SimulatedSyncGateway,
): Promise<void> {
  const automaticStatus = page.getByTestId('automatic-sync-status');
  await expect(automaticStatus).toContainText('Automatic sync needs attention');
  await expect(automaticStatus).toContainText(
    'Simulated interrupted publication upload',
  );
  expect(
    gateway.documentPaths().some((path) => path.endsWith('/book.json')),
  ).toBe(false);
  expect(gateway.objectPaths()).toEqual([]);
}

function noSyncPreparation(): Promise<void> {
  return Promise.resolve();
}

async function expectRetriedGitConflict(page: Page): Promise<void> {
  await expect(page.getByRole('status')).toContainText('1 conflicts retried');
}

function noSyncStatusAssertion(): Promise<void> {
  return Promise.resolve();
}

async function createDevice(
  browser: Browser,
  gateway: SimulatedSyncGateway,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await gateway.install(context);
  return { context, page: await context.newPage() };
}

async function expectInitialReaderLocation(
  page: Page,
  scenario: Pick<SyncScenario, 'mimeType' | 'title'>,
): Promise<void> {
  await expectReaderRoute(page);
  await expect(page.getByText(scenario.title, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  if (scenario.mimeType === 'application/pdf') {
    await expect(
      page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
    ).toBeVisible({ timeout: 20_000 });
  } else {
    await expectEpubChapter(page, 'Chapter One');
  }
}

async function expectEpubChapter(page: Page, chapter: string): Promise<void> {
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: chapter, exact: true }),
  ).toBeVisible({ timeout: 20_000 });
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
