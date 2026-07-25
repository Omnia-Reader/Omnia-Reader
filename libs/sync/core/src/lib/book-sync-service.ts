import {
  BookSource,
  LibraryRepository,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  BOOKS_ROOT,
  BookSyncManifest,
  bookManifestPath,
  createBookSyncManifest,
  isBookSyncManifest,
  manifestBookRecord,
} from './book-sync-manifest';
import {
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';

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
  }

  synchronize(): Promise<BookSyncResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization().finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  async pull(): Promise<BookSyncResult> {
    const documents = await this.remote.list(BOOKS_ROOT);
    let pulled = 0;
    let rejected = 0;

    for (const document of documents) {
      if (!document.path.endsWith('/book.json')) {
        continue;
      }
      const manifest = parseManifest(document);
      if (!manifest || document.path !== bookManifestPath(manifest.bookId)) {
        rejected += 1;
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

      const blob = await this.remote.downloadObject(manifest.objectPath);
      if (!(await matchesManifest(blob, manifest))) {
        rejected += 1;
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

  async push(): Promise<BookSyncResult> {
    const pending = await this.journal.pending();
    const writes = coalesceBookOperations(pending);
    for (const book of await this.repository.listBooks()) {
      if (!writes.documents.has(book.id)) {
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
      const result = await this.pushBook(write);
      pushed += result.pushed ? 1 : 0;
      conflicts += result.conflicts;
      rejected += result.rejected;
    }

    return { pulled: 0, pushed, conflicts, rejected };
  }

  private async runSynchronization(): Promise<BookSyncResult> {
    const pulled = await this.pull();
    const pushed = await this.push();
    return {
      pulled: pulled.pulled,
      pushed: pushed.pushed,
      conflicts: pulled.conflicts + pushed.conflicts,
      rejected: pulled.rejected + pushed.rejected,
    };
  }

  private async pushBook(
    pending: PendingBookWrite,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const source = await this.repository.getBookSource(pending.manifest.bookId);
    if (!source) {
      return {
        pushed: false,
        conflicts: 0,
        rejected: pending.operationIds.length,
      };
    }
    const opened = await source.open();
    const blob = opened instanceof Blob ? opened : new Blob([opened]);
    if (!(await matchesManifest(blob, pending.manifest))) {
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
      });
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

    return this.pushManifest(pending);
  }

  private async pushManifest(
    pending: PendingBookWrite,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const path = bookManifestPath(pending.manifest.bookId);
    const content = serializeManifest(pending.manifest);
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      const current = await this.remote.read(path);
      if (current?.content === content) {
        await this.journal.acknowledge(pending.operationIds);
        return { pushed: true, conflicts, rejected: 0 };
      }
      if (current) {
        const currentManifest = parseManifest(current);
        if (
          !currentManifest ||
          currentManifest.bookId !== pending.manifest.bookId ||
          currentManifest.sha256 !== pending.manifest.sha256
        ) {
          return {
            pushed: false,
            conflicts,
            rejected: pending.operationIds.length,
          };
        }
      }

      try {
        await this.remote.write({
          path,
          content,
          expectedRevision: current?.revision,
          message: `Update book manifest for ${pending.manifest.bookId}`,
        });
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

function parseManifest(
  document: Pick<RemoteDocument, 'content'>,
): BookSyncManifest | null {
  try {
    const value: unknown = JSON.parse(document.content);
    return isBookSyncManifest(value) ? value : null;
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
): Promise<boolean> {
  if (blob.size !== manifest.size) {
    return false;
  }
  const digest = await crypto.subtle.digest('SHA-256', await blobBytes(blob));
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return sha256 === manifest.sha256;
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () =>
      resolve(reader.result as ArrayBuffer),
    );
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read synchronized book')),
    );
    reader.readAsArrayBuffer(blob);
  });
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
