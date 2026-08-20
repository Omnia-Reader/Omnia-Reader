import { expect, type Page } from '@playwright/test';
import type { MANAGEMENT_DISTRIBUTIONS } from '../performance/management-branches.mjs';
import { measurePageAction } from '../performance/page-measurement.mjs';
import type { ManagementBranchFixture } from './management-branch-driver';

type ManagementDistribution = (typeof MANAGEMENT_DISTRIBUTIONS)[number];
type SampleFixture = ManagementBranchFixture & {
  ordinal: number;
  title: string;
  logicalBookId: string;
};

export async function runManagementDistributionSample(
  page: Page,
  distribution: ManagementDistribution,
  fixtureInput: ManagementBranchFixture,
): Promise<{ finalResultMs: number }> {
  const fixture = requiredFixture(fixtureInput);
  switch (distribution.id) {
    case 'filter':
      return filterLibrary(page, fixture);
    case 'open-epub':
      return openPublication(page, fixture, 'epub');
    case 'open-pdf':
      return openPublication(page, fixture, 'pdf');
    case 'switch-epub-to-pdf':
      return switchPublication(page, fixture, 'epub', 'pdf');
    case 'switch-pdf-to-epub':
      return switchPublication(page, fixture, 'pdf', 'epub');
  }
  throw new TypeError(`Unsupported management distribution ${distribution.id}`);
}

async function filterLibrary(page: Page, fixture: SampleFixture) {
  const search = await showFixture(page, fixture, false);
  await search.fill('');
  await expect(page.getByTestId('library-book').first()).toBeVisible();
  const measurement = await measurePageAction(
    page,
    {
      activation: { event: 'input', selector: '#library-search' },
      acknowledgement: {
        selector: '#library-result-summary[data-result-count="1"]',
      },
      finalState: {
        selector: '#library-result-summary[data-result-count="1"]',
      },
      timeoutMs: 20_000,
    },
    () => search.fill(fixture.title),
  );
  await expect(page.getByTestId('library-book')).toHaveCount(1);
  await expect(fixtureCard(page, fixture)).toBeVisible();
  return { finalResultMs: measurement.finalResultMs };
}

async function openPublication(
  page: Page,
  fixture: SampleFixture,
  format: 'epub' | 'pdf',
) {
  await showFixture(page, fixture, true);
  const measurement = await measurePageAction(page, openSpec(format), () =>
    fixtureCard(page, fixture)
      .getByRole('button', {
        name: new RegExp(`^${format.toUpperCase()} \\(open\\)`),
      })
      .click(),
  );
  await assertReaderResult(page, format);
  return { finalResultMs: measurement.finalResultMs };
}

async function switchPublication(
  page: Page,
  fixture: SampleFixture,
  from: 'epub' | 'pdf',
  to: 'epub' | 'pdf',
) {
  await ensureReaderFormat(page, fixture, from);
  const measurement = await measurePageAction(page, switchSpec(to), () =>
    formatControl(page, to).click(),
  );
  await assertReaderResult(page, to);
  return { finalResultMs: measurement.finalResultMs };
}

async function ensureReaderFormat(
  page: Page,
  fixture: SampleFixture,
  format: 'epub' | 'pdf',
) {
  if (!page.url().includes('/reader/')) {
    await showFixture(page, fixture, true);
    await fixtureCard(page, fixture)
      .getByRole('button', {
        name: new RegExp(`^${format.toUpperCase()} \\(open\\)`),
      })
      .click();
    await assertReaderResult(page, format);
    return;
  }
  const control = formatControl(page, format);
  if ((await control.getAttribute('aria-pressed')) !== 'true') {
    await control.click();
    await assertReaderResult(page, format);
  }
}

async function showFixture(
  page: Page,
  fixture: SampleFixture,
  requireHealthy: boolean,
) {
  if (!page.url().endsWith('/library')) {
    await page.getByRole('link', { name: 'Library', exact: true }).click();
  }
  const search = page.getByRole('searchbox', { name: 'Search library' });
  await search.fill(fixture.title);
  await expect(page.getByTestId('library-book')).toHaveCount(1);
  await expect(fixtureCard(page, fixture)).toBeVisible();
  if (requireHealthy) {
    await expect(
      fixtureCard(page, fixture).locator(
        '[data-format-badge][aria-label$="(Checking)"]',
      ),
    ).toHaveCount(0, { timeout: 20_000 });
  }
  return search;
}

function openSpec(format: 'epub' | 'pdf') {
  return {
    activation: {
      event: 'click' as const,
      selector: `button[aria-label^="${format.toUpperCase()} (open)"]`,
    },
    acknowledgement: {
      selector: '[aria-live="polite"] .mat-mdc-progress-spinner',
    },
    finalState: rendererSelector(format),
    timeoutMs: 20_000,
  };
}

function switchSpec(format: 'epub' | 'pdf') {
  return {
    activation: {
      event: 'click' as const,
      selector: `[aria-label="Reading format"] button[aria-label^="${format.toUpperCase()}"]`,
    },
    acknowledgement: {
      selector: '[aria-live="polite"] .mat-mdc-progress-spinner',
    },
    finalState: rendererSelector(format),
    timeoutMs: 20_000,
  };
}

function rendererSelector(format: 'epub' | 'pdf') {
  return {
    selector:
      format === 'epub'
        ? '[data-testid="publication-viewport"] iframe'
        : '.pdfViewer .page[data-page-number="1"] canvas',
  };
}

async function assertReaderResult(page: Page, format: 'epub' | 'pdf') {
  await expect(formatControl(page, format)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  if (format === 'epub') {
    await expect(
      page
        .getByTestId('publication-viewport')
        .frameLocator('iframe')
        .getByText('Chapter One'),
    ).toBeVisible();
    await expect(page.locator('.pdfViewer canvas')).toHaveCount(0);
  } else {
    await expect(
      page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
    ).toBeVisible();
    await expect(
      page.getByTestId('publication-viewport').locator('iframe'),
    ).toHaveCount(0);
  }
}

function formatControl(page: Page, format: 'epub' | 'pdf') {
  return page
    .getByRole('group', { name: 'Reading format' })
    .getByRole('button', { name: new RegExp(`^${format.toUpperCase()}\\b`) });
}

function fixtureCard(page: Page, fixture: SampleFixture) {
  return page.locator(
    `[data-testid="library-book"][data-logical-book-id="${fixture.logicalBookId}"]`,
  );
}

function requiredFixture(fixture: ManagementBranchFixture): SampleFixture {
  if (fixture.ordinal === null || !fixture.title || !fixture.logicalBookId) {
    throw new TypeError('The management distribution fixture is incomplete');
  }
  return fixture as SampleFixture;
}
