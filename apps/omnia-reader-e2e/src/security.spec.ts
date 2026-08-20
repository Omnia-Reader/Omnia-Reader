import { expect, test } from '@playwright/test';
import { createScriptActionPdfFixture } from './publication-fixtures';

test('keeps PDF document JavaScript inert while rendering the publication', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, '__omniaPdfScriptExecuted', {
      configurable: true,
      writable: true,
      value: false,
    });
  });
  await page.goto('/');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'script-action.pdf',
    mimeType: 'application/pdf',
    buffer: createScriptActionPdfFixture(),
  });

  const card = page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia Script Action PDF Fixture' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /^PDF\b/ }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __omniaPdfScriptExecuted?: boolean;
            }
          ).__omniaPdfScriptExecuted,
      ),
    )
    .toBe(false);
});
