import { SyncOperationJournal } from '@omnia-reader/reader/domain';
import {
  LibrarySyncTransport,
  RemoteDocument,
  RemoteObject,
} from './library-sync-transport';
import {
  LogicalBookStateRepository,
  LogicalBookSyncService,
} from './logical-book-sync-service';

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
      replaceLogicalBookState,
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).resolves.toMatchObject({ pushed: 1, rejected: 0 });
    expect(remote.listPrefixes).toEqual([
      '.omnia-reader/v1/logical-books/changes',
    ]);
    expect(remote.documents.size).toBe(1);
    expect(replaceLogicalBookState).toHaveBeenCalledWith([], [], []);
    expect(acknowledge).toHaveBeenCalledWith(['operation-1']);
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
      replaceLogicalBookState: vi.fn().mockResolvedValue(undefined),
    } as unknown as LogicalBookStateRepository;

    await expect(
      new LogicalBookSyncService(remote, journal, repository).synchronize(),
    ).rejects.toThrow('provider unavailable');
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  readonly listPrefixes: string[] = [];
  writeError: Error | null = null;

  list(prefix: string): Promise<readonly RemoteDocument[]> {
    this.listPrefixes.push(prefix);
    return Promise.resolve([...this.documents.values()]);
  }

  read(path: string): Promise<RemoteDocument | null> {
    return Promise.resolve(this.documents.get(path) ?? null);
  }

  async write(request: {
    path: string;
    content: string;
  }): Promise<RemoteDocument> {
    if (this.writeError) throw this.writeError;
    const document = {
      path: request.path,
      content: request.content,
      revision: '1',
    };
    this.documents.set(request.path, document);
    return document;
  }

  headObject(): Promise<RemoteObject | null> {
    return Promise.resolve(null);
  }

  downloadObject(): Promise<Blob> {
    throw new Error('Not used');
  }

  uploadObject(): Promise<RemoteObject> {
    throw new Error('Not used');
  }
}
