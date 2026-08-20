import { expect, test, type Page } from '@playwright/test';
import {
  assertClosedMatrix,
  recoveryMatrixRows,
  rowsOwnedBy,
} from './recovery-compatibility-matrix';

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

  await page.addInitScript(() => {
    let persisted = false;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: () =>
          Promise.resolve({
            usage: 5 * 1024 * 1024,
            quota: 100 * 1024 * 1024,
          }),
        persisted: () => Promise.resolve(persisted),
        persist: () => {
          persisted = true;
          return Promise.resolve(true);
        },
      },
    });
  });

  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page) ?? []).toEqual([]);
});

test('closes all 30 local, cancellation, and validation recovery rows', async () => {
  assertClosedMatrix(recoveryMatrixRows, 48);
  const rows = rowsOwnedBy(recoveryMatrixRows, 'storage');
  expect(rows).toHaveLength(30);
  expect(
    rows.filter(({ recoveryPoint }) => recoveryPoint === 'cancelled'),
  ).toHaveLength(5);
  expect(
    rows.filter(
      ({ recoveryPoint }) => recoveryPoint === 'validation-rejection',
    ),
  ).toHaveLength(7);
  expect(
    rows.filter(
      ({ recoveryPoint }) => recoveryPoint === 'post-commit-pre-journal',
    ),
  ).toHaveLength(6);
});

test('reports quota and lets the user protect the offline library', async ({
  page,
}) => {
  const storageCard = page.locator('mat-card').filter({
    has: page.getByRole('heading', { name: 'Offline library storage' }),
  });

  await expect(
    storageCard.getByText('Best effort', { exact: true }),
  ).toBeVisible();
  await expect(
    storageCard.getByText('5.0 MiB of 100.0 MiB used'),
  ).toBeVisible();
  await expect(
    storageCard.getByRole('meter', {
      name: 'Offline library storage usage',
    }),
  ).toHaveAttribute('value', '5');

  await storageCard
    .getByRole('button', { name: 'Protect offline library' })
    .click();

  await expect(
    storageCard.getByText('Protected', { exact: true }),
  ).toBeVisible();
  await expect(
    storageCard.getByRole('status').filter({
      hasText: 'Offline library storage is now protected',
    }),
  ).toBeVisible();
  await expect(
    storageCard.getByRole('button', { name: 'Protect offline library' }),
  ).toHaveCount(0);
});
