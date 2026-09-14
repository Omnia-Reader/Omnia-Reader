import {
  BookRecord,
  logicalBookFromVariant,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  BookSyncManifest,
  bookDeletionPath,
  bookManifestPath,
  bookObjectPath,
  createBookSyncDeletionTombstone,
} from './book-sync-manifest';
import { BookSyncExclusions } from './book-sync-exclusions';
import {
  DocumentDeleteRequest,
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectDeleteRequest,
  RemoteDocument,
  RemoteObject,
  SyncConflictError,
} from './library-sync-transport';
import {
  emptyLogicalBookState,
  LOGICAL_BOOK_STATE_PATH,
} from './logical-book-state';
import { RemoteBookBackupService } from './remote-book-backup-service';

const BOOK_ID = `sha256:${'a'.repeat(64)}`;
const BOOK: BookRecord = {
  id: BOOK_ID,
  format: 'epub',
  fileName: 'remote.epub',
  mediaType: 'application/epub+zip',
  size: 12,
  title: 'Remote publication',
  authors: ['Reader Example'],
  importedAt: '2026-07-25T10:00:00.000Z',
};
const OBJECT_PATH = bookObjectPath(BOOK);
const MANIFEST: BookSyncManifest = {
  schemaVersion: 2,
  bookId: BOOK_ID,
  format: 'epub',
  fileName: 'remote.epub',
  mediaType: 'application/epub+zip',
  size: 12,
  sha256: 'a'.repeat(64),
  objectPath: OBJECT_PATH,
  title: 'Remote publication',
  authors: ['Reader Example'],
  importedAt: '2026-07-25T10:00:00.000Z',
  updatedAt: '2026-07-25T10:00:00.000Z',
  appVersion: '1.0.0',
};

