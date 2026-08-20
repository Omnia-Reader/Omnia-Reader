import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  RemoteDocument,
  RemoteObject,
  SyncConflictError,
} from './library-sync-transport';
import {
  createLibrarySyncManifest,
  SYNC_MANIFEST_PATH,
} from './library-sync-manifest';
import {
  LibrarySyncManifestCompatibilityError,
  LibrarySyncManifestService,
} from './library-sync-manifest-service';

describe('LibrarySyncManifestService', () => {
  it('initializes an empty destination with the canonical manifest', async () => {
    const remote = new MemoryTransport();

    await expect(
      new LibrarySyncManifestService(remote).synchronize(),
    ).resolves.toEqual({
      pulled: 0,
      pushed: 1,
      conflicts: 0,
      rejected: 0,
    });
    expect(remote.writeRequests).toEqual([
      {
        path: SYNC_MANIFEST_PATH,
        content: `${JSON.stringify(createLibrarySyncManifest(), null, 2)}\n`,
        message: 'Initialize Omnia Reader synchronization schema',
      },
    ]);
  });

  it('accepts an existing compatible manifest without rewriting it', async () => {
    const remote = new MemoryTransport();
    remote.documents.set(
      SYNC_MANIFEST_PATH,
      document({
        ...createLibrarySyncManifest(),
        features: [
          ...createLibrarySyncManifest().features,
          'reading-statistics',
        ],
      }),
    );

    await expect(
      new LibrarySyncManifestService(remote).synchronize(),
    ).resolves.toEqual({
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      rejected: 0,
    });
    expect(remote.writeRequests).toEqual([]);
  });

  it('compare-and-swaps a compatible schema-1 root to schema 2', async () => {
    const remote = new MemoryTransport();
    const prepareLegacyUpgrade = vi.fn(async () => undefined);
    remote.documents.set(
      SYNC_MANIFEST_PATH,
      document({
        schemaVersion: 1,
        application: 'omnia-reader',
        publicationIdentity: 'sha256',
        features: ['annotations', 'bookmarks', 'books', 'progress'],
      }),
    );

    await expect(
      new LibrarySyncManifestService(remote, {
        prepareLegacyUpgrade,
      }).synchronize(),
    ).resolves.toMatchObject({
      pushed: 1,
    });
    expect(prepareLegacyUpgrade).toHaveBeenCalledOnce();
    expect(remote.readRequests).toEqual([
      SYNC_MANIFEST_PATH,
      SYNC_MANIFEST_PATH,
    ]);
    expect(prepareLegacyUpgrade.mock.invocationCallOrder[0]).toBeLessThan(
      remote.write.mock.invocationCallOrder[0],
    );
    expect(remote.writeRequests[0]).toMatchObject({
      expectedRevision: 'root-1',
      message: 'Upgrade Omnia Reader logical-book synchronization schema',
    });
  });

  it('does not expose schema 2 when legacy prerequisites fail', async () => {
    const remote = new MemoryTransport();
    remote.documents.set(
      SYNC_MANIFEST_PATH,
      document({
        schemaVersion: 1,
        application: 'omnia-reader',
        publicationIdentity: 'sha256',
        features: ['annotations', 'bookmarks', 'books', 'progress'],
      }),
    );
    const prepareLegacyUpgrade = vi.fn(async () => {
      throw new Error('Canonical state verification failed');
    });

    await expect(
      new LibrarySyncManifestService(remote, {
        prepareLegacyUpgrade,
      }).synchronize(),
    ).rejects.toThrow('Canonical state verification failed');
    expect(remote.writeRequests).toEqual([]);
  });

  it('fails closed when no legacy bootstrap is configured', async () => {
    const remote = new MemoryTransport();
    remote.documents.set(
      SYNC_MANIFEST_PATH,
      document({
        schemaVersion: 1,
        application: 'omnia-reader',
        publicationIdentity: 'sha256',
        features: ['annotations', 'bookmarks', 'books', 'progress'],
      }),
    );

    await expect(
      new LibrarySyncManifestService(remote).synchronize(),
    ).rejects.toBeInstanceOf(LibrarySyncManifestCompatibilityError);
    expect(remote.writeRequests).toEqual([]);
  });

  it('honors a concurrent compatible upgrade observed after bootstrap', async () => {
    const remote = new MemoryTransport();
    remote.documents.set(
      SYNC_MANIFEST_PATH,
      document({
        schemaVersion: 1,
        application: 'omnia-reader',
        publicationIdentity: 'sha256',
        features: ['annotations', 'bookmarks', 'books', 'progress'],
      }),
    );
    const prepareLegacyUpgrade = vi.fn(async () => {
      remote.documents.set(
        SYNC_MANIFEST_PATH,
        document(createLibrarySyncManifest()),
      );
    });

    await expect(
      new LibrarySyncManifestService(remote, {
        prepareLegacyUpgrade,
      }).synchronize(),
    ).resolves.toEqual({
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      rejected: 0,
    });
    expect(remote.writeRequests).toEqual([]);
  });

  it('reuses verified legacy prerequisites after an interrupted root upgrade', async () => {
    const remote = new MemoryTransport();
    remote.documents.set(
      SYNC_MANIFEST_PATH,
      document({
        schemaVersion: 1,
        application: 'omnia-reader',
        publicationIdentity: 'sha256',
        features: ['annotations', 'bookmarks', 'books', 'progress'],
      }),
    );
    remote.conflictsRemaining = 1;
    remote.preserveManifestOnConflict = true;
    const prepareLegacyUpgrade = vi.fn(async () => undefined);

    await expect(
      new LibrarySyncManifestService(remote, {
        prepareLegacyUpgrade,
        retryDelayMs: 0,
        wait: async () => undefined,
      }).synchronize(),
    ).resolves.toEqual({
      pulled: 0,
      pushed: 1,
      conflicts: 1,
      rejected: 0,
    });
    expect(prepareLegacyUpgrade).toHaveBeenCalledTimes(2);
    expect(remote.writeRequests).toHaveLength(2);
    expect(remote.writeRequests[1]?.expectedRevision).toBe('root-1');
  });

  it('re-reads after an initialization conflict', async () => {
    const remote = new MemoryTransport();
    remote.conflictsRemaining = 1;
    const service = new LibrarySyncManifestService(remote, {
      retryDelayMs: 0,
      wait: async () => undefined,
    });

    await expect(service.synchronize()).resolves.toEqual({
      pulled: 0,
      pushed: 0,
      conflicts: 1,
      rejected: 0,
    });
    expect(remote.writeRequests).toHaveLength(1);
  });

  it.each([
    '{',
    JSON.stringify({
      ...createLibrarySyncManifest(),
      schemaVersion: 3,
    }),
    JSON.stringify({
      ...createLibrarySyncManifest(),
      features: ['books'],
    }),
  ])('fails closed for an incompatible root manifest', async (content) => {
    const remote = new MemoryTransport();
    remote.documents.set(SYNC_MANIFEST_PATH, {
      path: SYNC_MANIFEST_PATH,
      content,
      revision: 'root-1',
    });

    await expect(
      new LibrarySyncManifestService(remote).synchronize(),
    ).rejects.toBeInstanceOf(LibrarySyncManifestCompatibilityError);
    expect(remote.writeRequests).toEqual([]);
  });

  it('coalesces concurrent schema checks', async () => {
    const remote = new MemoryTransport();
    const service = new LibrarySyncManifestService(remote);

    const first = service.synchronize();
    const second = service.synchronize();

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ pushed: 1 });
    expect(remote.writeRequests).toHaveLength(1);
  });
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  readonly readRequests: string[] = [];
  readonly writeRequests: DocumentWriteRequest[] = [];
  readonly write = vi.fn(async (request: DocumentWriteRequest) =>
    this.writeDocument(request),
  );
  conflictsRemaining = 0;
  preserveManifestOnConflict = false;

  async list(): Promise<readonly RemoteDocument[]> {
    return [...this.documents.values()];
  }

  async read(path: string): Promise<RemoteDocument | null> {
    this.readRequests.push(path);
    return this.documents.get(path) ?? null;
  }

  private async writeDocument(
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument> {
    this.writeRequests.push(request);
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      if (!this.preserveManifestOnConflict) {
        this.documents.set(
          SYNC_MANIFEST_PATH,
          document(createLibrarySyncManifest()),
        );
      }
      throw new SyncConflictError();
    }
    const current = this.documents.get(request.path);
    if (
      request.expectedRevision !== undefined &&
      current?.revision !== request.expectedRevision
    ) {
      throw new SyncConflictError();
    }
    const created: RemoteDocument = {
      path: request.path,
      content: request.content,
      revision: `root-${this.writeRequests.length}`,
    };
    this.documents.set(request.path, created);
    return created;
  }

  async headObject(): Promise<RemoteObject | null> {
    throw new Error('Not used');
  }

  async downloadObject(): Promise<Blob> {
    throw new Error('Not used');
  }

  async uploadObject(): Promise<RemoteObject> {
    throw new Error('Not used');
  }
}

function document(value: unknown): RemoteDocument {
  return {
    path: SYNC_MANIFEST_PATH,
    content: `${JSON.stringify(value, null, 2)}\n`,
    revision: 'root-1',
  };
}
