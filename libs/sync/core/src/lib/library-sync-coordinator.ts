import { ObjectTransferProgressListener } from './library-sync-transport';

export interface SyncWorkerResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  rejected: number;
}

export interface SyncWorkerOptions {
  signal?: AbortSignal;
  onTransferProgress?: ObjectTransferProgressListener;
}

export interface SyncWorker {
  synchronize(options?: SyncWorkerOptions): Promise<SyncWorkerResult>;
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
    const logicalBooks = this.workers.logicalBooks
      ? await this.workers.logicalBooks.synchronize(options)
      : EMPTY_SYNC_RESULT;
    throwIfSyncAborted(options.signal);
    const books = await this.workers.books.synchronize(options);
    throwIfSyncAborted(options.signal);
    const progress = await this.workers.progress.synchronize(options);
    throwIfSyncAborted(options.signal);
    const bookmarks = this.workers.bookmarks
      ? await this.workers.bookmarks.synchronize(options)
      : EMPTY_SYNC_RESULT;
    throwIfSyncAborted(options.signal);
    const annotations = this.workers.annotations
      ? await this.workers.annotations.synchronize(options)
      : EMPTY_SYNC_RESULT;
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

const EMPTY_SYNC_RESULT: SyncWorkerResult = {
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  rejected: 0,
};

export function throwIfSyncAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Synchronization was cancelled', 'AbortError');
}
