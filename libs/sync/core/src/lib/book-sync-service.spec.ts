import {
  BookRecord,
  BookSource,
  LibraryRepository,
  NewSyncOperation,
  PublicationFormat,
  PublicationBookmark,
  PublicationAnnotation,
  PublicationMetadata,
  ReaderPreferences,
  ReadingProgress,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BookSyncManifest,
  bookManifestPath,
  createBookSyncManifest,
} from './book-sync-manifest';
import { BookSyncService } from './book-sync-service';
import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectUploadRequest,
  RemoteDocument,
  RemoteObject,
  SyncConflictError,
} from './library-sync-transport';

describe('BookSyncService', () => {
  let fixture: Awaited<ReturnType<typeof bookFixture>>;

  beforeEach(async () => {
    fixture = await bookFixture();
  });

  it('uploads and verifies the immutable object before publishing its manifest', async () => {
    const journal = new MemoryJournal([
      operation('op-1', fixture.manifest),
      operation('op-2', {
        ...fixture.manifest,
        title: 'Updated title',
        updatedAt: '2026-07-25T02:00:00.000Z',
      }),
    ]);
    const repository = new MemoryRepository(fixture.book, fixture.source);
    const remote = new MemoryTransport();
    const service = new BookSyncService(remote, journal, repository);

    await expect(service.push()).resolves.toMatchObject({
      pushed: 1,
      rejected: 0,
    });

    expect(remote.events).toEqual(['upload-object', 'write-document']);
    expect(journal.acknowledged).toEqual(['op-1', 'op-2']);
    expect(remote.objects.get(fixture.manifest.objectPath)?.sha256).toBe(
      fixture.manifest.sha256,
    );
  });

  it('seeds a newly selected provider from the local library snapshot', async () => {
    const remote = new MemoryTransport();
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      new MemoryRepository(fixture.book, fixture.source),
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 1,
      rejected: 0,
    });
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(true);
    expect(remote.documents.has(bookManifestPath(fixture.book.id))).toBe(true);
  });

  it('restores a missing local book only after hash verification', async () => {
    const repository = new MemoryRepository();
    const remote = new MemoryTransport();
    remote.seed(fixture.manifest, fixture.blob);
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      repository,
    );

    await expect(service.pull()).resolves.toMatchObject({
      pulled: 1,
      rejected: 0,
    });
    expect(await repository.getBook(fixture.book.id)).toEqual(fixture.book);
    expect(
      await (await repository.getBookSource(fixture.book.id))?.open(),
    ).toEqual(fixture.blob);
  });

  it('rejects corrupted downloaded bytes without exposing a library record', async () => {
    const repository = new MemoryRepository();
    const remote = new MemoryTransport();
    remote.seed(fixture.manifest, await new Response('corrupt').blob());
    remote.objects.set(fixture.manifest.objectPath, {
      path: fixture.manifest.objectPath,
      revision: 'object-1',
      size: fixture.manifest.size,
      sha256: fixture.manifest.sha256,
    });
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      repository,
    );

    await expect(service.pull()).resolves.toMatchObject({
      pulled: 0,
      rejected: 1,
    });
    expect(await repository.getBook(fixture.book.id)).toBeNull();
  });

  it('retries optimistic manifest conflicts without re-uploading the object', async () => {
    const journal = new MemoryJournal([operation('op-1', fixture.manifest)]);
    const remote = new MemoryTransport();
    remote.conflictsRemaining = 1;
    const service = new BookSyncService(
      remote,
      journal,
      new MemoryRepository(fixture.book, fixture.source),
      { retryDelayMs: 0, wait: async () => undefined },
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 1,
      conflicts: 1,
    });
    expect(
      remote.events.filter((event) => event === 'upload-object'),
    ).toHaveLength(1);
  });

  it('does not publish or acknowledge a manifest after an interrupted object upload', async () => {
    const journal = new MemoryJournal([operation('op-1', fixture.manifest)]);
    const remote = new MemoryTransport();
    remote.failObjectUpload = true;
    const service = new BookSyncService(
      remote,
      journal,
      new MemoryRepository(fixture.book, fixture.source),
    );

    await expect(service.push()).rejects.toThrow('Upload interrupted');
    expect(remote.documents.size).toBe(0);
    expect(await journal.pending()).toHaveLength(1);
  });

  it('converges two offline libraries without losing either publication', async () => {
    const second = await bookFixture('second publication', 'Second.pdf', 'pdf');
    const remote = new MemoryTransport();
    const firstDevice = new MemoryRepository(fixture.book, fixture.source);
    const secondDevice = new MemoryRepository(second.book, second.source);

    await new BookSyncService(
      remote,
      new MemoryJournal(),
      firstDevice,
    ).synchronize();
    await new BookSyncService(
      remote,
      new MemoryJournal(),
      secondDevice,
    ).synchronize();
    await new BookSyncService(
      remote,
      new MemoryJournal(),
      firstDevice,
    ).synchronize();

    expect(await firstDevice.listBooks()).toHaveLength(2);
    expect(await secondDevice.listBooks()).toHaveLength(2);
    expect(remote.objects.size).toBe(2);
    expect(remote.documents.size).toBe(2);
  });
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  readonly objects = new Map<string, RemoteObject>();
  readonly objectContents = new Map<string, Blob>();
  readonly events: string[] = [];
  conflictsRemaining = 0;
  failObjectUpload = false;
  private revision = 0;

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    return [...this.documents.values()].filter((document) =>
      document.path.startsWith(prefix),
    );
  }

  async read(path: string): Promise<RemoteDocument | null> {
    return this.documents.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new SyncConflictError();
    }
    this.events.push('write-document');
    const document = {
      path: request.path,
      content: request.content,
      revision: `document-${++this.revision}`,
    };
    this.documents.set(request.path, document);
    return document;
  }

  async headObject(path: string): Promise<RemoteObject | null> {
    return this.objects.get(path) ?? null;
  }

  async downloadObject(path: string): Promise<Blob> {
    const blob = this.objectContents.get(path);
    if (!blob) {
      throw new Error('Object not found');
    }
    return blob;
  }

  async uploadObject(request: ObjectUploadRequest): Promise<RemoteObject> {
    this.events.push('upload-object');
    if (this.failObjectUpload) {
      throw new Error('Upload interrupted');
    }
    const object = {
      path: request.path,
      revision: `object-${++this.revision}`,
      size: request.size,
      sha256: request.sha256,
    };
    this.objects.set(request.path, object);
    this.objectContents.set(request.path, request.content);
    return object;
  }

  seed(manifest: BookSyncManifest, blob: Blob): void {
    this.documents.set(bookManifestPath(manifest.bookId), {
      path: bookManifestPath(manifest.bookId),
      revision: 'document-1',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    this.objects.set(manifest.objectPath, {
      path: manifest.objectPath,
      revision: 'object-1',
      size: blob.size,
      sha256: manifest.sha256,
    });
    this.objectContents.set(manifest.objectPath, blob);
  }
}

class MemoryJournal implements SyncOperationJournal {
  acknowledged: string[] = [];

  constructor(private operations: SyncOperation[] = []) {}

  async append(operation: NewSyncOperation): Promise<SyncOperation> {
    const appended: SyncOperation = {
      ...operation,
      id: `op-${this.operations.length + 1}`,
      revision: this.operations.length + 1,
      createdAt: '2026-07-25T00:00:00.000Z',
    };
    this.operations.push(appended);
    return appended;
  }

  async pending(): Promise<readonly SyncOperation[]> {
    return this.operations;
  }

  async acknowledge(operationIds: readonly string[]): Promise<void> {
    this.acknowledged.push(...operationIds);
    this.operations = this.operations.filter(
      (operation) => !operationIds.includes(operation.id),
    );
  }
}

class MemoryRepository implements LibraryRepository {
  private readonly books = new Map<string, BookRecord>();
  private readonly sources = new Map<string, BookSource>();
  private readonly progress = new Map<string, ReadingProgress>();
  private readonly bookmarks = new Map<string, PublicationBookmark>();
  private readonly annotations = new Map<string, PublicationAnnotation>();
  private readonly preferences = new Map<
    PublicationFormat,
    ReaderPreferences
  >();

  constructor(book?: BookRecord, source?: BookSource) {
    if (book && source) {
      this.books.set(book.id, book);
      this.sources.set(book.id, source);
    }
  }

  async listBooks(): Promise<readonly BookRecord[]> {
    return [...this.books.values()];
  }

  async getBook(bookId: string): Promise<BookRecord | null> {
    return this.books.get(bookId) ?? null;
  }

  async getBookSource(bookId: string): Promise<BookSource | null> {
    return this.sources.get(bookId) ?? null;
  }

  async getBookCover(): Promise<Blob | null> {
    return null;
  }

  async importBook(): Promise<BookRecord> {
    throw new Error('Not used');
  }

  async storeSyncedBook(book: BookRecord, source: BookSource): Promise<void> {
    this.books.set(book.id, book);
    this.sources.set(book.id, source);
  }

  async updateMetadata(
    bookId: string,
    metadata: PublicationMetadata,
  ): Promise<BookRecord> {
    const book = this.books.get(bookId);
    if (!book) {
      throw new Error('Book not found');
    }
    const updated = {
      ...book,
      title: metadata.title,
      authors: [...metadata.authors],
    };
    this.books.set(bookId, updated);
    return updated;
  }

  async removeBook(bookId: string): Promise<void> {
    this.books.delete(bookId);
    this.sources.delete(bookId);
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
}

function operation(id: string, payload: BookSyncManifest): SyncOperation {
  return {
    id,
    entity: 'book',
    entityId: payload.bookId,
    operation: 'upsert',
    revision: Number(id.replace(/\D/g, '')) || 1,
    createdAt: payload.updatedAt,
    payload,
  };
}

async function bookFixture(
  contents = 'valid EPUB fixture bytes',
  fileName = 'Fixture.epub',
  format: PublicationFormat = 'epub',
) {
  const mediaType =
    format === 'epub' ? 'application/epub+zip' : 'application/pdf';
  const blob = await new Response(contents, {
    headers: { 'Content-Type': mediaType },
  }).blob();
  const digest = await crypto.subtle.digest('SHA-256', await blobBytes(blob));
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const book: BookRecord = {
    id: `sha256:${sha256}`,
    format,
    fileName,
    mediaType,
    size: blob.size,
    title: fileName.replace(/\.(epub|pdf)$/i, ''),
    authors: ['Reader'],
    importedAt: '2026-07-25T00:00:00.000Z',
  };
  const source: BookSource = {
    name: book.fileName,
    mediaType: book.mediaType,
    size: blob.size,
    open: async () => blob,
  };
  return {
    blob,
    book,
    source,
    manifest: createBookSyncManifest(book, '2026-07-25T01:00:00.000Z', '1.0.0'),
  };
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () =>
      resolve(reader.result as ArrayBuffer),
    );
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read fixture')),
    );
    reader.readAsArrayBuffer(blob);
  });
}
