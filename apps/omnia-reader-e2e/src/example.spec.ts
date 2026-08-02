import { readFile } from 'node:fs/promises';
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  createEncryptedPdfFixture,
  createEpubFixture,
  createLargeEpubFixture,
  createFixedLayoutRtlEpubFixture,
  createMalformedPdfFixture,
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
      !message.text().includes("because the document's frame is sandboxed")
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
  const search = page.getByLabel('Search library');
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

  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter One', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('slider', { name: 'Book progress' }).fill('50');
  await expect
    .poll(() => storedTotalProgression(page))
    .toBeGreaterThanOrEqual(0.4);
  const progressMilestones = page.getByTestId('reader-progress-milestone');
  await expect(progressMilestones).toHaveCount(2);
  await expect(
    progressMilestones.first().locator('.reader-progress-milestone-inner'),
  ).toBeVisible();
  await expect(progressMilestones.first()).toHaveAttribute(
    'aria-label',
    /Go to 1 Chapter One/,
  );
  expect(await progressMilestones.first().getAttribute('title')).toBeNull();
  const chapterTwoMilestone = progressMilestones.nth(1);
  const progressBeforeMilestone = await storedTotalProgression(page);
  await chapterTwoMilestone.click();
  await expect
    .poll(() => storedTotalProgression(page))
    .toBeGreaterThan(Math.max(0.45, progressBeforeMilestone));
  const libraryProgressPercent = Math.round(
    (await storedTotalProgression(page)) * 100,
  );
  await page.goBack();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Omnia EPUB Fixture');
  const continueReading = libraryFormatButton(
    page,
    'Omnia EPUB Fixture',
    'epub',
  );
  await expect(continueReading).toBeVisible();
  await continueReading.click();
  await expect(page.getByTestId('reader-overall-progress')).toHaveText(
    `${libraryProgressPercent}% of book`,
  );
  await page.goBack();
  await expect(cards).toHaveCount(2);

  const readingStatus = page.getByLabel('Reading status');
  await readingStatus.selectOption('reading');
  await expectProgressFilterResult(
    page,
    cards,
    libraryProgressPercent,
    'reading',
  );

  await readingStatus.selectOption('unread');
  await expectLibraryFilterResult(page, cards, 1, 'Omnia PDF Fixture');

  await readingStatus.selectOption('finished');
  await expectProgressFilterResult(
    page,
    cards,
    libraryProgressPercent,
    'finished',
  );
  await readingStatus.selectOption('all');
  await search.fill('');
  await expect(readingStatus).toHaveValue('all');
  await expect(cards).toHaveCount(2);

  await page.getByLabel('Sort books').selectOption('added');
  await expect(cards.nth(0)).toContainText('Omnia PDF Fixture');

  await page.getByLabel('Sort books').selectOption('title');
  await expect(cards.nth(0)).toContainText('Omnia EPUB Fixture');
  await expect(cards.nth(1)).toContainText('Omnia PDF Fixture');

  await search.fill('epub');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Omnia EPUB Fixture');
  await expect(page.getByText('Showing 1 of 2 books')).toBeVisible();

  await search.fill('not in this library');
  await expect(
    page.getByRole('heading', { name: 'No books found' }),
  ).toBeVisible();
  await expect(page.getByText('Showing 0 of 2 books')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
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

test('associates EPUB and PDF entries into one format-selectable book', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pdfBytes = createPdfFixture();
  await importPublication(
    page,
    'omnia-associated.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );
  await importPublication(
    page,
    'omnia-associated.pdf',
    'application/pdf',
    pdfBytes,
    'Omnia PDF Fixture',
  );
  const cards = page.getByTestId('library-book');
  await expect(cards).toHaveCount(2);
  const destination = cards.filter({ hasText: 'Omnia EPUB Fixture' });
  const chooserPromise = page.waitForEvent('filechooser');
  await destination
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await chooserPromise
  ).setFiles({
    name: 'omnia-associated.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBytes,
  });
  const dialog = page.getByRole('dialog', {
    name: 'Associate an existing book',
  });
  await dialog.getByRole('radio', { name: /Omnia PDF Fixture/ }).check();
  await dialog.getByRole('button', { name: 'Associate books' }).click();

  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('EPUB');
  await expect(cards.first()).toContainText('PDF');
  await expect(
    cards.first().getByRole('button', { name: /^EPUB\b/ }),
  ).toBeVisible();
  await expect(
    cards.first().getByRole('button', { name: /^PDF\b/ }),
  ).toBeVisible();
});

test('adds a PDF format to an existing EPUB card', async ({ page }) => {
  await importPublication(
    page,
    'omnia-add-format.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );
  const card = page.getByTestId('library-book');
  const chooserPromise = page.waitForEvent('filechooser');
  await card
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await chooserPromise
  ).setFiles({
    name: 'omnia-add-format.pdf',
    mimeType: 'application/pdf',
    buffer: createPdfFixture(),
  });

  await expect(card).toHaveCount(1);
  await expect(card).toContainText('EPUB');
  await expect(card).toContainText('PDF');
  await expect(card.getByRole('button', { name: /^PDF\b/ })).toBeVisible({
    timeout: 20_000,
  });
});

