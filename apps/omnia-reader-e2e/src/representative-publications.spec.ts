import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { isExpectedSandboxEnforcementMessage } from './browser-failure-helpers';

interface RepresentativePublication {
  readonly fileName: string;
  readonly title: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

const REPRESENTATIVE_PUBLICATIONS_ENABLED =
  process.env['REPRESENTATIVE_PUBLICATIONS_E2E'] === '1';

const MOBY_DICK: RepresentativePublication = {
  fileName: 'moby-dick.epub',
  title: 'Moby-Dick',
  url: 'https://github.com/IDPF/epub3-samples/releases/download/20230704/moby-dick.epub',
  size: 1_628_868,
  sha256: '81bc079841a38e91a02a7776d04786a2fc311cfd300064e9fc533ce7c54cf7b4',
};

const ISRAEL_SAILING: RepresentativePublication = {
  fileName: 'israelsailing.epub',
  title: 'מפליגים בישראל',
  url: 'https://github.com/IDPF/epub3-samples/releases/download/20230704/israelsailing.epub',
  size: 1_358_190,
  sha256: '10c397036d2eb54db172d05c9e3cda4382d04e8e9ce3ddd8741ba7058c3dcd4a',
};

const VOYAGE_OF_LIFE: RepresentativePublication = {
  fileName: 'cole-voyage-of-life.epub',
  title: 'Thomas Cole - The Voyage of Life',
  url: 'https://github.com/IDPF/epub3-samples/releases/download/20230704/cole-voyage-of-life.epub',
  size: 970_980,
  sha256: 'e38ed606ff604e638f737efaf66e0fd0b2997c3eab7432bcba9a00a81a925cf3',
};

const VERTICALLY_SCROLLABLE_MANGA: RepresentativePublication = {
  fileName: 'vertically-scrollable-manga.epub',
  title: '鳥の眼',
  url: 'https://github.com/IDPF/epub3-samples/releases/download/20230704/vertically-scrollable-manga.epub',
  size: 5_826_314,
  sha256: '7ae9b49244218947a45c43f1d22ece95b52ea09f470edf239cd179a346c00269',
};

const READIUM_EPUB_2_SMOKE_TEST: RepresentativePublication = {
  fileName: 'SmokeTest-EPUB2.epub',
  title: 'SmokeTest - EPUB 2',
  url: 'https://raw.githubusercontent.com/readium/readium-test-files/743a3c973168e67be791787fe1c2b917ea98e56d/functional/smoke-tests/SmokeTest-EPUB2/SmokeTest-EPUB2.epub',
  size: 279_280,
  sha256: '84dad47591636e07b8eaceb80edc5a16bc08ce4cecc109d0c61afd44e4ba62ed',
};

const publicationDownloads = new Map<string, Promise<Buffer>>();
const browserFailures = new WeakMap<
  import('@playwright/test').Page,
  string[]
>();

test.describe('representative EPUB compatibility', () => {
  // The suite intentionally depends on external, hash-pinned release assets.
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    !REPRESENTATIVE_PUBLICATIONS_ENABLED,
    'Set REPRESENTATIVE_PUBLICATIONS_E2E=1 to download and verify the hash-pinned W3C/IDPF corpus.',
  );

  test.beforeEach(async ({ page }) => {
    const failures: string[] = [];
    browserFailures.set(page, failures);
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !isExpectedSandboxEnforcementMessage(message.text())
      ) {
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

  test('renders and searches the long-form Moby-Dick EPUB', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await importRepresentativePublication(page, MOBY_DICK);

    await page
      .getByRole('link', { name: `Start reading ${MOBY_DICK.title}` })
      .click();
    const viewport = page.getByTestId('publication-viewport');
    await expect(viewport.locator('iframe')).toBeVisible({ timeout: 30_000 });
    await expect(viewport).toHaveAttribute('dir', 'ltr');

    await page
      .getByRole('button', { name: 'Toggle table of contents' })
      .click();
    await page.getByRole('button', { name: /Chapter 1\. Loomings\.$/ }).click();
    const frame = viewport.frameLocator('iframe');
    await expect(
      frame.getByText('Call me Ishmael.', { exact: false }),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Open publication search' }).click();
    await page
      .getByRole('searchbox', { name: 'Search publication' })
      .fill('Call me Ishmael');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page
      .getByRole('button', { name: /Call me Ishmael/ })
      .first()
      .click();
    await expect(
      frame.getByText('Call me Ishmael.', { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('reader-root')).toBeFocused();
  });

  test('honors authored RTL direction and physical arrow order', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await importRepresentativePublication(page, ISRAEL_SAILING);

    await page
      .getByRole('link', { name: `Start reading ${ISRAEL_SAILING.title}` })
      .click();
    const viewport = page.getByTestId('publication-viewport');
    await expect(viewport.locator('iframe')).toBeVisible({ timeout: 30_000 });
    await expect(viewport).toHaveAttribute('dir', 'rtl');

    await page
      .getByRole('button', { name: 'Toggle table of contents' })
      .click();
    await page.getByRole('button', { name: /הפלגת קצרה עם רונית$/ }).click();
    const frame = viewport.frameLocator('iframe');
    await expect(
      frame.getByRole('heading', { name: 'הפלגת קצרה עם רונית' }),
    ).toBeVisible({ timeout: 30_000 });

    const locatorBeforeNext = await storedLocator(page);
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(() => storedLocator(page), { timeout: 30_000 })
      .not.toBe(locatorBeforeNext);
    const locatorAfterNext = await storedLocator(page);
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() => storedLocator(page), { timeout: 30_000 })
      .not.toBe(locatorAfterNext);
  });

  test('preserves item-level fixed layouts between reflowable sections', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await importRepresentativePublication(page, VOYAGE_OF_LIFE);

    await page
      .getByRole('link', { name: `Start reading ${VOYAGE_OF_LIFE.title}` })
      .click();
    const viewport = page.getByTestId('publication-viewport');
    await expect(viewport.locator('iframe')).toBeVisible({ timeout: 30_000 });

    await page
      .getByRole('button', { name: 'Toggle table of contents' })
      .click();
    await page.getByRole('button', { name: /Childhood$/ }).click();
    const frame = viewport.frameLocator('iframe');
    await expect(
      frame.getByRole('heading', { name: 'Childhood', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(viewport).toHaveAttribute(
      'data-current-section-layout',
      'reflowable',
    );

    await navigateUntilHref(page, '1b-childhood-painting.xhtml', 'ArrowDown');
    const painting = frame.getByRole('img', {
      name: /Thomas Cole's painting 'Childhood'/,
    });
    await expect(painting).toBeVisible({ timeout: 30_000 });
    await expect(viewport).toHaveAttribute(
      'data-current-section-layout',
      'pre-paginated',
    );
    expect(await renderedAspectRatio(painting)).toBeCloseTo(1024 / 697, 2);

    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => storedLocatorHref(page), { timeout: 30_000 })
      .toContain('2a-youth-text.xhtml');
    await expect(
      frame.getByRole('heading', { name: 'Youth', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(viewport).toHaveAttribute(
      'data-current-section-layout',
      'reflowable',
    );
  });

  test('honors authored vertical scrolling and explicit reader overrides', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await importRepresentativePublication(page, VERTICALLY_SCROLLABLE_MANGA);

    await page
      .getByRole('link', {
        name: `Start reading ${VERTICALLY_SCROLLABLE_MANGA.title}`,
      })
      .click();
    const viewport = page.getByTestId('publication-viewport');
    await expect(viewport.locator('iframe')).toBeVisible({ timeout: 30_000 });
    await expect(viewport).toHaveAttribute(
      'data-current-section-layout',
      'reflowable',
    );
    await expect(viewport).toHaveAttribute(
      'data-current-section-flow',
      'scrolled',
    );

    const frame = viewport.frameLocator('iframe');
    await expect(frame.getByRole('img')).toHaveCount(10, { timeout: 30_000 });
    const scrollContainer = viewport.locator('.epub-container');
    await expect
      .poll(
        () =>
          scrollContainer.evaluate(
            (element) => element.scrollHeight > element.clientHeight,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const locatorBeforeScroll = await storedLocatorHref(page);
    await scrollContainer.hover();
    await page.mouse.wheel(0, 1_200);
    await expect
      .poll(() => scrollContainer.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await storedLocatorHref(page)).toBe(locatorBeforeScroll);

    await page.getByRole('button', { name: 'Open reader settings' }).click();
    await page.getByLabel('EPUB reading mode').selectOption('paginated');
    await expect(viewport).toHaveAttribute(
      'data-current-section-flow',
      'paginated',
    );
    await page.getByLabel('EPUB reading mode').selectOption('auto');
    await expect(viewport).toHaveAttribute(
      'data-current-section-flow',
      'scrolled',
    );
  });

  test('renders legacy EPUB 2 content and de-duplicates NCX chapter numbers', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await importRepresentativePublication(page, READIUM_EPUB_2_SMOKE_TEST);

    await page
      .getByRole('link', {
        name: `Start reading ${READIUM_EPUB_2_SMOKE_TEST.title}`,
      })
      .click();
    const viewport = page.getByTestId('publication-viewport');
    await expect(viewport.locator('iframe')).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole('button', { name: 'Toggle table of contents' })
      .click();

    const firstChapter = page.getByRole('button', {
      name: "1 King Solomon's Mines",
      exact: true,
    });
    const secondChapter = page.getByRole('button', {
      name: '2 The Marvellous Land of Oz',
      exact: true,
    });
    await expect(firstChapter).toBeVisible();
    await expect(secondChapter).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: "1 1. King Solomon's Mines",
        exact: true,
      }),
    ).toHaveCount(0);

    await secondChapter.click();
    await expect(
      viewport
        .frameLocator('iframe')
        .getByRole('heading', { name: 'His Majesty the Scarecrow' }),
    ).toBeVisible({ timeout: 30_000 });
  });
});

async function importRepresentativePublication(
  page: import('@playwright/test').Page,
  publication: RepresentativePublication,
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: publication.fileName,
    mimeType: 'application/epub+zip',
    buffer: await downloadPublication(publication),
  });
  await expect(
    page.getByText(publication.title, { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

function downloadPublication(
  publication: RepresentativePublication,
): Promise<Buffer> {
  const existing = publicationDownloads.get(publication.url);
  if (existing) {
    return existing;
  }
  const download = fetchVerifiedPublication(publication);
  publicationDownloads.set(publication.url, download);
  return download;
}

async function fetchVerifiedPublication(
  publication: RepresentativePublication,
): Promise<Buffer> {
  const response = await fetch(publication.url, {
    headers: { 'user-agent': 'omnia-reader-compatibility-test' },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(
      `Unable to download ${publication.fileName}: HTTP ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== publication.size) {
    throw new Error(
      `${publication.fileName} size mismatch: expected ${publication.size}, received ${bytes.byteLength}`,
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== publication.sha256) {
    throw new Error(
      `${publication.fileName} SHA-256 mismatch: expected ${publication.sha256}, received ${digest}`,
    );
  }
  return bytes;
}

async function storedLocator(
  page: import('@playwright/test').Page,
): Promise<string> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const locator = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction('progress', 'readonly')
        .objectStore('progress')
        .getAll();
      request.addEventListener('success', () =>
        resolve(request.result[0]?.locator ?? null),
      );
      request.addEventListener('error', () => reject(request.error));
    });
    database.close();
    return JSON.stringify(locator);
  });
}

async function storedLocatorHref(
  page: import('@playwright/test').Page,
): Promise<string> {
  const serialized = await storedLocator(page);
  const locator = JSON.parse(serialized) as { href?: unknown } | null;
  return typeof locator?.href === 'string' ? locator.href : '';
}

async function navigateUntilHref(
  page: import('@playwright/test').Page,
  expectedHref: string,
  key: 'ArrowDown' | 'ArrowUp',
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await storedLocatorHref(page)).includes(expectedHref)) {
      return;
    }
    const locatorBeforeNavigation = await storedLocator(page);
    await page.keyboard.press(key);
    await waitForStoredLocatorChange(page, locatorBeforeNavigation);
  }
  expect(await storedLocatorHref(page)).toContain(expectedHref);
}

async function waitForStoredLocatorChange(
  page: import('@playwright/test').Page,
  previousLocator: string,
): Promise<void> {
  await expect
    .poll(() => storedLocator(page), {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .not.toBe(previousLocator);
}

async function renderedAspectRatio(
  locator: import('@playwright/test').Locator,
): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('The fixed-layout painting has no rendered bounds');
  }
  return box.width / box.height;
}
