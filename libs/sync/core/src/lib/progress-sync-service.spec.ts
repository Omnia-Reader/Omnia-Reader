import {
  NewSyncOperation,
  ReadingProgress,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';
import { progressDocumentPath, PROGRESS_ROOT } from './progress-paths';
import {
  ProgressRepository,
  ProgressSyncService,
} from './progress-sync-service';

const BOOK_ID = `sha256:${'a'.repeat(64)}`;

describe('ProgressSyncService', () => {
  it('pulls valid device documents, rejects malformed files, and keeps furthest progress', async () => {
    const remote = new MemorySyncTransport();
    const older = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.8,
    );
    const newer = progress(
      BOOK_ID,
      'device-b',
      '2026-07-24T11:00:00.000Z',
      0.4,
    );
    remote.seed(older);
    remote.seed(newer);
    remote.files.set(`${PROGRESS_ROOT}/broken.json`, {
      path: `${PROGRESS_ROOT}/broken.json`,
      content: '{not-json',
      revision: 'broken',
    });
    const repository = new MemoryProgressRepository();
    const service = new ProgressSyncService(
      remote,
      new MemoryJournal(),
      repository,
    );

    const result = await service.pull();

    expect(result).toEqual({
      pulled: 2,
      pushed: 0,
      conflicts: 0,
      rejected: 1,
    });
    expect(await repository.getProgress(BOOK_ID)).toEqual({
      ...newer,
      furthestTotalProgression: 0.8,
    });
    expect(await repository.listProgressDocuments()).toEqual([older, newer]);
  });

  it('rejects progress for a publication that is not in the local library', async () => {
    const remote = new MemorySyncTransport();
    const orphan = progress(
      `sha256:${'b'.repeat(64)}`,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.5,
    );
    remote.seed(orphan);
    const repository = new MemoryProgressRepository();

    await expect(
      new ProgressSyncService(remote, new MemoryJournal(), repository).pull(),
    ).resolves.toEqual({
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      rejected: 1,
    });
    await expect(repository.listProgressDocuments()).resolves.toEqual([]);
  });

  it('coalesces queued updates and acknowledges them only after the remote write', async () => {
    const remote = new MemorySyncTransport();
    const first = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.2,
    );
    const latest = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:01:00.000Z',
      0.3,
    );
    const journal = new MemoryJournal([
      operation('one', 1, first),
      operation('two', 2, latest),
    ]);
    const service = new ProgressSyncService(
      remote,
      journal,
      new MemoryProgressRepository(),
    );

    const result = await service.push();

    expect(result).toEqual({
      pulled: 0,
      pushed: 1,
      conflicts: 0,
      rejected: 0,
    });
    expect(await journal.pending()).toEqual([]);
    const stored = remote.files.get(progressDocumentPath(latest));
    expect(stored?.path).toBe(progressDocumentPath(latest));
    expect(JSON.parse(stored?.content ?? '')).toEqual(latest);
  });

  it('seeds a newly selected provider from the current local progress snapshot', async () => {
    const local = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.4,
    );
    const remote = new MemorySyncTransport();
    const service = new ProgressSyncService(
      remote,
      new MemoryJournal(),
      new MemoryProgressRepository(local),
    );

    await expect(service.push()).resolves.toEqual({
      pulled: 0,
      pushed: 1,
      conflicts: 0,
      rejected: 0,
    });
    expect(await remote.read(progressDocumentPath(local))).not.toBeNull();
  });

  it('migrates every cached device document to a newly selected provider', async () => {
    const source = new MemorySyncTransport();
    const olderFurthest = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.8,
    );
    const newerCurrent = progress(
      BOOK_ID,
      'device-b',
      '2026-07-24T11:00:00.000Z',
      0.4,
    );
    source.seed(olderFurthest);
    source.seed(newerCurrent);
    const repository = new MemoryProgressRepository();

    await new ProgressSyncService(
      source,
      new MemoryJournal(),
      repository,
    ).pull();

    const destination = new MemorySyncTransport();
    const result = await new ProgressSyncService(
      destination,
      new MemoryJournal(),
      repository,
    ).push();

    expect(result).toEqual({
      pulled: 0,
      pushed: 2,
      conflicts: 0,
      rejected: 0,
    });
    expect(destination.files.size).toBe(2);
    expect(
      JSON.parse(
        destination.files.get(progressDocumentPath(olderFurthest))?.content ??
          '',
      ),
    ).toEqual(olderFurthest);
    expect(
      JSON.parse(
        destination.files.get(progressDocumentPath(newerCurrent))?.content ??
          '',
      ),
    ).toEqual({
      ...newerCurrent,
      furthestTotalProgression: 0.8,
    });
  });

  it('re-reads and retries a bounded Git conflict before acknowledging', async () => {
    const remote = new MemorySyncTransport();
    remote.conflictsBeforeSuccess = 1;
    const local = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.5,
    );
    const journal = new MemoryJournal([operation('one', 1, local)]);
    const waits: number[] = [];
    const service = new ProgressSyncService(
      remote,
      journal,
      new MemoryProgressRepository(),
      {
        retryDelayMs: 25,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    );

    const result = await service.push();

    expect(result.conflicts).toBe(1);
    expect(result.pushed).toBe(1);
    expect(waits).toEqual([25]);
    expect(await journal.pending()).toEqual([]);
    expect(remote.writeAttempts).toBe(2);
  });

  it('leaves operations pending when all conflict retries are exhausted', async () => {
    const remote = new MemorySyncTransport();
    remote.conflictsBeforeSuccess = 3;
    const local = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.5,
    );
    const journal = new MemoryJournal([operation('one', 1, local)]);
    const service = new ProgressSyncService(
      remote,
      journal,
      new MemoryProgressRepository(),
      {
        maxConflictRetries: 2,
        wait: async () => undefined,
      },
    );

    await expect(service.push()).rejects.toBeInstanceOf(SyncConflictError);
    expect((await journal.pending()).map(({ id }) => id)).toEqual(['one']);
    expect(remote.writeAttempts).toBe(3);
  });

  it('converges two offline devices without discarding either device document', async () => {
    const remote = new MemorySyncTransport();
    const deviceA = progress(
      BOOK_ID,
      'device-a',
      '2026-07-24T10:00:00.000Z',
      0.7,
    );
    const deviceB = progress(
      BOOK_ID,
      'device-b',
      '2026-07-24T11:00:00.000Z',
      0.4,
    );
    const repositoryA = new MemoryProgressRepository(deviceA);
    const repositoryB = new MemoryProgressRepository(deviceB);
    const serviceA = new ProgressSyncService(
      remote,
      new MemoryJournal([operation('a', 1, deviceA)]),
      repositoryA,
    );
    const serviceB = new ProgressSyncService(
      remote,
      new MemoryJournal([operation('b', 1, deviceB)]),
      repositoryB,
    );

    await serviceA.synchronize();
    await serviceB.synchronize();
    await serviceA.pull();

    expect(remote.files.size).toBe(2);
    expect(await repositoryA.getProgress(BOOK_ID)).toEqual({
      ...deviceB,
      furthestTotalProgression: 0.7,
    });
    expect(await repositoryB.getProgress(BOOK_ID)).toEqual({
      ...deviceB,
      furthestTotalProgression: 0.7,
    });
  });
});

