import {
  BookRecord,
  LibraryRepository,
  NewSyncOperation,
  PublicationBookmark,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  BookmarkSyncService,
  bookmarkDocumentPath,
} from './bookmark-sync-service';
import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';

const BOOK: BookRecord = {
  id: `sha256:${'a'.repeat(64)}`,
  format: 'pdf',
  fileName: 'book.pdf',
  mediaType: 'application/pdf',
  size: 10,
  title: 'Book',
  authors: [],
  importedAt: '2026-07-25T08:00:00.000Z',
};

const BOOKMARK: PublicationBookmark = {
  schemaVersion: 1,
  id: '5d9b453a-620e-4ca1-a7fa-1f60d4fb6f62',
  bookId: BOOK.id,
  format: 'pdf',
  deviceId: 'device-a',
  locator: {
    href: '',
    type: 'application/pdf',
    title: 'Page 3',
    locations: { fragments: ['page=3'], position: 3 },
  },
  label: 'Page 3',
  createdAt: '2026-07-25T08:30:00.000Z',
  updatedAt: '2026-07-25T08:30:00.000Z',
};

describe('BookmarkSyncService', () => {
  it('pushes complete bookmark records and acknowledges their journal entries', async () => {
    const remote = new MemoryTransport();
    const journal = new MemoryJournal([operation('bookmark-op', BOOKMARK)]);
    const repository = bookmarkRepository(BOOKMARK);
    const service = new BookmarkSyncService(remote, journal, repository);

    const result = await service.push();
    const document = remote.documents.get(bookmarkDocumentPath(BOOKMARK));

    expect(result).toMatchObject({ pushed: 1, rejected: 0 });
    expect(journal.acknowledged).toEqual(['bookmark-op']);
    expect(JSON.parse(document?.content ?? '')).toEqual(BOOKMARK);
  });

  it('creates a pending bookmark without a preflight read or prefix list', async () => {
    const remote = new MemoryTransport();
    const pending = operation('bookmark-op', BOOKMARK);
    const journal = new MemoryJournal([pending]);
    const service = new BookmarkSyncService(
      remote,
      journal,
      bookmarkRepository(BOOKMARK),
    );

    await expect(service.synchronizePending([pending])).resolves.toMatchObject({
      pushed: 1,
      rejected: 0,
    });

    expect(remote.listRequests).toBe(0);
    expect(remote.readRequests).toBe(0);
    expect(journal.acknowledged).toEqual(['bookmark-op']);
  });

  it('falls back to one exact read when a create candidate already exists remotely', async () => {
    const remote = new MemoryTransport([
      remoteDocument(BOOKMARK, `${JSON.stringify(BOOKMARK, null, 2)}\n`),
    ]);
    const pending = operation('bookmark-op', BOOKMARK);
    const journal = new MemoryJournal([pending]);
    const service = new BookmarkSyncService(
      remote,
      journal,
      bookmarkRepository(BOOKMARK),
    );

    await expect(service.synchronizePending([pending])).resolves.toMatchObject({
      pushed: 0,
      conflicts: 1,
      rejected: 0,
    });

    expect(remote.readRequests).toBe(1);
    expect(journal.acknowledged).toEqual(['bookmark-op']);
  });

  it('publishes the latest local bookmark when it changed after the batch snapshot', async () => {
    const remote = new MemoryTransport();
    const current = {
      ...BOOKMARK,
      label: 'Latest local label',
      updatedAt: '2026-07-25T08:31:00.000Z',
    };
    const pending = operation('bookmark-op', BOOKMARK);
    const service = new BookmarkSyncService(
      remote,
      new MemoryJournal([pending]),
      bookmarkRepository(current),
    );

    await service.synchronizePending([pending]);

    expect(
      JSON.parse(
        remote.documents.get(bookmarkDocumentPath(current))?.content ?? '',
      ),
    ).toEqual(current);
  });

  it('reuses the pulled snapshot and reports no push for an identical bookmark', async () => {
    const remote = new MemoryTransport([
      remoteDocument(BOOKMARK, `${JSON.stringify(BOOKMARK, null, 2)}\n`),
    ]);
    const service = new BookmarkSyncService(
      remote,
      new MemoryJournal(),
      bookmarkRepository(BOOKMARK),
    );

    await expect(service.synchronize()).resolves.toMatchObject({
      pushed: 0,
      rejected: 0,
    });
    expect(remote.readRequests).toBe(0);
  });

  it('pulls a newer deletion tombstone without resurrecting the bookmark', async () => {
    const deletedAt = '2026-07-25T09:00:00.000Z';
    const tombstone: PublicationBookmark = {
      ...BOOKMARK,
      deviceId: 'device-b',
      updatedAt: deletedAt,
      deletedAt,
    };
    const remote = new MemoryTransport([
      remoteDocument(tombstone, JSON.stringify(tombstone)),
    ]);
    const repository = bookmarkRepository(BOOKMARK);
    const service = new BookmarkSyncService(
      remote,
      new MemoryJournal(),
      repository,
    );

    const result = await service.pull();

    expect(result).toMatchObject({ pulled: 1, rejected: 0 });
    await expect(repository.getBookmark(BOOKMARK.id)).resolves.toEqual(
      tombstone,
    );
    await expect(repository.listBookmarks(BOOK.id)).resolves.toEqual([]);
  });

  it('rejects malformed or orphaned remote bookmark documents', async () => {
    const orphan = {
      ...BOOKMARK,
      bookId: `sha256:${'b'.repeat(64)}`,
    };
    const remote = new MemoryTransport([
      {
        path: bookmarkDocumentPath(BOOKMARK),
        content: '{invalid',
        revision: 'bad-json',
      },
      remoteDocument(orphan, JSON.stringify(orphan)),
    ]);
    const service = new BookmarkSyncService(
      remote,
      new MemoryJournal(),
      bookmarkRepository(),
    );

    await expect(service.pull()).resolves.toMatchObject({
      pulled: 0,
      rejected: 2,
    });
  });

  it('retries optimistic conflicts before publishing the latest bookmark', async () => {
    const remote = new MemoryTransport();
    remote.conflictsRemaining = 1;
    const wait = vi.fn(async () => undefined);
    const service = new BookmarkSyncService(
      remote,
      new MemoryJournal([operation('retry-op', BOOKMARK)]),
      bookmarkRepository(BOOKMARK),
      { retryDelayMs: 1, wait },
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 1,
      conflicts: 1,
    });
    expect(wait).toHaveBeenCalledWith(1);
  });
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  conflictsRemaining = 0;
  readRequests = 0;
  listRequests = 0;

  constructor(documents: readonly RemoteDocument[] = []) {
    documents.forEach((document) =>
      this.documents.set(document.path, document),
    );
  }

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    this.listRequests += 1;
    return [...this.documents.values()].filter((document) =>
      document.path.startsWith(prefix),
    );
  }

  async read(path: string): Promise<RemoteDocument | null> {
    this.readRequests += 1;
    return this.documents.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new SyncConflictError();
    }
    const current = this.documents.get(request.path);
    if (
      (request.expectedRevision === undefined && current) ||
      (request.expectedRevision !== undefined &&
        request.expectedRevision !== current?.revision)
    ) {
      throw new SyncConflictError();
    }
    const document: RemoteDocument = {
      path: request.path,
      content: request.content,
      revision: String(this.documents.size + 1),
    };
    this.documents.set(document.path, document);
    return document;
  }

  async headObject(): Promise<null> {
    return null;
  }

  async downloadObject(): Promise<Blob> {
    throw new Error('Not used');
  }

  async uploadObject(): Promise<never> {
    throw new Error('Not used');
  }
}

