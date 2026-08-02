import {
  BookRecord,
  BookSource,
  LibraryRepository,
  AddLogicalBookVariantResult,
  LogicalBookChange,
  LogicalBookFormatPreference,
  LogicalBookId,
  LogicalBookRecord,
  LogicalBookMutationResult,
  LogicalLibrarySnapshot,
  logicalBookFromVariant,
  MembershipReconciliation,
  NewSyncOperation,
  PublicationFormat,
  PublicationBookmark,
  PublicationAnnotation,
  PublicationMetadata,
  ReaderPreferences,
  ReadingProgress,
  SyncOperation,
  SyncOperationJournal,
  VariantAvailability,
} from '@omnia-reader/reader/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKS_ROOT,
  BookSyncManifest,
  LEGACY_BOOKS_ROOT,
  bookDeletionPath,
  bookManifestPath,
  createBookSyncDeletionTombstone,
  createBookSyncManifest,
  legacyBookManifestPath,
  legacyBookObjectPath,
} from './book-sync-manifest';
import { BookSyncService } from './book-sync-service';
import { BookSyncExclusions } from './book-sync-exclusions';
import {
  DocumentDeleteRequest,
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectDownloadOptions,
  ObjectDeleteRequest,
  ObjectTransferProgress,
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
    expect(remote.documents.has(bookManifestPath(fixture.book))).toBe(true);
  });

  it('reports no push when the publication and manifest are already identical', async () => {
    const remote = new MemoryTransport();
    remote.seed(createBookSyncManifest(fixture.book), fixture.blob);
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      new MemoryRepository(fixture.book, fixture.source),
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 0,
      rejected: 0,
    });
    expect(remote.events).toEqual([]);
  });

  it('reuses one remote snapshot and skips current publication verification', async () => {
    const remote = new MemoryTransport();
    remote.seed(createBookSyncManifest(fixture.book), fixture.blob);
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      new MemoryRepository(fixture.book, fixture.source),
    );

    await expect(service.synchronize()).resolves.toMatchObject({
      pushed: 0,
      rejected: 0,
    });
    await expect(service.synchronize()).resolves.toMatchObject({
      pushed: 0,
      rejected: 0,
    });

    expect(
      remote.requests.filter((request) => request === `list:${BOOKS_ROOT}`),
    ).toHaveLength(2);
    expect(
      remote.requests.filter(
        (request) => request === `list:${LEGACY_BOOKS_ROOT}`,
      ),
    ).toHaveLength(0);
    expect(
      remote.requests.filter(
        (request) => request === `read:${bookManifestPath(fixture.book)}`,
      ),
    ).toHaveLength(0);
    expect(
      remote.requests.filter(
        (request) => request === `head:${fixture.manifest.objectPath}`,
      ),
    ).toHaveLength(0);
  });

  it('requires the exact canonical manifest path before skipping publication work', async () => {
    const remote = new MemoryTransport();
    const misplaced = {
      ...fixture.manifest,
      fileName: 'different-name.epub',
    };
    remote.seed(misplaced, fixture.blob);
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      new MemoryRepository(fixture.book, fixture.source),
    );

    await expect(service.synchronize()).resolves.toMatchObject({ pushed: 1 });

    expect(remote.documents.has(bookManifestPath(fixture.book))).toBe(true);
    expect(remote.documents.has(bookManifestPath(misplaced))).toBe(true);
  });

  it('removes the obsolete hash-addressed layout after publishing named files', async () => {
    const remote = new MemoryTransport();
    const legacyManifest = legacyBookManifestPath(fixture.book.id);
    const legacyObject = legacyBookObjectPath(
      fixture.book.id,
      fixture.book.format,
    );
    remote.documents.set(legacyManifest, {
      path: legacyManifest,
      revision: 'legacy-document',
      content: '{"schemaVersion":1}\n',
    });
    remote.objects.set(legacyObject, {
      path: legacyObject,
      revision: 'legacy-object',
      size: fixture.manifest.size,
      sha256: fixture.manifest.sha256,
    });
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      new MemoryRepository(fixture.book, fixture.source),
    );

    await service.synchronize();

    expect(remote.documents.has(legacyManifest)).toBe(false);
    expect(remote.objects.has(legacyObject)).toBe(false);
    expect(remote.documents.has(bookManifestPath(fixture.book))).toBe(true);
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(true);
  });

  it('retries legacy cleanup after a failed check and stops after success', async () => {
    const remote = new MemoryTransport();
    remote.failNextLegacyList = true;
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      new MemoryRepository(fixture.book, fixture.source),
    );

    await expect(service.synchronize()).rejects.toThrow(
      'Legacy layout unavailable',
    );
    await expect(service.synchronize()).resolves.toMatchObject({ pushed: 0 });
    await expect(service.synchronize()).resolves.toMatchObject({ pushed: 0 });

    expect(
      remote.requests.filter(
        (request) => request === `list:${LEGACY_BOOKS_ROOT}`,
      ),
    ).toHaveLength(2);
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

  it('propagates an excluded local deletion to the remote backup', async () => {
    const repository = new MemoryRepository();
    const remote = new MemoryTransport();
    remote.seed(fixture.manifest, fixture.blob);
    const exclusions = new MemoryBookSyncExclusions([fixture.book.id]);
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      repository,
      { exclusions },
    );

    await expect(service.synchronize()).resolves.toMatchObject({
      pulled: 0,
      pushed: 1,
      rejected: 0,
    });
    expect(await repository.getBook(fixture.book.id)).toBeNull();
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(false);
    expect(remote.documents.has(bookManifestPath(fixture.book))).toBe(false);
    expect(remote.documents.has(bookDeletionPath(fixture.book.id))).toBe(true);
  });

  it('pushes a journaled deletion and acknowledges it after remote cleanup', async () => {
    const remote = new MemoryTransport();
    remote.seed(fixture.manifest, fixture.blob);
    const tombstone = createBookSyncDeletionTombstone(
      fixture.book,
      '2026-07-25T03:00:00.000Z',
    );
    const journal = new MemoryJournal([
      {
        id: 'delete-1',
        entity: 'book',
        entityId: fixture.book.id,
        operation: 'delete',
        revision: 2,
        createdAt: tombstone.deletedAt,
        payload: tombstone,
      },
    ]);
    const service = new BookSyncService(
      remote,
      journal,
      new MemoryRepository(),
    );

    await expect(service.push()).resolves.toMatchObject({ pushed: 1 });

    expect(journal.acknowledged).toEqual(['delete-1']);
    expect(remote.documents.has(bookManifestPath(fixture.book))).toBe(false);
    expect(remote.documents.has(bookDeletionPath(fixture.book.id))).toBe(true);
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(false);
  });

  it('reports no push when an excluded remote deletion is already complete', async () => {
    const remote = new MemoryTransport();
    remote.seedTombstone(
      createBookSyncDeletionTombstone(fixture.book, '2026-07-25T03:00:00.000Z'),
    );
    remote.events.length = 0;
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      new MemoryRepository(),
      { exclusions: new MemoryBookSyncExclusions([fixture.book.id]) },
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 0,
      rejected: 0,
    });
    expect(remote.events).toEqual([]);
  });

  it('does not restore a book excluded while its download is in flight', async () => {
    const repository = new MemoryRepository();
    const remote = new MemoryTransport();
    remote.seed(fixture.manifest, fixture.blob);
    const exclusions = new MemoryBookSyncExclusions();
    remote.onDownload = () => exclusions.exclude(fixture.book.id);
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      repository,
      { exclusions },
    );

    await expect(service.pull()).resolves.toMatchObject({
      pulled: 0,
      rejected: 0,
    });
    expect(await repository.getBook(fixture.book.id)).toBeNull();
  });

  it('does not seed an excluded local edition until it is explicitly included', async () => {
    const repository = new MemoryRepository(fixture.book, fixture.source);
    const remote = new MemoryTransport();
    const exclusions = new MemoryBookSyncExclusions([fixture.book.id]);
    const service = new BookSyncService(
      remote,
      new MemoryJournal([operation('op-1', fixture.manifest)]),
      repository,
      { exclusions },
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 0,
      rejected: 0,
    });
    expect(remote.objects.size).toBe(0);
    expect(remote.documents.size).toBe(0);

    exclusions.include(fixture.book.id);
    await expect(service.push()).resolves.toMatchObject({ pushed: 1 });
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(true);
    expect(remote.documents.has(bookManifestPath(fixture.book))).toBe(true);
  });

  it('applies a remote deletion tombstone without deleting the local copy', async () => {
    const repository = new MemoryRepository(fixture.book, fixture.source);
    const remote = new MemoryTransport();
    remote.seed(fixture.manifest, fixture.blob);
    remote.seedTombstone(
      createBookSyncDeletionTombstone(fixture.book, '2026-07-25T03:00:00.000Z'),
    );
    const exclusions = new MemoryBookSyncExclusions();
    const service = new BookSyncService(
      remote,
      new MemoryJournal(),
      repository,
      { exclusions },
    );

    await expect(service.pull()).resolves.toMatchObject({ pulled: 1 });
    await expect(service.pull()).resolves.toMatchObject({ pulled: 0 });
    expect(exclusions.isExcluded(fixture.book.id)).toBe(true);
    expect(await repository.getBook(fixture.book.id)).toEqual(fixture.book);
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(false);
  });

  it('discards a stale pending upload when a newer remote deletion wins', async () => {
    const remote = new MemoryTransport();
    remote.seed(fixture.manifest, fixture.blob);
    remote.seedTombstone(
      createBookSyncDeletionTombstone(fixture.book, '2026-07-25T03:00:00.000Z'),
    );
    const journal = new MemoryJournal([operation('op-1', fixture.manifest)]);
    const exclusions = new MemoryBookSyncExclusions();
    const service = new BookSyncService(
      remote,
      journal,
      new MemoryRepository(fixture.book, fixture.source),
      { exclusions },
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 1,
      rejected: 0,
    });
    expect(journal.acknowledged).toEqual(['op-1']);
    expect(exclusions.isExcluded(fixture.book.id)).toBe(true);
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(false);
  });

  it('allows an explicit newer reimport to replace a remote tombstone', async () => {
    const remote = new MemoryTransport();
    remote.seedTombstone(
      createBookSyncDeletionTombstone(fixture.book, '2026-07-25T03:00:00.000Z'),
    );
    const manifest = {
      ...fixture.manifest,
      updatedAt: '2026-07-25T04:00:00.000Z',
    };
    const service = new BookSyncService(
      remote,
      new MemoryJournal([operation('op-1', manifest)]),
      new MemoryRepository(fixture.book, fixture.source),
      { exclusions: new MemoryBookSyncExclusions() },
    );

    await expect(service.push()).resolves.toMatchObject({ pushed: 1 });
    expect(remote.objects.has(manifest.objectPath)).toBe(true);
    expect(
      JSON.parse(
        remote.documents.get(bookManifestPath(fixture.book))?.content ?? '{}',
      ),
    ).toMatchObject({ title: manifest.title, updatedAt: manifest.updatedAt });
  });

  it('removes an uploaded object when a tombstone wins the manifest race', async () => {
    const remote = new MemoryTransport();
    remote.beforeWrite = () => {
      remote.beforeWrite = undefined;
      remote.seedTombstone(
        createBookSyncDeletionTombstone(
          fixture.book,
          '2026-07-25T03:00:00.000Z',
        ),
      );
    };
    const journal = new MemoryJournal([operation('op-1', fixture.manifest)]);
    const exclusions = new MemoryBookSyncExclusions();
    const service = new BookSyncService(
      remote,
      journal,
      new MemoryRepository(fixture.book, fixture.source),
      {
        exclusions,
        retryDelayMs: 0,
        wait: async () => undefined,
      },
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 1,
      conflicts: 0,
      rejected: 0,
    });
    expect(remote.objects.has(fixture.manifest.objectPath)).toBe(false);
    expect(exclusions.isExcluded(fixture.book.id)).toBe(true);
    expect(journal.acknowledged).toEqual(['op-1']);
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

  it('reports publication transfer progress to the synchronization caller', async () => {
    const progress: ObjectTransferProgress[] = [];
    const remote = new MemoryTransport();
    const service = new BookSyncService(
      remote,
      new MemoryJournal([operation('op-1', fixture.manifest)]),
      new MemoryRepository(fixture.book, fixture.source),
    );

    await service.push({
      onTransferProgress: (update) => progress.push(update),
    });

    expect(progress).toEqual([
      {
        direction: 'upload',
        path: fixture.manifest.objectPath,
        transferredBytes: 0,
        totalBytes: fixture.manifest.size,
      },
      {
        direction: 'upload',
        path: fixture.manifest.objectPath,
        transferredBytes: fixture.manifest.size,
        totalBytes: fixture.manifest.size,
      },
    ]);
  });

  it('keeps the manifest pending when publication synchronization is cancelled', async () => {
    const controller = new AbortController();
    const journal = new MemoryJournal([operation('op-1', fixture.manifest)]);
    const remote = new MemoryTransport();
    const service = new BookSyncService(
      remote,
      journal,
      new MemoryRepository(fixture.book, fixture.source),
    );

    await expect(
      service.push({
        signal: controller.signal,
        onTransferProgress: () =>
          controller.abort(
            new DOMException('Synchronization cancelled', 'AbortError'),
          ),
      }),
    ).rejects.toThrow('Synchronization cancelled');

    expect(remote.objects.size).toBe(0);
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
    expect(remote.documents.size).toBe(3);
    expect(
      remote.documents.get('.omnia-reader/v1/README.md')?.content,
    ).toContain('[Fixture](library/Fixture--');
  });
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  readonly objects = new Map<string, RemoteObject>();
  readonly objectContents = new Map<string, Blob>();
  readonly events: string[] = [];
  readonly requests: string[] = [];
  conflictsRemaining = 0;
  failObjectUpload = false;
  failNextLegacyList = false;
  beforeWrite: (() => void) | undefined;
  onDownload: (() => void) | undefined;
  private revision = 0;

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    this.requests.push(`list:${prefix}`);
    if (prefix === LEGACY_BOOKS_ROOT && this.failNextLegacyList) {
      this.failNextLegacyList = false;
      throw new Error('Legacy layout unavailable');
    }
    return [...this.documents.values()].filter((document) =>
      document.path.startsWith(prefix),
    );
  }

  async read(path: string): Promise<RemoteDocument | null> {
    this.requests.push(`read:${path}`);
    return this.documents.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new SyncConflictError();
    }
    this.beforeWrite?.();
    const current = this.documents.get(request.path);
    if (
      (current && request.expectedRevision !== current.revision) ||
      (!current && request.expectedRevision !== undefined)
    ) {
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

  async deleteDocument(request: DocumentDeleteRequest): Promise<void> {
    const current = this.documents.get(request.path);
    if (
      current &&
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    ) {
      throw new SyncConflictError();
    }
    this.documents.delete(request.path);
    this.events.push('delete-document');
  }

  async headObject(path: string): Promise<RemoteObject | null> {
    this.requests.push(`head:${path}`);
    return this.objects.get(path) ?? null;
  }

  async downloadObject(
    path: string,
    options: ObjectDownloadOptions = {},
  ): Promise<Blob> {
    const blob = this.objectContents.get(path);
    if (!blob) {
      throw new Error('Object not found');
    }
    this.onDownload?.();
    options.onProgress?.({
      direction: 'download',
      path,
      transferredBytes: blob.size,
      totalBytes: options.expectedSize ?? blob.size,
    });
    return blob;
  }

  async uploadObject(request: ObjectUploadRequest): Promise<RemoteObject> {
    this.events.push('upload-object');
    if (this.failObjectUpload) {
      throw new Error('Upload interrupted');
    }
    request.onProgress?.({
      direction: 'upload',
      path: request.path,
      transferredBytes: 0,
      totalBytes: request.size,
    });
    if (request.signal?.aborted) {
      throw request.signal.reason;
    }
    const object = {
      path: request.path,
      revision: `object-${++this.revision}`,
      size: request.size,
      sha256: request.sha256,
    };
    this.objects.set(request.path, object);
    this.objectContents.set(request.path, request.content);
    request.onProgress?.({
      direction: 'upload',
      path: request.path,
      transferredBytes: request.size,
      totalBytes: request.size,
    });
    return object;
  }

  async deleteObject(request: ObjectDeleteRequest): Promise<void> {
    const current = this.objects.get(request.path);
    if (
      current &&
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    ) {
      throw new SyncConflictError();
    }
    this.objects.delete(request.path);
    this.objectContents.delete(request.path);
    this.events.push('delete-object');
  }

  seed(manifest: BookSyncManifest, blob: Blob): void {
    this.documents.set(bookManifestPath(manifest), {
      path: bookManifestPath(manifest),
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

  seedTombstone(
    tombstone: ReturnType<typeof createBookSyncDeletionTombstone>,
  ): void {
    this.documents.set(bookDeletionPath(tombstone.bookId), {
      path: bookDeletionPath(tombstone.bookId),
      revision: `document-${++this.revision}`,
      content: `${JSON.stringify(tombstone, null, 2)}\n`,
    });
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

class MemoryBookSyncExclusions implements BookSyncExclusions {
  private readonly bookIds: Set<string>;

  constructor(bookIds: readonly string[] = []) {
    this.bookIds = new Set(bookIds);
  }

  isExcluded(bookId: string): boolean {
    return this.bookIds.has(bookId);
  }

  exclude(bookId: string): void {
    this.bookIds.add(bookId);
  }

  include(bookId: string): void {
    this.bookIds.delete(bookId);
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

  async listLogicalBooks(): Promise<readonly LogicalBookRecord[]> {
    return [...this.books.values()].map((book) => logicalBookFromVariant(book));
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

  async getLogicalBookCover(): Promise<Blob | null> {
    return null;
  }

  async getLogicalBookFormatPreference(): Promise<LogicalBookFormatPreference | null> {
    return null;
  }

  async getLogicalLibrarySnapshot(): Promise<LogicalLibrarySnapshot> {
    const logicalBooks = [...(await this.listLogicalBooks())];
    return {
      revision: JSON.stringify(logicalBooks),
      logicalBooks,
      preferences: [],
      reconciliations: [],
    };
  }

  addVariant(): Promise<AddLogicalBookVariantResult> {
    return Promise.reject(new Error('Not used'));
  }

  associate(): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not used'));
  }

  detachVariant(): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not used'));
  }

  deleteVariant(): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not used'));
  }

  saveLogicalBookFormatPreference(): Promise<LogicalBookChange | null> {
    return Promise.resolve(null);
  }

  reconcileMembership(): Promise<LogicalBookMutationResult> {
    return Promise.reject(new Error('Not used'));
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
    this.sources.set(variantId, source);
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
