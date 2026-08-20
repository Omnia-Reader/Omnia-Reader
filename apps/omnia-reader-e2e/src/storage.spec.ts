import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  canonicalRecoveryInventory,
  clearStoredPublicationBinaries,
} from './canonical-recovery-inventory';
import {
  createEpubFixture,
  createMalformedPdfFixture,
  createPdfFixture,
} from './publication-fixtures';
import {
  assertClosedMatrix,
  canonicalInventoryFields,
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

test('rejects an unsupported text import without changing canonical inventory', async ({
  page,
}) => {
  await page.goto('/');
  const inventoryBeforeRejection = await canonicalRecoveryInventory(page);
  const importChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  await (
    await importChooser
  ).setFiles({
    name: 'unsupported.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a supported publication', 'utf8'),
  });

  await expect(page.getByRole('alert')).toContainText(
    'Unsupported publication "unsupported.txt" (text/plain)',
  );
  await expect(page.getByTestId('library-book')).toHaveCount(0);
  const inventoryAfterRejection = await canonicalRecoveryInventory(page);
  expect(Object.keys(inventoryBeforeRejection).sort()).toEqual(
    [...canonicalInventoryFields].sort(),
  );
  expect(inventoryAfterRejection).toEqual(inventoryBeforeRejection);
});

test('rolls back a corrupt PDF import without changing canonical inventory', async ({
  page,
}) => {
  await page.goto('/');
  const inventoryBeforeRejection = await canonicalRecoveryInventory(page);
  const importChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  await (
    await importChooser
  ).setFiles({
    name: 'corrupt-publication.pdf',
    mimeType: 'application/pdf',
    buffer: createMalformedPdfFixture(),
  });

  await expect(page.getByRole('alert')).toContainText(
    /Could not import.*corrupt-publication\.pdf.*invalid pdf/i,
  );
  await expect(page.getByTestId('library-book')).toHaveCount(0);
  const inventoryAfterRejection = await canonicalRecoveryInventory(page);
  expect(inventoryAfterRejection).toEqual(inventoryBeforeRejection);
});

test('keeps an exact duplicate import canonically unchanged', async ({
  page,
}) => {
  await page.goto('/');
  const publication = await createEpubFixture();
  await importPublication(page, {
    name: 'duplicate-original.epub',
    mimeType: 'application/epub+zip',
    buffer: publication,
  });
  await expect(
    page.getByText('Omnia EPUB Fixture', { exact: true }),
  ).toBeVisible();
  const inventoryBeforeDuplicate = await canonicalRecoveryInventory(page);

  await importPublication(page, {
    name: 'duplicate-copy.epub',
    mimeType: 'application/epub+zip',
    buffer: publication,
  });
  await expect(
    page.getByRole('status').filter({
      hasText: '“Omnia EPUB Fixture” is already in your library.',
    }),
  ).toBeVisible();
  await expect(page.getByTestId('library-book')).toHaveCount(1);
  const inventoryAfterDuplicate = await canonicalRecoveryInventory(page);
  expect(inventoryAfterDuplicate).toEqual(inventoryBeforeDuplicate);
});

test('cancels exact-source replacement without changing canonical inventory', async ({
  page,
}) => {
  const { inventory: inventoryBeforeCancellation, replace } =
    await prepareUnavailablePdf(page);

  const replacementChooser = page.waitForEvent('filechooser');
  await replace.click();
  await (await replacementChooser).setFiles([]);
  await expect(replace).toBeEnabled();

  const inventoryAfterCancellation = await canonicalRecoveryInventory(page);
  expect(Object.keys(inventoryBeforeCancellation).sort()).toEqual(
    [...canonicalInventoryFields].sort(),
  );
  expect(inventoryAfterCancellation).toEqual(inventoryBeforeCancellation);
});

test('rejects a wrong-digest PDF replacement without changing canonical inventory', async ({
  page,
}) => {
  const wrongIdentity = Buffer.from(await createPdfFixture());
  wrongIdentity.writeUInt8(
    wrongIdentity.readUInt8(wrongIdentity.length - 1) ^ 0xff,
    wrongIdentity.length - 1,
  );
  const { after, before } = await rejectPdfReplacement(page, {
    name: 'wrong-digest-replacement.pdf',
    buffer: wrongIdentity,
  });
  expect(after).toEqual(before);
});

test('rejects EPUB content disguised as a PDF replacement without changing canonical inventory', async ({
  page,
}) => {
  const { after, before } = await rejectPdfReplacement(page, {
    name: 'wrong-format-replacement.pdf',
    buffer: await createEpubFixture(),
  });
  expect(after).toEqual(before);
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

async function prepareUnavailablePdf(
  page: Page,
): Promise<{ inventory: Record<string, unknown>; replace: Locator }> {
  await page.goto('/');
  const importChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  await (
    await importChooser
  ).setFiles({
    name: 'replacement-source.pdf',
    mimeType: 'application/pdf',
    buffer: await createPdfFixture(),
  });
  await expect(
    page.getByText('Omnia PDF Fixture', { exact: true }),
  ).toBeVisible();

  await clearStoredPublicationBinaries(page);
  await page.reload();
  const replace = page.getByRole('button', {
    name: 'Replace PDF for Omnia PDF Fixture from this device',
  });
  await expect(replace).toBeVisible();
  const inventory = await canonicalRecoveryInventory(page);
  expect(Object.keys(inventory).sort()).toEqual(
    [...canonicalInventoryFields].sort(),
  );
  return { inventory, replace };
}

async function rejectPdfReplacement(
  page: Page,
  replacement: { name: string; buffer: Buffer },
): Promise<{
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}> {
  const { inventory: before, replace } = await prepareUnavailablePdf(page);
  const replacementChooser = page.waitForEvent('filechooser');
  await replace.click();
  await (
    await replacementChooser
  ).setFiles({
    name: replacement.name,
    mimeType: 'application/pdf',
    buffer: replacement.buffer,
  });
  await expect(page.getByRole('alert')).toContainText(
    'Replacement publication failed exact-source validation',
  );
  await expect(replace).toBeEnabled();
  return { before, after: await canonicalRecoveryInventory(page) };
}

async function importPublication(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  await (await chooser).setFiles(file);
}
