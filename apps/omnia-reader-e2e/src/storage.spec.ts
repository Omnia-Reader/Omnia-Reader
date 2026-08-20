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

test('REC-add-post-commit-pre-journal keeps durable outbox work across reload', async ({
  page,
}) => {
  await page.goto('/');
  await importPublication(page, {
    name: 'post-commit-add.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
  });
  await interruptNextLogicalJournalHandoff(page);
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'post-commit-add.pdf',
    mimeType: 'application/pdf',
    buffer: await createPdfFixture(),
  });
  await expect(page.getByRole('button', { name: /^PDF\b/ })).toBeVisible();
  await expectDurableOutboxChange(page, 'add-variant');
});

test('REC-associate-post-commit-pre-journal keeps durable outbox work across reload', async ({
  page,
}) => {
  await page.goto('/');
  await importPublication(page, {
    name: 'post-commit-associate.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
  });
  const pdf = await createPdfFixture();
  await importPublication(page, {
    name: 'post-commit-associate.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  const epubCard = page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia EPUB Fixture' });
  const chooser = page.waitForEvent('filechooser');
  await epubCard
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'post-commit-associate-copy.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  const dialog = page.getByRole('dialog', {
    name: 'Associate an existing book',
  });
  await dialog.getByRole('radio').check();
  await interruptNextLogicalJournalHandoff(page);
  await dialog.getByRole('button', { name: 'Associate books' }).click();
  await expect(page.getByTestId('library-book')).toHaveCount(1);
  await expectDurableOutboxChange(page, 'associate');
});

test('REC-detach-post-commit-pre-journal keeps durable outbox work across reload', async ({
  page,
}) => {
  const card = await prepareTwoFormatBook(page);
  await card
    .getByRole('button', { name: 'Separate PDF from Omnia EPUB Fixture' })
    .click();
  await interruptNextLogicalJournalHandoff(page);
  await page
    .getByRole('dialog', { name: 'Separate the PDF version?' })
    .getByRole('button', { name: 'Separate format' })
    .click();
  await expect(page.getByTestId('library-book')).toHaveCount(2);
  await expectDurableOutboxChange(page, 'detach');
});

test('REC-delete-non-last-post-commit-pre-journal keeps durable outbox work across reload', async ({
  page,
}) => {
  const card = await prepareTwoFormatBook(page);
  await card
    .getByRole('button', { name: 'Remove PDF for Omnia EPUB Fixture' })
    .click();
  await interruptNextLogicalJournalHandoff(page);
  await page
    .getByRole('dialog', {
      name: 'Remove the PDF version of “Omnia PDF Fixture”?',
    })
    .getByRole('button', { name: 'Remove book' })
    .click();
  await expect(page.getByTestId('library-status')).toContainText(
    '“Omnia PDF Fixture” removed',
  );
  await expect(card.getByRole('button', { name: /^PDF\b/ })).toHaveCount(0);
  await expectDurableOutboxChange(page, 'delete-variant');
});

test('REC-preference-change-post-commit-pre-journal keeps durable outbox work across reload', async ({
  page,
}) => {
  const card = await prepareTwoFormatBook(page);
  await interruptNextLogicalJournalHandoff(page);
  await card.getByRole('button', { name: /^PDF\b/ }).click();
  await expect(
    page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
  ).toBeVisible();
  await expectDurableOutboxChange(page, 'preference');
});

test('REC-exact-source-replacement-post-commit-pre-journal commits without logical outbox work', async ({
  page,
}) => {
  const { replace } = await prepareUnavailablePdf(page);
  const before = await logicalOutbox(page);
  const chooser = page.waitForEvent('filechooser');
  await replace.click();
  await (
    await chooser
  ).setFiles({
    name: 'replacement-source.pdf',
    mimeType: 'application/pdf',
    buffer: await createPdfFixture(),
  });
  await expect(page.getByRole('status')).toContainText(
    'restored from this device',
  );
  expect(await logicalOutbox(page)).toEqual(before);
  await page.reload();
  expect(await logicalOutbox(page)).toEqual(before);
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

test('cancels association of an exact duplicate owned by another entry without canonical changes', async ({
  page,
}) => {
  await page.goto('/');
  await importPublication(page, {
    name: 'duplicate-elsewhere.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
  });
  const pdf = await createPdfFixture();
  await importPublication(page, {
    name: 'duplicate-elsewhere.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await expect(page.getByTestId('library-book')).toHaveCount(2);
  const inventoryBeforeAssociation = await canonicalRecoveryInventory(page);

  const epubCard = page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia EPUB Fixture' });
  const chooser = page.waitForEvent('filechooser');
  await epubCard
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'duplicate-elsewhere-copy.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  const dialog = page.getByRole('dialog', {
    name: 'Associate an existing book',
  });
  await expect(dialog).toContainText('Omnia PDF Fixture');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('library-book')).toHaveCount(2);

  const inventoryAfterCancellation = await canonicalRecoveryInventory(page);
  expect(inventoryAfterCancellation).toEqual(inventoryBeforeAssociation);
});

test('rejects a stale add when another page fills the format slot without canonical changes', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await importPublication(page, {
    name: 'occupied-format.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
  });
  const staleChooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();

  const competingPage = await context.newPage();
  await competingPage.goto('/');
  const acceptedPdf = await createPdfFixture();
  const competingChooser = competingPage.waitForEvent('filechooser');
  await competingPage
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await competingChooser
  ).setFiles({
    name: 'accepted-format.pdf',
    mimeType: 'application/pdf',
    buffer: acceptedPdf,
  });
  await expect(
    competingPage.getByRole('button', { name: /^PDF\b/ }),
  ).toBeVisible();
  const inventoryBeforeRejection =
    await canonicalRecoveryInventory(competingPage);

  await (
    await staleChooser
  ).setFiles({
    name: 'stale-format.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.concat([
      acceptedPdf,
      Buffer.from('\n% distinct occupied-slot edition\n'),
    ]),
  });
  await expect(page.getByRole('alert')).toContainText(
    '“Omnia EPUB Fixture” already has a PDF source in that format slot.',
  );
  await expect(page.getByTestId('library-book')).toHaveCount(1);

  const inventoryAfterRejection = await canonicalRecoveryInventory(page);
  expect(inventoryAfterRejection).toEqual(inventoryBeforeRejection);
});

