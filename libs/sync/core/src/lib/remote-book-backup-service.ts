import { SyncOperationJournal } from '@omnia-reader/reader/domain';
import {
  BOOKS_ROOT,
  BookSyncDeletionTombstone,
  BookSyncManifest,
  bookManifestPath,
  createBookSyncDeletionTombstone,
  isBookSyncDeletionTombstone,
  isBookSyncManifest,
} from './book-sync-manifest';
import { BookSyncExclusions } from './book-sync-exclusions';
import { parseBookSyncDocument } from './book-sync-service';
import {
  LibrarySyncTransport,
  SyncConflictError,
} from './library-sync-transport';

export interface RemoteBookBackup {
  manifest: BookSyncManifest;
  revision: string;
}

export interface RemoteBookBackupServiceOptions {
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => string;
}

const DEFAULT_MAX_CONFLICT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 100;

export class RemoteBookBackupProtocolError extends Error {
  constructor(message = 'A remote book backup record is invalid') {
    super(message);
    this.name = 'RemoteBookBackupProtocolError';
  }
}

export class RemoteBookBackupService {
  private readonly maxConflictRetries: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => string;

  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly exclusions: BookSyncExclusions,
    options: RemoteBookBackupServiceOptions = {},
  ) {
    this.maxConflictRetries =
      options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.wait = options.wait ?? wait;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(): Promise<readonly RemoteBookBackup[]> {
    const documents = await this.remote.list(BOOKS_ROOT);
    const backups: RemoteBookBackup[] = [];
    for (const document of documents) {
      if (!document.path.endsWith('/book.json')) {
        continue;
      }
      const record = parseBookSyncDocument(document);
      if (!record || document.path !== bookManifestPath(record.bookId)) {
        throw new RemoteBookBackupProtocolError();
      }
      if (isBookSyncManifest(record)) {
        backups.push({ manifest: record, revision: document.revision });
      }
    }
    return backups.sort((left, right) =>
      left.manifest.title.localeCompare(right.manifest.title),
    );
  }

  async deleteBackup(
    bookId: string,
  ): Promise<BookSyncDeletionTombstone | null> {
    const deleteObject = this.remote.deleteObject?.bind(this.remote);
    if (!deleteObject) {
      throw new Error(
        'The selected synchronization provider cannot delete remote publications',
      );
    }

    const wasExcluded = this.exclusions.isExcluded(bookId);
    this.exclusions.exclude(bookId);
    let tombstoneCommitted = false;
    try {
      for (let attempt = 0; ; attempt += 1) {
        const path = bookManifestPath(bookId);
        const current = await this.remote.read(path);
        if (!current) {
          await this.acknowledgePendingBookWrites(bookId);
          return null;
        }
        const record = parseBookSyncDocument(current);
        if (!record || record.bookId !== bookId) {
          throw new RemoteBookBackupProtocolError();
        }

        const tombstone = isBookSyncDeletionTombstone(record)
          ? record
          : createBookSyncDeletionTombstone(
              { id: record.bookId, format: record.format },
              this.now(),
            );
        if (!isBookSyncDeletionTombstone(record)) {
          try {
            await this.remote.write({
              path,
              content: serializeTombstone(tombstone),
              expectedRevision: current.revision,
              message: `Delete remote book backup ${bookId}`,
            });
            tombstoneCommitted = true;
          } catch (error) {
            if (
              !(error instanceof SyncConflictError) ||
              attempt >= this.maxConflictRetries
            ) {
              throw error;
            }
            await this.wait(this.retryDelayMs * 2 ** attempt);
            continue;
          }
        } else {
          tombstoneCommitted = true;
        }

        await this.acknowledgePendingBookWrites(bookId);
        const object = await this.remote.headObject(tombstone.objectPath);
        if (object) {
          await deleteObject({
            path: tombstone.objectPath,
            expectedRevision: object.revision,
          });
        }
        return tombstone;
      }
    } catch (error) {
      if (!wasExcluded && !tombstoneCommitted) {
        this.exclusions.include(bookId);
      }
      throw error;
    }
  }

  private async acknowledgePendingBookWrites(bookId: string): Promise<void> {
    const operationIds = (await this.journal.pending())
      .filter(
        (operation) =>
          operation.entity === 'book' && operation.entityId === bookId,
      )
      .map((operation) => operation.id);
    if (operationIds.length > 0) {
      await this.journal.acknowledge(operationIds);
    }
  }
}

function serializeTombstone(tombstone: BookSyncDeletionTombstone): string {
  return `${JSON.stringify(tombstone, null, 2)}\n`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
