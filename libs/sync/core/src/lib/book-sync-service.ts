import {
  BookSource,
  LibraryRepository,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  BOOK_DELETIONS_ROOT,
  BOOKS_ROOT,
  LEGACY_BOOKS_ROOT,
  BookSyncDeletionTombstone,
  BookSyncDocument,
  BookSyncManifest,
  bookDeletionPath,
  bookManifestPath,
  bookObjectPath,
  createBookSyncDeletionTombstone,
  createBookSyncManifest,
  isBookSyncDeletionTombstone,
  isBookSyncDocument,
  isBookSyncManifest,
  legacyBookObjectPath,
  manifestBookRecord,
} from './book-sync-manifest';
import { updateBookSyncCatalog } from './book-sync-catalog';
import {
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';
import {
  SyncWorkerOptions,
  throwIfSyncAborted,
} from './library-sync-coordinator';
import { blobSha256 } from './blob-sha256';
import {
  BookSyncExclusions,
  NO_BOOK_SYNC_EXCLUSIONS,
} from './book-sync-exclusions';

export interface BookSyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  rejected: number;
}

export interface BookSyncOptions {
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  exclusions?: BookSyncExclusions;
}

interface PendingBookWrite {
  kind: 'upsert';
  manifest: BookSyncManifest;
  operationIds: string[];
  latestOperation: SyncOperation;
}

interface PendingBookDeletion {
  kind: 'delete';
  tombstone: BookSyncDeletionTombstone;
  operationIds: string[];
  latestOperation: SyncOperation;
}

type PendingBookChange = PendingBookWrite | PendingBookDeletion;

const DEFAULT_MAX_CONFLICT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 100;

