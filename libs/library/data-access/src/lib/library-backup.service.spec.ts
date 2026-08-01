import {
  BookRecord,
  BookSource,
  LibraryRepository,
  LogicalBookFormatPreference,
  LogicalBookChange,
  LogicalBookId,
  LogicalBookMutationResult,
  LogicalBookRecord,
  LogicalLibrarySnapshot,
  LogicalMutationIdentity,
  AddLogicalBookVariantResult,
  logicalBookFromVariant,
  MembershipReconciliation,
  MembershipReconciliationDecision,
  PublicationFormat,
  PublicationAnnotation,
  PublicationBookmark,
  PublicationMetadata,
  ProgressDocumentRepository,
  ReaderPreferences,
  ReadingProgress,
  VariantAvailability,
} from '@omnia-reader/reader/domain';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '@zip.js/zip.js';
import {
  LibraryBackupService,
  LibraryBackupImportResult,
} from './library-backup.service';

const BOOK_ID = `sha256:${'a'.repeat(64)}`;
const BOOK_BLOB = new Blob(['%PDF-1.7 backup'], { type: 'application/pdf' });
const BOOK: BookRecord = {
  id: BOOK_ID,
  format: 'pdf',
  fileName: 'portable.pdf',
  mediaType: 'application/pdf',
  size: BOOK_BLOB.size,
  title: 'Portable library',
  authors: ['Omnia'],
  importedAt: '2026-07-24T08:00:00.000Z',
};
const PROGRESS: ReadingProgress = {
  schemaVersion: 1,
  bookId: BOOK_ID,
  format: 'pdf',
  deviceId: 'test-device',
  locator: {
    href: '',
    type: 'application/pdf',
    locations: { position: 4, totalProgression: 0.4 },
  },
  furthestTotalProgression: 0.4,
  updatedAt: '2026-07-24T09:00:00.000Z',
  appVersion: '0.1.0',
};
const SECOND_DEVICE_PROGRESS: ReadingProgress = {
  ...PROGRESS,
  deviceId: 'second-device',
  locator: {
    href: '',
    type: 'application/pdf',
    locations: { position: 3, totalProgression: 0.3 },
  },
  furthestTotalProgression: 0.3,
  updatedAt: '2026-07-24T08:30:00.000Z',
};
const PREFERENCES: ReaderPreferences = {
  format: 'pdf',
  zoomMode: 'fit-page',
  zoomPercent: 125,
  rotation: 90,
};
const BOOKMARK: PublicationBookmark = {
  schemaVersion: 1,
  id: '94d57c27-e4c4-4548-a1ae-24287126d34a',
  bookId: BOOK_ID,
  format: 'pdf',
  deviceId: 'test-device',
  locator: {
    href: '',
    type: 'application/pdf',
    title: 'Page 4',
    locations: { fragments: ['page=4'], position: 4 },
  },
  label: 'Important page',
  createdAt: '2026-07-24T09:30:00.000Z',
  updatedAt: '2026-07-24T09:30:00.000Z',
};
const ANNOTATION: PublicationAnnotation = {
  schemaVersion: 1,
  id: '23bb67e1-4c31-4b03-a23d-c86e938dc59e',
  bookId: BOOK_ID,
  format: 'pdf',
  deviceId: 'test-device',
  locator: {
    href: '',
    type: 'application/pdf',
    title: 'Page 4',
    locations: {
      fragments: ['pdf-text=4:10:28'],
      position: 4,
    },
    text: { highlight: 'portable annotation' },
  },
  color: 'blue',
  note: 'Keep this insight.',
  createdAt: '2026-07-24T09:45:00.000Z',
  updatedAt: '2026-07-24T09:45:00.000Z',
};

beforeAll(() => {
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value(this: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener('load', () =>
            resolve(reader.result as ArrayBuffer),
          );
          reader.addEventListener('error', () =>
            reject(reader.error ?? new Error('Unable to read test blob')),
          );
          reader.readAsArrayBuffer(this);
        });
      },
    });
  }
});

