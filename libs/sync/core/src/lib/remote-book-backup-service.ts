import { SyncOperationJournal } from '@omnia-reader/reader/domain';
import {
  BOOKS_ROOT,
  BookSyncDeletionTombstone,
  BookSyncManifest,
  bookDeletionPath,
  bookManifestPath,
  createBookSyncDeletionTombstone,
  isBookSyncDeletionTombstone,
  isBookSyncManifest,
} from './book-sync-manifest';
import { updateBookSyncCatalog } from './book-sync-catalog';
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
      if (!record || document.path !== bookManifestPath(record)) {
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
    const deleteDocument = this.remote.deleteDocument?.bind(this.remote);
    if (!deleteObject || !deleteDocument) {
      throw new Error(
        'The selected synchronization provider cannot delete remote publications and records',
      );
    }

    const wasExcluded = this.exclusions.isExcluded(bookId);
    this.exclusions.exclude(bookId);
    let tombstoneCommitted = false;
    try {
      const backup = (await this.list()).find(
        (candidate) => candidate.manifest.bookId === bookId,
      );
      const existingDeletion = await this.remote.read(bookDeletionPath(bookId));
      const deletionRecord = existingDeletion
        ? parseBookSyncDocument(existingDeletion)
        : null;
      if (
        existingDeletion &&
        (!deletionRecord ||
          !isBookSyncDeletionTombstone(deletionRecord) ||
          deletionRecord.bookId !== bookId)
      ) {
        throw new RemoteBookBackupProtocolError();
      }
      const existingTombstone =
        deletionRecord && isBookSyncDeletionTombstone(deletionRecord)
          ? deletionRecord
          : null;
      if (!backup && !existingTombstone) {
        await this.acknowledgePendingBookWrites(bookId);
        return null;
      }
      let tombstone: BookSyncDeletionTombstone;
      if (existingTombstone) {
        tombstone = existingTombstone;
      } else if (backup) {
        tombstone = createBookSyncDeletionTombstone(
          {
            id: backup.manifest.bookId,
            format: backup.manifest.format,
            fileName: backup.manifest.fileName,
          },
          this.now(),
        );
      } else {
        await this.acknowledgePendingBookWrites(bookId);
        return null;
      }
      for (let attempt = 0; ; attempt += 1) {
        const manifestPath = bookManifestPath(backup?.manifest ?? tombstone);
        const currentManifest = await this.remote.read(manifestPath);
        const record = currentManifest
          ? parseBookSyncDocument(currentManifest)
          : null;
        if (
          currentManifest &&
          (!record || !isBookSyncManifest(record) || record.bookId !== bookId)
        ) {
          throw new RemoteBookBackupProtocolError();
        }
        try {
          const deletionPath = bookDeletionPath(bookId);
          const currentDeletion = await this.remote.read(deletionPath);
          if (currentDeletion) {
            const deletion = parseBookSyncDocument(currentDeletion);
            if (
              !deletion ||
              !isBookSyncDeletionTombstone(deletion) ||
              deletion.bookId !== bookId
            ) {
              throw new RemoteBookBackupProtocolError();
            }
          }
          if (currentDeletion?.content !== serializeTombstone(tombstone)) {
            await this.remote.write({
              path: deletionPath,
              content: serializeTombstone(tombstone),
              expectedRevision: currentDeletion?.revision,
              message: `Delete remote book backup ${bookId}`,
            });
          }
          tombstoneCommitted = true;
          if (currentManifest) {
            await deleteDocument({
              path: manifestPath,
              expectedRevision: currentManifest.revision,
              message: `Delete remote book backup ${bookId}`,
            });
          }
          const object = await this.remote.headObject(tombstone.objectPath);
          if (object) {
            await deleteObject({
              path: tombstone.objectPath,
              expectedRevision: object.revision,
            });
          }
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
        await this.acknowledgePendingBookWrites(bookId);
        await updateBookSyncCatalog(this.remote, {
          maxConflictRetries: this.maxConflictRetries,
          retryDelayMs: this.retryDelayMs,
          wait: this.wait,
        });
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
