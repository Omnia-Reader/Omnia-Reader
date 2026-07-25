import { test, expect } from '@playwright/test';
import {
  createEncryptedPdfFixture,
  createEpubFixture,
  createFixedLayoutRtlEpubFixture,
  createPdfFixture,
} from './publication-fixtures';
import {
  createEpubHighlight,
  createPdfHighlight,
} from './reader-state-helpers';

const browserFailures = new WeakMap<
  import('@playwright/test').Page,
  string[]
>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !isExpectedSandboxInjectionRejection(message.text())
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

test('filters, sorts, and remembers the accessible library view', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await importPublication(
    page,
    'omnia-library.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );
  await importPublication(
    page,
    'omnia-library.pdf',
    'application/pdf',
    createPdfFixture(),
    'Omnia PDF Fixture',
  );

  const books = page.getByTestId('library-books');
  const cards = books.getByTestId('library-book');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Omnia PDF Fixture');

  await page.getByRole('link', { name: 'Open Omnia EPUB Fixture' }).click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter One', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: 'Back to library' }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Omnia EPUB Fixture');

  await page.getByLabel('Sort books').selectOption('added');
  await expect(cards.nth(0)).toContainText('Omnia PDF Fixture');

  await page.getByLabel('Sort books').selectOption('title');
  await expect(cards.nth(0)).toContainText('Omnia EPUB Fixture');
  await expect(cards.nth(1)).toContainText('Omnia PDF Fixture');

  const search = page.getByLabel('Search library');
  await search.fill('epub');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Omnia EPUB Fixture');
  await expect(page.getByText('Showing 1 of 2 books')).toBeVisible();

  await search.fill('not in this library');
  await expect(
    page.getByRole('heading', { name: 'No books found' }),
  ).toBeVisible();
  await expect(page.getByText('Showing 0 of 2 books')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(cards).toHaveCount(2);

  const listView = page.getByRole('button', { name: 'List view' });
  await listView.click();
  await expect(listView).toHaveAttribute('aria-pressed', 'true');
  await expect(books).toHaveAttribute('data-view', 'list');

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Sort books')).toHaveValue('title');
  await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('library-books')).toHaveAttribute(
    'data-view',
    'list',
  );
});

