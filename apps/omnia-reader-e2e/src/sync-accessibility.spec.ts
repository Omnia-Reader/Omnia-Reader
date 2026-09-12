import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const wcagTags = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
];

test.use({
  serviceWorkers: 'block',
  hasTouch: true,
  viewport: { width: 360, height: 800 },
});

test('keeps provider maturity accessible across touch, keyboard, and restart', async ({
  page,
}) => {
  const browserFailures = monitorBrowserFailures(page);
  await page.goto('/settings/sync');

  const git = page.getByTestId('sync-provider-git');
  const mega = page.getByTestId('sync-provider-mega');
  await expect(git).toContainText('Git + LFS');
  await expect(git).toContainText('Experimental');
  await expect(git).toContainText('keep another backup');
  await expect(mega).toContainText('MEGA');
  await expect(mega).toContainText('Experimental');
  await expect(mega).toContainText('keep another backup');

  for (const provider of [git, mega]) {
    const bounds = await provider.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.height).toBeGreaterThanOrEqual(96);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);
    const describedBy = await provider.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const descriptionIds = splitIdReferences(describedBy);
    expect(descriptionIds).toHaveLength(2);
    for (const id of descriptionIds) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  }

  await mega.tap();
  await expect(mega).toHaveClass(/border-violet-600/);
  await expect(git).toBeEnabled();
  await git.focus();
  await expect(git).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(git).toHaveClass(/border-violet-600/);

  await page.reload();
  await expect(git).toHaveClass(/border-violet-600/);
  await expect(git).toContainText('Experimental');
  const toolbar = page.getByTestId('global-sync-status');
  await expect(toolbar).toContainText('Experimental');
  await expect(toolbar).toHaveAttribute('aria-label', /Experimental provider/);
  await expect(toolbar).toHaveAttribute('title', /keep another backup/);

  const accessibility = await new AxeBuilder({ page })
    .withTags(wcagTags)
    .analyze();
  expect(
    accessibility.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map(({ target }) => target.join(' ')),
    })),
  ).toEqual([]);
  expect(browserFailures).toEqual([]);
});

function splitIdReferences(value: string | null): string[] {
  if (value === null) throw new Error('Expected aria-describedby references.');
  return value.split(' ').filter(Boolean);
}

function monitorBrowserFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  return failures;
}
