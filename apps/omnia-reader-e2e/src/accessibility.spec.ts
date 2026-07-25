import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createEpubFixture, createPdfFixture } from './publication-fixtures';

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

test('library has no automated WCAG A or AA violations', async ({ page }) => {
  test.setTimeout(60_000);
  await importPublication(
    page,
    'omnia-library-accessibility.epub',
    'application/epub+zip',
    await createEpubFixture(),
    'Omnia EPUB Fixture',
  );
  await expectAccessible(page);

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
  await importPublication(
    page,
    'omnia-accessibility.pdf',
    'application/pdf',
    createPdfFixture(),
    'Omnia PDF Fixture',
  );
  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible({ timeout: 20_000 });

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
  await page.getByText('Omnia EPUB Fixture', { exact: true }).click();
  await expect(
    page
      .getByTestId('publication-viewport')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Chapter One', exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await expectAccessible(page, true);
});

async function expectAccessible(
  page: Page,
  excludePublicationContents = false,
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(wcagTags);
  if (excludePublicationContents) {
    // EPUB contents are untrusted author-controlled documents in a
    // script-disabled iframe. This gate owns the reader shell and controls.
    builder = builder.exclude('[data-testid="publication-viewport"] iframe');
  }

  const results = await builder.analyze();
  expect(formatViolations(results.violations)).toEqual([]);
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

function isExpectedSandboxInjectionRejection(message: string): boolean {
  return (
    message.startsWith("Blocked script execution in '") &&
    message.includes(
      "the document's frame is sandboxed and the 'allow-scripts' permission is not set",
    )
  );
}