test('imports, reads, and resumes a PDF', async ({ page }) => {
  test.setTimeout(90_000);
  await importPublication(
    page,
    'omnia-fixture.pdf',
    'application/pdf',
    createPdfFixture(),
    'Omnia PDF Fixture',
  );

  await expect(
    page.getByRole('img', { name: 'Cover of Omnia PDF Fixture' }),
  ).toBeVisible();
  const initialStorage = await storedBinaryRepresentation(page);
  expect(['opfs', 'indexeddb']).toContain(initialStorage.storage);
  expect(initialStorage.hasBytes).toBe(initialStorage.storage === 'indexeddb');
  expect(initialStorage.hasBlob).toBe(false);
  await prepareBinaryStorageForReload(page, initialStorage.storage);
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.open = ((url?: string | URL) => {
      sessionStorage.setItem('omnia-external-url', String(url));
      return null;
    }) as typeof window.open;
  });
  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await expect
    .poll(() => storedBinaryStorage(page))
    .toBe(initialStorage.storage);
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible();
  const firstPage = page.locator('.pdfViewer .page[data-page-number="1"]');
  await expect(firstPage.locator('canvas')).toBeVisible({ timeout: 20_000 });
  await expect(firstPage.locator('.textLayer')).toContainText(
    'Omnia PDF Fixture - Page One',
    { timeout: 20_000 },
  );
  await expectPdfPageFitsViewport(page, 1);

  const readerName = firstPage.locator('.annotationLayer input[type="text"]');
  await expect(readerName).toBeVisible();
  await expect(readerName).toHaveAccessibleName(/reader name/i);
  await readerName.fill('Ada Reader');
  await expect(readerName).toHaveValue('Ada Reader');

  await firstPage
    .locator('.annotationLayer a[href="https://example.com/omnia-reader-pdf"]')
    .click();
  const externalDialog = page.getByRole('dialog', {
    name: 'Open external link?',
  });
  await expect(externalDialog).toBeVisible();
  await expect(
    externalDialog.getByText('https://example.com/omnia-reader-pdf'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('omnia-external-url')),
    )
    .toBeNull();
  await externalDialog.getByRole('button', { name: 'Open link' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('omnia-external-url')),
    )
    .toBe('https://example.com/omnia-reader-pdf');

  await firstPage.getByRole('link', { name: 'Continue to page two' }).click();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
  await expect(readerName).toHaveValue('Ada Reader');

  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();

  await page
    .getByRole('button', { name: 'Toggle PDF page thumbnails' })
    .click();
  await expect(
    page.getByRole('complementary', { name: 'PDF page thumbnails' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Go to PDF page 2' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Open reader settings' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Reader settings' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('complementary', { name: 'Reader settings' }),
  ).toBeHidden();
  await expect(page).toHaveURL(/\/reader\//);

  await page.getByRole('button', { name: 'Open reader settings' }).click();
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(page.getByText('Current rotation: 90°')).toBeVisible();
  await expect
    .poll(() => storedPreference<number>(page, 'pdf', 'rotation'))
    .toBe(90);
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await page.getByRole('slider', { name: 'Custom zoom' }).fill('50');
  await expect
    .poll(() => storedPreference<string>(page, 'pdf', 'zoomMode'))
    .toBe('custom');
  await expect
    .poll(() => storedPreference<number>(page, 'pdf', 'zoomPercent'))
    .toBe(50);
  await expect
    .poll(async () => {
      const box = await page
        .locator('.pdfViewer .page[data-page-number="1"] canvas')
        .boundingBox();
      return box?.width ?? 0;
    })
    .toBeLessThan(550);

  await page.getByRole('button', { name: 'Open publication search' }).click();
  await page
    .getByRole('searchbox', { name: 'Search publication' })
    .fill('Page Two');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Page 2/ }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="2"] canvas'),
  ).toBeVisible();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect.poll(() => storedProgressPage(page)).toBe(2);

  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page
    .getByRole('button', { name: 'Add bookmark at current location' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Delete bookmark Page 2' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page
    .getByRole('complementary', { name: 'Bookmarks' })
    .getByRole('button', { name: 'Page 2', exact: true })
    .click();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();

  await createPdfHighlight(page, 2, 'Page Two', 'Review this second page.');
  await expect(
    page.locator(
      '.pdfViewer .page[data-page-number="2"] [data-omnia-annotation-layer] > div',
    ),
  ).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Review this second page.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();

  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="2"] canvas'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open reader settings' }).click();
  await expect(page.getByText('Current rotation: 90°')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Custom', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('slider', { name: 'Custom zoom' })).toHaveValue(
    '50',
  );
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await expect(
    page.getByRole('button', { name: 'Delete bookmark Page 2' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete bookmark Page 2' }).click();
  await expect(
    page.getByText('Add a bookmark to return to this location later.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Review this second page.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit annotation' }).click();
  const pdfAnnotationEditor = page.getByRole('dialog', {
    name: 'Edit highlight',
  });
  await expect(
    pdfAnnotationEditor.getByRole('textbox', { name: 'Note (optional)' }),
  ).toHaveValue('Review this second page.');
  await pdfAnnotationEditor
    .getByRole('textbox', { name: 'Note (optional)' })
    .fill('Updated PDF note.');
  await pdfAnnotationEditor.getByRole('button', { name: 'Blue' }).click();
  await pdfAnnotationEditor
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Updated PDF note.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete annotation' }).click();
  await expect(page.getByText('No highlights yet.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('No highlights yet.')).toBeVisible();
});

test('opens an encrypted PDF after an accessible password retry', async ({
  page,
}) => {
  await importPublication(
    page,
    'Encrypted Omnia PDF.pdf',
    'application/pdf',
    createEncryptedPdfFixture(),
    'Encrypted Omnia PDF',
  );
  await page.getByText('Encrypted Omnia PDF', { exact: true }).click();

  const passwordDialog = page.getByRole('dialog', { name: 'Protected PDF' });
  await expect(passwordDialog).toBeVisible();
  const password = passwordDialog.getByLabel('Password');
  await password.fill('incorrect');
  await passwordDialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(
    passwordDialog.getByRole('alert').filter({ hasText: /incorrect/i }),
  ).toBeVisible();

  await password.fill('open-sesame');
  await passwordDialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(passwordDialog).toBeHidden();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] .textLayer'),
  ).toContainText('Encrypted Omnia PDF - Page One');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
});

test('imports and opens a PDF dropped onto the application', async ({
  page,
}) => {
  const encodedPdf = createPdfFixture().toString('base64');
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([bytes], 'dropped-fixture.pdf', {
        type: 'application/pdf',
      }),
    );
    globalThis.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  }, encodedPdf);

  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible({ timeout: 20_000 });
});

