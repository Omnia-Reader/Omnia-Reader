import {
  BookSource,
  LibraryRepository,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  BOOKS_ROOT,
  BookSyncDeletionTombstone,
  BookSyncDocument,
  BookSyncManifest,
  bookManifestPath,
  createBookSyncManifest,
  isBookSyncDeletionTombstone,
  isBookSyncDocument,
  isBookSyncManifest,
  manifestBookRecord,
} from './book-sync-manifest';
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
  manifest: BookSyncManifest;
  operationIds: string[];
  latestOperation: SyncOperation;
}

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
    const [documents, pending] = await Promise.all([
      this.remote.list(BOOKS_ROOT),
      this.journal.pending(),
    ]);
    const localIntents = coalesceBookOperations(pending).documents;
    let pulled = 0;
    let rejected = 0;

    for (const document of documents) {
      throwIfSyncAborted(options.signal);
      if (!document.path.endsWith('/book.json')) {
        continue;
      }
      const remoteBook = parseBookSyncDocument(document);
      if (
        !remoteBook ||
        document.path !== bookManifestPath(remoteBook.bookId)
      ) {
        rejected += 1;
        continue;
      }
      if (isBookSyncDeletionTombstone(remoteBook)) {
        const localIntent = localIntents.get(remoteBook.bookId);
        if (!localIntent || !isNewerThanDeletion(localIntent, remoteBook)) {
          const wasExcluded = this.exclusions.isExcluded(remoteBook.bookId);
          this.exclusions.exclude(remoteBook.bookId);
          await this.discardDeletedObject(remoteBook.objectPath);
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
    const writes = coalesceBookOperations(pending);
    const discardedOperationIds: string[] = [];
    for (const [bookId, write] of writes.documents) {
      if (this.exclusions.isExcluded(bookId)) {
        discardedOperationIds.push(...write.operationIds);
        writes.documents.delete(bookId);
      }
    }
    if (discardedOperationIds.length > 0) {
      await this.journal.acknowledge(discardedOperationIds);
    }
    for (const book of await this.repository.listBooks()) {
      throwIfSyncAborted(options.signal);
      if (
        !this.exclusions.isExcluded(book.id) &&
        !writes.documents.has(book.id)
      ) {
        const manifest = createBookSyncManifest(book);
        writes.documents.set(book.id, {
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
      writes.acceptedOperationCount;

    for (const write of writes.documents.values()) {
      throwIfSyncAborted(options.signal);
      const result = await this.pushBook(write, options);
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
    const current = await this.remote.read(
      bookManifestPath(pending.manifest.bookId),
    );
    const remoteBook = current ? parseBookSyncDocument(current) : null;
    if (
      remoteBook &&
      isBookSyncDeletionTombstone(remoteBook) &&
      !isNewerThanDeletion(pending, remoteBook)
    ) {
      this.exclusions.exclude(pending.manifest.bookId);
      await this.discardDeletedObject(pending.manifest.objectPath);
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

    return this.pushManifest(pending, options.signal);
  }

  private async pushManifest(
    pending: PendingBookWrite,
    signal?: AbortSignal,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const path = bookManifestPath(pending.manifest.bookId);
    const content = serializeManifest(pending.manifest);
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      throwIfSyncAborted(signal);
      const current = await this.remote.read(path);
      if (current?.content === content) {
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
          await this.discardDeletedObject(pending.manifest.objectPath);
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
        await this.remote.write({
          path,
          content,
          expectedRevision: current?.revision,
          message: `Update book manifest for ${pending.manifest.bookId}`,
        });
        throwIfSyncAborted(signal);
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
  documents: Map<string, PendingBookWrite>;
  acceptedOperationCount: number;
} {
  const documents = new Map<string, PendingBookWrite>();
  let acceptedOperationCount = 0;

  for (const operation of operations) {
    if (
      operation.entity !== 'book' ||
      operation.operation !== 'upsert' ||
      !isBookSyncManifest(operation.payload) ||
      operation.entityId !== operation.payload.bookId
    ) {
      continue;
    }
    acceptedOperationCount += 1;
    const existing = documents.get(operation.payload.bookId);
    if (!existing) {
      documents.set(operation.payload.bookId, {
        manifest: operation.payload,
        operationIds: [operation.id],
        latestOperation: operation,
      });
      continue;
    }
    existing.operationIds.push(operation.id);
    if (compareOperations(operation, existing.latestOperation) > 0) {
      existing.manifest = operation.payload;
      existing.latestOperation = operation;
    }
  }

  return { documents, acceptedOperationCount };
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
