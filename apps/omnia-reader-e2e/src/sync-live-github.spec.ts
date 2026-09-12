import { createHash } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import {
  canonicalRecoveryInventory,
  publicationBinaryEvidence,
} from './canonical-recovery-inventory';
import {
  invokeLiveGitHubControl,
  readLiveGitHubConfiguration,
  readProtectedGitHubStorageState,
} from './live-github-control.mjs';
import {
  createLargeEpubFixture,
  createPdfFixture,
} from './publication-fixtures';
import {
  createEpubHighlight,
  createPdfHighlight,
  openLibraryPublication,
} from './reader-state-helpers';
import {
  importSyncPublication,
  monitorSyncBrowserFailures,
} from './sync-test-helpers';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const configuration = readLiveGitHubConfiguration();

test('proves real GitHub synchronization and recovery through the public application boundary', async ({
  browser,
}) => {
  test.skip(
    configuration === null,
    'Run only on the protected live GitHub synchronization runner',
  );
  if (!configuration) throw new Error('Live GitHub configuration is required');

  test.setTimeout(20 * 60_000);
  const storageState = await readProtectedGitHubStorageState(
    configuration.authStatePath,
  );
  const pdf = createPdfFixture();
  const epub = await createLargeEpubFixture();
  const expectedPublications = [pdf, epub].map((content) => ({
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
  }));
  const devices: BrowserContext[] = [];
  const surfaces: CapturedSurface[] = [];
  let initialRecoveryState: Record<string, unknown> | undefined;
  let journeyFailure: unknown;

  try {
    assertDeploymentEvidence(
      await invokeLiveGitHubControl(configuration, 'prepare'),
      configuration,
    );
    const first = await createProtectedDevice(
      browser,
      storageState,
      devices,
      surfaces,
    );
    await test.step('create local EPUB and PDF reading state before connecting', async () => {
      await first.goto('/');
      await importSyncPublication(
        first,
        'live-github.pdf',
        'application/pdf',
        pdf,
        'Omnia PDF Fixture',
      );
      await importSyncPublication(
        first,
        'live-github-large.epub',
        'application/epub+zip',
        epub,
        'Omnia Large EPUB Fixture',
      );
      await createInitialReadingState(first);
    });

    await test.step('authorize publicly and create a unique private repository', async () => {
      await connectGitHub(first, configuration.baseUrl);
      await invokeLiveGitHubControl(configuration, 'interrupt-lfs-once');
      await createPrivateRepository(first, configuration.repositoryName);

      await expect(first.getByTestId('automatic-sync-status')).toContainText(
        'needs attention',
        { timeout: 90_000 },
      );
      await assertRemoteSafety(configuration);
      await assertLocalReadingAndMutationRemainUsable(first);
      await expect(
        first.getByText(/local changes? (?:is|are) waiting to sync/),
      ).toBeVisible();
      await synchronize(first, 'interrupted-upload-retry');
      await assertRemotePublications(configuration, expectedPublications);
      initialRecoveryState = replacementState(
        await canonicalRecoveryInventory(first),
      );
    });

    await test.step('retain the authenticated destination across a gateway replica restart', async () => {
      await invokeLiveGitHubControl(configuration, 'restart-gateway');
      await first.reload();
      await expect(first.getByText('Connected to GitHub as')).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        first.getByText(configuration.repositoryName).first(),
      ).toBeVisible();
    });

    const second = await createProtectedDevice(
      browser,
      storageState,
      devices,
      surfaces,
    );
    await test.step('restore exact publications and state on an isolated second client', async () => {
      await connectGitHub(second, configuration.baseUrl);
      await selectRepository(second, configuration.repositoryName);
      await synchronize(second, 'second-client-restore');
      await expectExactLocalPublications(second, expectedPublications);
      expect(
        replacementState(await canonicalRecoveryInventory(second)),
      ).toEqual(initialRecoveryState);
      await expectInitialReadingState(second);
      await createSecondClientContributions(second);
      await invokeLiveGitHubControl(configuration, 'force-conflict-once');
      await synchronize(second, 'optimistic-conflict');
      await expect(second.getByRole('status')).toContainText(
        'conflicts retried',
      );
      await synchronize(first, 'first-client-convergence');
      await expectConvergedContributions(first);
    });

    await test.step('converge membership and bookmark tombstones', async () => {
      await deletePdfAndCurrentEpubBookmark(second);
      await synchronize(second, 'tombstone-push');
      await synchronize(first, 'tombstone-pull');
      await first.goto('/');
      await expect(
        first.getByText('Omnia PDF Fixture', { exact: true }),
      ).toHaveCount(0);
      await expect(
        first.getByText('Omnia Large EPUB Fixture', { exact: true }),
      ).toBeVisible();
      const inventory = await canonicalRecoveryInventory(first);
      expect(records(inventory, 'tombstones').length).toBeGreaterThanOrEqual(2);
    });

    await test.step('restore the authoritative state on a clean replacement client', async () => {
      const authoritative = replacementState(
        await canonicalRecoveryInventory(first),
      );
      const replacement = await createProtectedDevice(
        browser,
        storageState,
        devices,
        surfaces,
      );
      await connectGitHub(replacement, configuration.baseUrl);
      await selectRepository(replacement, configuration.repositoryName);
      await synchronize(replacement, 'clean-replacement');
      expect(
        replacementState(await canonicalRecoveryInventory(replacement)),
      ).toEqual(authoritative);
    });

    await test.step('sanitize provider failures and recover repository permission', async () => {
      await invokeLiveGitHubControl(
        configuration,
        'inject-provider-error-once',
      );
      await first.goto('/settings/sync');
      await first
        .getByRole('button', { name: 'Sync books and progress' })
        .click();
      await expect(first.getByRole('alert')).toBeVisible({ timeout: 30_000 });
      await assertNoSecretCanary(surfaces, configuration.secretCanary);
      await assertLocalReadingAndMutationRemainUsable(first);
      await first.reload();
      await synchronize(first, 'provider-error-recovery');

      await invokeLiveGitHubControl(configuration, 'remove-repository-access');
      await first.getByRole('button', { name: 'Refresh repositories' }).click();
      await expect(first.getByRole('alert')).toContainText(
        'GitHub denied repository access',
      );
      await assertLocalReadingAndMutationRemainUsable(first);
      await invokeLiveGitHubControl(configuration, 'restore-repository-access');
      await first.getByRole('button', { name: 'Refresh repositories' }).click();
      await selectRepository(first, configuration.repositoryName);
      await synchronize(first, 'permission-recovery');
    });

    await test.step('refresh, revoke, disconnect, and reconnect without orphaned authority', async () => {
      await invokeLiveGitHubControl(configuration, 'expire-provider-token');
      await first.reload();
      await expect(first.getByText('Connected to GitHub as')).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        first.getByText(configuration.repositoryName).first(),
      ).toBeVisible();

      await invokeLiveGitHubControl(configuration, 'revoke-authorization');
      await first.reload();
      await expect(first.getByTestId('sync-connect')).toBeVisible({
        timeout: 30_000,
      });
      await assertLocalReadingAndMutationRemainUsable(first);
      await connectGitHub(first, configuration.baseUrl);
      await selectRepository(first, configuration.repositoryName);

      await first.getByRole('button', { name: 'Disconnect' }).click();
      await expect(first.getByTestId('sync-connect')).toBeVisible();
      await connectGitHub(first, configuration.baseUrl);
      await selectRepository(first, configuration.repositoryName);
      await synchronize(first, 'disconnect-reconnect');
      await assertNoAuthorizationOrphans(configuration);
    });

    await test.step('observe safe throttling or record the live gate as unavailable', async () => {
      const result = await invokeLiveGitHubControl(
        configuration,
        'throttle-once',
        { allowUnavailable: !configuration.throttleAvailable },
      );
      if (result.outcome === 'unavailable') {
        test.info().annotations.push({
          type: 'live-github-throttling',
          description: 'UNAVAILABLE: staging does not expose a safe throttle',
        });
        return;
      }
      await first.goto('/settings/sync');
      await first
        .getByRole('button', { name: 'Sync books and progress' })
        .click();
      await expect(first.getByRole('alert')).toContainText(
        'temporarily rate limiting synchronization',
      );
      await assertLocalReadingAndMutationRemainUsable(first);
      await synchronize(first, 'throttle-recovery');
    });

    await assertNoSecretCanary(surfaces, configuration.secretCanary);
    for (const surface of surfaces) {
      expect(surface.browserFailures()).toEqual([]);
    }
  } catch (error) {
    journeyFailure = error;
  }

  const teardownFailures: unknown[] = [];
  for (const context of devices.reverse()) {
    await context
      .close()
      .catch((error: unknown) => teardownFailures.push(error));
  }
  try {
    const cleanup = await invokeLiveGitHubControl(configuration, 'cleanup');
    assertCleanupEvidence(cleanup);
  } catch (error) {
    teardownFailures.push(error);
  }
  if (journeyFailure !== undefined && teardownFailures.length === 0)
    throw journeyFailure;
  if (journeyFailure === undefined && teardownFailures.length === 1)
    throw teardownFailures[0];
  if (journeyFailure !== undefined) teardownFailures.unshift(journeyFailure);
  if (teardownFailures.length > 0)
    throw new LiveGitHubJourneyError(teardownFailures);
});

