import { SyncOperationJournal } from '@omnia-reader/reader/domain';
import {
  LibrarySyncTransport,
  RemoteDocument,
  RemoteObject,
  SyncConflictError,
} from './library-sync-transport';
import {
  LogicalBookStateRepository,
  LogicalBookSyncService,
} from './logical-book-sync-service';
import {
  logicalBookChangePath,
  serializeLogicalBookChange,
} from './logical-book-change';
import {
  emptyLogicalBookState,
  LOGICAL_BOOK_STATE_PATH,
  mergeLogicalBookChangesIntoState,
  parseLogicalBookState,
  serializeLogicalBookState,
} from './logical-book-state';
import { bookObjectPath } from './book-sync-manifest';
import { BookSyncExclusions } from './book-sync-exclusions';

const change = {
  schemaVersion: 1 as const,
  changeId: 'change:device-a:1',
  kind: 'preference' as const,
  parents: [],
  resultingBooks: [],
  removedLogicalBookIds: [],
  preferenceEffects: [],
  createdAt: '2026-07-31T08:00:00.000Z',
  deviceId: 'device-a',
  appVersion: '0.0.0',
};

describe('LogicalBookSyncService', () => {
  it('publishes a local change before acknowledging its journal operation', async () => {
    const remote = new MemoryTransport();
    const acknowledge = vi.fn().mockImplementation(async () => {
      expect(remote.documents.size).toBe(1);
    });
    const journal = {
      pending: vi.fn().mockResolvedValue([
        {
          id: 'operation-1',
          entity: 'logical-book-change',
          entityId: change.changeId,
          operation: 'upsert',
          revision: 1,
          createdAt: change.createdAt,
          payload: change,
        },
      ]),
      acknowledge,
      append: vi.fn(),
    } as unknown as SyncOperationJournal;
    const replaceLogicalBookState = vi.fn().mockResolvedValue(undefined);
    const repository = {
      getLogicalLibrarySnapshot: vi.fn().mockResolvedValue(emptySnapshot()),
      replaceLogicalBookState,
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).resolves.toMatchObject({ pushed: 1, rejected: 0 });
    expect(remote.listPrefixes).toEqual([]);
    expect(remote.documents.size).toBe(1);
    expect([...remote.documents.keys()]).toEqual([LOGICAL_BOOK_STATE_PATH]);
    expect(replaceLogicalBookState).toHaveBeenCalledWith([], [], []);
    expect(acknowledge).toHaveBeenCalledWith(['operation-1']);
  });

  it('acknowledges every journal view of one immutable logical change', async () => {
    const remote = new MemoryTransport();
    const acknowledge = vi.fn();
    const journal = {
      pending: vi.fn().mockResolvedValue([
        {
          id: 'operation-1',
          entity: 'logical-book-change',
          entityId: change.changeId,
          operation: 'upsert',
          revision: 1,
          createdAt: change.createdAt,
          payload: change,
        },
        {
          id: `logical-book-outbox:${change.changeId}`,
          entity: 'logical-book-change',
          entityId: change.changeId,
          operation: 'upsert',
          revision: 1,
          createdAt: change.createdAt,
          payload: change,
        },
      ]),
      acknowledge,
      append: vi.fn(),
    } as unknown as SyncOperationJournal;
    const repository = {
      getLogicalLibrarySnapshot: vi.fn().mockResolvedValue(emptySnapshot()),
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).resolves.toMatchObject({ pushed: 1, rejected: 0 });

    const state = parseLogicalBookState(
      remote.documents.get(LOGICAL_BOOK_STATE_PATH)?.content ?? '',
    );
    expect(serializeLogicalBookState(state)).toBe(
      serializeLogicalBookState(
        mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [change]),
      ),
    );
    expect(acknowledge).toHaveBeenCalledWith([
      'operation-1',
      `logical-book-outbox:${change.changeId}`,
    ]);
  });

  it('does not acknowledge local work when publication fails', async () => {
    const remote = new MemoryTransport();
    remote.writeError = new Error('provider unavailable');
    const acknowledge = vi.fn();
    const journal = {
      pending: vi.fn().mockResolvedValue([
        {
          id: 'operation-1',
          entity: 'logical-book-change',
          entityId: change.changeId,
          operation: 'upsert',
          revision: 1,
          createdAt: change.createdAt,
          payload: change,
        },
      ]),
      acknowledge,
      append: vi.fn(),
    } as unknown as SyncOperationJournal;
    const repository = {
      getLogicalLibrarySnapshot: vi.fn().mockResolvedValue(emptySnapshot()),
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).rejects.toThrow('provider unavailable');
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('does not restore a publication removed by a later logical change', async () => {
    const remote = new MemoryTransport();
    const digest = 'a'.repeat(64);
    const variant = {
      id: `sha256:${digest}`,
      format: 'epub' as const,
      fileName: 'Removed.epub',
      mediaType: 'application/epub+zip',
      size: 4,
      title: 'Removed',
      authors: [],
      importedAt: '2026-07-31T08:00:00.000Z',
    };
    const logicalBookId = `logical:sha256:${digest}` as const;
    const upsert = {
      schemaVersion: 1 as const,
      changeId: 'change:device-a:upsert',
      kind: 'bootstrap' as const,
      parents: [],
      resultingBooks: [
        {
          schemaVersion: 1 as const,
          id: logicalBookId,
          title: 'Removed',
          authors: [],
          importedAt: variant.importedAt,
          updatedAt: variant.importedAt,
          coverState: 'pending' as const,
          variants: { epub: variant.id },
        },
      ],
      removedLogicalBookIds: [],
      variantEffects: [
        {
          operation: 'upsert' as const,
          variant,
          objectPath: `.omnia-reader/library/Removed--${digest.slice(0, 12)}/Removed.epub`,
        },
      ],
      preferenceEffects: [],
      resolvesConflictIds: [],
      createdAt: variant.importedAt,
      deviceId: 'device-a',
      appVersion: '0.0.0',
    };
    const removal = {
      ...change,
      changeId: 'change:device-a:remove',
      kind: 'delete-book' as const,
      parents: [],
      removedLogicalBookIds: [logicalBookId],
      variantEffects: [
        {
          operation: 'delete' as const,
          variantId: variant.id,
          format: 'epub' as const,
        },
      ],
      createdAt: '2026-07-31T09:00:00.000Z',
    };
    for (const current of [upsert, removal]) {
      const path = logicalBookChangePath(current.changeId);
      remote.documents.set(path, {
        path,
        content: serializeLogicalBookChange(current),
        revision: current.changeId,
      });
    }
    remote.documents.set(
      '.omnia-reader/logical-books/checkpoints/obsolete/page-0000.json',
      {
        path: '.omnia-reader/logical-books/checkpoints/obsolete/page-0000.json',
        content: '{}',
        revision: 'checkpoint-1',
      },
    );
    const headObject = vi.spyOn(remote, 'headObject');
    const repository = {
      listLogicalBooks: vi.fn().mockResolvedValue([]),
      getBook: vi.fn().mockResolvedValue(null),
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;
    const journal = {
      pending: vi.fn().mockResolvedValue([]),
      append: vi.fn(),
      acknowledge: vi.fn(),
    } as unknown as SyncOperationJournal;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).resolves.toMatchObject({ rejected: 0 });
    expect(headObject).not.toHaveBeenCalled();
    expect(repository.replaceLogicalBookState).toHaveBeenCalledWith([], [], []);
    expect([...remote.documents.keys()]).toEqual([LOGICAL_BOOK_STATE_PATH]);
    expect(
      parseLogicalBookState(
        remote.documents.get(LOGICAL_BOOK_STATE_PATH)?.content ?? '',
      ).removedBooks,
    ).toHaveLength(1);
    expect(remote.deletedEntries).toHaveLength(3);
  });

  it('retries an optimistic state conflict before acknowledging local work', async () => {
    const remote = new MemoryTransport();
    remote.writeConflicts = 1;
    const acknowledge = vi.fn();
    const journal = journalWithChange(acknowledge);
    const repository = {
      getLogicalLibrarySnapshot: vi.fn().mockResolvedValue(emptySnapshot()),
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).resolves.toMatchObject({ pushed: 1 });

    expect(remote.writeAttempts).toBe(2);
    expect(acknowledge).toHaveBeenCalledWith(['operation-1']);
  });

  it('preserves journal work when optimistic retries are exhausted', async () => {
    const remote = new MemoryTransport();
    remote.writeConflicts = 3;
    const acknowledge = vi.fn();
    const journal = journalWithChange(acknowledge);
    const repository = {
      getLogicalLibrarySnapshot: vi.fn().mockResolvedValue(emptySnapshot()),
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).rejects.toThrow('simulated state conflict');

    expect(remote.writeAttempts).toBe(3);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('restores a remote-only active variant from the canonical state', async () => {
    const remote = new MemoryTransport();
    const publication = publicationFixture();
    const state = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      publication.change,
    ]);
    remote.documents.set(LOGICAL_BOOK_STATE_PATH, {
      path: LOGICAL_BOOK_STATE_PATH,
      content: serializeLogicalBookState(state),
      revision: 'state-1',
    });
    remote.objects.set(bookObjectPath(publication.variant), {
      path: bookObjectPath(publication.variant),
      revision: 'object-1',
      size: publication.variant.size,
      sha256: publication.variant.id.slice('sha256:'.length),
    });
    remote.blobs.set(bookObjectPath(publication.variant), new Blob(['book']));
    const storeSyncedBook = vi.fn().mockResolvedValue(undefined);
    const repository = {
      getBook: vi.fn().mockResolvedValue(null),
      storeSyncedBook,
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;
    const journal = {
      pending: vi.fn().mockResolvedValue([]),
      acknowledge: vi.fn(),
    } as unknown as SyncOperationJournal;

    await new LogicalBookSyncService(remote, journal, repository).synchronize();

    expect(storeSyncedBook).toHaveBeenCalledWith(
      publication.variant,
      expect.anything(),
    );
    expect(repository.replaceLogicalBookState).toHaveBeenCalledWith(
      [publication.logicalBook],
      [],
      [],
    );
  });

  it('retains logical membership without recreating an excluded remote backup', async () => {
    const remote = new MemoryTransport();
    const publication = publicationFixture();
    const state = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      publication.change,
    ]);
    remote.documents.set(LOGICAL_BOOK_STATE_PATH, {
      path: LOGICAL_BOOK_STATE_PATH,
      content: serializeLogicalBookState(state),
      revision: 'state-1',
    });
    const repository = {
      getBook: vi.fn().mockResolvedValue(publication.variant),
      getBookSource: vi.fn().mockResolvedValue({
        name: publication.variant.fileName,
        mediaType: publication.variant.mediaType,
        size: publication.variant.size,
        open: () => Promise.resolve(new Blob(['book'])),
      }),
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;
    const journal = {
      pending: vi.fn().mockResolvedValue([]),
      acknowledge: vi.fn(),
    } as unknown as SyncOperationJournal;
    const exclusions = {
      isExcluded: vi
        .fn()
        .mockImplementation(
          (bookId: string) => bookId === publication.variant.id,
        ),
      exclude: vi.fn(),
      include: vi.fn(),
    } satisfies BookSyncExclusions;

    await new LogicalBookSyncService(
      remote,
      journal,
      repository,
      exclusions,
    ).synchronize();

    expect(remote.objects.has(bookObjectPath(publication.variant))).toBe(false);
    expect(repository.getBook).not.toHaveBeenCalled();
    expect(repository.getBookSource).not.toHaveBeenCalled();
    expect(repository.replaceLogicalBookState).toHaveBeenCalledWith(
      [publication.logicalBook],
      [],
      [],
    );
  });

  it('seeds the first canonical state from the complete local snapshot', async () => {
    const remote = new MemoryTransport();
    const publication = publicationFixture();
    const repository = {
      getLogicalLibrarySnapshot: vi.fn().mockResolvedValue({
        revision: 'local-1',
        logicalBooks: [publication.logicalBook],
        preferences: [],
        reconciliations: [],
      }),
      getBook: vi.fn().mockResolvedValue(publication.variant),
      getBookSource: vi.fn().mockResolvedValue({
        name: publication.variant.fileName,
        mediaType: publication.variant.mediaType,
        size: publication.variant.size,
        open: () => Promise.resolve(new Blob(['book'])),
      }),
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;
    const journal = {
      pending: vi.fn().mockResolvedValue([]),
      acknowledge: vi.fn(),
      append: vi.fn(),
    } as unknown as SyncOperationJournal;

    await new LogicalBookSyncService(remote, journal, repository).synchronize();

    const state = parseLogicalBookState(
      remote.documents.get(LOGICAL_BOOK_STATE_PATH)?.content ?? '',
    );
    expect(state.books.map((entry) => entry.book)).toEqual([
      publication.logicalBook,
    ]);
    expect(state.variants.map((entry) => entry.variant)).toEqual([
      publication.variant,
    ]);
    expect(journal.append).not.toHaveBeenCalled();
  });

  it('keeps legacy changes and pending work when cleanup fails', async () => {
    const remote = new MemoryTransport();
    const path = logicalBookChangePath(change.changeId);
    remote.documents.set(path, {
      path,
      content: serializeLogicalBookChange(change),
      revision: 'legacy-1',
    });
    remote.deleteError = new Error('cleanup unavailable');
    const acknowledge = vi.fn();
    const repository = {
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(
        remote,
        journalWithChange(acknowledge),
        repository,
      ).synchronize(),
    ).rejects.toThrow('cleanup unavailable');

    expect(remote.documents.has(path)).toBe(true);
    expect(remote.documents.has(LOGICAL_BOOK_STATE_PATH)).toBe(true);
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  readonly listPrefixes: string[] = [];
  readonly deletedEntries: string[] = [];
  readonly objects = new Map<string, RemoteObject>();
  readonly blobs = new Map<string, Blob>();
  writeError: Error | null = null;
  deleteError: Error | null = null;
  writeConflicts = 0;
  writeAttempts = 0;
  private revision = 0;

  list(prefix: string): Promise<readonly RemoteDocument[]> {
    this.listPrefixes.push(prefix);
    return Promise.resolve(
      [...this.documents.values()].filter(
        (document) =>
          document.path === prefix || document.path.startsWith(`${prefix}/`),
      ),
    );
  }

  read(path: string): Promise<RemoteDocument | null> {
    return Promise.resolve(this.documents.get(path) ?? null);
  }

  listEntries(prefix: string) {
    return Promise.resolve(
      [...this.documents.values()]
        .filter(
          (document) =>
            document.path === prefix || document.path.startsWith(`${prefix}/`),
        )
        .map((document) => ({
          path: document.path,
          revision: document.revision,
          kind: 'document' as const,
        })),
    );
  }

  async write(request: {
    path: string;
    content: string;
    expectedRevision?: string;
  }): Promise<RemoteDocument> {
    this.writeAttempts += 1;
    if (this.writeError) throw this.writeError;
    if (this.writeConflicts > 0) {
      this.writeConflicts -= 1;
      throw new SyncConflictError('simulated state conflict');
    }
    const current = this.documents.get(request.path);
    if (
      (current && request.expectedRevision !== current.revision) ||
      (!current && request.expectedRevision !== undefined)
    ) {
      throw new SyncConflictError();
    }
    const document = {
      path: request.path,
      content: request.content,
      revision: String(++this.revision),
    };
    this.documents.set(request.path, document);
    return document;
  }

  headObject(path: string): Promise<RemoteObject | null> {
    return Promise.resolve(this.objects.get(path) ?? null);
  }

  downloadObject(path: string): Promise<Blob> {
    const blob = this.blobs.get(path);
    if (!blob) throw new Error('Not used');
    return Promise.resolve(blob);
  }

  uploadObject(request: {
    path: string;
    content: Blob;
    size: number;
    sha256: string;
  }): Promise<RemoteObject> {
    const object = {
      path: request.path,
      revision: `object-${this.objects.size + 1}`,
      size: request.size,
      sha256: request.sha256,
    };
    this.objects.set(request.path, object);
    this.blobs.set(request.path, request.content);
    return Promise.resolve(object);
  }

  deleteEntries(
    requests: readonly { path: string; expectedRevision: string }[],
  ): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    for (const request of requests) {
      const current = this.documents.get(request.path);
      if (current && current.revision !== request.expectedRevision) {
        throw new SyncConflictError();
      }
    }
    for (const request of requests) {
      this.documents.delete(request.path);
      this.deletedEntries.push(request.path);
    }
    return Promise.resolve();
  }
}

function journalWithChange(acknowledge: ReturnType<typeof vi.fn>) {
  return {
    pending: vi.fn().mockResolvedValue([
      {
        id: 'operation-1',
        entity: 'logical-book-change',
        entityId: change.changeId,
        operation: 'upsert',
        revision: 1,
        createdAt: change.createdAt,
        payload: change,
      },
    ]),
    acknowledge,
    append: vi.fn(),
  } as unknown as SyncOperationJournal;
}

function publicationFixture() {
  const digest = 'b'.repeat(64);
  const variant = {
    id: `sha256:${digest}`,
    format: 'epub' as const,
    fileName: 'Remote Only.epub',
    mediaType: 'application/epub+zip',
    size: 4,
    title: 'Remote Only',
    authors: [],
    importedAt: '2026-08-03T08:00:00.000Z',
  };
  const logicalBook = {
    schemaVersion: 1 as const,
    id: `logical:sha256:${digest}` as const,
    title: variant.title,
    authors: [],
    importedAt: variant.importedAt,
    updatedAt: variant.importedAt,
    coverState: 'pending' as const,
    variants: { epub: variant.id },
  };
  return {
    variant,
    logicalBook,
    change: {
      schemaVersion: 1 as const,
      changeId: 'change:device-b:remote-only',
      kind: 'bootstrap' as const,
      parents: [],
      resultingBooks: [logicalBook],
      removedLogicalBookIds: [],
      variantEffects: [
        {
          operation: 'upsert' as const,
          variant,
          objectPath: bookObjectPath(variant),
        },
      ],
      preferenceEffects: [],
      resolvesConflictIds: [],
      createdAt: variant.importedAt,
      deviceId: 'device-b',
      appVersion: '0.0.0',
    },
  };
}

function emptySnapshot() {
  return {
    revision: 'local-0',
    logicalBooks: [],
    preferences: [],
    reconciliations: [],
  };
}
