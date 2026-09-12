import { expect, test, type Page } from '@playwright/test';
import { createPdfFixture } from './publication-fixtures';
import {
  assertClosedMatrix,
  canonicalInventoryFields,
  compatibilityMatrixRows,
  recoveryMatrixRows,
  rowsOwnedBy,
} from './recovery-compatibility-matrix';
import { SimulatedSyncGateway } from './simulated-sync-gateway';
import {
  canonicalRecoveryInventory,
  clearStoredPublicationBinaries,
  inventoryWithoutAvailability,
} from './canonical-recovery-inventory';
import {
  importSyncPublication,
  monitorSyncBrowserFailures,
  selectSyncProvider,
} from './sync-test-helpers';

// Browser routing is the provider boundary in this suite. A production service
// worker must not satisfy `/api/sync/**` before the simulated gateway sees it.
test.use({ serviceWorkers: 'block' });

test('records all interrupted-transfer recovery and logical sync compatibility rows', async () => {
  assertClosedMatrix(compatibilityMatrixRows, 14);
  const recoveryRows = rowsOwnedBy(recoveryMatrixRows, 'sync');
  const compatibilityRows = rowsOwnedBy(compatibilityMatrixRows, 'sync');
  expect(recoveryRows).toHaveLength(12);
  expect(
    recoveryRows.filter(
      ({ recoveryPoint }) => recoveryPoint === 'interrupted-upload',
    ),
  ).toHaveLength(6);
  expect(
    recoveryRows.filter(
      ({ recoveryPoint }) => recoveryPoint === 'interrupted-download',
    ),
  ).toHaveLength(6);
  expect(compatibilityRows).toHaveLength(7);
  expect(
    compatibilityRows.every(
      ({ providers }) => providers?.join(',') === 'git,mega',
    ),
  ).toBe(true);
});

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
  const gateway = new SimulatedSyncGateway('git', {
    existingGitRepository: false,
  });
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
  await expect(
    page.getByRole('heading', { name: 'Create a sync repository' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Manage repository access' }),
  ).toBeVisible();
});

test('restores GitHub setup and presents it consistently across Settings and the toolbar', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git', {
    selectedGitRepository: false,
  });
  await gateway.install(context);

  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();

  await expect(
    page.getByText('Restored sync repository omnia-reader/e2e-library', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText('Connected to GitHub as')).toBeVisible();
  await expect(page.locator('select').first()).toHaveValue('1');

  await page.goto('/settings');
  await expect(page.getByTestId('sync-connection-summary')).toContainText(
    'GitHub is connected as omnia-e2e',
  );
  await expect(page.getByTestId('sync-connection-summary')).toContainText(
    'omnia-reader/e2e-library',
  );
  await expect(
    page.getByRole('link', { name: 'Manage library sync' }),
  ).toBeVisible();

  await page.goto('/library');
  await expect(page.getByTestId('global-sync-status')).toHaveAttribute(
    'title',
    /omnia-reader\/e2e-library/,
  );
});

test('preserves successful Git sync details across an application reload', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git');
  await gateway.install(context);

  await page.goto('/settings/sync');
  await selectSyncProvider(page, /^Git \+ LFS/);
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

test('finishes a stable repeated Git sync with only one revision request', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git');
  gateway.seedDocument('.omnia-reader/v1/obsolete-a.tmp', 'obsolete');
  gateway.seedDocument('.omnia-reader/v1/obsolete-b.tmp', 'obsolete');
  await gateway.install(context);
  await context.addInitScript(() =>
    localStorage.setItem(
      'omnia-reader.sync-checkpoint',
      JSON.stringify({ schemaVersion: 2, git: '1:main:e2e-r2' }),
    ),
  );

  await page.goto('/settings/sync');
  await selectSyncProvider(page, /^Git \+ LFS/);
  const sync = page.getByRole('button', { name: 'Sync books and progress' });

  await expect(sync).toBeEnabled({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        gateway
          .requestHistory()
          .filter((request) => request === 'DELETE /entries').length,
      { timeout: 30_000 },
    )
    .toBe(1);
  expect(
    gateway
      .documentPaths()
      .some((path) => path.startsWith('.omnia-reader/v1/')),
  ).toBe(false);
  expect(
    gateway
      .documentPaths()
      .filter((path) => path.startsWith('.omnia-reader/logical-books/')),
  ).toEqual(['.omnia-reader/logical-books/state.json']);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem('omnia-reader.sync-checkpoint') ?? '{}',
          ).schemaVersion,
      ),
    )
    .toBe(3);
  await page.evaluate(() =>
    localStorage.removeItem('omnia-reader.sync-checkpoint'),
  );
  gateway.clearRequestHistory();
  await sync.click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  const firstSyncRequests = gateway.requestHistory();
  expect(
    firstSyncRequests.some(
      (request) => request === 'GET /files?prefix=.omnia-reader%2Flibrary',
    ),
  ).toBe(true);
  expect(
    firstSyncRequests.filter(
      (request) => request === 'GET /entries?prefix=.omnia-reader%2Fv1',
    ),
  ).toHaveLength(1);
  gateway.clearRequestHistory();
  const completedAt = await gitSyncSuccessTimestamp(page);
  await sync.click();
  await expect
    .poll(() => gitSyncSuccessTimestamp(page), { timeout: 30_000 })
    .not.toBe(completedAt);
  await expect(page.getByRole('status')).toContainText(
    'Sync complete: 0 pulled, 0 pushed.',
  );

  expect(gateway.requestHistory()).toEqual(['GET /revision']);
});

