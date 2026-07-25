export interface SyncWorkerResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  rejected: number;
}

export interface SyncWorker {
  synchronize(): Promise<SyncWorkerResult>;
}

export interface LibrarySyncResult extends SyncWorkerResult {
  schemaPulled: number;
  schemaPushed: number;
  booksPulled: number;
  booksPushed: number;
  progressPulled: number;
  progressPushed: number;
  bookmarksPulled: number;
  bookmarksPushed: number;
  annotationsPulled: number;
  annotationsPushed: number;
}

export interface LibrarySyncWorkers {
  schema: SyncWorker;
  books: SyncWorker;
  progress: SyncWorker;
  bookmarks?: SyncWorker;
  annotations?: SyncWorker;
}

export class LibrarySyncCoordinator implements SyncWorker {
  private activeSync: Promise<LibrarySyncResult> | null = null;

  constructor(private readonly workers: LibrarySyncWorkers) {}

  synchronize(): Promise<LibrarySyncResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization().finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  private async runSynchronization(): Promise<LibrarySyncResult> {
    const schema = await this.workers.schema.synchronize();
    const books = await this.workers.books.synchronize();
    const progress = await this.workers.progress.synchronize();
    const bookmarks = this.workers.bookmarks
      ? await this.workers.bookmarks.synchronize()
      : EMPTY_SYNC_RESULT;
    const annotations = this.workers.annotations
      ? await this.workers.annotations.synchronize()
      : EMPTY_SYNC_RESULT;
    return {
      pulled:
        schema.pulled +
        books.pulled +
        progress.pulled +
        bookmarks.pulled +
        annotations.pulled,
      pushed:
        schema.pushed +
        books.pushed +
        progress.pushed +
        bookmarks.pushed +
        annotations.pushed,
      conflicts:
        schema.conflicts +
        books.conflicts +
        progress.conflicts +
        bookmarks.conflicts +
        annotations.conflicts,
      rejected:
        schema.rejected +
        books.rejected +
        progress.rejected +
        bookmarks.rejected +
        annotations.rejected,
      schemaPulled: schema.pulled,
      schemaPushed: schema.pushed,
      booksPulled: books.pulled,
      booksPushed: books.pushed,
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