test('exports and restores a complete portable library backup', async ({
  page,
}) => {
  await importPublication(
    page,
    'omnia-backup-fixture.pdf',
    'application/pdf',
    createPdfFixture(),
    'Omnia PDF Fixture',
  );
  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page
    .getByRole('button', { name: 'Add bookmark at current location' })
    .click();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await createPdfHighlight(page, 1, 'Page One', 'Portable backup note.');
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.evaluate(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: undefined,
    });
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const backup = Buffer.concat(chunks);
  await expect(
    page.getByText('Backup saved with 1 publication.'),
  ).toBeVisible();
  expect(download.suggestedFilename()).toMatch(
    /^omnia-reader-backup-\d{4}-\d{2}-\d{2}\.omnia-backup$/,
  );

  await page.getByRole('link', { name: 'Library' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Remove Omnia PDF Fixture' }).click();
  await expect(page.getByText('Your library is empty')).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/vnd.omnia-reader.backup+zip',
    buffer: backup,
  });
  await expect(
    page.getByText(
      'Backup restored: 1 added, 0 updated, 1 progress records restored, 1 device progress records restored, 1 bookmarks restored, 1 annotations restored.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect.poll(() => storedProgressDocumentCount(page)).toBe(1);

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible();
  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await expect(
    page.getByRole('button', { name: 'Delete bookmark Page 1' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Portable backup note.')).toBeVisible();
});

test('imports an EPUB, navigates chapters, and blocks publication scripts', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const publicationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracking.invalid')) {
      publicationRequests.push(request.url());
    }
  });
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      if (event.data === 'epub-script-executed') {
        sessionStorage.setItem('epub-script-executed', 'true');
      }
    });
  });
  await importPublication(
    page,
    'omnia-fixture.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );

  await expect(
    page.getByRole('img', { name: 'Cover of Omnia EPUB Fixture' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Cover of Omnia EPUB Fixture' }),
  ).toBeVisible();
  await page.getByText('Omnia EPUB Fixture', { exact: true }).click();
  await expect(
    page.getByText('Omnia EPUB Fixture', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });
  const epubFrame = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe');
  await expect(
    epubFrame.getByRole('button', { name: 'Unsafe publication action' }),
  ).not.toHaveAttribute('onclick');
  await expect(
    epubFrame.getByText('Unsafe publication link'),
  ).not.toHaveAttribute('href');
  await expect(
    page.locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute('content', /object-src 'none'/);
  await expect(epubFrame.locator('iframe')).toHaveCount(0);
  await expect(
    epubFrame.locator(
      '[src*="tracking.invalid"], [href*="tracking.invalid"], [action*="tracking.invalid"], [style*="tracking.invalid"]',
    ),
  ).toHaveCount(0);
  await expectEpubViewportToBePaginated(page);
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('epub-script-executed')),
    )
    .toBeNull();

  await page.getByRole('button', { name: 'Toggle table of contents' }).click();
  await expect(
    page.getByRole('button', { name: 'Preface', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Expand sections for 1 Chapter One',
    }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('button', { name: '1.1 Introduction', exact: true }),
  ).toBeHidden();
  await page
    .getByRole('button', { name: 'Expand sections for 1 Chapter One' })
    .click();
  await expect(
    page.getByRole('button', { name: '1.1 Introduction', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Collapse sections for 1 Chapter One' })
    .click();
  await expect(
    page.getByRole('button', { name: '1.1 Introduction', exact: true }),
  ).toBeHidden();
  await page
    .getByRole('button', { name: 'Expand sections for 1 Chapter One' })
    .click();
  await expect(
    page.getByRole('button', { name: '1.1 Introduction', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '2 Chapter Two', exact: true })
    .click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter Two', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Toggle table of contents' }).click();
  await page
    .getByRole('button', { name: '1 Chapter One', exact: true })
    .click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter One', exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Open reader settings' }).click();
  await page.getByLabel('Theme').selectOption('sepia');
  await expect
    .poll(() => storedPreference<string>(page, 'epub', 'theme'))
    .toBe('sepia');
  await expect
    .poll(() =>
      page
        .getByTestId('publication-viewport')
        .frameLocator('iframe')
        .locator('body')
        .evaluate((body) => getComputedStyle(body).backgroundColor),
    )
    .toBe('rgb(244, 236, 216)');

  const firstProgression = await storedProgression(page);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => storedProgression(page))
    .toBeGreaterThan(firstProgression);
  await expect
    .poll(() => storedProgressHref(page))
    .toContain('chapter-1.xhtml');

  const progressionAfterOuterArrow = await storedProgression(page);
  await page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('body')
    .press('ArrowRight');
  await expect
    .poll(() => storedProgression(page))
    .toBeGreaterThan(progressionAfterOuterArrow);

  await page.getByRole('button', { name: 'Previous' }).click();
  await expect
    .poll(() => storedProgression(page))
    .toBeLessThan(progressionAfterOuterArrow + 0.001);

  await advanceEpubUntilHref(page, 'chapter-2.xhtml', 40);
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter Two'),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => storedProgressHref(page))
    .toContain('chapter-2.xhtml');

  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByText('Omnia EPUB Fixture', { exact: true }).click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter Two'),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Open reader settings' }).click();
  await expect(page.getByLabel('Theme')).toHaveValue('sepia');

  await page.getByRole('button', { name: 'Open publication search' }).click();
  await page
    .getByRole('searchbox', { name: 'Search publication' })
    .fill('first EPUB fixture');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('button', { name: /first EPUB fixture chapter/ })
    .click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });

  await createEpubHighlight(page, 'first EPUB fixture', 'Portable EPUB note.');
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Portable EPUB note.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByText('Omnia EPUB Fixture', { exact: true }).click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Portable EPUB note.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit annotation' }).click();
  const epubAnnotationEditor = page.getByRole('dialog', {
    name: 'Edit highlight',
  });
  await expect(
    epubAnnotationEditor.getByRole('textbox', { name: 'Note (optional)' }),
  ).toHaveValue('Portable EPUB note.');
  await epubAnnotationEditor
    .getByRole('textbox', { name: 'Note (optional)' })
    .fill('Updated EPUB note.');
  await epubAnnotationEditor.getByRole('button', { name: 'Pink' }).click();
  await epubAnnotationEditor
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Updated EPUB note.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete annotation' }).click();
  await expect(page.getByText('No highlights yet.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByText('Omnia EPUB Fixture', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('No highlights yet.')).toBeVisible();
  expect(publicationRequests).toEqual([]);
});