class MemoryJournal implements SyncOperationJournal {
  readonly acknowledged: string[] = [];

  constructor(private operations: SyncOperation[] = []) {}

  async append(operation: NewSyncOperation): Promise<SyncOperation> {
    void operation;
    throw new Error('Not used');
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

function bookmarkRepository(initial?: PublicationBookmark): LibraryRepository {
  const bookmarks = new Map<string, PublicationBookmark>();
  if (initial) {
    bookmarks.set(initial.id, initial);
  }
  return {
    getBook: async (bookId) => (bookId === BOOK.id ? BOOK : null),
    getBookmark: async (bookmarkId) => bookmarks.get(bookmarkId) ?? null,
    listBookmarks: async (bookId, includeDeleted = false) =>
      [...bookmarks.values()].filter(
        (bookmark) =>
          (bookId === undefined || bookmark.bookId === bookId) &&
          (includeDeleted || bookmark.deletedAt === undefined),
      ),
    saveBookmark: async (bookmark) => {
      bookmarks.set(bookmark.id, bookmark);
    },
  } as unknown as LibraryRepository;
}

function operation(id: string, bookmark: PublicationBookmark): SyncOperation {
  return {
    id,
    entity: 'bookmark',
    entityId: bookmark.id,
    operation: 'upsert',
    revision: 1,
    createdAt: bookmark.updatedAt,
    payload: bookmark,
  };
}

function remoteDocument(
  bookmark: PublicationBookmark,
  content: string,
): RemoteDocument {
  return {
    path: bookmarkDocumentPath(bookmark),
    content,
    revision: bookmark.updatedAt,
  };
}
