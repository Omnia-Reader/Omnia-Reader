import 'fake-indexeddb/auto';
import {
  DEFAULT_EPUB_READER_PREFERENCES,
  PublicationAnnotation,
  PublicationBookmark,
  ReadingProgress,
} from '@omnia-reader/reader/domain';
import { BrowserLibraryRepository } from './browser-library-repository';
import { publicationFingerprint } from './browser-library-repository';
import { PublicationBinaryStorage } from './publication-binary-storage';

describe('publicationFingerprint', () => {
  it('creates a stable exact-edition SHA-256 identifier', async () => {
    const first = await publicationFingerprint(blob('same edition'));
    const second = await publicationFingerprint(blob('same edition'));
    const revised = await publicationFingerprint(blob('revised edition'));

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(revised).not.toBe(first);
  });
});

describe('BrowserLibraryRepository reader preferences', () => {
  it('persists format-specific preferences across repository instances', async () => {
    const preferences = {
      ...DEFAULT_EPUB_READER_PREFERENCES,
      theme: 'sepia' as const,
      fontSizePercent: 125,
    };
    await new BrowserLibraryRepository().saveReaderPreferences(preferences);

    await expect(
      new BrowserLibraryRepository().getReaderPreferences('epub'),
    ).resolves.toEqual(preferences);
    await expect(
      new BrowserLibraryRepository().getReaderPreferences('pdf'),
    ).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository publication covers', () => {
  it('stores derived artwork without marking an import as opened', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 cover persistence fixture'], {
      type: 'application/pdf',
    });
    const source = {
      name: 'cover-persistence.pdf',
      mediaType: 'application/pdf',
      size: publication.size,
      open: async () => publication,
    };
    const imported = await repository.importBook(source);
    const cover = new Blob(['cover pixels'], { type: 'image/png' });

    const enriched = await repository.updateMetadata(imported.id, {
      title: 'Durable cover',
      authors: ['Omnia'],
      language: 'en',
      publisher: 'Omnia Press',
      identifier: 'urn:omnia:durable-cover',
      cover,
    });

    expect(enriched).toMatchObject({
      title: 'Durable cover',
      authors: ['Omnia'],
      language: 'en',
      publisher: 'Omnia Press',
      identifier: 'urn:omnia:durable-cover',
      coverState: 'available',
    });
    expect(enriched.lastOpenedAt).toBeUndefined();
    await expect(repository.getBookCover(imported.id)).resolves.not.toBeNull();

    const opened = await repository.updateMetadata(
      imported.id,
      { title: enriched.title, authors: enriched.authors },
      { markOpened: true },
    );
    expect(opened.lastOpenedAt).toBeDefined();
    expect(opened.coverState).toBe('available');
  });

  it('deletes cached artwork with its publication', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 cover deletion fixture'], {
      type: 'application/pdf',
    });
    const imported = await repository.importBook({
      name: 'cover-deletion.pdf',
      mediaType: 'application/pdf',
      size: publication.size,
      open: async () => publication,
    });
    await repository.updateMetadata(imported.id, {
      title: imported.title,
      authors: [],
      cover: new Blob(['cover'], { type: 'image/png' }),
    });

    await repository.removeBook(imported.id);

    await expect(repository.getBookCover(imported.id)).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository progress document cache', () => {
  it('persists every device document and removes them with the publication', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 progress cache fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'progress-cache.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const deviceA = progressDocument(book.id, 'device-a', 0.75);
    const deviceB = progressDocument(book.id, 'device-b', 0.4);

    await repository.saveProgressDocument(deviceA);
    await repository.saveProgressDocument(deviceB);

    await expect(
      new BrowserLibraryRepository().listProgressDocuments(book.id),
    ).resolves.toEqual([deviceA, deviceB]);

    await repository.removeBook(book.id);

    await expect(repository.listProgressDocuments(book.id)).resolves.toEqual(
      [],
    );
  });
});

