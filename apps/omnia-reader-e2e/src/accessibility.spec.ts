import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createEncryptedPdfFixture,
  createEpubFixture,
  createPdfFixture,
} from './publication-fixtures';
import { createPdfHighlight } from './reader-state-helpers';

const wcagTags = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
];
const browserFailures = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('console', (message) => {
    if (message.type() === 'error') {
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

test('library has no automated WCAG A or AA violations', async ({ page }) => {
  test.setTimeout(60_000);
  await importPublication(
    page,
    'omnia-library-accessibility.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );
  await libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub').click();
  const progress = page.getByRole('slider', { name: 'Book progress' });
  await expect(progress).toBeVisible({ timeout: 20_000 });
  await progress.fill('50');
  await expect(page.getByTestId('reader-overall-progress')).toHaveText(
    /[4-6]\d% of book/,
  );
  await page.goBack();
  await expect(
    libraryFormatButton(page, 'Omnia EPUB Fixture', 'epub'),
  ).toBeVisible();
  await expectAccessible(page);

  await page
    .getByRole('button', {
      name: 'Remove EPUB for Omnia EPUB Fixture',
    })
    .click();
  const removalDialog = page.getByRole('dialog', {
    name: 'Remove the EPUB version of “Omnia EPUB Fixture”?',
  });
  await expect(removalDialog).toBeVisible();
  await expect(
    removalDialog.getByRole('button', { name: 'Cancel' }),
  ).toBeFocused();
  await expectAccessible(page);
  await removalDialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.getByTestId('library-books')).toHaveAttribute(
    'data-view',
    'list',
  );
  await expectAccessible(page);
});

test('settings has no automated WCAG A or AA violations', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();

  await expectAccessible(page);
});

test('PDF reader shell has no automated WCAG A or AA violations', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await importPublication(
    page,
    'omnia-accessibility.pdf',
    'application/pdf',
    createPdfFixture(),
    'Omnia PDF Fixture',
  );
  await libraryFormatButton(page, 'Omnia PDF Fixture', 'pdf').click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible({ timeout: 20_000 });

  await expectAccessible(page);
  const searchTrigger = page.getByRole('button', {
    name: 'Open publication search',
  });
  await searchTrigger.click();
  await expect(
    page.getByRole('searchbox', { name: 'Search publication' }),
  ).toBeFocused();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Close publication search' }).click();
  await expect(searchTrigger).toBeFocused();

  const firstPage = page.locator('.pdfViewer .page[data-page-number="1"]');
  await firstPage
    .locator('.annotationLayer a[href="https://example.com/omnia-reader-pdf"]')
    .click();
  const externalLinkDialog = page.getByRole('dialog', {
    name: 'Open external link?',
  });
  await expect(externalLinkDialog).toBeVisible();
  await expect(
    externalLinkDialog.getByRole('button', { name: 'Cancel' }),
  ).toBeFocused();
  await expectAccessible(page);
  await externalLinkDialog.getByRole('button', { name: 'Cancel' }).click();

  await createPdfHighlight(page, 1, 'Page One', 'Accessibility note.');
  const savedHighlight = firstPage.locator('[data-omnia-annotation-id]');
  await savedHighlight.evaluate((element) => (element as HTMLElement).click());
  const annotationDashboard = page.getByTestId('annotation-dashboard');
  await expect(
    annotationDashboard.getByRole('textbox', { name: 'Note' }),
  ).toHaveValue('Accessibility note.');
  await expectAccessible(page);
  await page
    .getByTestId('publication-viewport')
    .click({ position: { x: 8, y: 8 } });
  await expect(annotationDashboard).toBeHidden();

  await page.goBack();
  await importPublication(
    page,
    'Encrypted Omnia PDF.pdf',
    'application/pdf',
    createEncryptedPdfFixture(),
    'Encrypted Omnia PDF',
  );
  await libraryFormatButton(page, 'Encrypted Omnia PDF', 'pdf').click();
  const passwordDialog = page.getByRole('dialog', { name: 'Protected PDF' });
  await expect(passwordDialog.getByLabel('Password')).toBeFocused();
  await expectAccessible(page);
});

test('EPUB reader shell has no automated WCAG A or AA violations', async ({
  page,
}) => {
  await importPublication(
    page,
    'omnia-accessibility.epub',
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

  await expectAccessible(page, true);
  const tocTrigger = page.getByRole('button', {
    name: 'Toggle table of contents',
  });
  await tocTrigger.click();
  await expect(
    page.getByRole('complementary', { name: 'Table of contents' }),
  ).toBeFocused();
  await expectAccessible(page, true);
  await page.getByRole('button', { name: 'Close table of contents' }).click();
  await expect(tocTrigger).toBeFocused();
});

async function expectAccessible(
  page: Page,
  excludePublicationContents = false,
): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toBeHidden();
  let builder = new AxeBuilder({ page }).withTags(wcagTags);
  if (excludePublicationContents) {
    // EPUB contents are untrusted author-controlled documents in a
    // script-disabled iframe. This gate owns the reader shell and controls.
    builder = builder.exclude('[data-testid="publication-viewport"] iframe');
  }

  const results = await builder.analyze();
  expect(formatViolations(results.violations)).toEqual([]);
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

function formatViolations(
  violations: readonly {
    id: string;
    impact?: string | null;
    help: string;
    helpUrl: string;
    nodes: readonly {
      target: readonly (string | readonly string[])[];
      failureSummary?: string;
    }[];
  }[],
): string[] {
  return violations.map((violation) => {
    const nodes = violation.nodes
      .map(
        (node) =>
          `${node.target.join(' > ')}: ${node.failureSummary ?? 'failed'}`,
      )
      .join('\n');
    return [
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}`,
      violation.helpUrl,
      nodes,
    ].join('\n');
  });
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
