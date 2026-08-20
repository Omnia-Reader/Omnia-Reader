import { expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import type { MANAGEMENT_BRANCHES } from '../performance/management-branches.mjs';
import { measurePageAction } from '../performance/page-measurement.mjs';

type ManagementBranch = (typeof MANAGEMENT_BRANCHES)[number];

interface FixturePublication {
  record: Record<string, unknown> & {
    id: string;
    fileName: string;
    mediaType: string;
  };
  binary: { bytesBase64: string };
}

export interface ManagementBranchFixture {
  ordinal: number | null;
  title?: string;
  logicalBookId?: string;
  logicalBook?: Record<string, unknown>;
  epub?: FixturePublication;
  pdf?: FixturePublication;
}

export async function runManagementBranchSample(
  page: Page,
  branch: ManagementBranch,
  fixture: ManagementBranchFixture,
  backup: Buffer,
): Promise<{ acknowledgementMs: number; finalResultMs: number }> {
  switch (branch.id) {
    case 'add-local-success':
      return addLocal(page, requiredFixture(fixture), true);
    case 'add-local-failure':
      return addLocal(page, requiredFixture(fixture), false);
    case 'associate-success':
      return associate(page, requiredFixture(fixture), true);
    case 'associate-failure':
      return associate(page, requiredFixture(fixture), false);
    case 'detach-success':
      return detach(page, requiredFixture(fixture), true);
    case 'detach-failure':
      return detach(page, requiredFixture(fixture), false);
    case 'delete-success':
      return remove(page, requiredFixture(fixture), true);
    case 'delete-failure':
      return remove(page, requiredFixture(fixture), false);
    case 'reconcile-success':
      return reconcile(page, requiredFixture(fixture), true);
    case 'reconcile-failure':
      return reconcile(page, requiredFixture(fixture), false);
    case 'replace-success':
      return replace(page, requiredFixture(fixture), true);
    case 'replace-failure':
      return replace(page, requiredFixture(fixture), false);
    case 'restore-success':
      return restore(page, backup, true);
    case 'restore-failure':
      return restore(page, backup, false);
  }
  throw new TypeError(`Unsupported management branch ${branch.id}`);
}

export async function createManagementRestoreBackup(
  fixtureInput: ManagementBranchFixture,
): Promise<Buffer> {
  const fixture = requiredFixture(fixtureInput);
  const archive = new JSZip();
  const date = new Date('2026-08-20T00:00:00.000Z');
  const options = { date, compression: 'STORE', createFolders: false } as const;
  const books = [fixture.epub, fixture.pdf].map(({ record }) => ({
    record,
    path: publicationPath(record.id, record.mediaType),
    sha256: record.id,
  }));
  archive.file(
    'manifest.json',
    JSON.stringify(
      {
        schemaVersion: 4,
        application: 'omnia-reader',
        createdAt: date.toISOString(),
        books,
        progress: [],
        progressDocuments: [],
        preferences: [],
        bookmarks: [],
        annotations: [],
        logicalBooks: [fixture.logicalBook],
        logicalBookPreferences: [],
        membershipReconciliations: [],
        logicalBookCovers: [],
      },
      null,
      2,
    ),
    options,
  );
  for (const publication of [fixture.epub, fixture.pdf]) {
    archive.file(
      publicationPath(publication.record.id, publication.record.mediaType),
      Buffer.from(publication.binary.bytesBase64, 'base64'),
      options,
    );
  }
  return archive.generateAsync({
    type: 'nodebuffer',
    compression: 'STORE',
    platform: 'UNIX',
  });
}

async function addLocal(
  page: Page,
  fixture: RequiredFixture,
  success: boolean,
) {
  await ensureLibrary(page, fixture);
  const button = page.getByRole('button', {
    name: `Add PDF for ${fixture.title}`,
  });
  await expect(button).toBeVisible();
  if (success) {
    expect(
      await storedRecordExists(page, 'binaries', fixture.pdf.record.id),
    ).toBe(false);
  }
  let measurement: { acknowledgementMs: number; finalResultMs: number };
  try {
    measurement = await measurePageAction(
      page,
      {
        activation: { event: 'change', selector: 'input[type="file"]' },
        acknowledgement: {
          selector: success
            ? `button[aria-label="Add PDF for ${fixture.title}"]:disabled`
            : '[data-testid="library-error"]',
        },
        finalState: {
          selector: success
            ? `${cardSelector(fixture.logicalBookId)} [data-format-badge="pdf"][aria-label^="PDF (open)"]`
            : '[data-testid="library-error"]',
        },
        timeoutMs: 20_000,
      },
      async () => {
        const chooserPromise = page.waitForEvent('filechooser');
        await button.click();
        const chooser = await chooserPromise;
        await chooser.setFiles(
          success
            ? publicationFile(fixture.pdf)
            : {
                name: 'invalid-performance.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\ninvalid'),
              },
        );
      },
    );
  } catch (error) {
    const diagnostic = await branchDiagnostic(
      page,
      fixture.logicalBookId,
      fixture.pdf.record.id,
    );
    throw new Error(
      `Add-local ${success ? 'success' : 'failure'} did not reach its measured boundary: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
  if (success) {
    await expect(
      card(page, fixture).getByRole('button', { name: /^PDF \(open\)/ }),
    ).toBeVisible();
  } else {
    await expect(page.getByTestId('library-error')).toBeVisible();
    await expect(button).toBeVisible();
  }
  return measurement;
}

async function associate(
  page: Page,
  fixture: RequiredFixture,
  success: boolean,
) {
  await ensureLibrary(page, fixture);
  const add = page.getByRole('button', {
    name: `Add PDF for ${fixture.title}`,
  });
  const chooserPromise = page.waitForEvent('filechooser');
  await add.click();
  await (await chooserPromise).setFiles(publicationFile(fixture.pdf));
  const dialog = page.getByRole('dialog', {
    name: 'Associate an existing book',
  });
  const candidate = dialog.getByRole('radio').first();
  await candidate.check();
  const restoreStaleCandidate = success
    ? async () => undefined
    : await removeLogicalBook(page, await candidate.inputValue());
  try {
    const measurement = await measurePageAction(
      page,
      {
        activation: {
          event: 'click',
          selector: '[role="dialog"] button[mat-flat-button]',
        },
        acknowledgement: {
          selector: success
            ? `button[aria-label="Add PDF for ${fixture.title}"]:disabled`
            : '[data-testid="library-error"]',
        },
        finalState: {
          selector: success
            ? `${cardSelector(fixture.logicalBookId)} [data-format-badge="pdf"][aria-label^="PDF (open)"]`
            : '[data-testid="library-error"]',
        },
        timeoutMs: 20_000,
      },
      () => dialog.getByRole('button', { name: 'Associate books' }).click(),
    );
    if (success) {
      await expect(
        card(page, fixture).getByRole('button', { name: /^PDF \(open\)/ }),
      ).toBeVisible();
    } else {
      await expect(page.getByTestId('library-error')).toContainText(
        'was not found',
      );
    }
    return measurement;
  } finally {
    await restoreStaleCandidate();
  }
}

async function detach(page: Page, fixture: RequiredFixture, success: boolean) {
  await ensureLibrary(page, fixture);
  const button = card(page, fixture).getByRole('button', {
    name: `Separate PDF from ${fixture.title}`,
  });
  await button.click();
  const dialog = page.getByRole('dialog', {
    name: 'Separate the PDF version?',
  });
  if (!success) await injectIndexedDbFailure(page, 'logicalBooks', 'put');
  try {
    const measurement = await measurePageAction(
      page,
      {
        activation: {
          event: 'click',
          selector: '[role="dialog"] button[mat-flat-button]',
        },
        acknowledgement: {
          selector: success
            ? '[data-testid="library-status"]'
            : '[data-testid="library-error"]',
        },
        finalState: {
          selector: success
            ? '[data-testid="library-status"]'
            : '[data-testid="library-error"]',
        },
        timeoutMs: 20_000,
      },
      () => dialog.getByRole('button', { name: 'Separate format' }).click(),
    );
    if (success) {
      await expect(page.getByTestId('library-status')).toContainText(
        'was separated',
      );
    } else {
      await expect(page.getByTestId('library-error')).toBeVisible();
    }
    return measurement;
  } finally {
    await restoreIndexedDbFailure(page);
  }
}

async function remove(page: Page, fixture: RequiredFixture, success: boolean) {
  await ensureLibrary(page, fixture);
  const button = card(page, fixture).getByRole('button', {
    name: `Remove PDF for ${fixture.title}`,
  });
  await button.click();
  const dialog = page.getByRole('dialog');
  if (!success) await injectIndexedDbFailure(page, 'books', 'delete');
  try {
    const measurement = await measurePageAction(
      page,
      {
        activation: {
          event: 'click',
          selector: '[role="dialog"] button[mat-button]',
        },
        acknowledgement: {
          selector: success
            ? '[data-testid="library-status"]'
            : '[data-testid="library-error"]',
        },
        finalState: {
          selector: success
            ? '[data-testid="library-status"]'
            : '[data-testid="library-error"]',
        },
        timeoutMs: 20_000,
      },
      () => dialog.getByRole('button', { name: 'Remove book' }).click(),
    );
    if (success) {
      await expect(page.getByTestId('library-status')).toContainText('removed');
      await expect(
        card(page, fixture).getByRole('button', { name: /^PDF\b/ }),
      ).toHaveCount(0);
    } else {
      await expect(page.getByTestId('library-error')).toBeVisible();
    }
    return measurement;
  } finally {
    await restoreIndexedDbFailure(page);
  }
}

async function reconcile(
  page: Page,
  fixture: RequiredFixture,
  success: boolean,
) {
  await ensureLibrary(page, fixture);
  const conflictId = `conflict:performance:${String(fixture.ordinal).padStart(4, '0')}`;
  const reviewIndex = await reconciliationReviewIndex(page, conflictId);
  const review = page.getByRole('button', {
    name: `Review format grouping conflict ${reviewIndex}`,
    exact: true,
  });
  await review.click();
  const dialog = page.getByRole('dialog', {
    name: 'Review conflicting book formats',
  });
  if (!success) {
    await updateReconciliationStatus(page, conflictId, 'resolved');
  }
  const measurement = await measurePageAction(
    page,
    {
      activation: {
        event: 'click',
        selector: '[role="dialog"] button[mat-flat-button]',
      },
      acknowledgement: {
        selector: success
          ? '[data-testid="library-status"]'
          : '[data-testid="library-error"]',
      },
      finalState: {
        selector: success
          ? '[data-testid="library-status"]'
          : '[data-testid="library-error"]',
      },
      timeoutMs: 20_000,
    },
    () => dialog.getByRole('button', { name: 'Keep current grouping' }).click(),
  );
  if (success) {
    await expect(page.getByTestId('library-status')).toContainText('resolved');
  } else {
    await expect(page.getByTestId('library-error')).toContainText(
      'no longer open',
    );
    await updateReconciliationStatus(page, conflictId, 'open');
  }
  return measurement;
}

async function replace(page: Page, fixture: RequiredFixture, success: boolean) {
  await ensureLibrary(page, fixture);
  const button = page.getByRole('button', {
    name: `Replace EPUB for ${fixture.title} from this device`,
  });
  const measurement = await measurePageAction(
    page,
    {
      activation: { event: 'change', selector: 'input[type="file"]' },
      acknowledgement: {
        selector: success
          ? '[data-testid="library-status"]'
          : '[data-testid="library-error"]',
      },
      finalState: {
        selector: success
          ? '[data-testid="library-status"]'
          : '[data-testid="library-error"]',
      },
      timeoutMs: 20_000,
    },
    async () => {
      const chooserPromise = page.waitForEvent('filechooser');
      await button.click();
      const chooser = await chooserPromise;
      await chooser.setFiles(
        success
          ? publicationFile(fixture.epub)
          : {
              ...publicationFile(fixture.pdf),
              name: 'mismatched-performance.epub',
              mimeType: 'application/epub+zip',
            },
      );
    },
  );
  if (success) {
    await expect(page.getByTestId('library-status')).toContainText(
      'restored from this device',
    );
  } else {
    await expect(page.getByTestId('library-error')).toBeVisible();
  }
  return measurement;
}

async function restore(page: Page, backup: Buffer, success: boolean) {
  if (!page.url().endsWith('/settings')) {
    await page.getByRole('link', { name: 'Settings' }).click();
  }
  let measurement: { acknowledgementMs: number; finalResultMs: number };
  try {
    measurement = await measurePageAction(
      page,
      {
        activation: { event: 'change', selector: '#backup-archive-input' },
        acknowledgement: {
          selector: success
            ? '[data-testid="backup-progress"]'
            : '[data-testid="backup-error"]',
        },
        finalState: {
          selector: success
            ? '[data-testid="backup-status"]'
            : '[data-testid="backup-error"]',
        },
        timeoutMs: 60_000,
      },
      () =>
        page.locator('#backup-archive-input').setInputFiles({
          name: success ? 'performance.omnia-backup' : 'invalid.omnia-backup',
          mimeType: 'application/vnd.omnia-reader.backup+zip',
          buffer: success ? backup : Buffer.from('not a backup'),
        }),
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      progress:
        document
          .querySelector('[data-testid="backup-progress"]')
          ?.textContent?.trim() ?? null,
      status:
        document
          .querySelector('[data-testid="backup-status"]')
          ?.textContent?.trim() ?? null,
      error:
        document
          .querySelector('[data-testid="backup-error"]')
          ?.textContent?.trim() ?? null,
    }));
    throw new Error(
      `Restore ${success ? 'success' : 'failure'} did not reach its measured boundary: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
  if (success) {
    await expect(page.getByTestId('backup-status')).toContainText(
      'Backup restored:',
    );
  } else {
    await expect(page.getByTestId('backup-error')).toBeVisible();
  }
  return measurement;
}

type RequiredFixture = ManagementBranchFixture & {
  ordinal: number;
  title: string;
  logicalBookId: string;
  logicalBook: Record<string, unknown>;
  epub: FixturePublication;
  pdf: FixturePublication;
};

function requiredFixture(fixture: ManagementBranchFixture): RequiredFixture {
  if (
    fixture.ordinal === null ||
    !fixture.title ||
    !fixture.logicalBookId ||
    !fixture.logicalBook ||
    !fixture.epub ||
    !fixture.pdf
  ) {
    throw new TypeError('The management branch fixture is incomplete');
  }
  return fixture as RequiredFixture;
}

function publicationPath(bookId: string, mediaType: string): string {
  const format = mediaType === 'application/pdf' ? 'pdf' : 'epub';
  return `books/${bookId.slice('sha256:'.length)}.${format}`;
}

function publicationFile(publication: FixturePublication) {
  return {
    name: publication.record.fileName,
    mimeType: publication.record.mediaType,
    buffer: Buffer.from(publication.binary.bytesBase64, 'base64'),
  };
}

function card(page: Page, fixture: RequiredFixture) {
  return page.locator(cardSelector(fixture.logicalBookId));
}

function cardSelector(logicalBookId: string): string {
  return `[data-testid="library-book"][data-logical-book-id="${logicalBookId}"]`;
}

async function branchDiagnostic(
  page: Page,
  logicalBookId: string,
  variantId: string,
) {
  return page.evaluate(
    async ({ selector, variantId }) => {
      const text = (query: string) =>
        document.querySelector(query)?.textContent?.trim().slice(0, 512) ??
        null;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('omnia-reader', 9);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      const read = (storeName: string) =>
        new Promise<unknown>((resolve, reject) => {
          const request = database
            .transaction(storeName, 'readonly')
            .objectStore(storeName)
            .get(variantId);
          request.addEventListener('success', () => resolve(request.result));
          request.addEventListener('error', () => reject(request.error));
        });
      const owner = new Promise<unknown>((resolve, reject) => {
        const request = database
          .transaction('logicalBooks', 'readonly')
          .objectStore('logicalBooks')
          .index('pdfVariantId')
          .get(variantId);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      const [book, binary, cover, logicalOwner] = await Promise.all([
        read('books'),
        read('binaries'),
        read('covers'),
        owner,
      ]);
      database.close();
      return {
        url: location.pathname,
        error: text('[data-testid="library-error"]'),
        status: text('[data-testid="library-status"]'),
        card: text(selector),
        badges: [
          ...document.querySelectorAll(`${selector} [data-format-badge]`),
        ]
          .slice(0, 4)
          .map((element) => element.getAttribute('aria-label')),
        storedVariant: {
          book: book !== undefined,
          binary: binary !== undefined,
          binaryStorage:
            typeof binary === 'object' && binary !== null && 'storage' in binary
              ? (binary as { storage: unknown }).storage
              : null,
          cover: cover !== undefined,
          logicalOwner:
            typeof logicalOwner === 'object' && logicalOwner !== null
              ? (logicalOwner as { id?: unknown }).id
              : null,
        },
      };
    },
    { selector: cardSelector(logicalBookId), variantId },
  );
}

async function storedRecordExists(
  page: Page,
  storeName: string,
  key: string,
): Promise<boolean> {
  return page.evaluate(
    async ({ storeName, key }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('omnia-reader', 9);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const request = database
            .transaction(storeName, 'readonly')
            .objectStore(storeName)
            .get(key);
          request.addEventListener('success', () =>
            resolve(request.result !== undefined),
          );
          request.addEventListener('error', () => reject(request.error));
        });
      } finally {
        database.close();
      }
    },
    { storeName, key },
  );
}

async function removeLogicalBook(
  page: Page,
  logicalBookId: string,
): Promise<() => Promise<void>> {
  const record = await page.evaluate(async (id) => {
    const database = await openLibraryDatabase();
    try {
      const transaction = database.transaction('logicalBooks', 'readwrite');
      const store = transaction.objectStore('logicalBooks');
      const value = await requestResult<Record<string, unknown>>(store.get(id));
      if (!value) throw new Error(`Missing logical book ${id}`);
      store.delete(id);
      await transactionComplete(transaction);
      return value;
    } finally {
      database.close();
    }

    function openLibraryDatabase(): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('omnia-reader', 9);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
    }

    function requestResult<Result>(
      request: IDBRequest<Result>,
    ): Promise<Result> {
      return new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
    }

    function transactionComplete(transaction: IDBTransaction): Promise<void> {
      return new Promise((resolve, reject) => {
        transaction.addEventListener('complete', () => resolve());
        transaction.addEventListener('error', () => reject(transaction.error));
        transaction.addEventListener('abort', () => reject(transaction.error));
      });
    }
  }, logicalBookId);

  return () =>
    page.evaluate(async (value) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('omnia-reader', 9);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      try {
        const transaction = database.transaction('logicalBooks', 'readwrite');
        transaction.objectStore('logicalBooks').put(value);
        await new Promise<void>((resolve, reject) => {
          transaction.addEventListener('complete', () => resolve());
          transaction.addEventListener('error', () =>
            reject(transaction.error),
          );
          transaction.addEventListener('abort', () =>
            reject(transaction.error),
          );
        });
      } finally {
        database.close();
      }
    }, record);
}