describe('LibraryBackupService', () => {
  it('round-trips publication bytes, metadata, progress, bookmarks, annotations, and preferences', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.progress.set(BOOK.id, PROGRESS);
    source.progressDocuments.set(progressDocumentKey(PROGRESS), PROGRESS);
    source.progressDocuments.set(
      progressDocumentKey(SECOND_DEVICE_PROGRESS),
      SECOND_DEVICE_PROGRESS,
    );
    source.bookmarks.set(BOOKMARK.id, BOOKMARK);
    source.annotations.set(ANNOTATION.id, ANNOTATION);
    source.preferences.set('pdf', PREFERENCES);
    const archive = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive(new Date('2026-07-25T12:30:00.000Z'));

    expect(archive.fileName).toBe(
      'omnia-reader-backup-2026-07-25.omnia-backup',
    );
    expect(archive.bookCount).toBe(1);
    expect(archive.blob.type).toBe('application/vnd.omnia-reader.backup+zip');

    const restored = new MemoryLibraryRepository();
    const result = await new LibraryBackupService(
      restored,
      async () => BOOK_ID,
    ).importArchive(archive.blob);

    expect(result).toEqual<LibraryBackupImportResult>({
      booksAdded: 1,
      booksUpdated: 0,
      progressRestored: 1,
      progressDocumentsRestored: 2,
      preferencesRestored: 1,
      bookmarksRestored: 1,
      annotationsRestored: 1,
    });
    expect(await restored.getBook(BOOK_ID)).toEqual(BOOK);
    expect(await (await restored.getBookSource(BOOK_ID))?.open()).toEqual(
      BOOK_BLOB,
    );
    expect(await restored.getProgress(BOOK_ID)).toEqual(PROGRESS);
    expect(await restored.listProgressDocuments()).toEqual([
      SECOND_DEVICE_PROGRESS,
      PROGRESS,
    ]);
    expect(await restored.getBookmark(BOOKMARK.id)).toEqual(BOOKMARK);
    expect(await restored.getAnnotation(ANNOTATION.id)).toEqual(ANNOTATION);
    expect(await restored.getReaderPreferences('pdf')).toEqual(PREFERENCES);
  });

  it('round-trips schema-4 logical membership, preference, and cover state', async () => {
    const epubId = `sha256:${'b'.repeat(64)}`;
    const logicalBookId = `logical:sha256:${'d'.repeat(64)}` as LogicalBookId;
    const epubBlob = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 31])], {
      type: 'application/epub+zip',
    });
    const epub: BookRecord = {
      ...BOOK,
      id: epubId,
      format: 'epub',
      fileName: 'portable.epub',
      mediaType: 'application/epub+zip',
      size: epubBlob.size,
    };
    const logicalBook: LogicalBookRecord = {
      ...logicalBookFromVariant(BOOK),
      id: logicalBookId,
      variants: { epub: epub.id, pdf: BOOK.id },
    };
    const logicalPreference: LogicalBookFormatPreference = {
      schemaVersion: 1,
      logicalBookId,
      preferredFormat: 'pdf',
      winningChangeId: 'change:preference',
      preferenceHeads: ['change:preference'],
      updatedAt: '2026-07-25T10:00:00.000Z',
      deviceId: 'test-device',
    };
    const cover = new Blob(['cover'], { type: 'image/png' });
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.books.set(epub.id, epub);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.sources.set(epub.id, epubBlob);
    source.logicalBooks.set(logicalBook.id, logicalBook);
    source.logicalPreferences.set(logicalBook.id, logicalPreference);
    source.logicalCovers.set(logicalBook.id, cover);
    const fingerprint = async (blob: Blob) =>
      blob.type === 'application/epub+zip' ? epubId : BOOK_ID;

    const archive = await new LibraryBackupService(
      source,
      fingerprint,
    ).exportArchive(new Date('2026-07-25T12:30:00.000Z'));
    const restored = new MemoryLibraryRepository();
    await new LibraryBackupService(restored, fingerprint).importArchive(
      archive.blob,
    );

    expect(await restored.listLogicalBooks()).toEqual([logicalBook]);
    expect(
      await restored.getLogicalBookFormatPreference(logicalBook.id),
    ).toEqual(logicalPreference);
    expect(await restored.getLogicalBookCover(logicalBook.id)).toEqual(cover);
  });

  it('streams a byte-compatible archive without creating a final backup Blob', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.progress.set(BOOK.id, PROGRESS);
    const chunks: BlobPart[] = [];
    const progress: number[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk.slice().buffer as ArrayBuffer);
      },
    });
    const service = new LibraryBackupService(source, async () => BOOK_ID);

    const exported = await service.exportArchiveTo(
      writable,
      new Date('2026-07-25T12:30:00.000Z'),
      {
        onProgress: (value) => progress.push(value.completedBooks),
      },
    );

    expect(exported).toEqual({
      fileName: 'omnia-reader-backup-2026-07-25.omnia-backup',
      bookCount: 1,
    });
    expect(progress).toEqual([0, 1]);
    expect(chunks.length).toBeGreaterThan(1);
    const archive = new Blob(chunks, {
      type: 'application/vnd.omnia-reader.backup+zip',
    });
    const restored = new MemoryLibraryRepository();
    await new LibraryBackupService(restored, async () => BOOK_ID).importArchive(
      archive,
    );
    expect(await restored.getBook(BOOK_ID)).toEqual(BOOK);
    expect(await restored.getProgress(BOOK_ID)).toEqual(PROGRESS);
    expect(await restored.listProgressDocuments()).toEqual([PROGRESS]);
  });

  it('aborts the destination when a streaming export is cancelled', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    const abort = vi.fn();
    const close = vi.fn();
    const writable = new WritableStream<Uint8Array>({ abort, close });
    const controller = new AbortController();
    controller.abort(
      new DOMException('Backup export was cancelled', 'AbortError'),
    );

    await expect(
      new LibraryBackupService(source, async () => BOOK_ID).exportArchiveTo(
        writable,
        new Date(),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('refuses to create a partial backup when publication bytes are missing', async () => {
    const repository = new MemoryLibraryRepository();
    repository.books.set(BOOK.id, BOOK);

    await expect(
      new LibraryBackupService(repository, async () => BOOK_ID).exportArchive(),
    ).rejects.toThrow('publication file is missing');
  });

  it('refuses to create an archive its own manifest limit cannot restore', async () => {
    const repository = new MemoryLibraryRepository();
    repository.books.set(BOOK.id, {
      ...BOOK,
      title: 'x'.repeat(2 * 1024 * 1024),
    });
    repository.sources.set(BOOK.id, BOOK_BLOB);

    await expect(
      new LibraryBackupService(repository, async () => BOOK_ID).exportArchive(),
    ).rejects.toThrow('manifest exceeds the supported size limit');
  });

  it('rejects a publication with a mismatched digest before mutating the library', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    const archive = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive();
    const restored = new MemoryLibraryRepository();

    await expect(
      new LibraryBackupService(
        restored,
        async () => `sha256:${'b'.repeat(64)}`,
      ).importArchive(archive.blob),
    ).rejects.toThrow('failed integrity validation');
    expect(await restored.listBooks()).toEqual([]);
  });

  it('keeps newer local progress while restoring metadata for an existing book', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.progress.set(BOOK.id, PROGRESS);
    const archive = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive();

    const restored = new MemoryLibraryRepository();
    restored.books.set(BOOK.id, { ...BOOK, title: 'Old metadata' });
    restored.sources.set(BOOK.id, BOOK_BLOB);
    const newerProgress: ReadingProgress = {
      ...PROGRESS,
      furthestTotalProgression: 0.8,
      updatedAt: '2026-07-25T09:00:00.000Z',
    };
    restored.progress.set(BOOK.id, newerProgress);

    const result = await new LibraryBackupService(
      restored,
      async () => BOOK_ID,
    ).importArchive(archive.blob);

    expect(result.booksUpdated).toBe(1);
    expect(result.progressRestored).toBe(0);
    expect((await restored.getBook(BOOK_ID))?.title).toBe(BOOK.title);
    expect(await restored.getProgress(BOOK_ID)).toEqual(newerProgress);
  });

  it('keeps newer local per-device progress while restoring other device history', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.progress.set(BOOK.id, PROGRESS);
    source.progressDocuments.set(
      progressDocumentKey(SECOND_DEVICE_PROGRESS),
      SECOND_DEVICE_PROGRESS,
    );
    const archive = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive();

    const restored = new MemoryLibraryRepository();
    restored.books.set(BOOK.id, BOOK);
    restored.sources.set(BOOK.id, BOOK_BLOB);
    const newerProgress: ReadingProgress = {
      ...SECOND_DEVICE_PROGRESS,
      locator: {
        ...SECOND_DEVICE_PROGRESS.locator,
        locations: { position: 8, totalProgression: 0.8 },
      },
      furthestTotalProgression: 0.8,
      updatedAt: '2026-07-25T09:00:00.000Z',
    };
    restored.progressDocuments.set(
      progressDocumentKey(newerProgress),
      newerProgress,
    );

    const result = await new LibraryBackupService(
      restored,
      async () => BOOK_ID,
    ).importArchive(archive.blob);

    expect(result.progressDocumentsRestored).toBe(1);
    expect(await restored.listProgressDocuments()).toEqual([
      newerProgress,
      PROGRESS,
    ]);
  });

  it('keeps a newer local bookmark tombstone during restore', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.bookmarks.set(BOOKMARK.id, BOOKMARK);
    const archive = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive();

    const restored = new MemoryLibraryRepository();
    restored.books.set(BOOK.id, BOOK);
    restored.sources.set(BOOK.id, BOOK_BLOB);
    const deletedAt = '2026-07-25T10:00:00.000Z';
    const tombstone: PublicationBookmark = {
      ...BOOKMARK,
      deviceId: 'newer-device',
      updatedAt: deletedAt,
      deletedAt,
    };
    restored.bookmarks.set(BOOKMARK.id, tombstone);

    const result = await new LibraryBackupService(
      restored,
      async () => BOOK_ID,
    ).importArchive(archive.blob);

    expect(result.bookmarksRestored).toBe(0);
    expect(await restored.getBookmark(BOOKMARK.id)).toEqual(tombstone);
  });

  it('migrates version 1 archives where bookmarks used the annotations field', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.bookmarks.set(BOOKMARK.id, BOOKMARK);
    const exported = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive();
    const legacyArchive = await asVersionOneArchive(exported.blob);
    const restored = new MemoryLibraryRepository();

    const result = await new LibraryBackupService(
      restored,
      async () => BOOK_ID,
    ).importArchive(legacyArchive);

    expect(result.bookmarksRestored).toBe(1);
    expect(result.annotationsRestored).toBe(0);
    expect(result.progressDocumentsRestored).toBe(0);
    expect(await restored.getBookmark(BOOKMARK.id)).toEqual(BOOKMARK);
    expect(await restored.listAnnotations()).toEqual([]);
  });

  it('migrates version 2 progress into the per-device history store', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.progress.set(BOOK.id, PROGRESS);
    source.progressDocuments.set(
      progressDocumentKey(SECOND_DEVICE_PROGRESS),
      SECOND_DEVICE_PROGRESS,
    );
    const exported = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive();
    const versionTwoArchive = await rewriteManifestArchive(
      exported.blob,
      (manifest) => {
        manifest['schemaVersion'] = 2;
        delete manifest['progressDocuments'];
      },
    );
    const restored = new MemoryLibraryRepository();

    const result = await new LibraryBackupService(
      restored,
      async () => BOOK_ID,
    ).importArchive(versionTwoArchive);

    expect(result.progressDocumentsRestored).toBe(1);
    expect(await restored.listProgressDocuments()).toEqual([PROGRESS]);
  });

  it('rejects duplicate per-device progress records before mutating the library', async () => {
    const source = new MemoryLibraryRepository();
    source.books.set(BOOK.id, BOOK);
    source.sources.set(BOOK.id, BOOK_BLOB);
    source.progress.set(BOOK.id, PROGRESS);
    const exported = await new LibraryBackupService(
      source,
      async () => BOOK_ID,
    ).exportArchive();
    const invalidArchive = await rewriteManifestArchive(
      exported.blob,
      (manifest) => {
        const documents = manifest['progressDocuments'] as ReadingProgress[];
        manifest['progressDocuments'] = [...documents, documents[0]];
      },
    );
    const restored = new MemoryLibraryRepository();

    await expect(
      new LibraryBackupService(restored, async () => BOOK_ID).importArchive(
        invalidArchive,
      ),
    ).rejects.toThrow('duplicate state records');
    expect(await restored.listBooks()).toEqual([]);
    expect(await restored.listProgressDocuments()).toEqual([]);
  });
});

