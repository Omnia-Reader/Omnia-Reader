import {
  LogicalBookChange,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
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
import {
  LOGICAL_BOOK_STATE_PATH,
  parseLogicalBookState,
} from './logical-book-state';
import { isSynchronizedLogicalBookChange } from './logical-book-change';
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
  orphanGraceMs?: number;
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
  private readonly orphanGraceMs: number;
  private orphanScope: string | null = null;
  private readonly orphanObservations = new Map<
    string,
    { fingerprint: string; since: number }
  >();

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
    this.orphanGraceMs = options.orphanGraceMs ?? 5 * 60_000;
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

  async reconcileOrphaned(
    scope: string,
  ): Promise<{ deleted: number; pending: boolean }> {
    if (this.orphanScope !== scope) {
      this.orphanObservations.clear();
      this.orphanScope = scope;
    }
    const candidates = await this.listOrphaned();
    const ids = new Set(candidates.map((backup) => backup.manifest.bookId));
    for (const id of this.orphanObservations.keys())
      if (!ids.has(id)) this.orphanObservations.delete(id);
    let deleted = 0;
    const now = Date.parse(this.now());
    for (const id of ids) {
      const backups = candidates.filter(
        (backup) => backup.manifest.bookId === id,
      );
      const fingerprint = JSON.stringify(
        backups
          .map((backup) => [bookManifestPath(backup.manifest), backup.revision])
          .sort(),
      );
      const previous = this.orphanObservations.get(id);
      if (
        !previous ||
        previous.fingerprint !== fingerprint ||
        now < previous.since
      ) {
        this.orphanObservations.set(id, { fingerprint, since: now });
        continue;
      }
      if (now - previous.since < this.orphanGraceMs) continue;
      try {
        await this.deleteOrphaned(backups);
        this.orphanObservations.delete(id);
        deleted += 1;
      } catch (error) {
        if (!(error instanceof SyncConflictError)) throw error;
        // A concurrently imported or changed backup must earn a fresh grace period.
        this.orphanObservations.delete(id);
      }
    }
    return {
      deleted,
      pending: this.orphanObservations.size > 0 || deleted < ids.size,
    };
  }

  async listOrphaned(): Promise<readonly RemoteBookBackup[]> {
    const document = await this.remote.read(LOGICAL_BOOK_STATE_PATH);
    // Before initial library synchronization, remote-only publications may be
    // the user's only restorable copy. Never classify them as cleanup targets.
    if (!document) return [];
    const state = parseLogicalBookState(document.content);
    const protectedIds = new Set(
      state.variants.map((entry) => entry.variant.id),
    );
    for (const operation of await this.journal.pending()) {
      if (operation.entity === 'book' && operation.operation === 'upsert')
        protectedIds.add(operation.entityId);
      if (
        operation.entity === 'logical-book-change' &&
        isSynchronizedLogicalBookChange(operation.payload)
      ) {
        const change = operation.payload as LogicalBookChange;
        for (const book of change.resultingBooks) {
          for (const id of Object.values(book.variants))
            if (id) protectedIds.add(id);
        }
        for (const effect of change.variantEffects ?? []) {
          if (effect.operation === 'upsert')
            protectedIds.add(effect.variant.id);
        }
      }
    }
    return (await this.list()).filter(
      (backup) => !protectedIds.has(backup.manifest.bookId),
    );
  }

  async deleteOrphaned(approved: readonly RemoteBookBackup[]): Promise<void> {
    for (const bookId of new Set(
      approved.map((backup) => backup.manifest.bookId),
    )) {
      // Recheck membership and exact manifest revisions after confirmation and
      // before each deletion. Newly imported or changed editions need review.
      const current = (await this.listOrphaned()).filter(
        (backup) => backup.manifest.bookId === bookId,
      );
      const expected = approved.filter(
        (backup) => backup.manifest.bookId === bookId,
      );
      if (
        current.length !== expected.length ||
        current.some(
          (backup) =>
            !expected.some(
              (candidate) =>
                candidate.revision === backup.revision &&
                bookManifestPath(candidate.manifest) ===
                  bookManifestPath(backup.manifest),
            ),
        )
      )
        throw new SyncConflictError(
          'The backup or its library membership changed. Cleanup will retry after reconciliation.',
        );
      await this.deleteBackupFromInventory(bookId, current);
    }
  }

  async deleteBackups(bookIds: readonly string[]): Promise<void> {
    const backups = await this.list();
    let hasDeletions = false;
    for (const bookId of new Set(bookIds)) {
      if (await this.deleteBackupFromInventory(bookId, backups, false)) {
        hasDeletions = true;
      }
    }
    if (hasDeletions) await this.refreshCatalog();
  }

  async deleteBackup(
    bookId: string,
  ): Promise<BookSyncDeletionTombstone | null> {
    return this.deleteBackupFromInventory(bookId, await this.list());
  }

  private async deleteBackupFromInventory(
    bookId: string,
    backups: readonly RemoteBookBackup[],
    refreshCatalog = true,
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
      const matchingBackups = backups.filter(
        (candidate) => candidate.manifest.bookId === bookId,
      );
      const backup = matchingBackups[0];
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
          // A renamed import of the same edition can leave another directory.
          // Retain its manifest until its bytes are gone so interrupted cleanup
          // can rediscover that path on the next attempt.
          for (const extra of matchingBackups.slice(1)) {
            const extraPath = bookManifestPath(extra.manifest);
            const currentExtra = await this.remote.read(extraPath);
            if (!currentExtra) continue;
            const extraRecord = parseBookSyncDocument(currentExtra);
            if (
              !extraRecord ||
              !isBookSyncManifest(extraRecord) ||
              extraRecord.bookId !== bookId
            ) {
              throw new RemoteBookBackupProtocolError();
            }
            const extraObject = await this.remote.headObject(
              extraRecord.objectPath,
            );
            if (extraObject)
              await deleteObject({
                path: extraObject.path,
                expectedRevision: extraObject.revision,
              });
            await deleteDocument({
              path: extraPath,
              expectedRevision: currentExtra.revision,
              message: `Delete remote book backup ${bookId}`,
            });
          }
          if (currentManifest && record && isBookSyncManifest(record)) {
            const manifestObject = await this.remote.headObject(
              record.objectPath,
            );
            if (manifestObject) {
              await deleteObject({
                path: manifestObject.path,
                expectedRevision: manifestObject.revision,
              });
            }
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
        if (refreshCatalog) await this.refreshCatalog();
        return tombstone;
      }
    } catch (error) {
      if (!wasExcluded && !tombstoneCommitted) {
        this.exclusions.include(bookId);
      }
      throw error;
    }
  }

  private async refreshCatalog(): Promise<void> {
    await updateBookSyncCatalog(this.remote, {
      maxConflictRetries: this.maxConflictRetries,
      retryDelayMs: this.retryDelayMs,
      wait: this.wait,
    });
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