test('aligns and highlights chapter milestone stones in a multi-chapter EPUB', async ({
  page,
  browserName,
}) => {
  test.setTimeout(120_000);
  await importPublication(
    page,
    'omnia-large.epub',
    'application/epub+zip',
    await createLargeEpubFixture(5, 48),
    'Omnia Large EPUB Fixture',
  );

  await libraryFormatButton(page, 'Omnia Large EPUB Fixture', 'epub').click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter 1', exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  const progressMilestones = page.getByTestId('reader-progress-milestone');
  await expect(progressMilestones).toHaveCount(5);
  const chapterFourHeading = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .getByRole('heading', { name: 'Chapter 4', exact: true });
  const chapterFourMilestone = progressMilestones.nth(3);
  const chapterFourPercent = await milestonePercent(chapterFourMilestone);
  const chapterFiveMilestone = progressMilestones.nth(4);
  const chapterFivePercent = await milestonePercent(chapterFiveMilestone);

  await chapterFourMilestone.evaluate((element) =>
    (element as HTMLButtonElement).click(),
  );
  await expect
    .poll(() => chapterFourMilestone.getAttribute('aria-current'))
    .toBe('location');
  await expect(chapterFourHeading).toBeVisible();
  const progressSlider = page.getByTestId('reader-progress-slider');
  await expect(progressSlider).toHaveValue(String(chapterFourPercent));
  const sliderFillPercent = await page
    .getByTestId('reader-progress-slider')
    .evaluate((element) => (element as HTMLInputElement).style.backgroundImage);
  expect(sliderFillPercent).toContain(`${chapterFourPercent}%`);
  await expect(page.getByTestId('reader-overall-progress')).toHaveText(
    new RegExp(`\\s*${Math.round(chapterFourPercent)}% of book\\s*`),
  );
  await expect(chapterFourMilestone).toHaveClass(
    /reader-progress-milestone-active/,
  );
  await expect(chapterFourMilestone).toHaveClass(
    /reader-progress-milestone-reached/,
  );

  const clickedMilestoneStyle =
    await chapterFourMilestone.getAttribute('style');
  expect(clickedMilestoneStyle).not.toBeNull();
  const expectedMilestoneLeft = await chapterFourMilestone.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.left || '0'),
  );
  expect(expectedMilestoneLeft).toBeGreaterThan(0);
  await expect(chapterFourMilestone).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect
    .poll(async () => {
      const currentSliderCenter = await progressSlider.evaluate((element) => {
        const sliderEl = element as HTMLInputElement;
        const sliderRect = sliderEl.getBoundingClientRect();
        const min = Number.parseFloat(sliderEl.min || '0');
        const max = Number.parseFloat(sliderEl.max || '100');
        const value = Number.parseFloat(sliderEl.value || '0');
        const ratio = Math.max(
          0,
          Math.min(1, (value - min) / Math.max(0.000001, max - min)),
        );
        const thumbWidth = Math.min(10, sliderRect.width);
        return (
          sliderRect.left +
          thumbWidth / 2 +
          ratio * Math.max(0, sliderRect.width - thumbWidth)
        );
      });
      const currentMilestoneCenter = await chapterFourMilestone.evaluate(
        (element) =>
          (element as HTMLElement).getBoundingClientRect().left +
          (element as HTMLElement).getBoundingClientRect().width / 2,
      );
      return Math.abs(currentMilestoneCenter - currentSliderCenter);
    })
    .toBeLessThanOrEqual(3);

  // The remaining cross-frame boundary sampling is Chromium/Firefox-specific;
  // the shared milestone alignment assertions above still cover WebKit.
  // eslint-disable-next-line playwright/no-conditional-in-test
  if (browserName === 'webkit') {
    return;
  }

  await expect(chapterFourMilestone).toBeEnabled();
  await page.evaluate(() => {
    const observation = {
      active: true,
      chapterThreePages: [] as string[],
    };
    (
      window as unknown as {
        __omniaPreviousBoundaryObservation?: typeof observation;
      }
    ).__omniaPreviousBoundaryObservation = observation;
    const sampleVisibleParagraph = (): void => {
      if (!observation.active) {
        return;
      }
      const frame = document.querySelector(
        '[data-testid="publication-viewport"] iframe',
      ) as HTMLIFrameElement | null;
      const visibleParagraph = Array.from(
        frame?.contentDocument?.querySelectorAll('p') ?? [],
      ).find((paragraph) => {
        const bounds = paragraph.getBoundingClientRect();
        return (
          bounds.right > 0 &&
          bounds.left < (frame?.clientWidth ?? 0) &&
          bounds.bottom > 0 &&
          bounds.top < (frame?.clientHeight ?? 0)
        );
      });
      const text = visibleParagraph?.textContent?.trim();
      if (text?.startsWith('Chapter 3, paragraph ')) {
        observation.chapterThreePages.push(text);
      }
      requestAnimationFrame(sampleVisibleParagraph);
    };
    requestAnimationFrame(sampleVisibleParagraph);
  });
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => Number(await progressSlider.inputValue()))
    .toBeLessThan(chapterFourPercent);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __omniaPreviousBoundaryObservation?: {
                chapterThreePages: string[];
              };
            }
          ).__omniaPreviousBoundaryObservation?.chapterThreePages.length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  const observedChapterThreePages = await page.evaluate(() => {
    const observation = (
      window as unknown as {
        __omniaPreviousBoundaryObservation?: {
          active: boolean;
          chapterThreePages: string[];
        };
      }
    ).__omniaPreviousBoundaryObservation;
    if (!observation) {
      return [];
    }
    observation.active = false;
    return observation.chapterThreePages;
  });
  expect(new Set(observedChapterThreePages).size).toBe(1);
  const lastVisibleChapterThreeParagraph = await page.evaluate(() => {
    const frame = document.querySelector(
      '[data-testid="publication-viewport"] iframe',
    ) as HTMLIFrameElement | null;
    return Array.from(frame?.contentDocument?.querySelectorAll('p') ?? [])
      .filter((paragraph) => {
        const bounds = paragraph.getBoundingClientRect();
        return (
          bounds.right > 0 &&
          bounds.left < (frame?.clientWidth ?? 0) &&
          bounds.bottom > 0 &&
          bounds.top < (frame?.clientHeight ?? 0)
        );
      })
      .at(-1)
      ?.textContent?.trim();
  });
  expect(lastVisibleChapterThreeParagraph).toContain(
    'Chapter 3, paragraph 48.',
  );
  await expect(chapterFourMilestone).not.toHaveAttribute(
    'aria-current',
    'location',
  );

  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () =>
      Math.abs(Number(await progressSlider.inputValue()) - chapterFourPercent),
    )
    .toBeLessThanOrEqual(0.1);
  await expect(chapterFourMilestone).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect(chapterFourHeading).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => Number(await progressSlider.inputValue()))
    .toBeGreaterThan(chapterFourPercent);
  const nextPagePercent = Number(await progressSlider.inputValue());
  expect(nextPagePercent).toBeLessThan(chapterFivePercent);
  await expect(chapterFourMilestone).not.toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect(chapterFourMilestone).toHaveClass(
    /reader-progress-milestone-reached/,
  );
  const nextPageSliderFill = await progressSlider.evaluate(
    (element) => (element as HTMLInputElement).style.backgroundImage,
  );
  expect(nextPageSliderFill).toContain(`${nextPagePercent}%`);

  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () =>
      Math.abs(Number(await progressSlider.inputValue()) - chapterFourPercent),
    )
    .toBeLessThanOrEqual(0.1);
  await expect(chapterFourMilestone).toHaveAttribute(
    'aria-current',
    'location',
  );
});

test('shows hover feedback on the progress slider milestone dots', async ({
  page,
}) => {
  test.setTimeout(90_000);

  await importPublication(
    page,
    'omnia-basic-epub.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );
  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter One', exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  const milestones = page.getByTestId('reader-progress-milestone');
  await expect(milestones).toHaveCount(2);
  const chapterMilestone = milestones.last();
  await expect(chapterMilestone).toBeVisible({ timeout: 20_000 });

  await chapterMilestone.evaluate((element) =>
    (element as HTMLButtonElement).click(),
  );
  await expect(chapterMilestone).toHaveClass(
    /reader-progress-milestone-active/,
  );
  await expect.poll(() => chapterMilestone.getAttribute('title')).toBeNull();

  const hoveredMilestone = milestones.first();
  const progressSlider = page.getByTestId('reader-progress-slider');
  const milestoneDot = hoveredMilestone.locator(
    '.reader-progress-milestone-inner',
  );
  const milestoneTooltip = hoveredMilestone.locator(
    '.reader-progress-milestone-tooltip',
  );
  const milestoneStyleBefore = await hoveredMilestone.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
    };
  });
  const dotStyleBefore = await milestoneDot.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      transform: style.transform,
      boxShadow: style.boxShadow,
    };
  });
  const tooltipOpacityBefore = await milestoneTooltip.evaluate(
    (element) => getComputedStyle(element).opacity,
  );

  const sliderValueBefore = await progressSlider.inputValue();
  const sliderBackgroundBefore = await progressSlider.evaluate((element) => {
    const slider = element as HTMLInputElement;
    return slider.style.backgroundImage;
  });
  const sliderAriaBefore = await requiredAttribute(
    progressSlider,
    'aria-valuetext',
  );
  const sliderThumbStyleBefore = await progressSlider.evaluate((element) => {
    const slider = element as HTMLInputElement;
    const withFallback = (selector: string) => {
      try {
        const style = window.getComputedStyle(slider, selector);
        return {
          transform: style.transform,
          boxShadow: style.boxShadow,
          backgroundColor: style.backgroundColor,
        };
      } catch {
        return null;
      }
    };
    return {
      webkit: withFallback('::-webkit-slider-thumb'),
      moz: withFallback('::-moz-range-thumb'),
      ms: withFallback('::-ms-thumb'),
    };
  });

  await hoveredMilestone.hover();
  await expect(milestoneTooltip).toHaveCSS('opacity', '1');

  const dotStyleAfter = await milestoneDot.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      transform: style.transform,
      boxShadow: style.boxShadow,
    };
  });
  const milestoneStyleAfter = await hoveredMilestone.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
    };
  });
  const tooltipOpacityAfter = await milestoneTooltip.evaluate(
    (element) => getComputedStyle(element).opacity,
  );

  expect(milestoneStyleAfter.opacity).toBe(milestoneStyleBefore.opacity);
  expect(milestoneStyleAfter.borderColor).toBe(
    milestoneStyleBefore.borderColor,
  );
  expect(milestoneStyleAfter.backgroundColor).toBe(
    milestoneStyleBefore.backgroundColor,
  );
  expect(dotStyleAfter.transform).not.toBe(dotStyleBefore.transform);
  expect(dotStyleAfter.boxShadow).not.toBe(dotStyleBefore.boxShadow);
  expect(tooltipOpacityBefore).toBe('0');
  expect(tooltipOpacityAfter).toBe('1');

  const sliderBackgroundAfter = await progressSlider.evaluate((element) => {
    const slider = element as HTMLInputElement;
    return slider.style.backgroundImage;
  });
  const sliderThumbStyleAfter = await progressSlider.evaluate((element) => {
    const slider = element as HTMLInputElement;
    const withFallback = (selector: string) => {
      try {
        const style = window.getComputedStyle(slider, selector);
        return {
          transform: style.transform,
          boxShadow: style.boxShadow,
          backgroundColor: style.backgroundColor,
        };
      } catch {
        return null;
      }
    };
    return {
      webkit: withFallback('::-webkit-slider-thumb'),
      moz: withFallback('::-moz-range-thumb'),
      ms: withFallback('::-ms-thumb'),
    };
  });

  await expect(progressSlider).toHaveValue(sliderValueBefore);
  expect(sliderBackgroundAfter).toBe(sliderBackgroundBefore);
  await expect(progressSlider).toHaveAttribute(
    'aria-valuetext',
    sliderAriaBefore,
  );
  expect(sliderThumbStyleAfter).toEqual(sliderThumbStyleBefore);
});