class MemoryBookSource implements BookSource {
  readonly size: number;

  constructor(
    readonly name: string,
    readonly mediaType: string,
    private readonly blob: Blob,
  ) {
    this.size = blob.size;
  }

  async open(): Promise<Blob> {
    return this.blob;
  }
}

class MemoryLibraryRepository
  implements LibraryRepository, ProgressDocumentRepository
{
  readonly books = new Map<string, BookRecord>();
  readonly sources = new Map<string, Blob>();
  readonly progress = new Map<string, ReadingProgress>();
  readonly progressDocuments = new Map<string, ReadingProgress>();
  readonly bookmarks = new Map<string, PublicationBookmark>();
  readonly annotations = new Map<string, PublicationAnnotation>();
  readonly preferences = new Map<PublicationFormat, ReaderPreferences>();
  readonly logicalBooks = new Map<LogicalBookId, LogicalBookRecord>();
  readonly logicalPreferences = new Map<
    LogicalBookId,
    LogicalBookFormatPreference
  >();
  readonly reconciliations = new Map<string, MembershipReconciliation>();
  readonly logicalCovers = new Map<LogicalBookId, Blob>();

  async listBooks(): Promise<readonly BookRecord[]> {
    return [...this.books.values()];
  }

  async getBook(bookId: string): Promise<BookRecord | null> {
    return this.books.get(bookId) ?? null;
  }

  async getBookSource(bookId: string): Promise<BookSource | null> {
    const book = this.books.get(bookId);
    const blob = this.sources.get(bookId);
    return book && blob
      ? new MemoryBookSource(book.fileName, book.mediaType, blob)
      : null;
  }

  async getBookCover(): Promise<Blob | null> {
    return null;
  }

  async importBook(): Promise<BookRecord> {
    throw new Error('Not implemented for this test');
  }

  async storeSyncedBook(book: BookRecord, source: BookSource): Promise<void> {
    if (!this.books.has(book.id)) {
      this.books.set(book.id, book);
    }
    if (!this.sources.has(book.id)) {
      const opened = await source.open();
      this.sources.set(
        book.id,
        opened instanceof Blob ? opened : new Blob([opened]),
      );
    }
  }

  async updateMetadata(
    bookId: string,
    metadata: PublicationMetadata,
  ): Promise<BookRecord> {
    const book = this.books.get(bookId);
    if (!book) {
      throw new Error('Missing book');
    }
    const updated: BookRecord = {
      ...book,
      title: metadata.title,
      authors: metadata.authors,
      language: metadata.language,
      publisher: metadata.publisher,
      identifier: metadata.identifier,
    };
    this.books.set(bookId, updated);
    return updated;
  }

  async removeBook(bookId: string): Promise<void> {
    this.books.delete(bookId);
    this.sources.delete(bookId);
    this.progress.delete(bookId);
    for (const [key, progress] of this.progressDocuments) {
      if (progress.bookId === bookId) {
        this.progressDocuments.delete(key);
      }
    }
    for (const bookmark of this.bookmarks.values()) {
      if (bookmark.bookId === bookId) {
        this.bookmarks.delete(bookmark.id);
      }
    }
    for (const annotation of this.annotations.values()) {
      if (annotation.bookId === bookId) {
        this.annotations.delete(annotation.id);
      }
    }
  }

  async getProgress(bookId: string): Promise<ReadingProgress | null> {
    return this.progress.get(bookId) ?? null;
  }

  async listProgress(): Promise<readonly ReadingProgress[]> {
    return [...this.progress.values()];
  }

  async saveProgress(progress: ReadingProgress): Promise<void> {
    this.progress.set(progress.bookId, progress);
  }

  async listProgressDocuments(
    bookId?: string,
  ): Promise<readonly ReadingProgress[]> {
    return [...this.progressDocuments.values()]
      .filter((progress) => bookId === undefined || progress.bookId === bookId)
      .sort(
        (left, right) =>
          left.bookId.localeCompare(right.bookId) ||
          left.deviceId.localeCompare(right.deviceId),
      );
  }

  async saveProgressDocument(progress: ReadingProgress): Promise<void> {
    this.progressDocuments.set(progressDocumentKey(progress), progress);
  }

  async getBookmark(bookmarkId: string): Promise<PublicationBookmark | null> {
    return this.bookmarks.get(bookmarkId) ?? null;
  }

  async listBookmarks(
    bookId?: string,
    includeDeleted = false,
  ): Promise<readonly PublicationBookmark[]> {
    return [...this.bookmarks.values()].filter(
      (bookmark) =>
        (bookId === undefined || bookmark.bookId === bookId) &&
        (includeDeleted || bookmark.deletedAt === undefined),
    );
  }

  async saveBookmark(bookmark: PublicationBookmark): Promise<void> {
    this.bookmarks.set(bookmark.id, bookmark);
  }

  async getAnnotation(
    annotationId: string,
  ): Promise<PublicationAnnotation | null> {
    return this.annotations.get(annotationId) ?? null;
  }

  async listAnnotations(
    bookId?: string,
    includeDeleted = false,
  ): Promise<readonly PublicationAnnotation[]> {
    return [...this.annotations.values()].filter(
      (annotation) =>
        (bookId === undefined || annotation.bookId === bookId) &&
        (includeDeleted || annotation.deletedAt === undefined),
    );
  }

  async saveAnnotation(annotation: PublicationAnnotation): Promise<void> {
    this.annotations.set(annotation.id, annotation);
  }

  async getReaderPreferences(
    format: PublicationFormat,
  ): Promise<ReaderPreferences | null> {
    return this.preferences.get(format) ?? null;
  }

  async saveReaderPreferences(preferences: ReaderPreferences): Promise<void> {
    this.preferences.set(preferences.format, preferences);
  }

  async listLogicalBooks(): Promise<readonly LogicalBookRecord[]> {
    return this.logicalBooks.size > 0
      ? [...this.logicalBooks.values()]
      : [...this.books.values()].map((book) => logicalBookFromVariant(book));
  }

  async getLogicalBook(id: LogicalBookId): Promise<LogicalBookRecord | null> {
    return (
      (await this.listLogicalBooks()).find((book) => book.id === id) ?? null
    );
  }

  async findLogicalBookByVariant(
    variantId: string,
  ): Promise<LogicalBookRecord | null> {
    return (
      (await this.listLogicalBooks()).find((book) =>
        Object.values(book.variants).includes(variantId),
      ) ?? null
    );
  }

  async getLogicalBookCover(
    logicalBookId: LogicalBookId,
  ): Promise<Blob | null> {
    return this.logicalCovers.get(logicalBookId) ?? null;
  }

  async getLogicalBookFormatPreference(
    logicalBookId: LogicalBookId,
  ): Promise<LogicalBookFormatPreference | null> {
    return this.logicalPreferences.get(logicalBookId) ?? null;
  }

  async getLogicalLibrarySnapshot(): Promise<LogicalLibrarySnapshot> {
    const logicalBooks = [...(await this.listLogicalBooks())];
    return {
      revision: JSON.stringify(logicalBooks),
      logicalBooks,
      preferences: [...this.logicalPreferences.values()],
      reconciliations: [...this.reconciliations.values()],
    };
  }

  async replaceLogicalBookState(
    logicalBooks: readonly LogicalBookRecord[],
    preferences: readonly LogicalBookFormatPreference[],
    reconciliations: readonly MembershipReconciliation[],
    covers?: ReadonlyMap<LogicalBookId, Blob>,
  ): Promise<void> {
    this.logicalBooks.clear();
    this.logicalPreferences.clear();
    this.reconciliations.clear();
    logicalBooks.forEach((book) => this.logicalBooks.set(book.id, book));
    preferences.forEach((preference) =>
      this.logicalPreferences.set(preference.logicalBookId, preference),
    );
    reconciliations.forEach((reconciliation) =>
      this.reconciliations.set(reconciliation.conflictId, reconciliation),
    );
    if (covers) {
      this.logicalCovers.clear();
      covers.forEach((cover, id) => this.logicalCovers.set(id, cover));
    }
  }

  addVariant(
    _logicalBookId: LogicalBookId,
    _variant: BookRecord,
    _source: BookSource,
    _identity: LogicalMutationIdentity,
  ): Promise<AddLogicalBookVariantResult> {
    return Promise.reject(new Error('Not implemented for this test'));
  }

  associate(
    _destinationId: LogicalBookId,
    _sourceId: LogicalBookId,
    _identity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not implemented for this test'));
  }

  detachVariant(
    _logicalBookId: LogicalBookId,
    _variantId: string,
    _identity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not implemented for this test'));
  }

  deleteVariant(
    _logicalBookId: LogicalBookId,
    _variantId: string | null,
    _identity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not implemented for this test'));
  }

  saveLogicalBookFormatPreference(
    _logicalBookId: LogicalBookId,
    _format: PublicationFormat,
    _identity: LogicalMutationIdentity,
  ): Promise<LogicalBookChange | null> {
    return Promise.resolve(null);
  }

  reconcileMembership(
    _conflictId: string,
    _decision: MembershipReconciliationDecision,
    _identity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not implemented for this test'));
  }

  async listOpenMembershipReconciliations(): Promise<
    readonly MembershipReconciliation[]
  > {
    return [];
  }

  async resolveVariantAvailability(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, VariantAvailability>> {
    return new Map(variantIds.map((id) => [id, { status: 'checking' }]));
  }

  async openHealthyVariant(variantId: string) {
    const source = await this.getBookSource(variantId);
    return source
      ? ({ availability: { status: 'healthy' }, source } as const)
      : ({
          availability: { status: 'unavailable', cause: 'missing' },
        } as const);
  }

  async replaceVariantSource(
    variantId: string,
    source: BookSource,
  ): Promise<void> {
    const opened = await source.open();
    this.sources.set(
      variantId,
      opened instanceof Blob ? opened : new Blob([opened]),
    );
  }
}

async function asVersionOneArchive(archive: Blob): Promise<Blob> {
  return rewriteManifestArchive(archive, (manifest) => {
    manifest['schemaVersion'] = 1;
    manifest['annotations'] = manifest['bookmarks'];
    delete manifest['bookmarks'];
    delete manifest['progressDocuments'];
  });
}

async function rewriteManifestArchive(
  archive: Blob,
  transform: (manifest: Record<string, unknown>) => void,
): Promise<Blob> {
  const {
    BlobReader,
    BlobWriter,
    TextReader,
    TextWriter,
    ZipReader,
    ZipWriter,
  } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(archive));
  const writer = new ZipWriter(
    new BlobWriter('application/vnd.omnia-reader.backup+zip'),
    { keepOrder: true },
  );
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory) {
        continue;
      }
      const file = entry as FileEntry;
      if (entry.filename === 'manifest.json') {
        const manifest = JSON.parse(
          await file.getData(new TextWriter()),
        ) as Record<string, unknown>;
        transform(manifest);
        await writer.add(
          entry.filename,
          new TextReader(JSON.stringify(manifest, null, 2)),
        );
      } else {
        const contents = await file.getData(new BlobWriter());
        await writer.add(entry.filename, new BlobReader(contents), {
          level: 0,
        });
      }
    }
    return await writer.close();
  } finally {
    await reader.close();
  }
}

function progressDocumentKey(progress: ReadingProgress): string {
  return `${progress.bookId}\u0000${progress.deviceId}`;
}