describe('BrowserLibraryRepository bookmarks', () => {
  it('persists active bookmarks and hides synchronized tombstones', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 bookmark fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'bookmark-fixture.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const bookmark: PublicationBookmark = {
      schemaVersion: 1,
      id: '5eb34fdb-e3e9-4396-af78-c6b2af0a9a4b',
      bookId: book.id,
      format: book.format,
      deviceId: 'repository-test',
      locator: {
        href: '',
        type: 'application/pdf',
        title: 'Page 2',
        locations: { fragments: ['page=2'], position: 2 },
      },
      label: 'Page 2',
      createdAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:00.000Z',
    };

    await repository.saveBookmark(bookmark);
    await expect(repository.getBookmark(bookmark.id)).resolves.toEqual(
      bookmark,
    );
    await expect(repository.listBookmarks(book.id)).resolves.toEqual([
      bookmark,
    ]);

    const tombstone: PublicationBookmark = {
      ...bookmark,
      updatedAt: '2026-07-25T09:00:00.000Z',
      deletedAt: '2026-07-25T09:00:00.000Z',
    };
    await repository.saveBookmark(tombstone);
    await expect(repository.listBookmarks(book.id)).resolves.toEqual([]);
    await expect(repository.listBookmarks(book.id, true)).resolves.toEqual([
      tombstone,
    ]);

    await repository.removeBook(book.id);
    await expect(repository.getBookmark(bookmark.id)).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository annotations', () => {
  it('persists active annotations, hides tombstones, and removes book state', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 annotation fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'annotation-fixture.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const annotation: PublicationAnnotation = {
      schemaVersion: 1,
      id: 'bd74c3bb-f5de-48dd-a6be-b80c55a79258',
      bookId: book.id,
      format: book.format,
      deviceId: 'repository-test',
      locator: {
        href: '',
        type: 'application/pdf',
        title: 'Page 2',
        locations: {
          fragments: ['pdf-text=2:7:22'],
          position: 2,
        },
        text: { highlight: 'important words' },
      },
      color: 'yellow',
      note: 'Remember this.',
      createdAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:00.000Z',
    };

    await repository.saveAnnotation(annotation);
    await expect(repository.getAnnotation(annotation.id)).resolves.toEqual(
      annotation,
    );
    await expect(repository.listAnnotations(book.id)).resolves.toEqual([
      annotation,
    ]);

    const tombstone: PublicationAnnotation = {
      ...annotation,
      updatedAt: '2026-07-25T09:00:00.000Z',
      deletedAt: '2026-07-25T09:00:00.000Z',
    };
    await repository.saveAnnotation(tombstone);
    await expect(repository.listAnnotations(book.id)).resolves.toEqual([]);
    await expect(repository.listAnnotations(book.id, true)).resolves.toEqual([
      tombstone,
    ]);

    await repository.removeBook(book.id);
    await expect(repository.getAnnotation(annotation.id)).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository binary recovery', () => {
  it('repairs missing local bytes when the same edition is imported again', async () => {
    const bookId = `sha256:${'f'.repeat(64)}`;
    let persisted: Blob | null = null;
    const binaryStorage = {
      save: vi.fn(async (request) => {
        persisted = request.blob;
        return {
          schemaVersion: 2 as const,
          storage: 'opfs' as const,
          bookId: request.bookId,
          fileName: request.fileName,
          mediaType: request.mediaType,
          size: request.blob.size,
          opfsFileName: `${'f'.repeat(64)}.pdf`,
        };
      }),
      open: vi.fn(async () => persisted),
      migrate: vi.fn(async (stored) => stored),
      remove: vi.fn(async () => undefined),
    } satisfies PublicationBinaryStorage;
    const repository = new BrowserLibraryRepository(
      binaryStorage,
      async () => bookId,
    );
    const publication = new Blob(['repairable publication'], {
      type: 'application/pdf',
    });
    const source = {
      name: 'repairable.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    };

    const imported = await repository.importBook(source);
    persisted = null;
    const repaired = await repository.importBook(source);

    expect(repaired).toEqual(imported);
    expect(binaryStorage.save).toHaveBeenCalledTimes(2);
    await expect(repository.getBookSource(bookId)).resolves.toMatchObject({
      size: publication.size,
    });
  });
});

describe('BrowserLibraryRepository integrity recovery', () => {
  it('quarantines malformed active records without hiding healthy books', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 integrity fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'integrity-fixture.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const corruptBookId = `sha256:${'c'.repeat(64)}`;
    await putRawLibraryRecords([
      {
        storeName: 'books',
        value: {
          id: corruptBookId,
          format: 'executable',
          title: 'Corrupt metadata',
        },
      },
      {
        storeName: 'binaries',
        value: {
          schemaVersion: 2,
          storage: 'opfs',
          bookId: book.id,
          fileName: book.fileName,
          mediaType: book.mediaType,
          size: -1,
          opfsFileName: 'outside-library.pdf',
        },
      },
      {
        storeName: 'covers',
        value: {
          bookId: book.id,
          mediaType: 'image/png',
          bytes: 'not binary data',
        },
      },
      {
        storeName: 'progress',
        value: {
          schemaVersion: 1,
          bookId: book.id,
          format: book.format,
          deviceId: 'corrupt-progress',
          locator: {
            href: '',
            type: 'application/pdf',
            locations: { position: 0 },
          },
          furthestTotalProgression: 2,
          updatedAt: 'not-a-date',
          appVersion: '1.0.0',
        },
      },
      {
        storeName: 'progressDocuments',
        value: {
          schemaVersion: 1,
          bookId: book.id,
          format: book.format,
          deviceId: 'corrupt-progress-document',
          locator: {
            href: '',
            type: 'application/pdf',
            locations: { position: 0 },
          },
          furthestTotalProgression: 2,
          updatedAt: 'not-a-date',
          appVersion: '1.0.0',
        },
      },
      {
        storeName: 'bookmarks',
        value: {
          id: 'corrupt-bookmark',
          bookId: book.id,
          format: book.format,
        },
      },
      {
        storeName: 'annotations',
        value: {
          id: 'corrupt-annotation',
          bookId: book.id,
          format: book.format,
        },
      },
      {
        storeName: 'preferences',
        value: {
          ...DEFAULT_EPUB_READER_PREFERENCES,
          theme: 'neon',
        },
      },
    ]);

    await expect(repository.listBooks()).resolves.toContainEqual(book);
    await expect(repository.getBook(corruptBookId)).resolves.toBeNull();
    await expect(repository.getBookSource(book.id)).resolves.toBeNull();
    await expect(repository.getBookCover(book.id)).resolves.toBeNull();
    await expect(repository.getProgress(book.id)).resolves.toBeNull();
    await expect(repository.listProgressDocuments(book.id)).resolves.toEqual(
      [],
    );
    await expect(repository.listBookmarks(book.id)).resolves.toEqual([]);
    await expect(repository.listAnnotations(book.id)).resolves.toEqual([]);
    await expect(repository.getReaderPreferences('epub')).resolves.toBeNull();

    const quarantined = await repository.listQuarantinedRecords();
    const recoveredStores = new Set(
      quarantined
        .filter((record) =>
          [
            corruptBookId,
            book.id,
            `${book.id},corrupt-progress-document`,
            'corrupt-bookmark',
            'corrupt-annotation',
            'epub',
          ].includes(String(record.recordKey)),
        )
        .map((record) => record.storeName),
    );
    expect(recoveredStores).toEqual(
      new Set([
        'books',
        'binaries',
        'covers',
        'progress',
        'progressDocuments',
        'bookmarks',
        'annotations',
        'preferences',
      ]),
    );
    expect(
      quarantined.find((record) => record.recordKey === 'epub')?.value,
    ).toMatchObject({ theme: 'neon' });
  });

  it('rejects malformed records before they reach IndexedDB', async () => {
    const repository = new BrowserLibraryRepository();

    await expect(
      repository.saveReaderPreferences({
        ...DEFAULT_EPUB_READER_PREFERENCES,
        marginPercent: 100,
      }),
    ).rejects.toThrow('preferences are invalid');
    await expect(
      repository.saveProgress({
        schemaVersion: 1,
        bookId: `sha256:${'d'.repeat(64)}`,
        format: 'pdf',
        deviceId: 'invalid-write',
        locator: {
          href: '',
          type: 'application/pdf',
          locations: { position: 0 },
        },
        furthestTotalProgression: -1,
        updatedAt: '2026-07-25T08:00:00.000Z',
        appVersion: '1.0.0',
      }),
    ).rejects.toThrow('progress record is invalid');
    await expect(
      repository.saveProgressDocument({
        schemaVersion: 1,
        bookId: `sha256:${'d'.repeat(64)}`,
        format: 'pdf',
        deviceId: 'invalid-document',
        locator: {
          href: '',
          type: 'application/pdf',
          locations: { position: 0 },
        },
        furthestTotalProgression: -1,
        updatedAt: '2026-07-25T08:00:00.000Z',
        appVersion: '1.0.0',
      }),
    ).rejects.toThrow('Progress document is invalid');
  });
});

function progressDocument(
  bookId: string,
  deviceId: string,
  totalProgression: number,
): ReadingProgress {
  return {
    schemaVersion: 1,
    bookId,
    format: 'pdf',
    deviceId,
    locator: {
      href: '',
      type: 'application/pdf',
      locations: {
        position: Math.max(1, Math.round(totalProgression * 10)),
        totalProgression,
      },
    },
    furthestTotalProgression: totalProgression,
    updatedAt:
      deviceId === 'device-a'
        ? '2026-07-25T08:00:00.000Z'
        : '2026-07-25T09:00:00.000Z',
    appVersion: '1.0.0',
  };
}

async function putRawLibraryRecords(
  records: readonly { storeName: string; value: unknown }[],
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('omnia-reader');
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Unable to open the test library')),
    );
  });
  const transaction = database.transaction(
    [...new Set(records.map((record) => record.storeName))],
    'readwrite',
  );
  for (const record of records) {
    transaction.objectStore(record.storeName).put(record.value);
  }
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('Unable to seed corrupt records')),
    );
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('Unable to seed corrupt records')),
    );
  });
  database.close();
}

function blob(content: string): Blob {
  return {
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as Blob;
}