class LiveGitHubJourneyError extends Error {
  constructor(readonly failures: readonly unknown[]) {
    super('The live GitHub journey and its scoped cleanup both failed');
    this.name = 'LiveGitHubJourneyError';
  }
}

interface CapturedSurface {
  readonly messages: string[];
  readonly page: Page;
  readonly browserFailures: () => string[];
}

async function createProtectedDevice(
  browser: Browser,
  storageState: Exclude<
    BrowserContextOptions['storageState'],
    string | undefined
  >,
  contexts: BrowserContext[],
  surfaces: CapturedSurface[],
): Promise<Page> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    storageState,
  });
  contexts.push(context);
  const page = await context.newPage();
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  surfaces.push({
    messages,
    page,
    browserFailures: monitorSyncBrowserFailures(page),
  });
  return page;
}

async function connectGitHub(page: Page, baseUrl: string): Promise<void> {
  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();
  const connected = page.getByText('Connected to GitHub as');
  if (await connected.isVisible().catch(() => false)) return;

  await page.getByTestId('sync-connect').click();
  await page.waitForLoadState('domcontentloaded');
  const url = new URL(page.url());
  if (url.hostname === 'github.com') {
    if (
      (await page.getByLabel(/Username or email address/i).count()) > 0 ||
      (await page.getByLabel(/^Password$/i).count()) > 0
    ) {
      throw new Error(
        'Protected GitHub browser state is no longer authenticated',
      );
    }
    const authorize = page
      .getByRole('button', { name: /^(?:Authorize|Continue|Approve)/i })
      .last();
    if (await authorize.isVisible().catch(() => false)) await authorize.click();
  }
  const expectedOrigin = new URL(baseUrl).origin;
  await page.waitForURL(
    (candidate) =>
      candidate.origin === expectedOrigin &&
      candidate.pathname.endsWith('/settings/sync'),
    { timeout: 90_000 },
  );
  await expect(connected).toBeVisible({ timeout: 60_000 });
}