class MemorySyncTransport implements LibrarySyncTransport {
  readonly files = new Map<string, RemoteDocument>();
  conflictsBeforeSuccess = 0;
  writeAttempts = 0;
  private revision = 0;

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    return [...this.files.values()].filter((file) =>
      file.path.startsWith(`${prefix}/`),
    );
  }

  async read(path: string): Promise<RemoteDocument | null> {
    return this.files.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    this.writeAttempts += 1;
    if (this.conflictsBeforeSuccess > 0) {
      this.conflictsBeforeSuccess -= 1;
      throw new SyncConflictError();
    }

    const current = this.files.get(request.path);
    if (current?.revision !== request.expectedRevision) {
      throw new SyncConflictError();
    }
    const file = {
      path: request.path,
      content: request.content,
      revision: String(++this.revision),
    };
    this.files.set(file.path, file);
    return file;
  }

  async headObject(): Promise<null> {
    return null;
  }

  async downloadObject(): Promise<Blob> {
    throw new Error('Object downloads are not used by progress sync tests');
  }

  async uploadObject(): Promise<never> {
    throw new Error('Object uploads are not used by progress sync tests');
  }

  seed(value: ReadingProgress): void {
    const path = progressDocumentPath(value);
    this.files.set(path, {
      path,
      content: `${JSON.stringify(value, null, 2)}\n`,
      revision: String(++this.revision),
    });
  }
}

class MemoryJournal implements SyncOperationJournal {
  constructor(private operations: SyncOperation[] = []) {}

  async append(input: NewSyncOperation): Promise<SyncOperation> {
    const operation = {
      ...input,
      id: crypto.randomUUID(),
      revision: this.operations.length + 1,
      createdAt: new Date().toISOString(),
    };
    this.operations.push(operation);
    return operation;
  }

  async pending(): Promise<readonly SyncOperation[]> {
    return [...this.operations];
  }

  async acknowledge(operationIds: readonly string[]): Promise<void> {
    const acknowledged = new Set(operationIds);
    this.operations = this.operations.filter(
      (operation) => !acknowledged.has(operation.id),
    );
  }
}

class MemoryProgressRepository implements ProgressRepository {
  private readonly progressByBook = new Map<string, ReadingProgress>();
  private readonly progressDocuments = new Map<string, ReadingProgress>();

  constructor(initial?: ReadingProgress) {
    if (initial) {
      this.progressByBook.set(initial.bookId, initial);
    }
  }

  async getBook(
    bookId: string,
  ): Promise<{ format: ReadingProgress['format'] } | null> {
    return bookId === BOOK_ID ? { format: 'epub' } : null;
  }

  async getProgress(bookId: string): Promise<ReadingProgress | null> {
    return this.progressByBook.get(bookId) ?? null;
  }

  async listProgress(): Promise<readonly ReadingProgress[]> {
    return [...this.progressByBook.values()];
  }

  async saveProgress(value: ReadingProgress): Promise<void> {
    this.progressByBook.set(value.bookId, value);
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

  async saveProgressDocument(value: ReadingProgress): Promise<void> {
    this.progressDocuments.set(progressDocumentPath(value), value);
  }
}

function operation(
  id: string,
  revision: number,
  payload: ReadingProgress,
): SyncOperation {
  return {
    id,
    entity: 'progress',
    entityId: payload.bookId,
    operation: 'upsert',
    revision,
    createdAt: payload.updatedAt,
    payload,
  };
}

function progress(
  bookId: string,
  deviceId: string,
  updatedAt: string,
  furthestTotalProgression: number,
): ReadingProgress {
  return {
    schemaVersion: 1,
    bookId,
    format: 'epub',
    deviceId,
    locator: {
      href: 'chapter.xhtml',
      type: 'application/xhtml+xml',
      locations: { totalProgression: furthestTotalProgression },
    },
    furthestTotalProgression,
    updatedAt,
    appVersion: '0.1.0',
  };
}