describe('RemoteBookBackupService', () => {
  it('automatically cleans stable orphans only after the grace period', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(LOGICAL_BOOK_STATE_PATH, emptyLogicalBookState());
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    remote.seedObject({
      path: OBJECT_PATH,
      revision: 'object-1',
      size: BOOK.size,
      sha256: MANIFEST.sha256,
    });
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      new MemoryExclusions(),
      { now: () => new Date(now).toISOString() },
    );
    await expect(service.reconcileOrphaned('repo-a')).resolves.toEqual({
      deleted: 0,
      pending: true,
    });
    now += 299_999;
    await expect(service.reconcileOrphaned('repo-a')).resolves.toEqual({
      deleted: 0,
      pending: true,
    });
    expect(await remote.headObject(OBJECT_PATH)).not.toBeNull();
    now += 1;
    await expect(service.reconcileOrphaned('repo-a')).resolves.toEqual({
      deleted: 1,
      pending: false,
    });
    await expect(service.list()).resolves.toEqual([]);
    expect(await remote.headObject(OBJECT_PATH)).toBeNull();
    expect(await remote.read(bookDeletionPath(BOOK_ID))).not.toBeNull();
  });

  it.each(['destination', 'manifest', 'pending-import'])(
    'restarts orphan grace when %s changes',
    async (reason) => {
      const remote = new MemoryRemote();
      remote.seedDocument(LOGICAL_BOOK_STATE_PATH, emptyLogicalBookState());
      remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
      const journal = new MemoryJournal();
      let now = Date.parse('2026-09-14T12:00:00.000Z');
      const service = new RemoteBookBackupService(
        remote,
        journal,
        new MemoryExclusions(),
        { now: () => new Date(now).toISOString() },
      );
      await service.reconcileOrphaned('repo-a');
      now += 300_000;
      if (reason === 'manifest')
        remote.seedDocument(bookManifestPath(MANIFEST), {
          ...MANIFEST,
          title: 'Renamed',
        });
      if (reason === 'pending-import')
        vi.spyOn(journal, 'pending').mockResolvedValue([bookOperation()]);
      expect(
        (
          await service.reconcileOrphaned(
            reason === 'destination' ? 'repo-b' : 'repo-a',
          )
        ).deleted,
      ).toBe(0);
      expect(await remote.read(bookManifestPath(MANIFEST))).not.toBeNull();
      expect(await remote.read(bookDeletionPath(BOOK_ID))).toBeNull();
    },
  );

  it('finds and deletes confirmed orphan files with no historical deletion marker', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(LOGICAL_BOOK_STATE_PATH, emptyLogicalBookState());
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    remote.seedObject({
      path: OBJECT_PATH,
      revision: 'object-1',
      size: BOOK.size,
      sha256: MANIFEST.sha256,
    });
    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      new MemoryExclusions(),
    );
    const candidates = await service.listOrphaned();
    expect(candidates).toHaveLength(1);
    await service.deleteOrphaned(candidates);
    await expect(service.list()).resolves.toEqual([]);
    await expect(remote.headObject(OBJECT_PATH)).resolves.toBeNull();
    expect(await remote.read(bookDeletionPath(BOOK_ID))).not.toBeNull();
  });

  it('never offers remote-only files before canonical library initialization', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      new MemoryExclusions(),
    );
    await expect(service.listOrphaned()).resolves.toEqual([]);
  });

  it.each(['changed-manifest', 'pending-import', 'active-membership'])(
    'refuses cleanup when %s appears after review',
    async (reason) => {
      const remote = new MemoryRemote();
      remote.seedDocument(LOGICAL_BOOK_STATE_PATH, emptyLogicalBookState());
      remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
      const journal = new MemoryJournal();
      const service = new RemoteBookBackupService(
        remote,
        journal,
        new MemoryExclusions(),
      );
      const candidates = await service.listOrphaned();
      if (reason === 'changed-manifest')
        remote.seedDocument(bookManifestPath(MANIFEST), {
          ...MANIFEST,
          title: 'Updated',
        });
      else if (reason === 'pending-import')
        vi.spyOn(journal, 'pending').mockResolvedValue([bookOperation()]);
      else {
        const clock = {
          changeId: 'change:import',
          deviceId: 'device',
          createdAt: BOOK.importedAt,
        };
        remote.seedDocument(LOGICAL_BOOK_STATE_PATH, {
          ...emptyLogicalBookState(),
          heads: [clock.changeId],
          books: [{ book: logicalBookFromVariant(BOOK), clock }],
          variants: [{ variant: BOOK, objectPath: OBJECT_PATH, clock }],
        });
      }
      await expect(service.deleteOrphaned(candidates)).rejects.toBeInstanceOf(
        SyncConflictError,
      );
      expect(await remote.read(bookManifestPath(MANIFEST))).not.toBeNull();
      expect(await remote.read(bookDeletionPath(BOOK_ID))).toBeNull();
    },
  );

  it('lists only active publication manifests', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    const deletedId = `sha256:${'b'.repeat(64)}`;
    remote.seedDocument(
      bookDeletionPath(deletedId),
      createBookSyncDeletionTombstone(
        { id: deletedId, format: 'pdf', fileName: 'deleted.pdf' },
        '2026-07-26T10:00:00.000Z',
      ),
    );

    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      new MemoryExclusions(),
    );

    await expect(service.list()).resolves.toEqual([
      {
        manifest: MANIFEST,
        revision: 'revision-1',
      },
    ]);
  });

  it('deletes all filename directories for one edition, including after an interruption', async () => {
    const remote = new MemoryRemote();
    const renamedBook = { ...BOOK, fileName: 'renamed.epub' };
    const renamed = {
      ...MANIFEST,
      fileName: renamedBook.fileName,
      objectPath: bookObjectPath(renamedBook),
    };
    for (const manifest of [MANIFEST, renamed]) {
      remote.seedDocument(bookManifestPath(manifest), manifest);
      remote.seedObject({
        path: manifest.objectPath,
        revision: 'object-1',
        size: manifest.size,
        sha256: manifest.sha256,
      });
    }
    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      new MemoryExclusions(),
    );
    remote.failDeletes = 1;
    await expect(service.deleteBackup(BOOK_ID)).rejects.toThrow();
    remote.failDeletes = 0;
    await service.deleteBackup(BOOK_ID);
    await expect(service.list()).resolves.toEqual([]);
    expect(await remote.headObject(MANIFEST.objectPath)).toBeNull();
    expect(await remote.headObject(renamed.objectPath)).toBeNull();
  });

  it('commits a tombstone before deleting the publication object', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    remote.seedObject({
      path: OBJECT_PATH,
      revision: 'object-revision-1',
      size: MANIFEST.size,
      sha256: MANIFEST.sha256,
    });
    const journal = new MemoryJournal([bookOperation()]);
    const exclusions = new MemoryExclusions();
    const service = new RemoteBookBackupService(remote, journal, exclusions, {
      now: () => '2026-07-26T12:00:00.000Z',
    });

    const result = await service.deleteBackup(BOOK_ID);

    expect(result).toMatchObject({
      deleted: true,
      bookId: BOOK_ID,
      deletedAt: '2026-07-26T12:00:00.000Z',
    });
    expect(exclusions.isExcluded(BOOK_ID)).toBe(true);
    expect(journal.acknowledged).toEqual(['operation-1']);
    expect(remote.deletedObjects).toEqual([
      {
        path: OBJECT_PATH,
        expectedRevision: 'object-revision-1',
      },
    ]);
    expect(remote.events).toEqual([
      'write-tombstone',
      'delete-object',
      'delete-document',
      'write-catalog',
    ]);
  });

  it('retries a conflicting tombstone write against the latest revision', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    remote.conflictWrites = 1;
    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      new MemoryExclusions(),
      {
        retryDelayMs: 0,
        wait: async () => undefined,
        now: () => '2026-07-26T12:00:00.000Z',
      },
    );

    await service.deleteBackup(BOOK_ID);

    expect(remote.events).toEqual([
      'write-tombstone',
      'delete-document',
      'write-catalog',
    ]);
  });

  it('keeps the tombstone and exclusion when object cleanup must be retried', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    remote.seedObject({
      path: OBJECT_PATH,
      revision: 'object-revision-1',
      size: MANIFEST.size,
      sha256: MANIFEST.sha256,
    });
    remote.failDeletes = 1;
    const exclusions = new MemoryExclusions();
    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      exclusions,
      { now: () => '2026-07-26T12:00:00.000Z' },
    );

    await expect(service.deleteBackup(BOOK_ID)).rejects.toThrow(
      'Object deletion failed',
    );
    expect(exclusions.isExcluded(BOOK_ID)).toBe(true);
    expect(
      JSON.parse(
        (await remote.read(bookDeletionPath(BOOK_ID)))?.content ?? '{}',
      ),
    ).toMatchObject({ deleted: true, bookId: BOOK_ID });

    await expect(service.deleteBackup(BOOK_ID)).resolves.toMatchObject({
      deleted: true,
    });
    await expect(remote.headObject(OBJECT_PATH)).resolves.toBeNull();
  });

  it('rolls back a new exclusion when no tombstone was committed', async () => {
    const remote = new MemoryRemote();
    remote.seedDocument(bookManifestPath(MANIFEST), MANIFEST);
    remote.failWrites = 1;
    const exclusions = new MemoryExclusions();
    const service = new RemoteBookBackupService(
      remote,
      new MemoryJournal(),
      exclusions,
    );

    await expect(service.deleteBackup(BOOK_ID)).rejects.toThrow(
      'Document write failed',
    );
    expect(exclusions.isExcluded(BOOK_ID)).toBe(false);
  });
});