test('exports exact PDF and EPUB publication files from the library', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pdfBytes = createPdfFixture();
  const epubBytes = await createEpubFixture();
  await importPublication(
    page,
    'omnia-owned.pdf',
    'application/pdf',
    pdfBytes,
    'Omnia PDF Fixture',
  );
  await importPublication(
    page,
    'omnia-owned.epub',
    'application/epub+zip',
    epubBytes,
    'Omnia EPUB Fixture',
  );
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
    });
  });

  const pdfDownloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export PDF for Omnia PDF Fixture' })
    .click();
  const pdfDownload = await pdfDownloadPromise;
  expect(pdfDownload.suggestedFilename()).toBe('omnia-owned.pdf');
  await expectDownloadedBytes(pdfDownload, pdfBytes);
  await expect(
    page.getByRole('status').filter({
      hasText: '“Omnia PDF Fixture” exported as omnia-owned.pdf.',
    }),
  ).toBeVisible();

  const epubDownloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export EPUB for Omnia EPUB Fixture' })
    .click();
  const epubDownload = await epubDownloadPromise;
  expect(epubDownload.suggestedFilename()).toBe('omnia-owned.epub');
  await expectDownloadedBytes(epubDownload, epubBytes);
  await expect(
    page.getByRole('status').filter({
      hasText: '“Omnia EPUB Fixture” exported as omnia-owned.epub.',
    }),
  ).toBeVisible();
  await expect(page.getByTestId('library-book')).toHaveCount(2);
});

