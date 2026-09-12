import { expect, test } from '@playwright/test';
import { preferredPublicationOpenButton } from './reader-state-helpers';

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