class MemoryRemote implements LibrarySyncTransport {
  private readonly documents = new Map<string, RemoteDocument>();
  private readonly objects = new Map<string, RemoteObject>();
  private revision = 0;
  conflictWrites = 0;
  failWrites = 0;
  failDeletes = 0;
  writeAttempts = 0;
  readonly events: string[] = [];
  readonly deletedObjects: ObjectDeleteRequest[] = [];

  seedDocument(path: string, value: unknown): void {
    this.documents.set(path, {
      path,
      content: `${JSON.stringify(value, null, 2)}\n`,
      revision: `revision-${++this.revision}`,
    });
  }

  seedObject(object: RemoteObject): void {
    this.objects.set(object.path, object);
  }

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    return [...this.documents.values()].filter((document) =>
      document.path.startsWith(prefix),
    );
  }

  async read(path: string): Promise<RemoteDocument | null> {
    return this.documents.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    this.writeAttempts += 1;
    if (this.failWrites-- > 0) {
      throw new Error('Document write failed');
    }
    if (this.conflictWrites-- > 0) {
      throw new SyncConflictError();
    }
    const current = this.documents.get(request.path);
    if (current?.revision !== request.expectedRevision) {
      throw new SyncConflictError();
    }
    const document = {
      path: request.path,
      content: request.content,
      revision: `revision-${++this.revision}`,
    };
    this.documents.set(request.path, document);
    this.events.push(
      request.path.endsWith('/README.md') ? 'write-catalog' : 'write-tombstone',
    );
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
    return this.objects.get(path) ?? null;
  }

  async downloadObject(): Promise<Blob> {
    throw new Error('Not used');
  }

  async uploadObject(): Promise<RemoteObject> {
    throw new Error('Not used');
  }

  async deleteObject(request: ObjectDeleteRequest): Promise<void> {
    if (this.failDeletes-- > 0) {
      throw new Error('Object deletion failed');
    }
    const current = this.objects.get(request.path);
    if (
      current &&
      request.expectedRevision !== undefined &&
      current.revision !== request.expectedRevision
    ) {
      throw new SyncConflictError();
    }
    this.deletedObjects.push(request);
    this.objects.delete(request.path);
    this.events.push('delete-object');
  }
}

class MemoryJournal implements SyncOperationJournal {
  readonly acknowledged: string[] = [];

  constructor(private readonly operations: SyncOperation[] = []) {}

  async append(): Promise<SyncOperation> {
    throw new Error('Not used');
  }

  async pending(): Promise<readonly SyncOperation[]> {
    return this.operations.filter(
      (operation) => !this.acknowledged.includes(operation.id),
    );
  }

  async acknowledge(operationIds: readonly string[]): Promise<void> {
    this.acknowledged.push(...operationIds);
  }
}

class MemoryExclusions implements BookSyncExclusions {
  private readonly bookIds = new Set<string>();

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

function bookOperation(): SyncOperation {
  return {
    id: 'operation-1',
    entity: 'book',
    entityId: BOOK_ID,
    operation: 'upsert',
    revision: 1,
    createdAt: MANIFEST.updatedAt,
    payload: MANIFEST,
  };
}
