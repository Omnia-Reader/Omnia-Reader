import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createEpubFixture, createPdfFixture } from './publication-fixtures';
import {
  SimulatedSyncGateway,
  type SimulatedSyncProvider,
} from './simulated-sync-gateway';
import {
  createEpubHighlight,
  createPdfHighlight,
} from './reader-state-helpers';

// Browser routing is the provider boundary in this suite. A production service
// worker must not satisfy `/api/sync/**` before the simulated gateway sees it.
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

const scenarios: readonly SyncScenario[] = [
  {
    provider: 'git',
    providerButtonName: /^Git \+ LFS/,
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
      createPdfHighlight(
        page,
        2,
        'Page Two',
        'Git synchronized PDF annotation.',
      ),
    highlightText: 'Page Two',
    annotationNote: 'Git synchronized PDF annotation.',
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
    prepareSuccessfulSync: verifyInterruptedGitUpload,
    expectSuccessfulSync: async (page) => {
      await expect(page.getByRole('status')).toContainText(
        '1 conflicts retried',
      );
    },
  },
  {
    provider: 'mega',
    providerButtonName: /^MEGA/,
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
        'MEGA synchronized EPUB annotation.',
      ),
    highlightText: 'second EPUB fixture',
    annotationNote: 'MEGA synchronized EPUB annotation.',
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
    prepareSuccessfulSync: noSyncPreparation,
    expectSuccessfulSync: noSyncStatusAssertion,
  },
];

test('keeps synchronization status and setup one click from the app toolbar', async ({
  page,
}) => {
  await page.goto('/library');

  const syncStatus = page.getByTestId('global-sync-status');
  await expect(syncStatus).toHaveAttribute(
    'aria-label',
    'Set up sync. View sync details.',
  );
  await expect(syncStatus).toHaveAttribute(
    'title',
    /Set up Git synchronization/,
  );

  await syncStatus.click();
  await expect(page).toHaveURL('/settings/sync');
});

test('offers GitHub App installation before account authorization', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git', { authenticated: false });
  await gateway.install(context);

  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();

  await expect(
    page.getByRole('link', { name: '1. Install or manage GitHub App' }),
  ).toHaveAttribute(
    'href',
    'https://github.test/apps/omnia-reader/installations/new',
  );
  await expect(
    page.getByRole('button', { name: '2. Authorize GitHub account' }),
  ).toBeEnabled();
});

test('returns a cancelled GitHub authorization to Sync Settings', async ({
  page,
}) => {
  await page.goto('/settings/sync?syncAuth=github-denied');

  await expect(page.getByRole('alert')).toContainText(
    'GitHub authorization was cancelled. Your local library is unchanged.',
  );
  await expect(page).toHaveURL('/settings/sync');
});

test('creates and selects a private GitHub synchronization repository', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git');
  await gateway.install(context);

  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();
  await expect(page.getByText('Connected to GitHub as')).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Repository name' })
    .fill('omnia-reader-private');
  await page.getByRole('button', { name: 'Create private repository' }).click();

  await expect(
    page.getByText(
      'Created and selected private repository omnia-e2e/omnia-reader-private',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.locator('select').first()).toHaveValue('2');
});

test('preserves successful Git sync details across an application reload', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git');
  await gateway.install(context);

  await page.goto('/settings/sync');
  await selectProvider(page, { providerButtonName: /^Git \+ LFS/ });
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });

  const result = page.getByTestId('last-sync-result');
  await expect(result).toContainText('Last successful result');
  await expect(result).toContainText('Received');
  await expect(result).toContainText('Sent');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = localStorage.getItem(
          'omnia-reader.auto-sync.v1.history.git',
        );
        if (!value) {
          return null;
        }
        const history = JSON.parse(value) as {
          lastSuccessAt?: unknown;
          lastResult?: unknown;
        };
        return {
          hasTimestamp: typeof history.lastSuccessAt === 'string',
          hasResult:
            !!history.lastResult && typeof history.lastResult === 'object',
        };
      }),
    )
    .toEqual({ hasTimestamp: true, hasResult: true });

  await page.reload();

  await expect(result).toBeVisible();
  await expect(result).toContainText('Last successful result');
  await expect(page.getByTestId('github-library-status')).toContainText(
    'Library is up to date',
  );
});