async function gitSyncSuccessTimestamp(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const value = localStorage.getItem('omnia-reader.auto-sync.v1.history.git');
    if (!value) {
      return null;
    }
    const history = JSON.parse(value) as { lastSuccessAt?: unknown };
    return typeof history.lastSuccessAt === 'string'
      ? history.lastSuccessAt
      : null;
  });
}

test('recovers when GitHub forbids repository creation', async ({
  context,
  page,
}) => {
  const gateway = new SimulatedSyncGateway('git', {
    forbidRepositoryCreation: true,
    existingGitRepository: false,
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

    await importSyncPublication(
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
    await page.getByRole('link', { name: 'Manage library sync' }).click();

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
      page.getByText(/local changes? (?:is|are) waiting to sync/),
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
      page.getByText(/local changes? (?:is|are) waiting to sync/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sync books and progress' }),
    ).toBeEnabled();
  } finally {
    gateway.releaseObjectUpload();
  }
});

test('retries an interrupted exact synchronized-source recovery without losing local state', async ({
  context,
  page,
}) => {
  const objectDownloads = await verifySynchronizedRecoveryRetry(context, page, {
    interruptFirstObjectDownload: true,
    expectedError: 'Simulated interrupted publication download',
  });
  expect(objectDownloads).toBe(2);
});

test('rejects a corrupted synchronized source and restores exact bytes on retry', async ({
  context,
  page,
}) => {
  const objectDownloads = await verifySynchronizedRecoveryRetry(context, page, {
    corruptFirstObjectDownload: true,
    expectedError: 'Replacement publication failed exact-source validation',
  });
  expect(objectDownloads).toBe(2);
});

async function verifySynchronizedRecoveryRetry(
  context: BrowserContext,
  page: Page,
  failure: {
    interruptFirstObjectDownload?: boolean;
    corruptFirstObjectDownload?: boolean;
    expectedError: string;
  },
): Promise<number> {
  const publication = await createPdfFixture();
  const gateway = new SimulatedSyncGateway('mega', {
    expectedPublication: publication,
    ...(failure.interruptFirstObjectDownload
      ? { interruptFirstObjectDownload: true }
      : {}),
    ...(failure.corruptFirstObjectDownload
      ? { corruptFirstObjectDownload: true }
      : {}),
  });
  await gateway.install(context);

  await page.goto('/');
  await importSyncPublication(
    page,
    'synchronized-recovery.pdf',
    'application/pdf',
    publication,
    'Omnia PDF Fixture',
  );
  await page.goto('/settings/sync');
  await selectSyncProvider(page, /^MEGA/);
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  expect(gateway.objectPaths()).toHaveLength(1);

  await page.goto('/');
  await clearStoredPublicationBinaries(page);
  await page.reload();
  const recovery = page.getByRole('button', {
    name: 'Download synchronized PDF for Omnia PDF Fixture',
  });
  await expect(recovery).toBeVisible();
  const inventoryBeforeFailure = await canonicalRecoveryInventory(page);
  await recovery.click();
  await expect(page.getByRole('alert')).toContainText(failure.expectedError);
  await expect(recovery).toBeVisible();
  await expect(recovery).toBeEnabled();
  await expect(
    page.getByTestId('library-book').filter({ hasText: 'Omnia PDF Fixture' }),
  ).toBeVisible();
  const inventoryAfterFailure = await canonicalRecoveryInventory(page);
  expect(Object.keys(inventoryBeforeFailure).sort()).toEqual(
    [...canonicalInventoryFields].sort(),
  );
  expect(inventoryAfterFailure).toEqual(inventoryBeforeFailure);

  await recovery.click();
  await expect(
    page.getByRole('status').filter({
      hasText: 'PDF for “Omnia PDF Fixture” was restored from synchronization.',
    }),
  ).toBeVisible();
  const inventoryAfterRecovery = await canonicalRecoveryInventory(page);
  expect(inventoryWithoutAvailability(inventoryAfterRecovery)).toEqual(
    inventoryWithoutAvailability(inventoryBeforeFailure),
  );
  expect(inventoryBeforeFailure['availability']).toEqual([]);
  const exactPublications = inventoryBeforeFailure[
    'exactHashesAndSizes'
  ] as readonly { id?: unknown }[];
  expect(exactPublications).toHaveLength(1);
  expect(inventoryAfterRecovery['availability']).toEqual([
    expect.objectContaining({
      bookId: exactPublications[0]?.id,
      storage: expect.stringMatching(/^(indexeddb|opfs)$/),
    }),
  ]);
  await page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia PDF Fixture' })
    .getByRole('button', { name: /^PDF\b/ })
    .click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  return gateway.requestHistory().filter((request) => request === 'GET /object')
    .length;
}

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
  const browserFailures = monitorSyncBrowserFailures(page);

  await page.goto('/');
  await importSyncPublication(
    page,
    'local-removal.pdf',
    'application/pdf',
    publication,
    'Omnia PDF Fixture',
  );

  await page.goto('/settings/sync');
  await selectSyncProvider(page, /^MEGA/);
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  const manifestPath = gateway
    .documentPaths()
    .find((path) => path.endsWith('/book.json'));
  const objectPath = gateway
    .objectPaths()
    .find((path) => path.includes('/library/') && path.endsWith('.pdf'));
  expect(manifestPath).toBeDefined();
  expect(objectPath).toBeDefined();
  expect(objectPath).toMatch(
    /^\.omnia-reader\/library\/local-removal--[a-f0-9]{12}\/local-removal\.pdf$/,
  );

  await page.goto('/');
  await page
    .getByRole('button', { name: 'Remove PDF for Omnia PDF Fixture' })
    .click();
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
  const browserFailures = monitorSyncBrowserFailures(page);

  await page.goto('/');
  await importSyncPublication(
    page,
    'remote-deletion.pdf',
    'application/pdf',
    publication,
    'Omnia PDF Fixture',
  );
  await page.goto('/settings/sync');
  await selectSyncProvider(page, /^MEGA/);
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });

  const manifestPath = gateway
    .documentPaths()
    .find((path) => path.endsWith('/book.json'));
  const libraryObjectPath = gateway
    .objectPaths()
    .find((path) => path.includes('/library/'));
  expect(manifestPath).toBeDefined();
  expect(libraryObjectPath).toBeDefined();
  const bookId = JSON.parse(
    gateway.documentContent(manifestPath as string) ?? '{}',
  )['bookId'] as string;
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
  expect(
    gateway.objectPaths(),
    gateway.requestHistory().join('\n'),
  ).not.toContain(libraryObjectPath);
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
  await expectExcludedBook(page, bookId);

  await page.reload();
  await expectExcludedBook(page, bookId);
  await page.getByRole('button', { name: 'Sync books and progress' }).click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 30_000,
  });
  expect(
    gateway.objectPaths(),
    gateway.requestHistory().join('\n'),
  ).not.toContain(libraryObjectPath);
  await page.goto('/');
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible();
  expect(browserFailures()).toEqual([]);
});

async function expectExcludedBook(page: Page, bookId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = localStorage.getItem('omnia-reader.sync-excluded-books');
        return value ? (JSON.parse(value)['bookIds'] as string[]) : [];
      }),
    )
    .toContain(bookId);
}