async function ensureLibrary(
  page: Page,
  fixture: RequiredFixture,
): Promise<void> {
  if (!page.url().endsWith('/library')) {
    await page.getByRole('link', { name: 'Library', exact: true }).click();
  }
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Search library' })
    .fill(fixture.title);
  await expect(card(page, fixture)).toBeVisible();
}

async function injectIndexedDbFailure(
  page: Page,
  storeName: string,
  method: 'put' | 'delete',
): Promise<void> {
  await page.evaluate(
    ({ storeName, method }) => {
      const state = window as unknown as Record<string, unknown>;
      const prototype = IDBObjectStore.prototype as unknown as Record<
        string,
        (...arguments_: unknown[]) => IDBRequest
      >;
      const original = prototype[method];
      state['__omniaPerformanceIdbRestore'] = () => {
        prototype[method] = original;
        delete state['__omniaPerformanceIdbRestore'];
      };
      prototype[method] = function (...arguments_: unknown[]) {
        if ((this as unknown as IDBObjectStore).name === storeName) {
          (state['__omniaPerformanceIdbRestore'] as () => void)();
          throw new DOMException(
            'Injected performance transaction failure',
            'AbortError',
          );
        }
        return original.apply(this, arguments_);
      };
    },
    { storeName, method },
  );
}