async function createPrivateRepository(
  page: Page,
  repositoryName: string,
): Promise<void> {
  const creation = page.getByTestId('create-github-repository');
  await expect(creation).toBeVisible();
  await creation
    .getByRole('textbox', { name: 'Repository name' })
    .fill(repositoryName);
  await creation
    .getByRole('button', { name: 'Create private repository' })
    .click();
  await expect(page.getByRole('status')).toContainText(
    `Created and selected private repository`,
    { timeout: 60_000 },
  );
  await expect(page.getByText(repositoryName).first()).toBeVisible();
}

async function selectRepository(page: Page, repositoryName: string) {
  await page.goto('/settings/sync');
  await page.getByRole('button', { name: /^Git \+ LFS/ }).click();
  const repository = page.getByLabel('Git/LFS repository');
  const option = repository
    .locator('option')
    .filter({ hasText: repositoryName });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await repository.selectOption(await option.getAttribute('value'));
  await expect(page.getByText(repositoryName).first()).toBeVisible();
}

async function synchronize(page: Page, sample: string): Promise<void> {
  await page.goto('/settings/sync');
  const button = page.getByRole('button', { name: 'Sync books and progress' });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  const started = Date.now();
  await button.click();
  await expect(page.getByRole('status')).toContainText('Sync complete:', {
    timeout: 90_000,
  });
  test.info().annotations.push({
    type: 'sync-staging-v1-sample',
    description: `${sample}:${Date.now() - started}ms`,
  });
  await expect(
    page.getByText(/0 local changes are waiting to sync/),
  ).toBeVisible();
}