export class BookSyncService {
  private readonly maxConflictRetries: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly exclusions: BookSyncExclusions;
  private activeSync: Promise<BookSyncResult> | null = null;

  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly repository: LibraryRepository,
    options: BookSyncOptions = {},
  ) {
    this.maxConflictRetries =
      options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.wait = options.wait ?? wait;
    this.exclusions = options.exclusions ?? NO_BOOK_SYNC_EXCLUSIONS;
  }

  synchronize(options: SyncWorkerOptions = {}): Promise<BookSyncResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization(options).finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  async pull(options: SyncWorkerOptions = {}): Promise<BookSyncResult> {
    throwIfSyncAborted(options.signal);
    const [deletions, books, pending] = await Promise.all([
      this.remote.list(BOOK_DELETIONS_ROOT),
      this.remote.list(BOOKS_ROOT),
      this.journal.pending(),
    ]);
    const documents = [...deletions, ...books];
    const localIntents = coalesceBookOperations(pending).changes;
    let pulled = 0;
    let rejected = 0;

    for (const document of documents) {
      throwIfSyncAborted(options.signal);
      const remoteBook = parseBookSyncDocument(document);
      if (
        !remoteBook ||
        document.path !==
          (isBookSyncDeletionTombstone(remoteBook)
            ? bookDeletionPath(remoteBook.bookId)
            : bookManifestPath(remoteBook))
      ) {
        rejected += 1;
        continue;
      }
      if (isBookSyncDeletionTombstone(remoteBook)) {
        const localIntent = localIntents.get(remoteBook.bookId);
        if (
          !localIntent ||
          localIntent.kind === 'delete' ||
          !isNewerThanDeletion(localIntent, remoteBook)
        ) {
          const wasExcluded = this.exclusions.isExcluded(remoteBook.bookId);
          this.exclusions.exclude(remoteBook.bookId);
          await this.discardDeletedObjects(remoteBook, remoteBook);
          pulled += wasExcluded ? 0 : 1;
        }
        continue;
      }
      const manifest = remoteBook;
      if (this.exclusions.isExcluded(manifest.bookId)) {
        continue;
      }
      if (await this.repository.getBook(manifest.bookId)) {
        continue;
      }

      const remoteObject = await this.remote.headObject(manifest.objectPath);
      if (
        !remoteObject ||
        remoteObject.path !== manifest.objectPath ||
        remoteObject.size !== manifest.size ||
        remoteObject.sha256 !== manifest.sha256
      ) {
        rejected += 1;
        continue;
      }

      const blob = await this.remote.downloadObject(manifest.objectPath, {
        signal: options.signal,
        onProgress: options.onTransferProgress,
        expectedSize: manifest.size,
      });
      throwIfSyncAborted(options.signal);
      if (!(await matchesManifest(blob, manifest, options.signal))) {
        rejected += 1;
        continue;
      }

      throwIfSyncAborted(options.signal);
      if (this.exclusions.isExcluded(manifest.bookId)) {
        continue;
      }
      await this.repository.storeSyncedBook(
        manifestBookRecord(manifest),
        new BlobBookSource(manifest.fileName, manifest.mediaType, blob),
      );
      pulled += 1;
    }

    return { pulled, pushed: 0, conflicts: 0, rejected };
  }

  async push(options: SyncWorkerOptions = {}): Promise<BookSyncResult> {
    throwIfSyncAborted(options.signal);
    const pending = await this.journal.pending();
    const changes = coalesceBookOperations(pending);
    const remoteDocuments = await this.remote.list(BOOKS_ROOT);
    const excludedRemoteBooks = new Map<string, BookSyncManifest>();
    for (const document of remoteDocuments) {
      if (!document.path.endsWith('/book.json')) {
        continue;
      }
      const record = parseBookSyncDocument(document);
      if (
        record &&
        isBookSyncManifest(record) &&
        document.path === bookManifestPath(record) &&
        this.exclusions.isExcluded(record.bookId)
      ) {
        excludedRemoteBooks.set(record.bookId, record);
      }
    }
    const discardedOperationIds: string[] = [];
    for (const [bookId, change] of changes.changes) {
      if (!this.exclusions.isExcluded(bookId) || change.kind === 'delete') {
        continue;
      }
      const remoteBook = excludedRemoteBooks.get(bookId);
      if (remoteBook) {
        changes.changes.set(
          bookId,
          pendingDeletion(
            createBookSyncDeletionTombstone(
              {
                id: remoteBook.bookId,
                format: remoteBook.format,
                fileName: remoteBook.fileName,
              },
              change.latestOperation.createdAt,
            ),
            change.operationIds,
            change.latestOperation,
          ),
        );
      } else {
        discardedOperationIds.push(...change.operationIds);
        changes.changes.delete(bookId);
      }
    }
    for (const [bookId, remoteBook] of excludedRemoteBooks) {
      if (!changes.changes.has(bookId)) {
        const tombstone = createBookSyncDeletionTombstone(
          {
            id: remoteBook.bookId,
            format: remoteBook.format,
            fileName: remoteBook.fileName,
          },
          new Date().toISOString(),
        );
        changes.changes.set(
          bookId,
          pendingDeletion(tombstone, [], syntheticBookDeletion(tombstone)),
        );
      }
    }
    if (discardedOperationIds.length > 0) {
      await this.journal.acknowledge(discardedOperationIds);
    }
    for (const book of await this.repository.listBooks()) {
      throwIfSyncAborted(options.signal);
      if (
        !this.exclusions.isExcluded(book.id) &&
        !changes.changes.has(book.id)
      ) {
        const manifest = createBookSyncManifest(book);
        changes.changes.set(book.id, {
          kind: 'upsert',
          manifest,
          operationIds: [],
          latestOperation: syntheticBookOperation(manifest),
        });
      }
    }
    let pushed = 0;
    let conflicts = 0;
    let rejected =
      pending.filter((operation) => operation.entity === 'book').length -
      changes.acceptedOperationCount;

    for (const change of changes.changes.values()) {
      throwIfSyncAborted(options.signal);
      const result =
        change.kind === 'upsert'
          ? await this.pushBook(change, options)
          : await this.pushDeletion(change, options);
      pushed += result.pushed ? 1 : 0;
      conflicts += result.conflicts;
      rejected += result.rejected;
    }

    return { pulled: 0, pushed, conflicts, rejected };
  }

  private async runSynchronization(
    options: SyncWorkerOptions,
  ): Promise<BookSyncResult> {
    const pulled = await this.pull(options);
    throwIfSyncAborted(options.signal);
    const pushed = await this.push(options);
    await this.cleanupLegacyRemoteLayout();
    await updateBookSyncCatalog(this.remote, {
      maxConflictRetries: this.maxConflictRetries,
      retryDelayMs: this.retryDelayMs,
      wait: this.wait,
    });
    return {
      pulled: pulled.pulled,
      pushed: pushed.pushed,
      conflicts: pulled.conflicts + pushed.conflicts,
      rejected: pulled.rejected + pushed.rejected,
    };
  }

  private async pushBook(
    pending: PendingBookWrite,
    options: SyncWorkerOptions,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    throwIfSyncAborted(options.signal);
    const deletion = await this.remote.read(
      bookDeletionPath(pending.manifest.bookId),
    );
    const remoteDeletion = deletion ? parseBookSyncDocument(deletion) : null;
    if (
      remoteDeletion &&
      isBookSyncDeletionTombstone(remoteDeletion) &&
      !isNewerThanDeletion(pending, remoteDeletion)
    ) {
      this.exclusions.exclude(pending.manifest.bookId);
      await this.discardDeletedObjects(remoteDeletion, pending.manifest);
      await this.journal.acknowledge(pending.operationIds);
      return { pushed: false, conflicts: 0, rejected: 0 };
    }
    const current = await this.remote.read(bookManifestPath(pending.manifest));
    const remoteBook = current ? parseBookSyncDocument(current) : null;
    if (
      remoteBook &&
      isBookSyncDeletionTombstone(remoteBook) &&
      !isNewerThanDeletion(pending, remoteBook)
    ) {
      this.exclusions.exclude(pending.manifest.bookId);
      await this.discardDeletedObjects(remoteBook, pending.manifest);
      await this.journal.acknowledge(pending.operationIds);
      return { pushed: false, conflicts: 0, rejected: 0 };
    }
    const source = await this.repository.getBookSource(pending.manifest.bookId);
    if (!source) {
      return {
        pushed: false,
        conflicts: 0,
        rejected: pending.operationIds.length,
      };
    }
    const opened = await source.open();
    throwIfSyncAborted(options.signal);
    const blob = opened instanceof Blob ? opened : new Blob([opened]);
    if (!(await matchesManifest(blob, pending.manifest, options.signal))) {
      return {
        pushed: false,
        conflicts: 0,
        rejected: pending.operationIds.length,
      };
    }

    const existingObject = await this.remote.headObject(
      pending.manifest.objectPath,
    );
    if (
      existingObject &&
      (existingObject.size !== pending.manifest.size ||
        existingObject.sha256 !== pending.manifest.sha256)
    ) {
      return {
        pushed: false,
        conflicts: 0,
        rejected: pending.operationIds.length,
      };
    }
    if (!existingObject) {
      const uploaded = await this.remote.uploadObject({
        path: pending.manifest.objectPath,
        content: blob,
        size: pending.manifest.size,
        sha256: pending.manifest.sha256,
        mediaType: pending.manifest.mediaType,
        signal: options.signal,
        onProgress: options.onTransferProgress,
      });
      throwIfSyncAborted(options.signal);
      if (
        uploaded.path !== pending.manifest.objectPath ||
        uploaded.size !== pending.manifest.size ||
        uploaded.sha256 !== pending.manifest.sha256
      ) {
        return {
          pushed: false,
          conflicts: 0,
          rejected: pending.operationIds.length,
        };
      }
    }

    const result = await this.pushManifest(pending, options.signal);
    if (result.pushed && deletion) {
      await this.deleteRemoteDocument({
        path: deletion.path,
        expectedRevision: deletion.revision,
        message: `Restore book ${pending.manifest.title}`,
      });
      this.exclusions.include(pending.manifest.bookId);
    }
    return result;
  }

  private async pushDeletion(
    pending: PendingBookDeletion,
    options: SyncWorkerOptions,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const path = bookDeletionPath(pending.tombstone.bookId);
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      throwIfSyncAborted(options.signal);
      const current = await this.remote.read(path);
      const remoteBook = current ? parseBookSyncDocument(current) : null;
      if (
        current &&
        (!remoteBook || remoteBook.bookId !== pending.tombstone.bookId)
      ) {
        return {
          pushed: false,
          conflicts,
          rejected: pending.operationIds.length,
        };
      }
      const tombstone =
        remoteBook &&
        isBookSyncDeletionTombstone(remoteBook) &&
        remoteBook.deletedAt > pending.tombstone.deletedAt
          ? remoteBook
          : pending.tombstone;

      try {
        if (!current || current.content !== serializeTombstone(tombstone)) {
          await this.remote.write({
            path,
            content: serializeTombstone(tombstone),
            expectedRevision: current?.revision,
            message: `Delete book ${tombstone.bookId}`,
          });
        }
        const manifestPath = bookManifestPath(tombstone);
        const manifest = await this.remote.read(manifestPath);
        if (manifest) {
          const active = parseBookSyncDocument(manifest);
          if (
            !active ||
            !isBookSyncManifest(active) ||
            active.bookId !== tombstone.bookId
          ) {
            return {
              pushed: false,
              conflicts,
              rejected: pending.operationIds.length,
            };
          }
          await this.deleteRemoteDocument({
            path: manifestPath,
            expectedRevision: manifest.revision,
            message: `Delete book ${tombstone.bookId}`,
          });
        }
        await this.discardDeletedObjects(tombstone, remoteBook);
        await this.journal.acknowledge(pending.operationIds);
        return { pushed: true, conflicts, rejected: 0 };
      } catch (error) {
        if (
          !(error instanceof SyncConflictError) ||
          attempt >= this.maxConflictRetries
        ) {
          throw error;
        }
        conflicts += 1;
        await this.wait(this.retryDelayMs * 2 ** attempt);
      }
    }
  }

  private async pushManifest(
    pending: PendingBookWrite,
    signal?: AbortSignal,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const path = bookManifestPath(pending.manifest);
    const content = serializeManifest(pending.manifest);
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      throwIfSyncAborted(signal);
      const current = await this.remote.read(path);
      if (current?.content === content) {
        if (await this.discardManifestIfDeleted(pending, current)) {
          return { pushed: false, conflicts, rejected: 0 };
        }
        await this.journal.acknowledge(pending.operationIds);
        return { pushed: true, conflicts, rejected: 0 };
      }
      if (current) {
        const currentBook = parseBookSyncDocument(current);
        if (
          currentBook &&
          isBookSyncDeletionTombstone(currentBook) &&
          !isNewerThanDeletion(pending, currentBook)
        ) {
          this.exclusions.exclude(pending.manifest.bookId);
          await this.discardDeletedObjects(currentBook, pending.manifest);
          await this.journal.acknowledge(pending.operationIds);
          return { pushed: false, conflicts, rejected: 0 };
        }
        if (!currentBook) {
          return {
            pushed: false,
            conflicts,
            rejected: pending.operationIds.length,
          };
        }
        if (
          isBookSyncManifest(currentBook) &&
          (currentBook.bookId !== pending.manifest.bookId ||
            currentBook.sha256 !== pending.manifest.sha256)
        ) {
          return {
            pushed: false,
            conflicts,
            rejected: pending.operationIds.length,
          };
        }
      }

      try {
        throwIfSyncAborted(signal);
        const written = await this.remote.write({
          path,
          content,
          expectedRevision: current?.revision,
          message: `Update book manifest for ${pending.manifest.bookId}`,
        });
        throwIfSyncAborted(signal);
        if (await this.discardManifestIfDeleted(pending, written)) {
          return { pushed: false, conflicts, rejected: 0 };
        }
        await this.journal.acknowledge(pending.operationIds);
        return { pushed: true, conflicts, rejected: 0 };
      } catch (error) {
        if (
          !(error instanceof SyncConflictError) ||
          attempt >= this.maxConflictRetries
        ) {
          throw error;
        }
        conflicts += 1;
        await this.wait(this.retryDelayMs * 2 ** attempt);
        throwIfSyncAborted(signal);
      }
    }
  }

  private async discardDeletedObject(path: string): Promise<void> {
    if (!this.remote.deleteObject) {
      return;
    }
    const object = await this.remote.headObject(path);
    if (object) {
      await this.remote.deleteObject({
        path,
        expectedRevision: object.revision,
      });
    }
  }

  private async discardManifestIfDeleted(
    pending: PendingBookWrite,
    manifest: RemoteDocument,
  ): Promise<boolean> {
    const document = await this.remote.read(
      bookDeletionPath(pending.manifest.bookId),
    );
    const deletion = document ? parseBookSyncDocument(document) : null;
    if (
      !deletion ||
      !isBookSyncDeletionTombstone(deletion) ||
      isNewerThanDeletion(pending, deletion)
    ) {
      return false;
    }
    this.exclusions.exclude(pending.manifest.bookId);
    await this.deleteRemoteDocument({
      path: manifest.path,
      expectedRevision: manifest.revision,
      message: `Honor deletion of ${pending.manifest.title}`,
    });
    await this.discardDeletedObjects(deletion, pending.manifest);
    await this.journal.acknowledge(pending.operationIds);
    return true;
  }

  private deleteRemoteDocument(
    request: Parameters<NonNullable<LibrarySyncTransport['deleteDocument']>>[0],
  ): Promise<void> {
    if (!this.remote.deleteDocument) {
      throw new Error(
        'The selected synchronization provider cannot delete remote documents',
      );
    }
    return this.remote.deleteDocument(request);
  }

  private async discardDeletedObjects(
    tombstone: BookSyncDeletionTombstone,
    remoteBook: BookSyncDocument | null,
  ): Promise<void> {
    const paths = new Set([
      tombstone.objectPath,
      bookObjectPath(tombstone),
      legacyBookObjectPath(tombstone.bookId, tombstone.format),
      ...(remoteBook ? [remoteBook.objectPath] : []),
    ]);
    for (const path of paths) {
      await this.discardDeletedObject(path);
    }
  }

  private async cleanupLegacyRemoteLayout(): Promise<void> {
    for (const document of await this.remote.list(LEGACY_BOOKS_ROOT)) {
      if (!document.path.endsWith('/book.json')) {
        continue;
      }
      const directory = document.path.slice(0, -'/book.json'.length);
      for (const format of ['epub', 'pdf'] as const) {
        await this.discardDeletedObject(`${directory}/publication.${format}`);
      }
      await this.deleteRemoteDocument({
        path: document.path,
        expectedRevision: document.revision,
        message: 'Remove obsolete hash-addressed book record',
      });
    }
  }
}