test('preserves fixed-layout EPUB pages, RTL navigation, and safe link policy', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.evaluate(() => {
    window.open = ((url?: string | URL) => {
      sessionStorage.setItem('omnia-external-url', String(url));
      return null;
    }) as typeof window.open;
  });
  await importPublication(
    page,
    'omnia-fixed-rtl.epub',
    'application/epub+zip',
    await createFixedLayoutRtlEpubFixture(),
    'Omnia Fixed RTL Fixture',
  );
  await page.getByText('Omnia Fixed RTL Fixture', { exact: true }).click();

  const viewport = page.getByTestId('publication-viewport');
  await expect(viewport).toHaveAttribute(
    'data-publication-layout',
    'pre-paginated',
  );
  await expect(viewport).toHaveAttribute('dir', 'rtl');
  let frame = viewport.frameLocator('iframe');
  await expect(
    frame.getByText('Fixed RTL Page One', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() =>
      frame.locator('body').evaluate((body) => getComputedStyle(body).fontSize),
    )
    .toBe('42px');

  await page.getByRole('button', { name: 'Open reader settings' }).click();
  await expect(
    page.getByText(/fixed-layout publication.*typography.*preserved/i),
  ).toBeVisible();
  await expect(page.getByLabel('Theme')).toHaveCount(0);
  await expect(page.getByLabel('Page presentation')).toBeVisible();
  await page.getByRole('button', { name: 'Open reader settings' }).click();

  await frame.locator('body').press('ArrowLeft');
  await expect.poll(() => storedProgressHref(page)).toContain('page-2.xhtml');
  frame = viewport.frameLocator('iframe');
  await expect(
    frame.getByText('Fixed RTL Page Two', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Previous' }).click();
  frame = viewport.frameLocator('iframe');
  await expect(
    frame.getByText('Fixed RTL Page One', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await frame.getByRole('link', { name: 'Continue inside this book' }).click();
  await expect.poll(() => storedProgressHref(page)).toContain('page-2.xhtml');
  frame = viewport.frameLocator('iframe');
  await expect(
    frame.getByText('Fixed RTL Page Two', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Previous' }).click();
  frame = viewport.frameLocator('iframe');
  await expect(
    frame.getByText('Fixed RTL Page One', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await frame
    .getByRole('link', { name: 'Visit the external reference' })
    .click();
  const externalDialog = page.getByRole('dialog', {
    name: 'Open external link?',
  });
  await expect(externalDialog).toBeVisible();
  await expect(
    externalDialog.getByText('https://example.com/omnia-reader'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('omnia-external-url')),
    )
    .toBeNull();
  await externalDialog.getByRole('button', { name: 'Open link' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('omnia-external-url')),
    )
    .toBe('https://example.com/omnia-reader');

  await frame.getByRole('link', { name: 'Unsupported mail link' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Open external link?' }),
  ).toHaveCount(0);
});

async function importPublication(
  page: import('@playwright/test').Page,
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

async function expectPdfPageFitsViewport(
  page: import('@playwright/test').Page,
  pageNumber: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const [viewport, pdfPage] = await Promise.all([
        page.getByTestId('publication-viewport').boundingBox(),
        page
          .locator(`.pdfViewer .page[data-page-number="${pageNumber}"]`)
          .boundingBox(),
      ]);
      if (!viewport || !pdfPage) {
        return false;
      }
      return (
        pdfPage.width > 100 &&
        pdfPage.height > 100 &&
        pdfPage.x >= viewport.x - 1 &&
        pdfPage.x + pdfPage.width <= viewport.x + viewport.width + 1
      );
    })
    .toBe(true);
}

async function expectEpubViewportToBePaginated(
  page: import('@playwright/test').Page,
): Promise<void> {
  const viewport = page.getByTestId('publication-viewport');
  const iframe = viewport.locator('iframe');
  await expect
    .poll(async () => {
      const [viewportBox, iframeBox, windowWidth] = await Promise.all([
        viewport.boundingBox(),
        iframe.boundingBox(),
        page.evaluate(() => window.innerWidth),
      ]);
      return (
        !!viewportBox &&
        !!iframeBox &&
        viewportBox.width > 200 &&
        viewportBox.width <= windowWidth + 1 &&
        iframeBox.width > 200 &&
        iframeBox.height > 200 &&
        iframeBox.x >= viewportBox.x &&
        iframeBox.y >= viewportBox.y &&
        iframeBox.width >= viewportBox.width - 64 &&
        iframeBox.y + iframeBox.height <= viewportBox.y + viewportBox.height + 1
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const viewportWidth = await viewport.evaluate(
        (element) => element.clientWidth,
      );
      return viewport
        .frameLocator('iframe')
        .locator('body')
        .evaluate((body, maximumColumnWidth) => {
          const style = getComputedStyle(body);
          const columnWidth = Number.parseFloat(style.columnWidth);
          return (
            Number.isFinite(columnWidth) &&
            columnWidth > 100 &&
            columnWidth <= maximumColumnWidth &&
            style.overflowY === 'hidden'
          );
        }, viewportWidth);
    })
    .toBe(true);
}

async function storedProgressPage(
  page: import('@playwright/test').Page,
): Promise<number | null> {
  return (await storedProgress(page))?.locator?.locations?.position ?? null;
}

async function storedProgressHref(
  page: import('@playwright/test').Page,
): Promise<string | null> {
  return (await storedProgress(page))?.locator?.href ?? null;
}

async function advanceEpubUntilHref(
  page: import('@playwright/test').Page,
  expectedHref: string,
  maximumMoves: number,
): Promise<void> {
  for (let pageIndex = 0; pageIndex < maximumMoves; pageIndex += 1) {
    if ((await storedProgressHref(page))?.includes(expectedHref)) {
      return;
    }
    await page.getByRole('button', { name: 'Next' }).click();
  }
  throw new Error(
    `EPUB navigation did not reach "${expectedHref}" after ${maximumMoves} moves`,
  );
}

async function storedProgression(
  page: import('@playwright/test').Page,
): Promise<number> {
  return (await storedProgress(page))?.locator?.locations?.progression ?? 0;
}

async function storedProgress(page: import('@playwright/test').Page): Promise<{
  locator?: {
    href?: string;
    locations?: { position?: number; progression?: number };
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
        locations?: { position?: number; progression?: number };
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

async function storedProgressDocumentCount(
  page: import('@playwright/test').Page,
): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = database
        .transaction('progressDocuments', 'readonly')
        .objectStore('progressDocuments')
        .count();
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    database.close();
    return count;
  });
}

async function storedPreference<T>(
  page: import('@playwright/test').Page,
  format: 'epub' | 'pdf',
  property: string,
): Promise<T | null> {
  return page.evaluate(
    async ({ publicationFormat, preferenceProperty }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('omnia-reader');
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      const preferences = await new Promise<Record<string, unknown> | null>(
        (resolve, reject) => {
          const request = database
            .transaction('preferences', 'readonly')
            .objectStore('preferences')
            .get(publicationFormat);
          request.addEventListener('success', () =>
            resolve(request.result ?? null),
          );
          request.addEventListener('error', () => reject(request.error));
        },
      );
      database.close();
      return (preferences?.[preferenceProperty] as T | undefined) ?? null;
    },
    { publicationFormat: format, preferenceProperty: property },
  );
}

async function storedBinaryStorage(
  page: import('@playwright/test').Page,
): Promise<string | null> {
  return (await storedBinaryRepresentation(page)).storage;
}

async function storedBinaryRepresentation(
  page: import('@playwright/test').Page,
): Promise<{
  storage: string | null;
  hasBytes: boolean;
  hasBlob: boolean;
}> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const binary = await new Promise<{
      storage?: string;
      bytes?: unknown;
      blob?: unknown;
    } | null>((resolve, reject) => {
      const request = database
        .transaction('binaries', 'readonly')
        .objectStore('binaries')
        .getAll();
      request.addEventListener('success', () =>
        resolve(request.result[0] ?? null),
      );
      request.addEventListener('error', () => reject(request.error));
    });
    database.close();
    return {
      storage: binary?.storage ?? null,
      hasBytes: binary?.bytes instanceof ArrayBuffer,
      hasBlob: binary?.blob instanceof Blob,
    };
  });
}

async function movePublicationToLegacyIndexedDb(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const binary = await new Promise<{
      bookId: string;
      fileName: string;
      mediaType: string;
      opfsFileName: string;
    }>((resolve, reject) => {
      const request = database
        .transaction('binaries', 'readonly')
        .objectStore('binaries')
        .getAll();
      request.addEventListener('success', () => resolve(request.result[0]));
      request.addEventListener('error', () => reject(request.error));
    });
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('publications-v1');
    const handle = await directory.getFileHandle(binary.opfsFileName);
    const file = await handle.getFile();
    const blob = new Blob([await file.arrayBuffer()], {
      type: binary.mediaType,
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('binaries', 'readwrite');
      transaction.objectStore('binaries').put({
        bookId: binary.bookId,
        fileName: binary.fileName,
        mediaType: binary.mediaType,
        blob,
      });
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('error', () => reject(transaction.error));
    });
    await directory.removeEntry(binary.opfsFileName);
    database.close();
  });
}

async function prepareBinaryStorageForReload(
  page: import('@playwright/test').Page,
  storage: 'opfs' | 'indexeddb',
): Promise<void> {
  if (storage !== 'opfs') {
    return;
  }
  await movePublicationToLegacyIndexedDb(page);
  await page.reload();
}

function isExpectedSandboxInjectionRejection(message: string): boolean {
  return (
    message.startsWith("Blocked script execution in '") &&
    message.includes(
      "the document's frame is sandboxed and the 'allow-scripts' permission is not set",
    )
  );
}