async function createInitialReadingState(page: Page): Promise<void> {
  await openLibraryPublication(page, 'Omnia PDF Fixture');
  await page.keyboard.press('ArrowDown');
  await addBookmark(page);
  await createPdfHighlight(page, 2, 'Page Two', 'Live GitHub PDF note.');

  await openLibraryPublication(page, 'Omnia Large EPUB Fixture');
  await addBookmark(page);
  await createEpubHighlight(
    page,
    'Chapter 1, paragraph 1',
    'Live GitHub EPUB note.',
  );
}

async function createSecondClientContributions(page: Page): Promise<void> {
  await openLibraryPublication(page, 'Omnia PDF Fixture');
  await addBookmark(page);
  await createPdfHighlight(page, 2, 'Page Two', 'Second GitHub PDF note.');
  await openLibraryPublication(page, 'Omnia Large EPUB Fixture');
  await addBookmark(page);
  await createEpubHighlight(
    page,
    'Chapter 1, paragraph 2',
    'Second GitHub EPUB note.',
  );
}

async function expectInitialReadingState(page: Page): Promise<void> {
  await openLibraryPublication(page, 'Omnia PDF Fixture');
  await expectReaderContribution(page, 'Live GitHub PDF note.');
  await openLibraryPublication(page, 'Omnia Large EPUB Fixture');
  await expectReaderContribution(page, 'Live GitHub EPUB note.');
}

async function expectConvergedContributions(page: Page): Promise<void> {
  await openLibraryPublication(page, 'Omnia PDF Fixture');
  await expectReaderContribution(page, 'Live GitHub PDF note.');
  await expectReaderContribution(page, 'Second GitHub PDF note.');
  await openLibraryPublication(page, 'Omnia Large EPUB Fixture');
  await expectReaderContribution(page, 'Live GitHub EPUB note.');
  await expectReaderContribution(page, 'Second GitHub EPUB note.');
}

async function expectReaderContribution(page: Page, note: string) {
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'Highlights and notes' })
      .getByText(note),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
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

async function assertLocalReadingAndMutationRemainUsable(
  page: Page,
): Promise<void> {
  await openLibraryPublication(page, 'Omnia Large EPUB Fixture');
  const toggle = page.getByRole('button', { name: 'Toggle bookmarks' });
  await toggle.click();
  const bookmarks = page.getByRole('complementary', { name: 'Bookmarks' });
  const remove = bookmarks.getByRole('button', {
    name: 'Remove bookmark at current location',
  });
  if (await remove.isVisible().catch(() => false)) {
    await remove.click();
    await expect(
      bookmarks.getByRole('button', {
        name: 'Add bookmark at current location',
      }),
    ).toBeVisible();
  } else {
    await bookmarks
      .getByRole('button', { name: 'Add bookmark at current location' })
      .click();
    await expect(remove).toBeVisible();
  }
  await toggle.click();
}