class BlobBookSource implements BookSource {
  readonly size: number;

  constructor(
    readonly name: string,
    readonly mediaType: string,
    private readonly blob: Blob,
  ) {
    this.size = blob.size;
  }

  async open(): Promise<Blob> {
    return this.blob;
  }
}

export function parseBookSyncDocument(
  document: Pick<RemoteDocument, 'content'>,
): BookSyncDocument | null {
  try {
    const value: unknown = JSON.parse(document.content);
    return isBookSyncDocument(value) ? value : null;
  } catch {
    return null;
  }
}

function serializeManifest(manifest: BookSyncManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function serializeTombstone(tombstone: BookSyncDeletionTombstone): string {
  return `${JSON.stringify(tombstone, null, 2)}\n`;
}

async function matchesManifest(
  blob: Blob,
  manifest: BookSyncManifest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (blob.size !== manifest.size) {
    return false;
  }
  throwIfSyncAborted(signal);
  const sha256 = await blobSha256(blob, signal);
  throwIfSyncAborted(signal);
  return sha256 === manifest.sha256;
}

function coalesceBookOperations(operations: readonly SyncOperation[]): {
  changes: Map<string, PendingBookChange>;
  acceptedOperationCount: number;
} {
  const changes = new Map<string, PendingBookChange>();
  let acceptedOperationCount = 0;

  for (const operation of operations) {
    if (
      operation.entity !== 'book' ||
      operation.entityId !==
        (isBookSyncManifest(operation.payload) ||
        isBookSyncDeletionTombstone(operation.payload)
          ? operation.payload.bookId
          : null) ||
      (operation.operation === 'upsert'
        ? !isBookSyncManifest(operation.payload)
        : operation.operation === 'delete'
          ? !isBookSyncDeletionTombstone(operation.payload)
          : true)
    ) {
      continue;
    }
    acceptedOperationCount += 1;
    const payload = operation.payload as BookSyncDocument;
    const existing = changes.get(payload.bookId);
    if (!existing) {
      changes.set(
        payload.bookId,
        isBookSyncManifest(payload)
          ? {
              kind: 'upsert',
              manifest: payload,
              operationIds: [operation.id],
              latestOperation: operation,
            }
          : pendingDeletion(payload, [operation.id], operation),
      );
      continue;
    }
    existing.operationIds.push(operation.id);
    if (compareOperations(operation, existing.latestOperation) > 0) {
      changes.set(
        payload.bookId,
        isBookSyncManifest(payload)
          ? {
              kind: 'upsert',
              manifest: payload,
              operationIds: existing.operationIds,
              latestOperation: operation,
            }
          : pendingDeletion(payload, existing.operationIds, operation),
      );
    }
  }

  return { changes, acceptedOperationCount };
}

function compareOperations(left: SyncOperation, right: SyncOperation): number {
  const byRevision = left.revision - right.revision;
  if (byRevision) {
    return byRevision;
  }
  return left.id.localeCompare(right.id);
}

function isNewerThanDeletion(
  pending: PendingBookWrite,
  tombstone: BookSyncDeletionTombstone,
): boolean {
  return (
    pending.latestOperation.createdAt > tombstone.deletedAt &&
    pending.manifest.updatedAt > tombstone.deletedAt
  );
}

function syntheticBookOperation(manifest: BookSyncManifest): SyncOperation {
  return {
    id: `snapshot:${manifest.bookId}`,
    entity: 'book',
    entityId: manifest.bookId,
    operation: 'upsert',
    revision: 0,
    createdAt: manifest.updatedAt,
    payload: manifest,
  };
}

function pendingDeletion(
  tombstone: BookSyncDeletionTombstone,
  operationIds: string[],
  latestOperation: SyncOperation,
): PendingBookDeletion {
  return {
    kind: 'delete',
    tombstone,
    operationIds,
    latestOperation,
  };
}

function syntheticBookDeletion(
  tombstone: BookSyncDeletionTombstone,
): SyncOperation {
  return {
    id: `snapshot-delete:${tombstone.bookId}`,
    entity: 'book',
    entityId: tombstone.bookId,
    operation: 'delete',
    revision: 0,
    createdAt: tombstone.deletedAt,
    payload: tombstone,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
