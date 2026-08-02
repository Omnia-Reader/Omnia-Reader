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
import { LibrarySyncTransport } from './library-sync-transport';
import {
  isSynchronizedLogicalBookChange,
  logicalBookChangePath,
  parseLogicalBookChange,
  serializeLogicalBookChange,
} from './logical-book-change';
import { foldLogicalBookChanges } from './logical-book-merge';
import { SYNC_ROOT } from './library-sync-manifest';

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
    const [documents, pending] = await Promise.all([
      this.remote.list(`${SYNC_ROOT}/logical-books/changes`),
      this.journal.pending(),
    ]);
    const remoteChanges = documents.map((document) =>
      parseLogicalBookChange(document.content),
    );
    const pendingOperations = pending.filter(
      (operation) =>
        operation.entity === 'logical-book-change' &&
        isSynchronizedLogicalBookChange(operation.payload),
    );
    if (documents.length === 0 && pendingOperations.length === 0) {
      const snapshot = await this.repository.getLogicalLibrarySnapshot();
      for (const logicalBook of snapshot.logicalBooks) {
        const variants = (
          await Promise.all(
            Object.values(logicalBook.variants).map((id) =>
              id ? this.repository.getBook(id) : Promise.resolve(null),
            ),
          )
        ).filter((book): book is BookRecord => !!book);
        const change: LogicalBookChange = {
          schemaVersion: 1,
          changeId: `change:bootstrap:${logicalBook.id.slice(
            'logical:sha256:'.length,
          )}`,
          kind: 'bootstrap',
          parents: [],
          resultingBooks: [logicalBook],
          removedLogicalBookIds: [],
          variantEffects: variants.map((variant) => ({
            operation: 'upsert' as const,
            variant,
            objectPath: `${SYNC_ROOT}/books/${variant.id.slice(
              'sha256:'.length,
            )}/publication.${variant.format}`,
          })),
          preferenceEffects: snapshot.preferences
            .filter((preference) => preference.logicalBookId === logicalBook.id)
            .map((preference) => ({
              logicalBookId: logicalBook.id,
              preference,
            })),
          resolvesConflictIds: [],
          createdAt: logicalBook.importedAt,
          deviceId: 'schema-v2-bootstrap',
          appVersion: '0.0.0',
        };
        pendingOperations.push(
          await this.journal.append({
            entity: 'logical-book-change',
            entityId: change.changeId,
            operation: 'upsert',
            payload: change,
          }),
        );
      }
    }
    const localChanges = pendingOperations.map(
      (operation) => operation.payload as LogicalBookChange,
    );
    const allChanges = uniqueChanges([...remoteChanges, ...localChanges]);

    for (const change of allChanges) {
      for (const effect of change.variantEffects ?? []) {
        if (effect.operation !== 'upsert') continue;
        const existing = await this.repository.getBook(effect.variant.id);
        if (existing) continue;
        const descriptor = await this.remote.headObject(effect.objectPath);
        if (
          !descriptor ||
          descriptor.size !== effect.variant.size ||
          descriptor.sha256 !== effect.variant.id.slice('sha256:'.length)
        ) {
          throw new Error(
            'Remote publication descriptor failed integrity validation',
          );
        }
        const blob = await this.remote.downloadObject(effect.objectPath, {
          expectedSize: effect.variant.size,
        });
        await this.repository.storeSyncedBook(
          effect.variant,
          new BlobBookSource(
            effect.variant.fileName,
            effect.variant.mediaType,
            blob,
          ),
        );
      }
    }

    const merged = foldLogicalBookChanges(allChanges);
    if (allChanges.length > 0) {
      await this.repository.replaceLogicalBookState(
        merged.books,
        merged.preferences,
        merged.reconciliations,
      );
    }

    let pushed = 0;
    for (const operation of pendingOperations) {
      const change = operation.payload as LogicalBookChange;
      for (const effect of change.variantEffects ?? []) {
        if (effect.operation !== 'upsert') continue;
        if (await this.remote.headObject(effect.objectPath)) continue;
        const source = await this.repository.getBookSource(effect.variant.id);
        if (!source) throw new Error('Local publication source is unavailable');
        const opened = await source.open();
        const blob = opened instanceof Blob ? opened : new Blob([opened]);
        await this.remote.uploadObject({
          path: effect.objectPath,
          content: blob,
          size: effect.variant.size,
          sha256: effect.variant.id.slice('sha256:'.length),
          mediaType: effect.variant.mediaType,
        });
      }
      const path = logicalBookChangePath(change.changeId);
      const existing = await this.remote.read(path);
      if (!existing) {
        await this.remote.write({
          path,
          content: serializeLogicalBookChange(change),
          message: `Synchronize logical book change ${change.changeId}`,
        });
        pushed += 1;
      } else if (
        parseLogicalBookChange(existing.content).changeId !== change.changeId
      ) {
        throw new Error('Remote logical change identity mismatch');
      }
      await this.journal.acknowledge([operation.id]);
    }
    return {
      pulled: remoteChanges.length,
      pushed,
      conflicts: merged.reconciliations.filter((item) => item.status === 'open')
        .length,
      rejected: 0,
    };
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
