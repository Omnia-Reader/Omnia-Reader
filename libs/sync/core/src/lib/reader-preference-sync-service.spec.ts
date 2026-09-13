import {
  DEFAULT_EPUB_READER_PREFERENCES,
  DEFAULT_PDF_READER_PREFERENCES,
  type ReaderPreferenceChange,
  type ReaderPreferences,
  type ReaderPreferenceSyncMetadata,
  type SyncOperation,
  type SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  type DocumentWriteRequest,
  type LibrarySyncTransport,
  type RemoteDocument,
  type RemoteObject,
  SyncConflictError,
} from './library-sync-transport';
import {
  READER_PREFERENCE_SYNC_PATH,
  ReaderPreferenceSyncService,
  type ReaderPreferenceSyncRepository,
} from './reader-preference-sync-service';

describe('ReaderPreferenceSyncService', () => {
  it('adopts existing remote preferences as the first-upgrade baseline', async () => {
    const remote = new MemoryTransport();
    remote.state = stateDocument('dark');
    const repository = new MemoryRepository([
      { ...DEFAULT_EPUB_READER_PREFERENCES, theme: 'sepia' },
    ]);

    const result = await service(remote, repository).synchronize();

    expect(result).toEqual({
      pulled: 1,
      pushed: 0,
      conflicts: 0,
      rejected: 0,
    });
    expect(await repository.getReaderPreferences('epub')).toEqual({
      ...DEFAULT_EPUB_READER_PREFERENCES,
      theme: 'dark',
    });
    expect(repository.metadata?.baseline).toBe('remote');
    expect(remote.writes).toHaveLength(0);
  });

  it('seeds an empty destination from non-default stored preferences only', async () => {
    const remote = new MemoryTransport();
    const repository = new MemoryRepository([
      { ...DEFAULT_EPUB_READER_PREFERENCES, fontSizePercent: 125 },
      { ...DEFAULT_PDF_READER_PREFERENCES },
    ]);

    await service(remote, repository).synchronize();

    expect(JSON.parse(remote.state?.content ?? '')).toEqual({
      schemaVersion: 1,
      epub: {
        fontSizePercent: {
          value: 125,
          revision: 1,
          deviceId: 'device-a',
          changeId: 'seed-fontSizePercent',
        },
      },
      pdf: {},
    });
    expect(repository.metadata?.baseline).toBe('seeded');
  });

  it('relays durable changes, merges fields, verifies the reread, and acknowledges once', async () => {
    const remote = new MemoryTransport();
    remote.state = stateDocument('dark');
    const change: ReaderPreferenceChange = {
      schemaVersion: 1,
      format: 'epub',
      field: 'fontSizePercent',
      register: {
        value: 130,
        revision: 1,
        deviceId: 'device-b',
        changeId: 'change-font-size',
      },
    };
    const repository = new MemoryRepository([], [change]);
    const journal = new MemoryJournal();

    const result = await service(remote, repository, journal).synchronize();

    expect(result).toMatchObject({ pulled: 1, pushed: 1, rejected: 0 });
    expect(JSON.parse(remote.state?.content ?? '').epub).toMatchObject({
      theme: expect.objectContaining({ value: 'dark' }),
      fontSizePercent: expect.objectContaining({ value: 130 }),
    });
    expect(repository.outbox).toEqual([]);
    expect(await journal.pending()).toEqual([]);
    expect(remote.reads).toBeGreaterThanOrEqual(2);
  });

  it('fails closed on malformed remote state and retains pending work', async () => {
    const remote = new MemoryTransport();
    remote.state = {
      path: READER_PREFERENCE_SYNC_PATH,
      revision: 'remote-1',
      content:
        '{"schemaVersion":1,"epub":{"theme":{"value":"blue","revision":1,"deviceId":"x","changeId":"y"}},"pdf":{}}',
    };
    const change: ReaderPreferenceChange = {
      schemaVersion: 1,
      format: 'pdf',
      field: 'rotation',
      register: {
        value: 90,
        revision: 1,
        deviceId: 'device-a',
        changeId: 'pending-rotation',
      },
    };
    const repository = new MemoryRepository([], [change]);
    const journal = new MemoryJournal();

    await expect(
      service(remote, repository, journal).synchronize(),
    ).resolves.toEqual({
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      rejected: 1,
    });
    expect(
      (await journal.pending()).map((operation) => operation.entityId),
    ).toEqual(['pending-rotation']);
    expect(repository.metadata).toBeNull();
  });

  it('retries a concurrent write and converges deterministically', async () => {
    const remote = new MemoryTransport();
    remote.conflicts = 1;
    const change: ReaderPreferenceChange = {
      schemaVersion: 1,
      format: 'epub',
      field: 'theme',
      register: {
        value: 'sepia',
        revision: 2,
        deviceId: 'device-a',
        changeId: 'local-theme',
      },
    };
    const repository = new MemoryRepository([], [change]);

    await service(remote, repository).synchronize();

    expect(remote.writes).toHaveLength(2);
    expect(JSON.parse(remote.state?.content ?? '').epub.theme.value).toBe(
      'sepia',
    );
  });
});