test('cancels the add-format picker without changing canonical inventory', async ({
  page,
}) => {
  await page.goto('/');
  await importPublication(page, {
    name: 'picker-cancelled.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
  });
  await expect(
    page.getByText('Omnia EPUB Fixture', { exact: true }),
  ).toBeVisible();
  const inventoryBeforeCancellation = await canonicalRecoveryInventory(page);

  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (await chooser).setFiles([]);
  await expect(
    page.getByRole('status').filter({
      hasText: 'Adding a format to “Omnia EPUB Fixture” was cancelled.',
    }),
  ).toBeVisible();

  const inventoryAfterCancellation = await canonicalRecoveryInventory(page);
  expect(inventoryAfterCancellation).toEqual(inventoryBeforeCancellation);
});

test('cancels separating a format without changing canonical inventory', async ({
  page,
}) => {
  const card = await prepareTwoFormatBook(page);
  const inventoryBeforeCancellation = await canonicalRecoveryInventory(page);

  await card
    .getByRole('button', {
      name: 'Separate PDF from Omnia EPUB Fixture',
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Separate the PDF version?',
  });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^PDF\b/ })).toBeVisible();

  const inventoryAfterCancellation = await canonicalRecoveryInventory(page);
  expect(inventoryAfterCancellation).toEqual(inventoryBeforeCancellation);
});

test('cancels removing a non-last format without changing canonical inventory', async ({
  page,
}) => {
  const card = await prepareTwoFormatBook(page);
  const inventoryBeforeCancellation = await canonicalRecoveryInventory(page);

  await card
    .getByRole('button', {
      name: 'Remove PDF for Omnia EPUB Fixture',
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Remove the PDF version of “Omnia PDF Fixture”?',
  });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^PDF\b/ })).toBeVisible();

  const inventoryAfterCancellation = await canonicalRecoveryInventory(page);
  expect(inventoryAfterCancellation).toEqual(inventoryBeforeCancellation);
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

async function prepareTwoFormatBook(page: Page): Promise<Locator> {
  await page.goto('/');
  await importPublication(page, {
    name: 'cancellation.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
  });
  const card = page
    .getByTestId('library-book')
    .filter({ hasText: 'Omnia EPUB Fixture' });
  const chooser = page.waitForEvent('filechooser');
  await card
    .getByRole('button', { name: 'Add PDF for Omnia EPUB Fixture' })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'cancellation.pdf',
    mimeType: 'application/pdf',
    buffer: await createPdfFixture(),
  });
  await expect(card.getByRole('button', { name: /^PDF\b/ })).toBeVisible();
  return card;
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

async function interruptNextLogicalJournalHandoff(page: Page): Promise<void> {
  await page.addInitScript(blockLogicalOutboxAcknowledgement);
  await page.evaluate(blockLogicalOutboxAcknowledgement);
}

function blockLogicalOutboxAcknowledgement(): void {
  const state = window as unknown as Record<string, unknown>;
  if (state['__omniaOutboxDeleteBlocked']) return;
  const prototype = IDBObjectStore.prototype;
  const original = prototype.delete;
  state['__omniaOutboxDeleteBlocked'] = true;
  state['__omniaOutboxDeleteIntercepted'] = false;
  prototype.delete = function (
    this: IDBObjectStore,
    query: IDBValidKey | IDBKeyRange,
  ): IDBRequest<undefined> {
    const request = original.call(this, query);
    if (this.name === 'logicalBookChangeOutbox') {
      state['__omniaOutboxDeleteIntercepted'] = true;
      this.transaction.abort();
    }
    return request;
  };
}

async function expectDurableOutboxChange(
  page: Page,
  kind: string,
): Promise<void> {
  const beforeReload = await logicalOutbox(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>)[
          '__omniaOutboxDeleteIntercepted'
        ],
    ),
  ).toBe(true);
  expect(beforeReload).toEqual([
    expect.objectContaining({ kind, changeId: expect.any(String) }),
  ]);
  await page.reload();
  expect(await logicalOutbox(page)).toEqual(beforeReload);
}

async function logicalOutbox(page: Page): Promise<unknown[]> {
  const inventory = await canonicalRecoveryInventory(page);
  const pending = inventory['pendingJournalOperations'] as {
    logicalChangeOutbox?: unknown[];
  };
  return pending.logicalChangeOutbox ?? [];
}
