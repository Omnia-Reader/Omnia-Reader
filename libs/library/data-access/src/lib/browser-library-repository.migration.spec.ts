import 'fake-indexeddb/auto';
import { BrowserLibraryRepository } from './browser-library-repository';

const BOOK = {
  id: `sha256:${'e'.repeat(64)}`,
  format: 'pdf' as const,
  fileName: 'preserved.pdf',
  mediaType: 'application/pdf',
  size: 128,
  title: 'Preserved across migration',
  authors: ['Omnia'],
  importedAt: '2026-07-25T08:00:00.000Z',
};

const EPUB_BOOK = {
  ...BOOK,
  id: `sha256:${'d'.repeat(64)}`,
  format: 'epub' as const,
  fileName: 'preserved.epub',
  mediaType: 'application/epub+zip',
  size: 256,
  title: 'Preserved EPUB across migration',
};

describe('BrowserLibraryRepository schema migration', () => {
  it('COMP-v8-singleton-pdf migrates without rewriting variant state', async () => {
    const databaseName = 'omnia-reader-v8-valid';
    const legacy = await openDatabase(databaseName, 8, (database) => {
      database.createObjectStore('books', { keyPath: 'id' }).put(BOOK);
      database.createObjectStore('binaries', { keyPath: 'bookId' }).put({
        bookId: BOOK.id,
        marker: 'binary-key-unchanged',
      });
      database.createObjectStore('covers', { keyPath: 'bookId' }).put({
        bookId: BOOK.id,
        mediaType: 'image/png',
        bytes: new TextEncoder().encode('legacy cover').buffer,
      });
      database.createObjectStore('progress', { keyPath: 'bookId' }).put({
        bookId: BOOK.id,
        marker: 'progress-key-unchanged',
      });
      database
        .createObjectStore('progressDocuments', {
          keyPath: ['bookId', 'deviceId'],
        })
        .createIndex('bookId', 'bookId');
      database.createObjectStore('preferences', { keyPath: 'format' });
      database
        .createObjectStore('bookmarks', { keyPath: 'id' })
        .createIndex('bookId', 'bookId');
      database
        .createObjectStore('annotations', { keyPath: 'id' })
        .createIndex('bookId', 'bookId');
      database.createObjectStore('quarantine', {
        keyPath: 'id',
        autoIncrement: true,
      });
    });
    legacy.close();

    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      databaseName,
    );

    await expect(repository.listBooks()).resolves.toEqual([BOOK]);
    await expect(repository.listLogicalBooks()).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        id: `logical:sha256:${'e'.repeat(64)}`,
        title: BOOK.title,
        variants: { pdf: BOOK.id },
      }),
    ]);
    await expect(
      repository.getLogicalBookFormatPreference(
        `logical:sha256:${'e'.repeat(64)}`,
      ),
    ).resolves.toBeNull();
    await expect(
      repository.getLogicalBookCover(`logical:sha256:${'e'.repeat(64)}`),
    ).resolves.toEqual(expect.any(Blob));
    await expect(repository.listQuarantinedRecords()).resolves.toEqual([]);
    const migrated = await openDatabase(databaseName);
    expect(migrated.version).toBe(10);
    expect([...migrated.objectStoreNames]).toContain('quarantine');
    expect([...migrated.objectStoreNames]).toContain('progressDocuments');
    expect([...migrated.objectStoreNames]).toContain('logicalBookChangeOutbox');
    expect([...migrated.objectStoreNames]).toEqual(
      expect.arrayContaining([
        'logicalBooks',
        'logicalBookCovers',
        'logicalBookPreferences',
        'logicalBookReconciliations',
      ]),
    );
    const logicalStore = migrated
      .transaction('logicalBooks', 'readonly')
      .objectStore('logicalBooks');
    expect(logicalStore.index('epubVariantId').unique).toBe(true);
    expect(logicalStore.index('pdfVariantId').unique).toBe(true);
    await expect(
      readRecord(migrated, 'binaries', BOOK.id),
    ).resolves.toMatchObject({
      marker: 'binary-key-unchanged',
    });
    await expect(
      readRecord(migrated, 'progress', BOOK.id),
    ).resolves.toMatchObject({
      marker: 'progress-key-unchanged',
    });
    migrated.close();

    await expect(
      new BrowserLibraryRepository(
        undefined,
        undefined,
        databaseName,
      ).listLogicalBooks(),
    ).resolves.toHaveLength(1);
  });

  it.each([
    {
      matrixId: 'COMP-v8-singleton-epub',
      databaseName: 'omnia-reader-v8-epub',
      books: [EPUB_BOOK],
    },
    {
      matrixId: 'COMP-v8-mixed-library',
      databaseName: 'omnia-reader-v8-mixed',
      books: [EPUB_BOOK, BOOK],
    },
  ])(
    '$matrixId preserves exact singleton membership',
    async ({ databaseName, books }) => {
      const legacy = await openDatabase(databaseName, 8, (database) => {
        createLegacyStores(database);
      });
      const transaction = legacy.transaction('books', 'readwrite');
      for (const book of books) {
        transaction.objectStore('books').put(book);
      }
      await transactionComplete(transaction);
      legacy.close();

      const repository = new BrowserLibraryRepository(
        undefined,
        undefined,
        databaseName,
      );

      const migratedBooks = await repository.listBooks();
      expect(migratedBooks).toHaveLength(books.length);
      expect(migratedBooks).toEqual(expect.arrayContaining(books));
      const logicalBooks = await repository.listLogicalBooks();
      expect(logicalBooks).toHaveLength(books.length);
      for (const book of books) {
        expect(logicalBooks).toContainEqual(
          expect.objectContaining({
            id: `logical:${book.id}`,
            variants: { [book.format]: book.id },
          }),
        );
      }
      const migrated = await openDatabase(databaseName);
      expect(migrated.version).toBe(10);
      migrated.close();
    },
  );

  it('quarantines malformed v8 books without inventing membership', async () => {
    const databaseName = 'omnia-reader-v8-malformed';
    const legacy = await openDatabase(databaseName, 8, (database) => {
      database.createObjectStore('books', { keyPath: 'id' }).put({
        id: `sha256:${'f'.repeat(64)}`,
        format: 'script',
        title: 'Malformed',
      });
      for (const [name, keyPath] of [
        ['binaries', 'bookId'],
        ['covers', 'bookId'],
        ['progress', 'bookId'],
        ['preferences', 'format'],
      ] as const) {
        database.createObjectStore(name, { keyPath });
      }
      database
        .createObjectStore('progressDocuments', {
          keyPath: ['bookId', 'deviceId'],
        })
        .createIndex('bookId', 'bookId');
      database
        .createObjectStore('bookmarks', { keyPath: 'id' })
        .createIndex('bookId', 'bookId');
      database
        .createObjectStore('annotations', { keyPath: 'id' })
        .createIndex('bookId', 'bookId');
      database.createObjectStore('quarantine', {
        keyPath: 'id',
        autoIncrement: true,
      });
    });
    legacy.close();

    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      databaseName,
    );
    await expect(repository.listLogicalBooks()).resolves.toEqual([]);
    await expect(repository.listQuarantinedRecords()).resolves.toEqual([
      expect.objectContaining({ storeName: 'books' }),
    ]);
  });

  it('leaves v8 intact after an aborted upgrade and migrates on retry', async () => {
    const databaseName = 'omnia-reader-v8-abort-retry';
    const legacy = await openDatabase(databaseName, 8, (database) => {
      createLegacyStores(database);
    });
    legacy.close();
    const seeded = await openDatabase(databaseName);
    const seedTransaction = seeded.transaction('books', 'readwrite');
    seedTransaction.objectStore('books').put(BOOK);
    await transactionComplete(seedTransaction);
    seeded.close();

    await expect(abortUpgrade(databaseName, 9)).rejects.toBeTruthy();
    const unchanged = await openDatabase(databaseName);
    expect(unchanged.version).toBe(8);
    expect([...unchanged.objectStoreNames]).not.toContain('logicalBooks');
    unchanged.close();

    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      databaseName,
    );
    await expect(repository.listLogicalBooks()).resolves.toEqual([
      expect.objectContaining({ variants: { pdf: BOOK.id } }),
    ]);
  });

  it('migrates v9 logical state to the durable v10 change outbox without rewriting it', async () => {
    const databaseName = 'omnia-reader-v9-outbox';
    const logicalBook = {
      schemaVersion: 1 as const,
      id: `logical:sha256:${'e'.repeat(64)}` as const,
      title: BOOK.title,
      authors: BOOK.authors,
      importedAt: BOOK.importedAt,
      updatedAt: BOOK.importedAt,
      coverState: 'unavailable' as const,
      variants: { pdf: BOOK.id },
    };
    const versionNine = await openDatabase(databaseName, 9, (database) => {
      createLegacyStores(database);
      const logicalBooks = database.createObjectStore('logicalBooks', {
        keyPath: 'id',
      });
      logicalBooks.createIndex('epubVariantId', 'variants.epub', {
        unique: true,
      });
      logicalBooks.createIndex('pdfVariantId', 'variants.pdf', {
        unique: true,
      });
      logicalBooks.put(logicalBook);
      database.createObjectStore('logicalBookCovers', {
        keyPath: 'logicalBookId',
      });
      database.createObjectStore('logicalBookPreferences', {
        keyPath: 'logicalBookId',
      });
      database.createObjectStore('logicalBookReconciliations', {
        keyPath: 'conflictId',
      });
    });
    versionNine.close();

    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      databaseName,
    );

    await expect(repository.listLogicalBooks()).resolves.toEqual([logicalBook]);
    await expect(repository.listPendingLogicalBookChanges()).resolves.toEqual(
      [],
    );
    const migrated = await openDatabase(databaseName);
    expect(migrated.version).toBe(10);
    expect([...migrated.objectStoreNames]).toContain('logicalBookChangeOutbox');
    migrated.close();
  });
});