test('reports exact-edition duplicate and mixed publication imports', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const epubBytes = await createEpubFixture();
  await importPublication(
    page,
    'omnia-duplicate.epub',
    'application/epub+zip',
    epubBytes,
    'Omnia EPUB Fixture',
  );

  let chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  let chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'same-edition.epub',
    mimeType: 'application/epub+zip',
    buffer: epubBytes,
  });

  await expect(
    page.getByRole('status').filter({
      hasText: '“Omnia EPUB Fixture” is already in your library.',
    }),
  ).toBeVisible();
  await expect(page.getByTestId('library-book')).toHaveCount(1);

  chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  chooser = await chooserPromise;
  await chooser.setFiles([
    {
      name: 'same-edition-again.epub',
      mimeType: 'application/epub+zip',
      buffer: epubBytes,
    },
    {
      name: 'new-edition.pdf',
      mimeType: 'application/pdf',
      buffer: createPdfFixture(),
    },
    {
      name: 'broken-publication.pdf',
      mimeType: 'application/pdf',
      buffer: createMalformedPdfFixture(),
    },
  ]);

  await expect(
    page.getByRole('status').filter({
      hasText: '1 book added; 1 is already in your library.',
    }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    /Could not import.*broken-publication\.pdf.*invalid pdf/i,
  );
  await expect(page.getByTestId('library-book')).toHaveCount(2);
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
  await libraryFormatButton(page, 'Omnia PDF Fixture', 'pdf').click();
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
  await expect
    .poll(async () => {
      const footer = await page.getByTestId('reader-footer').boundingBox();
      return footer?.height ?? Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(32);
  await expectPdfPageFitsViewport(page, 1);
  const pdfProgress = page.getByRole('slider', { name: 'Book progress' });
  await expect(pdfProgress).toHaveValue('0');
  await pdfProgress.fill('100');
  await expectReaderPage(page, 2, 2);
  await expect.poll(() => storedProgressPage(page)).toBe(2);
  await pdfProgress.fill('0');
  await expectReaderPage(page, 1, 2);
  await page.getByTestId('reader-root').focus();
  await page.keyboard.press('Shift+/');
  const pdfShortcuts = page.getByRole('dialog', {
    name: 'Keyboard shortcuts',
  });
  await expect(pdfShortcuts).toBeVisible();
  await expect(pdfShortcuts).toContainText('Open highlights and notes');
  await page.keyboard.press('Escape');
  await expect(pdfShortcuts).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileReaderActions = page.getByRole('button', {
    name: 'Toggle reader actions',
  });
  await expect(mobileReaderActions).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open publication search' }),
  ).toBeHidden();
  await expect
    .poll(() =>
      page
        .getByTestId('reader-root')
        .evaluate((root) => root.scrollWidth <= root.clientWidth),
    )
    .toBe(true);
  await mobileReaderActions.click();
  await expect(
    page.getByRole('complementary', { name: 'Reader actions' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Reader settings', exact: true })
    .click();
  await expect(
    page.getByRole('complementary', { name: 'Reader settings' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close reader settings' }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(firstPage.locator('canvas')).toBeVisible();

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
  const cancelExternalLink = externalDialog.getByRole('button', {
    name: 'Cancel',
  });
  const openExternalLink = externalDialog.getByRole('button', {
    name: 'Open link',
  });
  await expect(cancelExternalLink).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expectReaderPage(page, 1, 2);
  await page.keyboard.press('Shift+Tab');
  await expect(openExternalLink).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancelExternalLink).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('omnia-external-url')),
    )
    .toBeNull();
  await openExternalLink.click();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('omnia-external-url')),
    )
    .toBe('https://example.com/omnia-reader-pdf');

  await firstPage.getByRole('link', { name: 'Continue to page two' }).click();
  await expectReaderPage(page, 2, 2);
  await page.keyboard.press('ArrowUp');
  await expectReaderPage(page, 1, 2);
  await expect(readerName).toHaveValue('Ada Reader');

  await page.keyboard.press('ArrowRight');
  await expectReaderPage(page, 2, 2);
  await page.keyboard.press('ArrowLeft');
  await expectReaderPage(page, 1, 2);
  await page.keyboard.press('ArrowDown');
  await expectReaderPage(page, 2, 2);
  await page.keyboard.press('ArrowUp');
  await expectReaderPage(page, 1, 2);
  await page.getByTestId('publication-viewport').hover();
  await page.mouse.wheel(0, 120);
  await expectReaderPage(page, 2, 2);
  const pdfWheelThrottleExpiresAt = Date.now() + 450;
  await expect
    .poll(() => Date.now())
    .toBeGreaterThanOrEqual(pdfWheelThrottleExpiresAt);
  await page.mouse.wheel(0, -120);
  await expectReaderPage(page, 1, 2);
  await page.keyboard.press('ArrowDown');
  await expectReaderPage(page, 2, 2);
  await page.keyboard.press('ArrowUp');
  await expectReaderPage(page, 1, 2);
  await expect(page.getByRole('button', { name: 'Previous' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);

  await installMockReaderFullscreen(page);
  const pdfReaderRoot = page.getByTestId('reader-root');
  await page
    .getByRole('button', { name: 'Enter immersive reading mode' })
    .click();
  await expect(pdfReaderRoot).toHaveAttribute('data-immersive-mode', 'true');
  const visiblePdfReaderRootBox = requireVisibleBox(
    await pdfReaderRoot.boundingBox(),
    'immersive PDF reader root',
  );
  await page.mouse.move(
    visiblePdfReaderRootBox.x + visiblePdfReaderRootBox.width / 2,
    visiblePdfReaderRootBox.y + visiblePdfReaderRootBox.height / 2,
  );
  await expect
    .poll(async () => {
      const viewportBox = await page
        .getByTestId('publication-viewport')
        .boundingBox();
      if (!viewportBox || visiblePdfReaderRootBox.height === 0) {
        return 0;
      }
      return viewportBox.height / visiblePdfReaderRootBox.height;
    })
    .toBeGreaterThan(0.75);
  await expect(firstPage.locator('canvas')).toBeVisible();
  await page.getByTestId('immersive-toolbar-reveal').click();
  await page
    .getByRole('button', { name: 'Exit immersive reading mode' })
    .click();
  await expect(pdfReaderRoot).not.toHaveAttribute('data-immersive-mode');

  await page
    .getByRole('button', { name: 'Toggle PDF page thumbnails' })
    .click();
  const thumbnailPanel = page.getByRole('complementary', {
    name: 'PDF page thumbnails',
  });
  await expect(thumbnailPanel).toBeVisible();
  await expect(thumbnailPanel).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Go to PDF page 2' }),
  ).toBeVisible();

  const readerSettingsTrigger = page.getByRole('button', {
    name: 'Open reader settings',
  });
  await readerSettingsTrigger.click();
  const readerSettingsPanel = page.getByRole('complementary', {
    name: 'Reader settings',
  });
  await expect(readerSettingsPanel).toBeVisible();
  await expect(readerSettingsPanel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(readerSettingsPanel).toBeHidden();
  await expect(readerSettingsTrigger).toBeFocused();
  await expect(page).toHaveURL(/\/reader\//);

  await readerSettingsTrigger.click();
  await expect(readerSettingsPanel).toBeFocused();
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
  await page.getByRole('button', { name: 'Close reader settings' }).click();
  await expect(readerSettingsPanel).toBeHidden();
  const publicationViewport = page.getByTestId('publication-viewport');
  const zoomInPrevented = await publicationViewport.evaluate((viewport) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
    });
    viewport.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(zoomInPrevented).toBe(true);
  await expect
    .poll(() => storedPreference<number>(page, 'pdf', 'zoomPercent'))
    .toBe(55);
  await expect(page.getByTestId('reader-zoom-indicator')).toHaveText('55%');
  const zoomOutPrevented = await publicationViewport.evaluate((viewport) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: 120,
    });
    viewport.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(zoomOutPrevented).toBe(true);
  await expect
    .poll(() => storedPreference<number>(page, 'pdf', 'zoomPercent'))
    .toBe(50);
  await expect(page.getByTestId('reader-zoom-indicator')).toHaveText('50%');
  await expect(page.getByTestId('reader-zoom-indicator')).toBeHidden({
    timeout: 3_000,
  });
  await expect
    .poll(async () => {
      const box = await page
        .locator('.pdfViewer .page[data-page-number="1"] canvas')
        .boundingBox();
      return box?.width ?? 0;
    })
    .toBeLessThan(550);

  await page.getByRole('button', { name: 'Open publication search' }).click();
  const publicationSearch = page.getByRole('searchbox', {
    name: 'Search publication',
  });
  await expect(publicationSearch).toBeFocused();
  await publicationSearch.fill('Page Two');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Page 2/ }).click();
  await expect(page.getByTestId('reader-root')).toBeFocused();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="2"] canvas'),
  ).toBeVisible();
  await expectReaderPage(page, 2, 2);
  await expect.poll(() => storedProgressPage(page)).toBe(2);

  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Bookmarks' }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Add bookmark at current location' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Delete bookmark Page 2' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page.keyboard.press('ArrowUp');
  await expectReaderPage(page, 1, 2);
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page
    .getByRole('complementary', { name: 'Bookmarks' })
    .getByRole('button', { name: 'Page 2', exact: true })
    .click();
  await expectReaderPage(page, 2, 2);

  await createPdfHighlight(
    page,
    2,
    'Page Two',
    'Review this second page.',
    'strikethrough',
  );
  await expect(
    page.locator(
      '.pdfViewer .page[data-page-number="2"] [data-omnia-annotation-layer] > div',
    ),
  ).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(
    page.getByRole('complementary', { name: 'Highlights and notes' }),
  ).toBeFocused();
  await expect(page.getByText('Review this second page.')).toBeVisible();
  const pdfAnnotationsPanel = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  await expect(
    pdfAnnotationsPanel.getByRole('button', { name: 'Strikethrough 1' }),
  ).toBeVisible();
  await expect(
    pdfAnnotationsPanel.getByRole('button', { name: 'Notes 1' }),
  ).toBeVisible();
  const annotationOrder = pdfAnnotationsPanel.getByRole('combobox', {
    name: 'Order annotations',
  });
  await expect(annotationOrder).toHaveValue('reading-order');
  await annotationOrder.selectOption('updated-desc');
  await expect(annotationOrder).toHaveValue('updated-desc');
  await annotationOrder.selectOption('reading-order');
  await pdfAnnotationsPanel
    .getByRole('searchbox', { name: 'Find in this book' })
    .fill('second page');
  await expect(
    pdfAnnotationsPanel.getByTestId('annotation-result-summary'),
  ).toHaveText('1 annotation');
  await expect(
    pdfAnnotationsPanel.getByRole('button', {
      name: 'Clear annotation search',
    }),
  ).toBeVisible();
  await expect(pdfAnnotationsPanel.getByText('Page Two')).toBeVisible();
  await pdfAnnotationsPanel
    .getByRole('button', { name: 'Clear annotation search' })
    .click();
  await expect(
    pdfAnnotationsPanel.getByRole('searchbox', { name: 'Find in this book' }),
  ).toBeFocused();
  await pdfAnnotationsPanel
    .getByRole('searchbox', { name: 'Find in this book' })
    .fill('missing phrase');
  await expect(
    pdfAnnotationsPanel.getByTestId('annotation-result-summary'),
  ).toHaveText('0 of 1 shown');
  await pdfAnnotationsPanel
    .getByRole('button', { name: 'Show all annotations' })
    .click();
  await expect(
    pdfAnnotationsPanel.getByTestId('annotation-result-summary'),
  ).toHaveText('1 annotation');
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
    });
  });
  const pdfAnnotationDownload = page.waitForEvent('download');
  await pdfAnnotationsPanel
    .getByRole('button', {
      name: 'Export 1 shown annotation as Markdown',
    })
    .click();
  const downloadedPdfAnnotations = await pdfAnnotationDownload;
  expect(downloadedPdfAnnotations.suggestedFilename()).toBe(
    'Omnia PDF Fixture-highlights-and-notes.md',
  );
  const downloadedPdfAnnotationPath = await downloadedPdfAnnotations.path();
  expect(downloadedPdfAnnotationPath).not.toBeNull();
  const pdfAnnotationMarkdown = await readFile(
    downloadedPdfAnnotationPath as string,
    'utf8',
  );
  expect(pdfAnnotationMarkdown).toContain(
    '# Highlights and notes — Omnia PDF Fixture',
  );
  expect(pdfAnnotationMarkdown).toContain('Review this second page.');
  expect(pdfAnnotationMarkdown).toContain('**Strikethrough · Purple**');
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();

  await page.goBack();
  await libraryFormatButton(page, 'Omnia PDF Fixture', 'pdf').click();
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
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  const pdfSavedHighlight = page.locator(
    '.pdfViewer .page[data-page-number="2"] [data-omnia-annotation-id]',
  );
  await expect(pdfSavedHighlight).toBeVisible();
  await expect(pdfSavedHighlight).toHaveAttribute(
    'data-omnia-annotation-style',
    'strikethrough',
  );
  await expect(pdfSavedHighlight).toHaveAttribute('role', 'button');
  await pdfSavedHighlight.focus();
  await pdfSavedHighlight.press('Enter');
  const pdfAnnotationEditor = page.getByTestId('annotation-dashboard');
  const pdfAnnotationNote = pdfAnnotationEditor.getByRole('textbox', {
    name: 'Note',
  });
  await expect(pdfAnnotationNote).toHaveValue('Review this second page.');
  await pdfAnnotationNote.fill('Updated PDF note.');
  await pdfAnnotationEditor
    .getByRole('button', { name: 'Strikethrough', exact: true })
    .click();
  await pdfAnnotationEditor
    .getByRole('button', { name: 'Underline', exact: true })
    .click();
  await pdfAnnotationEditor
    .getByRole('button', { name: /^Underline color:/ })
    .click();
  await page.getByRole('button', { name: 'Dark blue underline color' }).click();
  await pdfAnnotationEditor
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(pdfAnnotationEditor).toBeHidden();
  await expect(pdfSavedHighlight).toHaveAttribute(
    'data-omnia-annotation-style',
    'underline',
  );
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Updated PDF note.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await pdfSavedHighlight.focus();
  await pdfSavedHighlight.press('Enter');
  await pdfAnnotationEditor
    .getByRole('button', { name: 'Delete annotation' })
    .click();
  await expect(pdfAnnotationEditor).toBeHidden();
  await expect(pdfSavedHighlight).toHaveCount(0);
  const pdfAnnotationStatus = page.getByTestId('annotation-status');
  await expect(pdfAnnotationStatus).toContainText('Annotation deleted.');
  await pdfAnnotationStatus.getByRole('button', { name: 'Undo' }).click();
  await expect(pdfAnnotationStatus).toContainText('Annotation restored.');
  await expect(pdfSavedHighlight).toBeVisible();
  await pdfSavedHighlight.focus();
  await pdfSavedHighlight.press('Enter');
  await pdfAnnotationEditor
    .getByRole('button', { name: 'Delete annotation' })
    .click();
  await expect(pdfAnnotationEditor).toBeHidden();
  await expect(pdfSavedHighlight).toHaveCount(0);
  await pdfAnnotationStatus
    .getByRole('button', { name: 'Dismiss annotation message' })
    .click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('No annotations yet.')).toBeVisible();
  await page.goBack();
  await libraryFormatButton(page, 'Omnia PDF Fixture', 'pdf').click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('No annotations yet.')).toBeVisible();
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
  await libraryFormatButton(page, 'Encrypted Omnia PDF', 'pdf').click();

  const passwordDialog = page.getByRole('dialog', { name: 'Protected PDF' });
  await expect(passwordDialog).toBeVisible();
  const password = passwordDialog.getByLabel('Password');
  await expect(password).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    passwordDialog.getByRole('button', { name: 'Cancel' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
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
  await expectReaderPage(page, 2, 2);
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
  await libraryFormatButton(page, 'Omnia PDF Fixture', 'pdf').click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await page
    .getByRole('button', { name: 'Add bookmark at current location' })
    .click();
  await page.getByRole('button', { name: 'Toggle bookmarks' }).click();
  await createPdfHighlight(page, 1, 'Page One', 'Portable backup note.');
  await page.goBack();
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

  await page.getByRole('link', { name: 'Library', exact: true }).click();
  const removeBookButton = page.getByRole('button', {
    name: 'Remove PDF for Omnia PDF Fixture',
  });
  await removeBookButton.click();
  let removalDialog = page.getByRole('dialog', {
    name: 'Remove the PDF version of “Omnia PDF Fixture”?',
  });
  await expect(removalDialog).toContainText(
    'reading progress, bookmarks, highlights, and notes',
  );
  await removalDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(removalDialog).toHaveCount(0);
  await expect(removeBookButton).toBeFocused();

  await removeBookButton.click();
  removalDialog = page.getByRole('dialog', {
    name: 'Remove the PDF version of “Omnia PDF Fixture”?',
  });
  await removalDialog.getByRole('button', { name: 'Remove book' }).click();
  await expect(
    page.getByText(
      '“Omnia PDF Fixture” removed and queued for synchronization.',
    ),
  ).toBeVisible();
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

  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible();
  await libraryFormatButton(page, 'Omnia PDF Fixture', 'pdf').click();
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

test('loads EPUB chapters from a blob-backed sandbox document', async ({
  page,
}) => {
  await importPublication(
    page,
    'omnia-sandbox-fixture.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );

  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });
  const iframe = page.getByTestId('publication-viewport').locator('iframe');
  await expect(iframe).toHaveAttribute('src', /^blob:/);
  await expect(iframe).toHaveAttribute('sandbox', /allow-same-origin/);
  await expect(iframe).not.toHaveAttribute('sandbox', /allow-scripts/);

  const highlightsButton = page.getByRole('button', {
    name: 'Toggle highlights and notes',
  });
  const highlightsIcon = highlightsButton.locator('mat-icon');
  await expect(highlightsIcon).toHaveText('highlight');
  await page.evaluate(() => document.fonts.ready);
  expect(
    await highlightsIcon.evaluate((icon) => {
      const range = document.createRange();
      range.selectNodeContents(icon);
      return range.getBoundingClientRect().width;
    }),
  ).toBeLessThanOrEqual(28);

  for (const [buttonName, tooltip] of [
    ['Toggle bookmarks', 'Bookmarks'],
    ['Toggle highlights and notes', 'Highlights and notes'],
    ['Open reader settings', 'Reader settings'],
  ] as const) {
    await page.getByRole('button', { name: buttonName }).hover();
    await expect(
      page.locator('.mat-mdc-tooltip').filter({ hasText: tooltip }),
    ).toBeVisible();
  }
});

test('imports an EPUB, navigates chapters, and blocks publication scripts', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const publicationRequests: string[] = [];
  page.on('request', (request) => {
    if (
      /(?:tracking\.invalid|fonts\.googleapis\.com|fonts\.gstatic\.com)/.test(
        request.url(),
      )
    ) {
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
  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  await expect(
    page.getByText('Omnia EPUB Fixture', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('reader-page-status')).toHaveText(
    /Page \d+ of \d+\s+in this section/,
  );
  await expect(page.getByTestId('reader-overall-progress')).toHaveText(
    /\d+% of book/,
  );
  await expect
    .poll(async () => {
      const footer = await page.getByTestId('reader-footer').boundingBox();
      return footer?.height ?? Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(32);
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
  await expect(
    page.locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute(
    'content',
    /font-src 'self' data: blob: https:\/\/fonts\.gstatic\.com/,
  );
  await expect(epubFrame.locator('iframe')).toHaveCount(0);
  await expect(
    epubFrame.locator(
      '[src*="tracking.invalid"], [href*="tracking.invalid"], [action*="tracking.invalid"], [style*="tracking.invalid"]',
    ),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      epubFrame
        .locator('html')
        .evaluate((root) =>
          getComputedStyle(root)
            .getPropertyValue('--omnia-fixture-safe-style')
            .trim(),
        ),
    )
    .toBe('applied');
  await expect
    .poll(() =>
      epubFrame.locator('body').evaluate(async (body) => {
        const loaded = await body.ownerDocument.fonts.load(
          '16px "Embedded fixture font"',
        );
        return loaded.length > 0;
      }),
    )
    .toBe(true);
  await expectEpubViewportToBePaginated(page);
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('epub-script-executed')),
    )
    .toBeNull();
  const epubProgress = page.getByRole('slider', { name: 'Book progress' });
  await epubProgress.fill('75');
  await expect
    .poll(() => storedTotalProgression(page))
    .toBeGreaterThanOrEqual(0.6);
  await expect(page.getByTestId('reader-overall-progress')).toHaveText(
    /[6-7]\d% of book/,
  );
  await epubProgress.fill('0');
  await expect.poll(() => storedTotalProgression(page)).toBeLessThan(0.1);
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('reader-root').focus();

  const tocButton = page.getByRole('button', {
    name: 'Toggle table of contents',
  });
  const appNavigationButton = page.getByRole('button', {
    name: 'Toggle app navigation',
  });
  const searchButton = page.getByRole('button', {
    name: 'Open publication search',
  });
  await expect(appNavigationButton).toHaveAttribute(
    'aria-controls',
    'primary-navigation',
  );
  await expect(
    page.getByTestId('app-toolbar').getByRole('button', {
      name: 'Toggle app navigation',
    }),
  ).toBeVisible();
  await appNavigationButton.click();
  await expect(appNavigationButton).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('complementary', { name: 'Primary navigation' }),
  ).toHaveClass(/md:-translate-x-full/);
  await appNavigationButton.click();
  await expect(appNavigationButton).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('complementary', { name: 'Primary navigation' }),
  ).toHaveClass(/md:translate-x-0/);
  const readerRoot = page.getByTestId('reader-root');
  await installMockReaderFullscreen(page);
  await page
    .getByRole('button', { name: 'Enter immersive reading mode' })
    .click();
  await expect(readerRoot).toHaveAttribute('data-immersive-mode', 'true');
  await expect(readerRoot).toHaveClass(/grid-rows-\[minmax\(0,1fr\)_auto\]/);
  const readerToolbar = page.getByTestId('reader-toolbar');
  const toolbarReveal = page.getByTestId('immersive-toolbar-reveal');
  const visibleReaderRootBox = requireVisibleBox(
    await readerRoot.boundingBox(),
    'immersive EPUB reader root',
  );
  await page.mouse.move(
    visibleReaderRootBox.x + visibleReaderRootBox.width / 2,
    visibleReaderRootBox.y + visibleReaderRootBox.height / 2,
  );
  await expect(readerToolbar).toHaveClass(
    /-translate-y-\[calc\(100%-0\.5rem\)\]/,
  );
  await expect(readerToolbar).toHaveAttribute('aria-hidden', 'true');
  await expect
    .poll(async () => {
      const [rootBox, viewportBox] = await Promise.all([
        readerRoot.boundingBox(),
        page.getByTestId('publication-viewport').boundingBox(),
      ]);
      if (!rootBox || !viewportBox || rootBox.height === 0) {
        return 0;
      }
      return viewportBox.height / rootBox.height;
    })
    .toBeGreaterThan(0.75);
  await expect(epubFrame.getByText('Chapter One')).toBeVisible();
  await toolbarReveal.hover();
  await expect(toolbarReveal).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(async () => {
      const toolbarBox = await readerToolbar.boundingBox();
      return toolbarBox
        ? Math.round(toolbarBox.y - visibleReaderRootBox.y)
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1);
  await page.mouse.move(
    visibleReaderRootBox.x + visibleReaderRootBox.width / 2,
    visibleReaderRootBox.y + visibleReaderRootBox.height / 2,
  );
  await expect(toolbarReveal).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(async () => {
      const toolbarBox = await readerToolbar.boundingBox();
      return toolbarBox
        ? Math.round(toolbarBox.y + toolbarBox.height - visibleReaderRootBox.y)
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(10);
  await toolbarReveal.click();
  await expect(toolbarReveal).toHaveAttribute('aria-expanded', 'true');
  await expect(readerToolbar).toHaveClass(/translate-y-0/);
  await page.getByRole('button', { name: 'Hide reader controls' }).click();
  await expect(readerToolbar).toHaveAttribute('aria-hidden', 'true');
  await toolbarReveal.focus();
  await expect(readerToolbar).not.toHaveAttribute('aria-hidden');
  await page.keyboard.press('Tab');
  await expect(tocButton).toBeFocused();
  await page
    .getByRole('button', { name: 'Exit immersive reading mode' })
    .click();
  await expect(readerRoot).not.toHaveAttribute('data-immersive-mode');
  const [tocButtonBox, searchButtonBox] = await Promise.all([
    tocButton.boundingBox(),
    searchButton.boundingBox(),
  ]);
  expect(tocButtonBox?.x).toBeLessThan(searchButtonBox?.x ?? 0);
  await tocButton.click();
  const tocPanel = page.getByRole('complementary', {
    name: 'Table of contents',
  });
  await expect(tocPanel).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tocPanel).toBeFocused();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter One', exact: true }),
  ).toBeVisible();
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
  await expect(readerRoot).toBeFocused();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter Two', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Toggle table of contents' }).click();
  await expect(tocPanel).toBeVisible();
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
  await expect(
    page.getByRole('complementary', { name: 'Reader settings' }),
  ).toBeFocused();
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
  await page.getByRole('button', { name: 'Close reader settings' }).click();
  await expect(
    page.getByRole('button', { name: 'Open reader settings' }),
  ).toBeFocused();

  const firstProgression = await storedProgression(page);
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(() => storedProgression(page))
    .toBeGreaterThan(firstProgression);
  const progressionAfterDown = await storedProgression(page);
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(() => storedProgression(page))
    .toBeLessThan(progressionAfterDown);
  const progressionAfterUp = await storedProgression(page);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => storedProgression(page))
    .toBeGreaterThan(progressionAfterUp);
  await expect
    .poll(() => storedProgressHref(page))
    .toContain('chapter-1.xhtml');

  const progressionAfterOuterArrow = await storedProgression(page);
  const epubFrameElement = page
    .getByTestId('publication-viewport')
    .locator('iframe');
  const wheelDownPrevented = await epubFrameElement.evaluate((frame) => {
    const readerWindow = frame.ownerDocument.defaultView;
    if (!readerWindow) {
      throw new Error('Reader window is unavailable');
    }
    return !frame.dispatchEvent(
      new readerWindow.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
      }),
    );
  });
  expect(wheelDownPrevented).toBe(true);
  await expect
    .poll(() => storedProgression(page))
    .toBeGreaterThan(progressionAfterOuterArrow);
  const progressionAfterWheelDown = await storedProgression(page);
  const epubWheelThrottleExpiresAt = Date.now() + 450;
  await expect
    .poll(() => Date.now())
    .toBeGreaterThanOrEqual(epubWheelThrottleExpiresAt);
  const wheelUpPrevented = await epubFrameElement.evaluate((frame) => {
    const readerWindow = frame.ownerDocument.defaultView;
    if (!readerWindow) {
      throw new Error('Reader window is unavailable');
    }
    return !frame.dispatchEvent(
      new readerWindow.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -120,
      }),
    );
  });
  expect(wheelUpPrevented).toBe(true);
  await expect
    .poll(() => storedProgression(page))
    .toBeLessThan(progressionAfterWheelDown);
  const progressionAfterWheelUp = await storedProgression(page);
  await page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('body')
    .press('ArrowRight');
  await expect
    .poll(() => storedProgression(page))
    .toBeGreaterThan(progressionAfterWheelUp);

  const focusedEpubBody = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('body');
  await focusedEpubBody.press('Shift+/');
  const epubShortcuts = page.getByRole('dialog', {
    name: 'Keyboard shortcuts',
  });
  await expect(epubShortcuts).toBeVisible();
  await expect(epubShortcuts).toContainText(
    'including while the EPUB page has focus',
  );
  await page.keyboard.press('Escape');
  await expect(epubShortcuts).toBeHidden();
  await focusedEpubBody.press('a');
  await expect(
    page.getByRole('complementary', { name: 'Highlights and notes' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Close highlights and notes' })
    .click();

  await page.keyboard.press('ArrowUp');
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
  await expect.poll(() => storedTotalProgression(page)).toBeGreaterThan(0);
  await expect(page.getByTestId('reader-overall-progress')).toHaveText(
    /[1-9]\d*% of book/,
  );

  await page.goBack();
  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
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

  await createEpubHighlight(
    page,
    'first EPUB fixture',
    'Portable EPUB note.',
    'underline',
  );
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Portable EPUB note.')).toBeVisible();
  const epubAnnotationsPanel = page.getByRole('complementary', {
    name: 'Highlights and notes',
  });
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
    });
  });
  const epubAnnotationDownload = page.waitForEvent('download');
  await epubAnnotationsPanel
    .getByRole('button', {
      name: 'Export 1 shown annotation as Markdown',
    })
    .click();
  const downloadedEpubAnnotations = await epubAnnotationDownload;
  expect(downloadedEpubAnnotations.suggestedFilename()).toBe(
    'Omnia EPUB Fixture-highlights-and-notes.md',
  );
  const downloadedEpubAnnotationPath = await downloadedEpubAnnotations.path();
  expect(downloadedEpubAnnotationPath).not.toBeNull();
  const epubAnnotationMarkdown = await readFile(
    downloadedEpubAnnotationPath as string,
    'utf8',
  );
  expect(epubAnnotationMarkdown).toContain(
    '# Highlights and notes — Omnia EPUB Fixture',
  );
  expect(epubAnnotationMarkdown).toContain('Portable EPUB note.');
  expect(epubAnnotationMarkdown).toContain('**Underline · Bluish green**');
  await page.goBack();
  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByText('Chapter One'),
  ).toBeVisible({ timeout: 20_000 });
  const epubAnnotationMarker = epubFrame.getByRole('button', {
    name: 'Open note: Portable EPUB note.',
  });
  await expect(epubAnnotationMarker).toBeVisible();
  await epubAnnotationMarker.click();
  const epubAnnotationEditor = page.getByTestId('annotation-dashboard');
  await expect(
    epubAnnotationEditor.getByRole('textbox', { name: 'Note' }),
  ).toHaveValue('Portable EPUB note.');
  await epubAnnotationEditor
    .getByRole('textbox', { name: 'Note' })
    .fill('Updated EPUB note.');
  await epubAnnotationEditor
    .getByRole('button', { name: 'Underline', exact: true })
    .click();
  await epubAnnotationEditor
    .getByRole('button', { name: 'Strikethrough', exact: true })
    .click();
  await epubAnnotationEditor
    .getByRole('button', { name: /^Strikethrough color:/ })
    .click();
  await page
    .getByRole('button', { name: 'Purple strikethrough color' })
    .click();
  await epubAnnotationEditor
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(epubAnnotationEditor).toBeHidden();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('Updated EPUB note.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  const updatedEpubAnnotationMarker = epubFrame.getByRole('button', {
    name: 'Open note: Updated EPUB note.',
  });
  await expect(updatedEpubAnnotationMarker).toBeVisible();
  await updatedEpubAnnotationMarker.click();
  await epubAnnotationEditor
    .getByRole('button', { name: 'Delete annotation' })
    .click();
  await expect(epubAnnotationEditor).toBeHidden();
  await expect(updatedEpubAnnotationMarker).toHaveCount(0);
  const epubAnnotationStatus = page.getByTestId('annotation-status');
  await expect(epubAnnotationStatus).toContainText('Annotation deleted.');
  await epubAnnotationStatus.getByRole('button', { name: 'Undo' }).click();
  await expect(epubAnnotationStatus).toContainText('Annotation restored.');
  await expect(updatedEpubAnnotationMarker).toBeVisible();
  await updatedEpubAnnotationMarker.click();
  await epubAnnotationEditor
    .getByRole('button', { name: 'Delete annotation' })
    .click();
  await expect(epubAnnotationEditor).toBeHidden();
  await expect(updatedEpubAnnotationMarker).toHaveCount(0);
  await epubAnnotationStatus
    .getByRole('button', { name: 'Dismiss annotation message' })
    .click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('No annotations yet.')).toBeVisible();
  await page.goBack();
  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();
  await expect(page.getByText('No annotations yet.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle highlights and notes' })
    .click();

  const finalEpubFrame = page
    .getByTestId('publication-viewport')
    .locator('iframe');
  const finalEpubBody = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('body');
  const initialEpubFontSize = await finalEpubBody.evaluate(
    (body) => getComputedStyle(body).fontSize,
  );
  const epubZoomInPrevented = await finalEpubFrame.evaluate((frame) => {
    const readerWindow = frame.ownerDocument.defaultView;
    if (!readerWindow) {
      throw new Error('Reader window is unavailable');
    }
    return !frame.dispatchEvent(
      new readerWindow.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -120,
      }),
    );
  });
  expect(epubZoomInPrevented).toBe(true);
  await expect
    .poll(() => storedPreference<number>(page, 'epub', 'fontSizePercent'))
    .toBe(105);
  await expect(page.getByTestId('reader-zoom-indicator')).toHaveText('105%');
  await expect
    .poll(() =>
      finalEpubBody.evaluate((body) => getComputedStyle(body).fontSize),
    )
    .not.toBe(initialEpubFontSize);
  const epubZoomOutPrevented = await finalEpubFrame.evaluate((frame) => {
    const readerWindow = frame.ownerDocument.defaultView;
    if (!readerWindow) {
      throw new Error('Reader window is unavailable');
    }
    return !frame.dispatchEvent(
      new readerWindow.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: 120,
      }),
    );
  });
  expect(epubZoomOutPrevented).toBe(true);
  await expect
    .poll(() => storedPreference<number>(page, 'epub', 'fontSizePercent'))
    .toBe(100);
  await expect(page.getByTestId('reader-zoom-indicator')).toHaveText('100%');
  await expect(page.getByTestId('reader-zoom-indicator')).toBeHidden({
    timeout: 3_000,
  });
  await expect
    .poll(() =>
      finalEpubBody.evaluate((body) => getComputedStyle(body).fontSize),
    )
    .toBe(initialEpubFontSize);
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
  await libraryFormatButton(page, 'Omnia Fixed RTL Fixture', 'epub').click();

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

  await page.keyboard.press('ArrowUp');
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

  await page.keyboard.press('ArrowUp');
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