async function restoreIndexedDbFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as Record<string, unknown>;
    const restore = state['__omniaPerformanceIdbRestore'];
    if (typeof restore === 'function') restore();
  });
}

async function updateReconciliationStatus(
  page: Page,
  conflictId: string,
  status: 'open' | 'resolved',
): Promise<void> {
  await page.evaluate(
    async ({ conflictId, status }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('omnia-reader', 9);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      try {
        const transaction = database.transaction(
          'logicalBookReconciliations',
          'readwrite',
        );
        const store = transaction.objectStore('logicalBookReconciliations');
        const reconciliation = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            const request = store.get(conflictId);
            request.addEventListener('success', () => resolve(request.result));
            request.addEventListener('error', () => reject(request.error));
          },
        );
        store.put(
          status === 'open'
            ? Object.fromEntries(
                Object.entries({ ...reconciliation, status }).filter(
                  ([key]) => key !== 'resolvedByChangeId',
                ),
              )
            : {
                ...reconciliation,
                status,
                resolvedByChangeId: `change:performance-stale:${conflictId}`,
              },
        );
        await new Promise<void>((resolve, reject) => {
          transaction.addEventListener('complete', () => resolve());
          transaction.addEventListener('error', () =>
            reject(transaction.error),
          );
          transaction.addEventListener('abort', () =>
            reject(transaction.error),
          );
        });
      } finally {
        database.close();
      }
    },
    { conflictId, status },
  );
}

async function reconciliationReviewIndex(
  page: Page,
  conflictId: string,
): Promise<number> {
  return page.evaluate(async (targetConflictId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader', 9);
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    try {
      const reconciliations = await new Promise<
        Array<{ conflictId: string; status: string }>
      >((resolve, reject) => {
        const request = database
          .transaction('logicalBookReconciliations', 'readonly')
          .objectStore('logicalBookReconciliations')
          .getAll();
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      const index = reconciliations
        .filter(({ status }) => status === 'open')
        .sort((left, right) => left.conflictId.localeCompare(right.conflictId))
        .findIndex(({ conflictId }) => conflictId === targetConflictId);
      if (index < 0)
        throw new Error(`Missing reconciliation ${targetConflictId}`);
      return index + 1;
    } finally {
      database.close();
    }
  }, conflictId);
}