function createLegacyStores(database: IDBDatabase): void {
  database.createObjectStore('books', { keyPath: 'id' });
  database.createObjectStore('binaries', { keyPath: 'bookId' });
  database.createObjectStore('covers', { keyPath: 'bookId' });
  database.createObjectStore('progress', { keyPath: 'bookId' });
  database
    .createObjectStore('progressDocuments', {
      keyPath: ['bookId', 'deviceId'],
    })
    .createIndex('bookId', 'bookId');
  database.createObjectStore('preferences', { keyPath: 'format' });
  database
    .createObjectStore('bookmarks', { keyPath: 'id' })
    .createIndex('bookId', 'bookId');
  database
    .createObjectStore('annotations', { keyPath: 'id' })
    .createIndex('bookId', 'bookId');
  database.createObjectStore('quarantine', {
    keyPath: 'id',
    autoIncrement: true,
  });
}

function abortUpgrade(databaseName: string, version: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore('logicalBooks', { keyPath: 'id' });
      request.transaction?.abort();
    });
    request.addEventListener('success', () => {
      request.result.close();
      resolve();
    });
    request.addEventListener('error', () => reject(request.error));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () => reject(transaction.error));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
}

function readRecord(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(storeName)
      .objectStore(storeName)
      .get(key);
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
}

function openDatabase(
  databaseName: string,
  version?: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(databaseName)
        : indexedDB.open(databaseName, version);
    request.addEventListener('upgradeneeded', () => upgrade?.(request.result));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Unable to open the test library')),
    );
  });
}