test('recovers when GitHub forbids repository creation', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git', {
    forbidRepositoryCreation: true,
  });
  await gateway.install(context);

  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();
  await page
    .getByRole('textbox', { name: 'Repository name' })
    .fill('omnia-reader-private');
  await page.getByRole('button', { name: 'Create private repository' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'Grant the App Contents read and write access',
  );
  await expect(alert).toContainText('Administration read and write access');
  await expect(alert).toContainText('Your local library is unchanged');
  await expect(alert).not.toContainText('Provider-controlled');
  await expect(page.getByTestId('github-permission-recovery')).toHaveAttribute(
    'href',
    'https://github.test/apps/omnia-reader/installations/new',
  );
});

test('offers reconnection when GitHub authorization is revoked', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git', {
    expireGitHubAuthorizationOnRepositories: true,
  });
  await gateway.install(context);

  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'Your provider session expired. Connect again to sync.',
  );
  await expect(alert).not.toContainText('Provider-controlled');
  await expect(
    page.getByRole('button', { name: '2. Authorize GitHub account' }),
  ).toBeEnabled();
});

test('backs off safely when GitHub rate limits repository access', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git', {
    rateLimitGitHubRepositories: true,
  });
  await gateway.install(context);

  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'GitHub is temporarily rate limiting synchronization',
  );
  await expect(alert).toContainText('Try again in about 2 minutes');
  await expect(alert).toContainText('pending changes remain safe');
  await expect(alert).not.toContainText('Provider-controlled');
  await expect(page.getByTestId('github-permission-recovery')).toHaveCount(0);
});

test('cancels an automatic publication upload without losing queued local work', async ({
  context,
  page,
}) => {
  const publication = await createPdfFixture();
  const gateway = new SimulatedSyncGateway('mega', {
    holdFirstObjectUpload: true,
    expectedPublication: publication,
  });
  await gateway.install(context);

  try {
    await page.goto('/settings/sync');
    await page.getByRole('button', { name: /^MEGA/ }).click();
    await expect(
      page.getByRole('button', { name: 'Sync books and progress' }),
    ).toBeEnabled();
    await page.getByRole('link', { name: 'Library', exact: true }).click();

    await importPublication(
      page,
      'automatic-cancel.pdf',
      'application/pdf',
      publication,
      'Omnia PDF Fixture',
    );
    await gateway.waitForObjectUploadStart();

    const globalSyncStatus = page.getByTestId('global-sync-status');
    await expect(globalSyncStatus).toHaveAttribute(
      'aria-label',
      /Syncing(?: \d+%)?\. View sync details\./,
    );

    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('link', { name: 'Configure library sync' }).click();

    const automaticStatus = page.getByTestId('automatic-sync-status');
    await expect(
      automaticStatus.getByRole('button', {
        name: 'Cancel automatic sync',
      }),
    ).toBeVisible();
    await expect(
      automaticStatus.getByText(/Uploading publication:/),
    ).toBeVisible();
    await expect(automaticStatus.locator('progress')).toBeVisible();
    await expect(
      page.getByText(/1 local change is waiting to sync/),
    ).toBeVisible();

    await automaticStatus
      .getByRole('button', { name: 'Cancel automatic sync' })
      .click();
    gateway.releaseObjectUpload();

    await expect(automaticStatus).toContainText(
      'Automatic synchronization cancelled',
    );
    await expect(automaticStatus).toContainText(
      'Local changes are safe and remain queued',
    );
    await expect(globalSyncStatus).toHaveAttribute(
      'aria-label',
      'Sync cancelled. View sync details.',
    );
    await expect(
      page.getByText(/1 local change is waiting to sync/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sync books and progress' }),
    ).toBeEnabled();
  } finally {
    gateway.releaseObjectUpload();
  }
});

test('deletes a synchronized publication locally and remotely', async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const publication = await createPdfFixture();
  const gateway = new SimulatedSyncGateway('mega', {
    expectedPublication: publication,
  });
  await gateway.install(context);
  const browserFailures = monitorBrowserFailures(page);

  await page.goto('/');
  await importPublication(
    page,
    'local-removal.pdf',
    'application/pdf',
    publication,
    'Omnia PDF Fixture',
  );

  await page.goto('/settings/sync');
  await selectProvider(page, { providerButtonName: /^MEGA/ });
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  const manifestPath = gateway
    .documentPaths()
    .find((path) => path.endsWith('/book.json'));
  const objectPath = gateway
    .objectPaths()
    .find((path) => path.endsWith('.pdf'));
  expect(manifestPath).toBeDefined();
  expect(objectPath).toBeDefined();

  await page.goto('/');
  await page.getByRole('button', { name: 'Remove Omnia PDF Fixture' }).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText(
    'its remote publication file is deleted during the next synchronization',
  );
  await confirmation.getByRole('button', { name: 'Remove book' }).click();
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toHaveCount(0);

  await page.goto('/settings/sync');
  await expect(
    page.getByRole('button', { name: 'Sync books and progress' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });

  await page.reload();
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  await page.goto('/');
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toHaveCount(0);
  expect(gateway.documentPaths()).not.toContain(manifestPath);
  expect(gateway.objectPaths()).not.toContain(objectPath);
  const deletionPath = gateway
    .documentPaths()
    .find((path) => path.includes('/.deletions/books/'));
  expect(deletionPath).toBeDefined();
  expect(
    JSON.parse(gateway.documentContent(deletionPath as string) ?? '{}'),
  ).toMatchObject({
    schemaVersion: 2,
    deleted: true,
  });
  const readmePath = gateway
    .documentPaths()
    .find((path) => path.endsWith('/README.md'));
  expect(readmePath).toBeDefined();
  expect(gateway.documentContent(readmePath as string)).not.toContain(
    'Omnia PDF Fixture',
  );
  expect(browserFailures()).toEqual([]);
});

test('deletes a remote publication backup without deleting the local copy', async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const publication = await createPdfFixture();
  const gateway = new SimulatedSyncGateway('mega', {
    expectedPublication: publication,
  });
  await gateway.install(context);
  const browserFailures = monitorBrowserFailures(page);

  await page.goto('/');
  await importPublication(
    page,
    'remote-deletion.pdf',
    'application/pdf',
    publication,
    'Omnia PDF Fixture',
  );
  await page.goto('/settings/sync');
  await selectProvider(page, { providerButtonName: /^MEGA/ });
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });

  const manifestPath = gateway
    .documentPaths()
    .find((path) => path.endsWith('/book.json'));
  expect(manifestPath).toBeDefined();
  expect(gateway.objectPaths()).toHaveLength(1);
  await expect(
    page.getByRole('button', {
      name: 'Delete remote backup for Omnia PDF Fixture',
    }),
  ).toBeVisible();

  await page
    .getByRole('button', {
      name: 'Delete remote backup for Omnia PDF Fixture',
    })
    .click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText(
    'It does not delete a copy already stored on this device',
  );
  await confirmation
    .getByRole('button', { name: 'Delete remote backup' })
    .click();

  await expect(page.getByRole('status')).toContainText(
    'Copies already stored on devices remain available',
  );
  await expect(
    page.getByText('No publication files are stored in this sync destination'),
  ).toBeVisible();
  expect(gateway.objectPaths()).toEqual([]);
  expect(gateway.documentContent(manifestPath as string)).toBeNull();
  const deletionPath = gateway
    .documentPaths()
    .find((path) => path.includes('/.deletions/books/'));
  expect(deletionPath).toBeDefined();
  expect(
    JSON.parse(gateway.documentContent(deletionPath as string) ?? '{}'),
  ).toMatchObject({
    schemaVersion: 2,
    deleted: true,
  });

  await page.reload();
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  expect(gateway.objectPaths()).toEqual([]);
  await page.goto('/');
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible();
  expect(browserFailures()).toEqual([]);
});

