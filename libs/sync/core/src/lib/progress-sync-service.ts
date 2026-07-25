import {
  BookRecord,
  ProgressDocumentRepository,
  ReadingProgress,
  SyncOperation,
  SyncOperationJournal,
  SyncResult,
} from '@omnia-reader/reader/domain';
import {
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';
import { progressDocumentPath, PROGRESS_ROOT } from './progress-paths';
import { isReadingProgress, mergeDeviceProgress } from './progress-merge';

export interface ProgressRepository {
  getBook(bookId: string): Promise<Pick<BookRecord, 'format'> | null>;
  getProgress(bookId: string): Promise<ReadingProgress | null>;
  listProgress(): Promise<readonly ReadingProgress[]>;
  saveProgress(progress: ReadingProgress): Promise<void>;
}

export type ProgressSyncRepository = ProgressRepository &
  ProgressDocumentRepository;

export interface ProgressSyncResult extends SyncResult {
  rejected: number;
}

export interface ProgressSyncOptions {
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

interface PendingProgressWrite {
  progress: ReadingProgress;
  operationIds: string[];
  latestOperation: SyncOperation;
}

const DEFAULT_MAX_CONFLICT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;

export class ProgressSyncService {
  private readonly maxConflictRetries: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private activeSync: Promise<ProgressSyncResult> | null = null;

  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly progressRepository: ProgressSyncRepository,
    options: ProgressSyncOptions = {},
  ) {
    this.maxConflictRetries =
      options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.wait = options.wait ?? wait;
  }

  synchronize(): Promise<ProgressSyncResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization().finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  async pull(): Promise<ProgressSyncResult> {
    const files = await this.remote.list(PROGRESS_ROOT);
    const knownDocuments = new Map(
      (await this.progressRepository.listProgressDocuments()).map(
        (progress) => [progressDocumentPath(progress), progress],
      ),
    );
    const changedDocuments = new Map<string, ReadingProgress>();
    const pulledByBook = new Map<string, ReadingProgress[]>();
    let rejected = 0;

    for (const file of files) {
      const progress = parseProgressFile(file);
      if (!progress || progressDocumentPath(progress) !== file.path) {
        rejected += 1;
        continue;
      }
      const book = await this.progressRepository.getBook(progress.bookId);
      if (!book || book.format !== progress.format) {
        rejected += 1;
        continue;
      }
      const path = progressDocumentPath(progress);
      const cached = knownDocuments.get(path);
      const document = cached
        ? mergeProgressDocument(cached, progress)
        : progress;
      knownDocuments.set(path, document);
      changedDocuments.set(path, document);
      const documents = pulledByBook.get(progress.bookId) ?? [];
      documents.push(progress);
      pulledByBook.set(progress.bookId, documents);
    }

    for (const progress of changedDocuments.values()) {
      await this.progressRepository.saveProgressDocument(progress);
    }

    let pulled = 0;
    const knownByBook = new Map<string, ReadingProgress[]>();
    for (const progress of knownDocuments.values()) {
      const documents = knownByBook.get(progress.bookId) ?? [];
      documents.push(progress);
      knownByBook.set(progress.bookId, documents);
    }
    for (const [bookId, documents] of knownByBook) {
      const local = await this.progressRepository.getProgress(bookId);
      const merged = mergeDeviceProgress(
        local ? [...documents, local] : documents,
      );
      if (!merged.current) {
        continue;
      }
      const progress: ReadingProgress = {
        ...merged.current,
        furthestTotalProgression: merged.furthestTotalProgression,
      };
      if (!local || JSON.stringify(local) !== JSON.stringify(progress)) {
        await this.progressRepository.saveProgress(progress);
      }
      pulled += pulledByBook.get(bookId)?.length ?? 0;
    }

    return { pulled, pushed: 0, conflicts: 0, rejected };
  }

  async push(): Promise<ProgressSyncResult> {
    const pending = await this.journal.pending();
    const progressOperations = pending.filter(
      (operation) => operation.entity === 'progress',
    );
    const writes = coalesceProgressOperations(progressOperations);
    for (const progress of await this.progressRepository.listProgressDocuments()) {
      mergeProgressSnapshot(writes.documents, progress);
    }
    for (const progress of await this.progressRepository.listProgress()) {
      mergeProgressSnapshot(writes.documents, progress);
    }
    let pushed = 0;
    let conflicts = 0;
    let rejected = progressOperations.length - writes.acceptedOperationCount;

    for (const write of writes.documents.values()) {
      const result = await this.pushProgress(write);
      conflicts += result.conflicts;
      rejected += result.rejected;
      if (result.pushed) {
        pushed += 1;
      }
    }

    return { pulled: 0, pushed, conflicts, rejected };
  }

  private async runSynchronization(): Promise<ProgressSyncResult> {
    const pulled = await this.pull();
    const pushed = await this.push();
    return {
      pulled: pulled.pulled,
      pushed: pushed.pushed,
      conflicts: pulled.conflicts + pushed.conflicts,
      rejected: pulled.rejected + pushed.rejected,
    };
  }

  private async pushProgress(
    pending: PendingProgressWrite,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const path = progressDocumentPath(pending.progress);
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      const current = await this.remote.read(path);
      const remoteProgress = current ? parseProgressFile(current) : null;
      if (
        current &&
        (!remoteProgress ||
          remoteProgress.bookId !== pending.progress.bookId ||
          remoteProgress.deviceId !== pending.progress.deviceId)
      ) {
        return {
          pushed: false,
          conflicts,
          rejected: Math.max(1, pending.operationIds.length),
        };
      }

      const progress = remoteProgress
        ? mergeProgressDocument(remoteProgress, pending.progress)
        : pending.progress;
      const content = serializeProgress(progress);

      if (current?.content === content) {
        await this.progressRepository.saveProgressDocument(progress);
        await this.journal.acknowledge(pending.operationIds);
        return { pushed: true, conflicts, rejected: 0 };
      }

      try {
        await this.remote.write({
          path,
          content,
          expectedRevision: current?.revision,
          message: `Update reading progress for ${progress.bookId}`,
        });
        await this.progressRepository.saveProgressDocument(progress);
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

function parseProgressFile(
  file: Pick<RemoteDocument, 'content'>,
): ReadingProgress | null {
  try {
    const value: unknown = JSON.parse(file.content);
    return isReadingProgress(value) ? value : null;
  } catch {
    return null;
  }
}

function serializeProgress(progress: ReadingProgress): string {
  return `${JSON.stringify(progress, null, 2)}\n`;
}

function coalesceProgressOperations(operations: readonly SyncOperation[]): {
  documents: Map<string, PendingProgressWrite>;
  acceptedOperationCount: number;
} {
  const documents = new Map<string, PendingProgressWrite>();
  let acceptedOperationCount = 0;

  for (const operation of operations) {
    if (
      operation.entity !== 'progress' ||
      operation.operation !== 'upsert' ||
      !isReadingProgress(operation.payload) ||
      operation.entityId !== operation.payload.bookId
    ) {
      continue;
    }

    acceptedOperationCount += 1;
    const path = progressDocumentPath(operation.payload);
    const existing = documents.get(path);
    if (!existing) {
      documents.set(path, {
        progress: operation.payload,
        operationIds: [operation.id],
        latestOperation: operation,
      });
      continue;
    }

    existing.operationIds.push(operation.id);
    if (compareOperations(operation, existing.latestOperation) > 0) {
      existing.progress = operation.payload;
      existing.latestOperation = operation;
    }
  }

  return { documents, acceptedOperationCount };
}

function mergeProgressSnapshot(
  documents: Map<string, PendingProgressWrite>,
  progress: ReadingProgress,
): void {
  if (!isReadingProgress(progress)) {
    return;
  }
  const path = progressDocumentPath(progress);
  const existing = documents.get(path);
  if (!existing) {
    documents.set(path, {
      progress,
      operationIds: [],
      latestOperation: syntheticProgressOperation(progress),
    });
    return;
  }
  existing.progress = mergeProgressDocument(existing.progress, progress);
}

function mergeProgressDocument(
  left: ReadingProgress,
  right: ReadingProgress,
): ReadingProgress {
  if (progressDocumentPath(left) !== progressDocumentPath(right)) {
    throw new TypeError(
      'Cannot merge progress from different device documents',
    );
  }
  const byUpdatedAt = left.updatedAt.localeCompare(right.updatedAt);
  const selected =
    byUpdatedAt > 0
      ? left
      : byUpdatedAt < 0
        ? right
        : JSON.stringify(left).localeCompare(JSON.stringify(right)) >= 0
          ? left
          : right;
  return {
    ...selected,
    furthestTotalProgression: Math.max(
      left.furthestTotalProgression,
      right.furthestTotalProgression,
    ),
  };
}

function compareOperations(left: SyncOperation, right: SyncOperation): number {
  const leftProgress = left.payload as ReadingProgress;
  const rightProgress = right.payload as ReadingProgress;
  return (
    leftProgress.updatedAt.localeCompare(rightProgress.updatedAt) ||
    left.revision - right.revision ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function syntheticProgressOperation(progress: ReadingProgress): SyncOperation {
  return {
    id: `snapshot:${progress.bookId}:${progress.deviceId}`,
    entity: 'progress',
    entityId: progress.bookId,
    operation: 'upsert',
    revision: 0,
    createdAt: progress.updatedAt,
    payload: progress,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
