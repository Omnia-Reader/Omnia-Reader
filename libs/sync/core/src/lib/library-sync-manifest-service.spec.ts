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
    ).resolves.toMatchObject({
      pushed: 1,
    });
    expect(remote.writeRequests[0]).toMatchObject({
      expectedRevision: 'root-1',
      message: 'Upgrade Omnia Reader logical-book synchronization schema',
    });
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
  readonly writeRequests: DocumentWriteRequest[] = [];
  conflictsRemaining = 0;

  async list(): Promise<readonly RemoteDocument[]> {
    return [...this.documents.values()];
  }

  async read(path: string): Promise<RemoteDocument | null> {
    return this.documents.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    this.writeRequests.push(request);
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      this.documents.set(
        SYNC_MANIFEST_PATH,
        document(createLibrarySyncManifest()),
      );
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