function service(
  remote: MemoryTransport,
  repository: MemoryRepository,
  journal = new MemoryJournal(),
) {
  return new ReaderPreferenceSyncService(remote, journal, repository, {
    destinationId: 'git:destination-a',
    deviceId: 'device-a',
    createChangeId: (_format, field) => `seed-${field}`,
    retryDelayMs: 0,
    wait: async () => undefined,
  });
}

class MemoryRepository implements ReaderPreferenceSyncRepository {
  readonly preferences = new Map<'epub' | 'pdf', ReaderPreferences>();
  metadata: ReaderPreferenceSyncMetadata | null = null;

  constructor(
    preferences: readonly ReaderPreferences[] = [],
    readonly outbox: ReaderPreferenceChange[] = [],
  ) {
    for (const value of preferences) this.preferences.set(value.format, value);
  }

  async getReaderPreferences(format: 'epub' | 'pdf') {
    return this.preferences.get(format) ?? null;
  }

  async saveReaderPreferences(preferences: ReaderPreferences) {
    this.preferences.set(preferences.format, preferences);
  }

  async listPendingReaderPreferenceChanges() {
    return this.outbox;
  }

  async acknowledgePendingReaderPreferenceChanges(
    changeIds: readonly string[],
  ) {
    for (const changeId of changeIds) {
      const index = this.outbox.findIndex(
        (change) => change.register.changeId === changeId,
      );
      if (index >= 0) this.outbox.splice(index, 1);
    }
  }

  async getReaderPreferenceSyncMetadata(destinationId: string) {
    return this.metadata?.destinationId === destinationId
      ? this.metadata
      : null;
  }

  async saveReaderPreferenceSyncMetadata(
    metadata: ReaderPreferenceSyncMetadata,
  ) {
    this.metadata = metadata;
  }

  async saveSynchronizedReaderPreferences(
    preferences: readonly ReaderPreferences[],
    metadata: ReaderPreferenceSyncMetadata,
  ) {
    for (const value of preferences) this.preferences.set(value.format, value);
    this.metadata = metadata;
  }

  async saveReaderPreferencesWithChange(): Promise<void> {
    throw new Error('Not used by synchronization service tests');
  }

  async commitReaderPreferenceUpdate(): Promise<
    readonly ReaderPreferenceChange[]
  > {
    throw new Error('Not used by synchronization service tests');
  }
}

class MemoryJournal implements SyncOperationJournal {
  readonly operations: SyncOperation[] = [];

  async append(input: Omit<SyncOperation, 'id' | 'revision' | 'createdAt'>) {
    const operation: SyncOperation = {
      ...input,
      id: `operation-${this.operations.length + 1}`,
      revision: this.operations.length + 1,
      createdAt: '2026-09-13T00:00:00.000Z',
    };
    this.operations.push(operation);
    return operation;
  }

  async pending() {
    return this.operations;
  }

  async acknowledge(operationIds: readonly string[]) {
    for (const operationId of operationIds) {
      const index = this.operations.findIndex(
        (operation) => operation.id === operationId,
      );
      if (index >= 0) this.operations.splice(index, 1);
    }
  }
}

class MemoryTransport implements LibrarySyncTransport {
  state: RemoteDocument | null = null;
  reads = 0;
  writes: DocumentWriteRequest[] = [];
  conflicts = 0;

  async list() {
    return this.state ? [this.state] : [];
  }

  async read() {
    this.reads += 1;
    return this.state;
  }

  async write(request: DocumentWriteRequest) {
    this.writes.push(request);
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      throw new SyncConflictError();
    }
    this.state = {
      path: request.path,
      content: request.content,
      revision: `remote-${this.writes.length}`,
    };
    return this.state;
  }

  async headObject(): Promise<RemoteObject | null> {
    return null;
  }

  async downloadObject(): Promise<Blob> {
    throw new Error('not implemented');
  }

  async uploadObject(): Promise<RemoteObject> {
    throw new Error('not implemented');
  }
}

function stateDocument(theme: 'light' | 'sepia' | 'dark'): RemoteDocument {
  return {
    path: READER_PREFERENCE_SYNC_PATH,
    revision: 'remote-1',
    content: JSON.stringify({
      schemaVersion: 1,
      epub: {
        theme: {
          value: theme,
          revision: 1,
          deviceId: 'remote-device',
          changeId: 'remote-theme',
        },
      },
      pdf: {},
    }),
  };
}