async function deletePdfAndCurrentEpubBookmark(page: Page): Promise<void> {
  await openLibraryPublication(page, 'Omnia Large EPUB Fixture');
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page
    .getByRole('complementary', { name: 'Bookmarks' })
    .getByRole('button', { name: 'Remove bookmark at current location' })
    .click();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Remove PDF for Omnia PDF Fixture' })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove book' })
    .click();
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toHaveCount(0);
}

async function expectExactLocalPublications(
  page: Page,
  expected: readonly { sha256: string; size: number }[],
) {
  const actual = (await publicationBinaryEvidence(page))
    .map(({ sha256, size }) => ({ sha256, size }))
    .sort(byDigest);
  expect(actual).toEqual([...expected].sort(byDigest));
}

async function assertRemoteSafety(
  liveConfiguration: NonNullable<typeof configuration>,
) {
  const result = await invokeLiveGitHubControl(liveConfiguration, 'inspect');
  const evidence = controlEvidence(result);
  expect(evidence['danglingPointers']).toBe(0);
  expect(evidence['acknowledgedWithoutPointer']).toBe(0);
}

async function assertRemotePublications(
  liveConfiguration: NonNullable<typeof configuration>,
  expected: readonly { sha256: string; size: number }[],
) {
  const result = await invokeLiveGitHubControl(liveConfiguration, 'inspect');
  const evidence = controlEvidence(result);
  expect(evidence['privateRepository']).toBe(true);
  expect(evidence['danglingPointers']).toBe(0);
  expect(evidence['acknowledgedWithoutPointer']).toBe(0);
  const publications = evidence['publications'];
  expect(Array.isArray(publications)).toBe(true);
  expect(
    (
      publications as {
        sha256: string;
        size: number;
        pointerPublished: boolean;
      }[]
    )
      .map(({ sha256, size, pointerPublished }) => ({
        sha256,
        size,
        pointerPublished,
      }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256)),
  ).toEqual(
    expected
      .map((publication) => ({ ...publication, pointerPublished: true }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256)),
  );
}

async function assertNoAuthorizationOrphans(
  liveConfiguration: NonNullable<typeof configuration>,
) {
  const result = await invokeLiveGitHubControl(liveConfiguration, 'inspect');
  expect(controlEvidence(result)['authorizationOrphans']).toBe(0);
}

function assertDeploymentEvidence(
  result: unknown,
  liveConfiguration: NonNullable<typeof configuration>,
): void {
  const evidence = controlEvidence(result);
  expect(evidence['deployedCommit']).toBe(liveConfiguration.candidateCommit);
  expect(evidence['deployedRelease']).toBe(liveConfiguration.candidateRelease);
  expect(evidence['deployedArtifactDigest']).toBe(
    liveConfiguration.artifactDigest,
  );
}

function assertCleanupEvidence(result: unknown): void {
  const evidence = controlEvidence(result);
  expect(evidence['repositoryDeleted']).toBe(true);
  expect(evidence['authorizationRevoked']).toBe(true);
}

function controlEvidence(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result['evidence'])) {
    throw new Error('Live GitHub control evidence is missing');
  }
  return result['evidence'];
}

async function assertNoSecretCanary(
  surfaces: readonly CapturedSurface[],
  canary: string,
): Promise<void> {
  for (const surface of surfaces) {
    if (
      surface.messages.some((message) => message.includes(canary)) ||
      surface.browserFailures().some((message) => message.includes(canary)) ||
      (
        await surface.page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).includes(canary)
    ) {
      throw new Error('A protected secret canary reached browser diagnostics');
    }
  }
}

function replacementState(inventory: Record<string, unknown>) {
  return {
    membership: records(inventory, 'membership').map((record) =>
      Object.fromEntries(
        Object.entries(record).filter(
          ([key, value]) => key !== 'updatedAt' && value !== undefined,
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

function records(
  inventory: Record<string, unknown>,
  field: string,
): readonly Record<string, unknown>[] {
  const value = inventory[field];
  expect(Array.isArray(value), `${field} must be an array`).toBe(true);
  return value as readonly Record<string, unknown>[];
}

function byDigest(left: { sha256: string }, right: { sha256: string }) {
  return left.sha256.localeCompare(right.sha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