test('navigates PDF and EPUB publications with guarded touch swipes', async ({
  page,
  browserName,
}) => {
  // Playwright WebKit cannot synthesize the sandboxed iframe pointer stream;
  // its TouchEvent fallback is covered by the engine and shell unit suites.
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    browserName === 'webkit',
    'Desktop WebKit does not deliver synthetic iframe touch pointers consistently.',
  );
  test.setTimeout(120_000);

  await importPublication(
    page,
    'touch-navigation.pdf',
    'application/pdf',
    createPdfFixture(),
    'Omnia PDF Fixture',
  );
  await libraryFormatButton(page, 'Omnia PDF Fixture', 'pdf').click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible({ timeout: 20_000 });
  const pdfViewport = page.getByTestId('publication-viewport');
  await expect(
    dispatchTouchSwipe(pdfViewport, { x: 220, y: 120 }, { x: 70, y: 124 }),
  ).resolves.toBe(true);
  await expectReaderPage(page, 2, 2);
  await dispatchTouchSwipe(pdfViewport, { x: 70, y: 120 }, { x: 220, y: 124 });
  await expectReaderPage(page, 1, 2);
  await expect(
    dispatchTouchSwipe(pdfViewport, { x: 180, y: 80 }, { x: 170, y: 220 }),
  ).resolves.toBe(false);
  await expectReaderPage(page, 1, 2);
  const pdfInput = page.locator(
    '.pdfViewer .page[data-page-number="1"] .annotationLayer input[type="text"]',
  );
  await expect(pdfInput).toBeVisible();
  await expect(
    dispatchTouchSwipe(pdfInput, { x: 220, y: 120 }, { x: 70, y: 124 }),
  ).resolves.toBe(false);
  await expectReaderPage(page, 1, 2);

  await page.goBack();
  await importPublication(
    page,
    'touch-navigation.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );
  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  const epubFrame = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe');
  await expect(
    epubFrame.getByRole('heading', { name: 'Chapter One', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  const epubProgression = await storedProgression(page);
  await expect(
    dispatchTouchSwipe(
      epubFrame.locator('body'),
      { x: 220, y: 120 },
      { x: 70, y: 124 },
    ),
  ).resolves.toBe(true);
  await expect
    .poll(() => storedProgression(page))
    .toBeGreaterThan(epubProgression);
  const epubProgressionAfterNext = await storedProgression(page);
  await dispatchTouchSwipe(
    epubFrame.locator('body'),
    { x: 70, y: 120 },
    { x: 220, y: 124 },
  );
  await expect
    .poll(() => storedProgression(page))
    .toBeLessThan(epubProgressionAfterNext);
  const epubProgressionAfterPrevious = await storedProgression(page);
  await expect(
    dispatchTouchSwipe(
      epubFrame.locator('body'),
      { x: 180, y: 80 },
      { x: 170, y: 220 },
    ),
  ).resolves.toBe(false);
  await expect
    .poll(() => storedProgression(page))
    .toBeCloseTo(epubProgressionAfterPrevious, 6);

  await page.goBack();
  await importPublication(
    page,
    'touch-navigation-rtl.epub',
    'application/epub+zip',
    await createFixedLayoutRtlEpubFixture(),
    'Omnia Fixed RTL Fixture',
  );
  await libraryFormatButton(page, 'Omnia Fixed RTL Fixture', 'epub').click();
  const rtlViewport = page.getByTestId('publication-viewport');
  let rtlFrame = rtlViewport.frameLocator('iframe');
  await expect(
    rtlFrame.getByText('Fixed RTL Page One', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Opening publication…')).toHaveCount(0);
  await expect(
    dispatchTouchSwipe(
      rtlFrame.locator('body'),
      { x: 70, y: 120 },
      { x: 220, y: 124 },
    ),
  ).resolves.toBe(true);
  rtlFrame = rtlViewport.frameLocator('iframe');
  await expect(
    rtlFrame.getByText('Fixed RTL Page Two', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await dispatchTouchSwipe(
    rtlFrame.locator('body'),
    { x: 220, y: 120 },
    { x: 70, y: 124 },
  );
  rtlFrame = rtlViewport.frameLocator('iframe');
  await expect(
    rtlFrame.getByText('Fixed RTL Page One', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
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

async function expectDownloadedBytes(
  download: import('@playwright/test').Download,
  expected: Buffer,
): Promise<void> {
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path as string)).toEqual(expected);
}

async function dispatchTouchSwipe(
  target: import('@playwright/test').Locator,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<boolean> {
  return target.evaluate(
    (element, points) => {
      const pointer = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
      };
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...pointer,
          clientX: points.start.x,
          clientY: points.start.y,
        }),
      );
      return !element.dispatchEvent(
        new PointerEvent('pointerup', {
          ...pointer,
          clientX: points.end.x,
          clientY: points.end.y,
        }),
      );
    },
    { start, end },
  );
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

async function expectReaderPage(
  page: import('@playwright/test').Page,
  current: number,
  total: number,
): Promise<void> {
  await expect(page.getByTestId('reader-page-status')).toHaveText(
    `Page ${current} of ${total}`,
  );
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
    const locatorBeforeMove = JSON.stringify(
      (await storedProgress(page))?.locator ?? null,
    );
    await page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .locator('body')
      .press('ArrowDown');
    await expect
      .poll(
        async () =>
          JSON.stringify((await storedProgress(page))?.locator ?? null),
        { timeout: 5_000 },
      )
      .not.toBe(locatorBeforeMove);
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

async function storedTotalProgression(
  page: import('@playwright/test').Page,
): Promise<number> {
  return (
    (await storedProgress(page))?.locator?.locations?.totalProgression ?? 0
  );
}

type StoredProgressRecord = {
  locator?: {
    href?: string;
    locations?: {
      position?: number;
      progression?: number;
      totalProgression?: number;
    };
  };
};

async function storedProgress(
  page: import('@playwright/test').Page,
): Promise<StoredProgressRecord | null> {
  const routeBookId = currentReaderBookId(page.url());
  return page.evaluate(async (bookId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const progress = await new Promise<StoredProgressRecord | null>(
      (resolve, reject) => {
        const store = database
          .transaction('progress', 'readonly')
          .objectStore('progress');
        const request = (
          bookId ? store.get(bookId) : store.getAll()
        ) as IDBRequest<
          StoredProgressRecord | StoredProgressRecord[] | undefined
        >;
        request.addEventListener('success', () => {
          const result = request.result;
          resolve((Array.isArray(result) ? result[0] : result) ?? null);
        });
        request.addEventListener('error', () => reject(request.error));
      },
    );
    database.close();
    return progress;
  }, routeBookId);
}

function currentReaderBookId(url: string): string | null {
  const match = /^\/reader\/([^/]+)$/.exec(new URL(url).pathname);
  return match ? decodeURIComponent(match[1]) : null;
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

async function installMockReaderFullscreen(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.getByTestId('reader-root').evaluate((root) => {
    let activeFullscreenElement: Element | null = null;
    Object.defineProperty(root.ownerDocument, 'fullscreenElement', {
      configurable: true,
      get: () => activeFullscreenElement,
    });
    Object.defineProperty(root, 'requestFullscreen', {
      configurable: true,
      value: async () => {
        activeFullscreenElement = root;
        root.ownerDocument.dispatchEvent(new Event('fullscreenchange'));
      },
    });
    Object.defineProperty(root.ownerDocument, 'exitFullscreen', {
      configurable: true,
      value: async () => {
        activeFullscreenElement = null;
        root.ownerDocument.dispatchEvent(new Event('fullscreenchange'));
      },
    });
  });
}

function requireVisibleBox(
  box: { x: number; y: number; width: number; height: number } | null,
  label: string,
): { x: number; y: number; width: number; height: number } {
  if (!box) {
    throw new Error(`The ${label} is not visible`);
  }
  return box;
}

async function milestonePercent(milestone: Locator): Promise<number> {
  const label = await requiredAttribute(milestone, 'aria-label');
  const percent = Number(label.match(/\(([\d.]+)%/)?.[1]);
  if (!Number.isFinite(percent)) {
    throw new Error(`The milestone label has no percentage: ${label}`);
  }
  return percent;
}

async function requiredAttribute(
  locator: Locator,
  name: string,
): Promise<string> {
  const value = await locator.getAttribute(name);
  if (value === null) {
    throw new Error(`The element has no ${name} attribute`);
  }
  return value;
}

function libraryFormatButton(
  page: Page,
  title: string,
  format: 'epub' | 'pdf',
): Locator {
  const card = page.getByTestId('library-book').filter({ hasText: title });
  return card.getByRole('button', {
    name: new RegExp(`^${format.toUpperCase()}\\b`),
  });
}

async function expectLibraryFilterResult(
  page: Page,
  cards: Locator,
  count: 0 | 1,
  title?: string,
): Promise<void> {
  await expect(cards).toHaveCount(count);
  await expect(page.getByText(`Showing ${count} of 2 books`)).toBeVisible();
  if (title) {
    await expect(cards.first()).toContainText(title);
  } else {
    await expect(
      page.getByRole('heading', { name: 'No books found' }),
    ).toBeVisible();
  }
}

async function expectProgressFilterResult(
  page: Page,
  cards: Locator,
  progressPercent: number,
  status: 'reading' | 'finished',
): Promise<void> {
  const included =
    status === 'finished' ? progressPercent === 100 : progressPercent < 100;
  await expectLibraryFilterResult(
    page,
    cards,
    included ? 1 : 0,
    included ? 'Omnia EPUB Fixture' : undefined,
  );
}
