import { SyncOperation } from '@omnia-reader/reader/domain';
import { ObjectTransferProgressListener } from './library-sync-transport';

export interface SyncWorkerResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  rejected: number;
  unchanged?: true;
}

export interface SyncWorkerOptions {
  signal?: AbortSignal;
  onTransferProgress?: ObjectTransferProgressListener;
}

export interface SyncWorker {
  synchronize(options?: SyncWorkerOptions): Promise<SyncWorkerResult>;
}

export type ReadingStateSyncEntity = Extract<
  SyncOperation['entity'],
  'progress' | 'bookmark' | 'annotation'
>;

export interface PendingReadingStateSyncWorker {
  synchronizePending(
    operations: readonly SyncOperation[],
    options?: SyncWorkerOptions,
  ): Promise<SyncWorkerResult>;
}

export interface TargetedReadingStateSyncWorker extends SyncWorker {
  synchronizePending(
    operations: readonly SyncOperation[],
    options?: SyncWorkerOptions,
  ): Promise<SyncWorkerResult>;
}

export interface ReadingStateSyncWorkers {
  progress: TargetedReadingStateSyncWorker;
  bookmarks?: TargetedReadingStateSyncWorker;
  annotations?: TargetedReadingStateSyncWorker;
}

export interface LibrarySyncResult extends SyncWorkerResult {
  schemaPulled: number;
  schemaPushed: number;
  booksPulled: number;
  booksPushed: number;
  logicalBooksPulled: number;
  logicalBooksPushed: number;
  progressPulled: number;
  progressPushed: number;
  bookmarksPulled: number;
  bookmarksPushed: number;
  annotationsPulled: number;
  annotationsPushed: number;
}

export interface LibrarySyncWorkers {
  schema: SyncWorker;
  logicalBooks?: SyncWorker;
  books: SyncWorker;
  progress: SyncWorker;
  bookmarks?: SyncWorker;
  annotations?: SyncWorker;
}

export class LibrarySyncCoordinator implements SyncWorker {
  private activeSync: Promise<LibrarySyncResult> | null = null;

  constructor(private readonly workers: LibrarySyncWorkers) {}

  synchronize(options: SyncWorkerOptions = {}): Promise<LibrarySyncResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization(options).finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  private async runSynchronization(
    options: SyncWorkerOptions,
  ): Promise<LibrarySyncResult> {
    throwIfSyncAborted(options.signal);
    const schema = await this.workers.schema.synchronize(options);
    throwIfSyncAborted(options.signal);
    const books = await this.workers.books.synchronize(options);
    throwIfSyncAborted(options.signal);
    const logicalBooks = this.workers.logicalBooks
      ? await this.workers.logicalBooks.synchronize(options)
      : EMPTY_SYNC_RESULT;
    throwIfSyncAborted(options.signal);
    const [progress, bookmarks, annotations] = await Promise.all([
      this.workers.progress.synchronize(options),
      this.workers.bookmarks
        ? this.workers.bookmarks.synchronize(options)
        : EMPTY_SYNC_RESULT,
      this.workers.annotations
        ? this.workers.annotations.synchronize(options)
        : EMPTY_SYNC_RESULT,
    ]);
    throwIfSyncAborted(options.signal);
    return {
      pulled:
        schema.pulled +
        logicalBooks.pulled +
        books.pulled +
        progress.pulled +
        bookmarks.pulled +
        annotations.pulled,
      pushed:
        schema.pushed +
        logicalBooks.pushed +
        books.pushed +
        progress.pushed +
        bookmarks.pushed +
        annotations.pushed,
      conflicts:
        schema.conflicts +
        logicalBooks.conflicts +
        books.conflicts +
        progress.conflicts +
        bookmarks.conflicts +
        annotations.conflicts,
      rejected:
        schema.rejected +
        logicalBooks.rejected +
        books.rejected +
        progress.rejected +
        bookmarks.rejected +
        annotations.rejected,
      schemaPulled: schema.pulled,
      schemaPushed: schema.pushed,
      booksPulled: books.pulled,
      booksPushed: books.pushed,
      logicalBooksPulled: logicalBooks.pulled,
      logicalBooksPushed: logicalBooks.pushed,
      progressPulled: progress.pulled,
      progressPushed: progress.pushed,
      bookmarksPulled: bookmarks.pulled,
      bookmarksPushed: bookmarks.pushed,
      annotationsPulled: annotations.pulled,
      annotationsPushed: annotations.pushed,
    };
  }
}

/**
 * Synchronizes only the mutable reading-state domains represented by a durable
 * operation batch. The caller is responsible for proving that the remote
 * schema and publication state are already at a trusted checkpoint.
 */
export class ReadingStateSyncCoordinator
  implements PendingReadingStateSyncWorker
{
  private activeSync: Promise<SyncWorkerResult> | null = null;

  constructor(private readonly workers: ReadingStateSyncWorkers) {}

  synchronizePending(
    operations: readonly SyncOperation[],
    options: SyncWorkerOptions = {},
  ): Promise<SyncWorkerResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization(operations, options).finally(
        () => {
          this.activeSync = null;
        },
      );
    }
    return this.activeSync;
  }

  private async runSynchronization(
    operations: readonly SyncOperation[],
    options: SyncWorkerOptions,
  ): Promise<SyncWorkerResult> {
    throwIfSyncAborted(options.signal);
    const entities = new Set(operations.map((operation) => operation.entity));
    if ([...entities].some((entity) => !isReadingStateEntity(entity))) {
      throw new TypeError(
        'Targeted synchronization accepts only reading-state operations',
      );
    }

    const results = await Promise.all([
      entities.has('progress')
        ? this.workers.progress.synchronizePending(operations, options)
        : EMPTY_SYNC_RESULT,
      entities.has('bookmark') && this.workers.bookmarks
        ? this.workers.bookmarks.synchronizePending(operations, options)
        : EMPTY_SYNC_RESULT,
      entities.has('annotation') && this.workers.annotations
        ? this.workers.annotations.synchronizePending(operations, options)
        : EMPTY_SYNC_RESULT,
    ]);
    throwIfSyncAborted(options.signal);
    return combineWorkerResults(results);
  }
}

const EMPTY_SYNC_RESULT: SyncWorkerResult = {
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  rejected: 0,
};

function isReadingStateEntity(
  entity: SyncOperation['entity'],
): entity is ReadingStateSyncEntity {
  return (
    entity === 'progress' || entity === 'bookmark' || entity === 'annotation'
  );
}

function combineWorkerResults(
  results: readonly SyncWorkerResult[],
): SyncWorkerResult {
  return results.reduce<SyncWorkerResult>(
    (combined, result) => ({
      pulled: combined.pulled + result.pulled,
      pushed: combined.pushed + result.pushed,
      conflicts: combined.conflicts + result.conflicts,
      rejected: combined.rejected + result.rejected,
    }),
    { ...EMPTY_SYNC_RESULT },
  );
}

export function throwIfSyncAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Synchronization was cancelled', 'AbortError');
}
