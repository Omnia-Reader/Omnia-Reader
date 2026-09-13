import { expect, test } from '@playwright/test';
import {
  expectNewPdfAnnotation,
  preferredPublicationOpenButton,
} from './reader-state-helpers';

test('targets the accessible preferred-format control instead of inert title text', async ({
  page,
}) => {
  const title = 'A title with (punctuation) [and symbols]';
  await page.setContent(`
    <article>
      <h2>${title}</h2>
      <button type="button" aria-label="Open ${title} in its preferred format">
        Cover
      </button>
    </article>
  `);

  const openButton = preferredPublicationOpenButton(page, title);

  await expect(openButton).toHaveCount(1);
  await expect(openButton).toHaveAccessibleName(
    `Open ${title} in its preferred format`,
  );
});

test('waits for a new PDF annotation on the requested page and accepts multiple rectangles', async ({
  page,
}) => {
  await page.setContent(`<div class="pdfViewer">
    <div class="page" data-page-number="1">
      <i data-omnia-annotation-id="old" data-omnia-annotation-style="highlight"></i>
      <i data-omnia-annotation-id="old" data-omnia-annotation-style="highlight"></i>
      <i data-omnia-annotation-id="wrong-style" data-omnia-annotation-style="underline"></i>
    </div>
    <div class="page" data-page-number="2">
      <i data-omnia-annotation-id="wrong-page" data-omnia-annotation-style="highlight"></i>
    </div>
  </div>`);
  await page.evaluate(() => {
    setTimeout(() => {
      document
        .querySelector('.page')
        ?.insertAdjacentHTML(
          'beforeend',
          '<i data-omnia-annotation-id="new" data-omnia-annotation-style="highlight"></i>'.repeat(
            2,
          ),
        );
    }, 500);
  });
  await expectNewPdfAnnotation(page, 1, 'highlight', ['old']);
  // An immediate count catches helpers that mistakenly accept the old marks.
  expect(await page.locator('[data-omnia-annotation-id="new"]').count()).toBe(
    2,
  );
});
