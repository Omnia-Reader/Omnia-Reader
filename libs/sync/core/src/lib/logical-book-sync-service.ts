import {
  BookSource,
  BookRecord,
  LibraryRepository,
  LogicalBookChange,
  LogicalBookFormatPreference,
  LogicalBookRecord,
  MembershipReconciliation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { SyncWorker, SyncWorkerResult } from './library-sync-coordinator';
import {
  LibrarySyncTransport,
  RemoteDocument,
  RemoteSyncEntry,
  SyncConflictError,
} from './library-sync-transport';
import {
  isSynchronizedLogicalBookChange,
  parseLogicalBookChange,
  serializeLogicalBookChange,
} from './logical-book-change';
import { SYNC_ROOT } from './library-sync-manifest';
import { bookObjectPath } from './book-sync-manifest';
import {
  emptyLogicalBookState,
  LOGICAL_BOOK_STATE_PATH,
  logicalBookStateView,
  LogicalBookStateDocument,
  mergeLogicalBookChangesIntoState,
  parseLogicalBookState,
  serializeLogicalBookState,
} from './logical-book-state';

const LOGICAL_STATE_WRITE_ATTEMPTS = 3;
const LOGICAL_BOOKS_ROOT = `${SYNC_ROOT}/logical-books`;
const LEGACY_CHANGES_ROOT = `${SYNC_ROOT}/logical-books/changes`;

export interface LogicalBookStateRepository extends LibraryRepository {
  replaceLogicalBookState(
    books: readonly LogicalBookRecord[],
    preferences: readonly LogicalBookFormatPreference[],
    reconciliations: readonly MembershipReconciliation[],
  ): Promise<void>;
}

export class LogicalBookSyncService implements SyncWorker {
  private active: Promise<SyncWorkerResult> | null = null;

  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly repository: LogicalBookStateRepository,
  ) {}

  synchronize(): Promise<SyncWorkerResult> {
    if (!this.active) {
      this.active = this.run().finally(() => {
        this.active = null;
      });
    }
    return this.active;
  }

  private async run(): Promise<SyncWorkerResult> {
    const [logicalEntries, pending, initialStateDocument] = await Promise.all([
      this.listLogicalEntries(),
      this.journal.pending(),
      this.remote.read(LOGICAL_BOOK_STATE_PATH),
    ]);
    const hasLegacyChanges = logicalEntries.some(
      (entry) =>
        entry.path === LEGACY_CHANGES_ROOT ||
        entry.path.startsWith(`${LEGACY_CHANGES_ROOT}/`),
    );
    const legacyDocuments = hasLegacyChanges
      ? await this.remote.list(LEGACY_CHANGES_ROOT)
      : [];
    const remoteChanges = legacyDocuments.map((document) =>
      parseLogicalBookChange(document.content),
    );
    const pendingOperations = pending.filter(
      (operation) =>
        operation.entity === 'logical-book-change' &&
        isSynchronizedLogicalBookChange(operation.payload),
    );
    const localSeed =
      !initialStateDocument && legacyDocuments.length === 0
        ? await this.localStateSnapshot()
        : emptyLogicalBookState();
    const localChanges = pendingOperations.map(
      (operation) => operation.payload as LogicalBookChange,
    );
    const allChanges = uniqueChanges([...remoteChanges, ...localChanges]);
    const legacyVariantPaths = new Map<string, string>();
    for (const change of remoteChanges) {
      for (const effect of change.variantEffects ?? []) {
        if (effect.operation === 'upsert') {
          legacyVariantPaths.set(effect.variant.id, effect.objectPath);
        }
      }
    }

    const { state, pushed } = await this.writeMergedState(
      initialStateDocument,
      localSeed,
      allChanges,
      legacyVariantPaths,
    );
    const view = logicalBookStateView(state);
    await this.repository.replaceLogicalBookState(
      view.books,
      view.preferences,
      view.reconciliations,
    );

    await this.deleteLegacyLogicalEntries(logicalEntries);
    if (pendingOperations.length > 0) {
      await this.journal.acknowledge(
        pendingOperations.map((operation) => operation.id),
      );
    }
    return {
      pulled: remoteChanges.length + (initialStateDocument ? 1 : 0),
      pushed,
      conflicts: view.reconciliations.filter((item) => item.status === 'open')
        .length,
      rejected: 0,
    };
  }

  private async writeMergedState(
    initialDocument: RemoteDocument | null,
    localSeed: LogicalBookStateDocument,
    changes: readonly LogicalBookChange[],
    legacyVariantPaths: ReadonlyMap<string, string>,
  ): Promise<{ state: LogicalBookStateDocument; pushed: number }> {
    let current = initialDocument;
    for (
      let attempt = 0;
      attempt < LOGICAL_STATE_WRITE_ATTEMPTS;
      attempt += 1
    ) {
      const base = current ? parseLogicalBookState(current.content) : localSeed;
      const state = mergeLogicalBookChangesIntoState(base, changes);
      await this.reconcileActiveVariants(state, legacyVariantPaths);
      const content = serializeLogicalBookState(state);
      let pushed = 0;
      try {
        if (current?.content !== content) {
          current = await this.remote.write({
            path: LOGICAL_BOOK_STATE_PATH,
            content,
            ...(current ? { expectedRevision: current.revision } : {}),
            message: 'Synchronize logical book state',
          });
          pushed = 1;
        }
        const verified = await this.remote.read(LOGICAL_BOOK_STATE_PATH);
        if (
          !verified ||
          verified.content !== content ||
          verified.revision !== current?.revision
        ) {
          throw new SyncConflictError(
            'The canonical logical book state changed during verification',
          );
        }
        const parsed = parseLogicalBookState(verified.content);
        if (serializeLogicalBookState(parsed) !== content) {
          throw new Error('Canonical logical book state verification failed');
        }
        return { state: parsed, pushed };
      } catch (error) {
        if (
          !isSyncConflict(error) ||
          attempt + 1 >= LOGICAL_STATE_WRITE_ATTEMPTS
        ) {
          throw error;
        }
        current = await this.remote.read(LOGICAL_BOOK_STATE_PATH);
      }
    }
    throw new SyncConflictError('Logical book state retry bound exhausted');
  }

  private async reconcileActiveVariants(
    state: LogicalBookStateDocument,
    legacyVariantPaths: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const entry of state.variants) {
      let local = await this.repository.getBook(entry.variant.id);
      let descriptor = await this.remote.headObject(entry.objectPath);
      if (descriptor) validateRemoteVariant(entry.variant, descriptor);

      if (!local && !descriptor) {
        const legacyPath = legacyVariantPaths.get(entry.variant.id);
        if (legacyPath) {
          const legacyDescriptor = await this.remote.headObject(legacyPath);
          if (legacyDescriptor) {
            validateRemoteVariant(entry.variant, legacyDescriptor);
            const blob = await this.remote.downloadObject(legacyPath, {
              expectedSize: entry.variant.size,
            });
            await this.repository.storeSyncedBook(
              entry.variant,
              new BlobBookSource(
                entry.variant.fileName,
                entry.variant.mediaType,
                blob,
              ),
            );
            local = entry.variant;
          }
        }
      }
      if (!local && descriptor) {
        const blob = await this.remote.downloadObject(entry.objectPath, {
          expectedSize: entry.variant.size,
        });
        await this.repository.storeSyncedBook(
          entry.variant,
          new BlobBookSource(
            entry.variant.fileName,
            entry.variant.mediaType,
            blob,
          ),
        );
        local = entry.variant;
      }
      if (!descriptor) {
        const source = await this.repository.getBookSource(entry.variant.id);
        if (!source) throw new Error('Local publication source is unavailable');
        const opened = await source.open();
        const blob = opened instanceof Blob ? opened : new Blob([opened]);
        descriptor = await this.remote.uploadObject({
          path: entry.objectPath,
          content: blob,
          size: entry.variant.size,
          sha256: entry.variant.id.slice('sha256:'.length),
          mediaType: entry.variant.mediaType,
        });
        validateRemoteVariant(entry.variant, descriptor);
      }
    }
  }

  private async listLogicalEntries(): Promise<readonly RemoteSyncEntry[]> {
    if (!this.remote.listEntries) {
      throw new Error(
        'The synchronization provider cannot inventory logical book state',
      );
    }
    return this.remote.listEntries(LOGICAL_BOOKS_ROOT);
  }

  private async localStateSnapshot(): Promise<LogicalBookStateDocument> {
    const snapshot = await this.repository.getLogicalLibrarySnapshot();
    const books: LogicalBookStateDocument['books'] = [];
    const variants = new Map<
      string,
      LogicalBookStateDocument['variants'][number]
    >();
    for (const book of snapshot.logicalBooks) {
      const clock = {
        changeId: `change:bootstrap:${book.id.slice('logical:sha256:'.length)}`,
        createdAt: book.importedAt,
        deviceId: 'schema-v2-bootstrap',
      };
      books.push({ book, clock });
      for (const variantId of Object.values(book.variants)) {
        if (!variantId || variants.has(variantId)) continue;
        const variant = await this.repository.getBook(variantId);
        if (!variant)
          throw new Error('Local publication record is unavailable');
        variants.set(variantId, {
          variant,
          objectPath: bookObjectPath(variant),
          clock,
        });
      }
    }
    return parseLogicalBookState(
      serializeLogicalBookState({
        schemaVersion: 1,
        heads: [],
        books,
        removedBooks: [],
        variants: [...variants.values()],
        removedVariants: [],
        preferences: snapshot.preferences.map((preference) => ({
          logicalBookId: preference.logicalBookId,
          preference,
          clock: {
            changeId: preference.winningChangeId,
            createdAt: preference.updatedAt,
            deviceId: preference.deviceId,
          },
        })),
        reconciliations: snapshot.reconciliations.map((reconciliation) => ({
          reconciliation,
          clock: {
            changeId:
              reconciliation.resolvedByChangeId ??
              reconciliation.conflictingChangeIds.slice(-1)[0] ??
              reconciliation.conflictId,
            createdAt: reconciliation.detectedAt,
            deviceId: 'schema-v2-bootstrap',
          },
        })),
      }),
    );
  }

  private async deleteLegacyLogicalEntries(
    entries: readonly RemoteSyncEntry[],
  ): Promise<void> {
    const legacy = entries.filter(
      (entry) => entry.path !== LOGICAL_BOOK_STATE_PATH,
    );
    if (legacy.length === 0) return;
    if (!this.remote.deleteEntries) {
      throw new Error(
        'The synchronization provider cannot retire legacy logical book state',
      );
    }
    await this.remote.deleteEntries(
      legacy.map((entry) => ({
        path: entry.path,
        expectedRevision: entry.revision,
      })),
    );
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

  open(): Promise<Blob> {
    return Promise.resolve(this.blob);
  }
}

function uniqueChanges(
  changes: readonly LogicalBookChange[],
): LogicalBookChange[] {
  const unique = new Map<string, LogicalBookChange>();
  for (const change of changes) {
    const current = unique.get(change.changeId);
    if (
      current &&
      serializeLogicalBookChange(current) !== serializeLogicalBookChange(change)
    ) {
      throw new Error('Conflicting immutable logical change documents');
    }
    unique.set(change.changeId, change);
  }
  return [...unique.values()];
}

function validateRemoteVariant(
  variant: BookRecord,
  descriptor: { size: number; sha256: string },
): void {
  if (
    descriptor.size !== variant.size ||
    descriptor.sha256 !== variant.id.slice('sha256:'.length)
  ) {
    throw new Error(
      'Remote publication descriptor failed integrity validation',
    );
  }
}

function isSyncConflict(error: unknown): boolean {
  return (
    error instanceof SyncConflictError ||
    (error instanceof Error && error.name === 'SyncConflictError')
  );
}