for (const scenario of scenarios) {
  test(`synchronizes an exact ${scenario.mimeType} publication and reader state between two devices through ${scenario.provider}`, async ({
    browser,
  }) => {
    // The complete two-device transfer is intentionally opt-in because it is
    // substantially longer than repository onboarding, which runs by default.
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip(
      process.env['REMOTE_SYNC_E2E'] !== '1',
      'Run the extended two-device provider convergence suite explicitly',
    );
    test.setTimeout(120_000);
    const evidence = await synchronizeBetweenTwoDevices(browser, scenario);
    expect(evidence.documentPaths).toContain('.omnia-reader/v1/manifest.json');
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
  const firstDeviceFailures = monitorBrowserFailures(firstDevice.page);
  try {
    await firstDevice.page.goto('/');
    await expect(
      firstDevice.page.getByRole('heading', {
        name: 'Library',
        exact: true,
      }),
    ).toBeVisible();
    await importPublication(
      firstDevice.page,
      scenario.name,
      scenario.mimeType,
      publication,
      scenario.title,
    );
    await firstDevice.page.getByText(scenario.title, { exact: true }).click();
    await expectInitialReaderLocation(firstDevice.page, scenario);
    await scenario.navigate(firstDevice.page);
    await createReaderState(firstDevice.page, scenario);

    await firstDevice.page.goto('/settings/sync');
    await selectProvider(firstDevice.page, scenario);
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
    const secondDeviceFailures = monitorBrowserFailures(secondDevice.page);
    try {
      await secondDevice.page.goto('/settings/sync');
      await selectProvider(secondDevice.page, scenario);
      await secondDevice.page
        .getByRole('button', { name: 'Sync books and progress' })
        .click();
      await expect(secondDevice.page.getByRole('status')).toContainText(
        'Sync complete:',
        { timeout: 30_000 },
      );

      await secondDevice.page.goto('/');
      await expect(
        secondDevice.page.getByText(scenario.title, { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await secondDevice.page
        .getByText(scenario.title, { exact: true })
        .click();
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
      await openPublication(firstDevice.page, scenario.title);
      await expectConvergedReaderState(firstDevice.page, scenario);
      await openPublication(secondDevice.page, scenario.title);
      await expectConvergedReaderState(secondDevice.page, scenario);
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

async function createReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
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

  await scenario.createHighlight(page);
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  await expect(annotations.getByText(scenario.highlightText)).toBeVisible();
  await expect(annotations.getByText(scenario.annotationNote)).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
}

async function createSecondDeviceReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
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

  await scenario.createSecondDeviceHighlight(page);
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  await expect(
    annotations.getByText(scenario.secondDeviceHighlightText),
  ).toBeVisible();
  await expect(
    annotations.getByText(scenario.secondDeviceAnnotationNote),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
}

async function expectRestoredReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  const bookmarks = page.getByRole('complementary', { name: 'Bookmarks' });
  await expect(
    bookmarks.getByRole('button', { name: /^Delete bookmark / }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();

  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  await expect(annotations.getByText(scenario.highlightText)).toBeVisible();
  await expect(annotations.getByText(scenario.annotationNote)).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
}

async function expectConvergedReaderState(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  const bookmarks = page.getByRole('complementary', { name: 'Bookmarks' });
  await expect(
    bookmarks.getByRole('button', { name: /^Delete bookmark / }),
  ).toHaveCount(2);
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();

  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const annotations = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  await expect(annotations.getByText(scenario.highlightText)).toBeVisible();
  await expect(annotations.getByText(scenario.annotationNote)).toBeVisible();
  await expect(
    annotations.getByText(scenario.secondDeviceHighlightText),
  ).toBeVisible();
  await expect(
    annotations.getByText(scenario.secondDeviceAnnotationNote),
  ).toBeVisible();
}

async function synchronizeConfiguredDevice(
  page: Page,
  scenario: SyncScenario,
): Promise<void> {
  await page.goto('/settings/sync');
  await selectProvider(page, scenario);
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  await expect(
    page.getByText(/0 local changes are waiting to sync/),
  ).toBeVisible();
}

async function openPublication(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByText(title, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByText(title, { exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
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

async function selectProvider(
  page: Page,
  scenario: Pick<SyncScenario, 'providerButtonName'>,
): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Library sync', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: scenario.providerButtonName }).click();
  await expect(
    page.getByRole('button', { name: 'Sync books and progress' }),
  ).toBeEnabled();
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

async function expectInitialReaderLocation(
  page: Page,
  scenario: Pick<SyncScenario, 'mimeType' | 'title'>,
): Promise<void> {
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

function monitorBrowserFailures(page: Page): () => string[] {
  const consoleFailures: string[] = [];
  const pageFailures: string[] = [];
  const expectedGatewayFailures: number[] = [];
  page.on('response', (response) => {
    if (response.status() < 400) {
      return;
    }
    if (response.url().includes('/api/sync/')) {
      expectedGatewayFailures.push(response.status());
      return;
    }
    pageFailures.push(`response: ${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleFailures.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageFailures.push(`page: ${error.message}`));
  return () => {
    const observedGatewayFailures = [...expectedGatewayFailures];
    return [
      ...consoleFailures
        .filter(
          (failure) =>
            !isExpectedGatewayFailure(failure, observedGatewayFailures),
        )
        .map((failure) => `console: ${failure}`),
      ...pageFailures,
    ];
  };
}

function isExpectedGatewayFailure(
  consoleFailure: string,
  expectedFailures: number[],
): boolean {
  const match = consoleFailure.match(
    /^Failed to load resource: the server responded with a status of (\d+)/,
  );
  const status = match ? Number(match[1]) : null;
  const expected = expectedFailures.some(
    (expectedStatus) => status === null || expectedStatus === status,
  );
  return (
    expected &&
    (status !== null || consoleFailure === 'Failed to load resource')
  );
}
