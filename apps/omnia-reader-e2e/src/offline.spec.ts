import { expect, test } from '@playwright/test';
import { createPdfFixture } from './publication-fixtures';

// This suite intentionally remains opt-in because Angular only registers its
// service worker in a production build served from a secure origin.
// eslint-disable-next-line playwright/no-skipped-test
test.skip(
  process.env['PWA_E2E'] !== '1',
  'Run against the production service-worker build with PWA_E2E=1',
);

test('reopens a stored publication while fully offline', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'offline-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: createPdfFixture(),
  });

  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  await page.goBack();

  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible();

  await page.getByText('Omnia PDF Fixture', { exact: true }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
});
