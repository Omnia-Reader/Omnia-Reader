import {
  isPublicationBookmark,
  LibraryRepository,
  preferredBookmark,
  PublicationBookmark,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';
import { SYNC_ROOT } from './library-sync-manifest';
import type { SyncWorkerResult } from './library-sync-coordinator';

export const BOOKMARKS_ROOT = `${SYNC_ROOT}/bookmarks`;

interface PendingBookmarkWrite {
  bookmark: PublicationBookmark;
  operationIds: string[];
  latestOperation: SyncOperation;
}

export interface BookmarkSyncOptions {
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MAX_CONFLICT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;

export class BookmarkSyncService {
  private readonly maxConflictRetries: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private activeSync: Promise<SyncWorkerResult> | null = null;

  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly repository: LibraryRepository,
    options: BookmarkSyncOptions = {},
  ) {
    this.maxConflictRetries =
      options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.wait = options.wait ?? wait;
  }

  synchronize(): Promise<SyncWorkerResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization().finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  async pull(): Promise<SyncWorkerResult> {
    const documents = await this.remote.list(BOOKMARKS_ROOT);
    let pulled = 0;
    let rejected = 0;

    for (const document of documents) {
      const incoming = parseBookmarkDocument(document);
      if (!incoming || bookmarkDocumentPath(incoming) !== document.path) {
        rejected += 1;
        continue;
      }
      const book = await this.repository.getBook(incoming.bookId);
      if (!book || book.format !== incoming.format) {
        rejected += 1;
        continue;
      }

      const current = await this.repository.getBookmark(incoming.id);
      const selected = preferredBookmark(current, incoming);
      if (selected === incoming) {
        await this.repository.saveBookmark(incoming);
      }
      pulled += 1;
    }

    return { pulled, pushed: 0, conflicts: 0, rejected };
  }

  async push(): Promise<SyncWorkerResult> {
    const pending = await this.journal.pending();
    const bookmarkOperations = pending.filter(
      (operation) => operation.entity === 'bookmark',
    );
    const writes = coalesceBookmarkOperations(bookmarkOperations);
    for (const bookmark of await this.repository.listBookmarks(
      undefined,
      true,
    )) {
      if (!isPublicationBookmark(bookmark)) {
        continue;
      }
      mergeSnapshot(writes.documents, bookmark);
    }

    let pushed = 0;
    let conflicts = 0;
    let rejected = bookmarkOperations.length - writes.acceptedOperationCount;
    for (const write of writes.documents.values()) {
      const result = await this.pushBookmark(write);
      pushed += result.pushed ? 1 : 0;
      conflicts += result.conflicts;
      rejected += result.rejected;
    }
    return { pulled: 0, pushed, conflicts, rejected };
  }

  private async runSynchronization(): Promise<SyncWorkerResult> {
    const pulled = await this.pull();
    const pushed = await this.push();
    return {
      pulled: pulled.pulled,
      pushed: pushed.pushed,
      conflicts: pulled.conflicts + pushed.conflicts,
      rejected: pulled.rejected + pushed.rejected,
    };
  }

  private async pushBookmark(
    pending: PendingBookmarkWrite,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const path = bookmarkDocumentPath(pending.bookmark);
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      const current = await this.remote.read(path);
      const remoteBookmark = current ? parseBookmarkDocument(current) : null;
      if (
        current &&
        (!remoteBookmark ||
          remoteBookmark.id !== pending.bookmark.id ||
          remoteBookmark.bookId !== pending.bookmark.bookId)
      ) {
        return {
          pushed: false,
          conflicts,
          rejected: pending.operationIds.length,
        };
      }

      const bookmark = remoteBookmark
        ? preferredBookmark(remoteBookmark, pending.bookmark)
        : pending.bookmark;
      if (bookmark === remoteBookmark) {
        await this.repository.saveBookmark(bookmark);
      }
      const content = serializeBookmark(bookmark);
      if (current?.content === content) {
        await this.journal.acknowledge(pending.operationIds);
        return { pushed: true, conflicts, rejected: 0 };
      }

      try {
        await this.remote.write({
          path,
          content,
          expectedRevision: current?.revision,
          message: `${bookmark.deletedAt ? 'Delete' : 'Update'} bookmark for ${bookmark.bookId}`,
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

export function bookmarkDocumentPath(bookmark: PublicationBookmark): string {
  return `${BOOKMARKS_ROOT}/${pathSegment(bookmark.bookId)}/${pathSegment(bookmark.id)}.json`;
}

function parseBookmarkDocument(
  document: Pick<RemoteDocument, 'content'>,
): PublicationBookmark | null {
  try {
    const value: unknown = JSON.parse(document.content);
    return isPublicationBookmark(value) ? value : null;
  } catch {
    return null;
  }
}

function serializeBookmark(bookmark: PublicationBookmark): string {
  return `${JSON.stringify(bookmark, null, 2)}\n`;
}

function coalesceBookmarkOperations(operations: readonly SyncOperation[]): {
  documents: Map<string, PendingBookmarkWrite>;
  acceptedOperationCount: number;
} {
  const documents = new Map<string, PendingBookmarkWrite>();
  let acceptedOperationCount = 0;
  for (const operation of operations) {
    if (
      operation.entity !== 'bookmark' ||
      operation.operation !== 'upsert' ||
      !isPublicationBookmark(operation.payload) ||
      operation.entityId !== operation.payload.id
    ) {
      continue;
    }
    acceptedOperationCount += 1;
    const path = bookmarkDocumentPath(operation.payload);
    const existing = documents.get(path);
    if (!existing) {
      documents.set(path, {
        bookmark: operation.payload,
        operationIds: [operation.id],
        latestOperation: operation,
      });
      continue;
    }

    existing.operationIds.push(operation.id);
    if (
      preferredBookmark(existing.bookmark, operation.payload) ===
      operation.payload
    ) {
      existing.bookmark = operation.payload;
      existing.latestOperation = operation;
    }
  }
  return { documents, acceptedOperationCount };
}

function mergeSnapshot(
  documents: Map<string, PendingBookmarkWrite>,
  bookmark: PublicationBookmark,
): void {
  const path = bookmarkDocumentPath(bookmark);
  const existing = documents.get(path);
  if (!existing) {
    documents.set(path, {
      bookmark,
      operationIds: [],
      latestOperation: syntheticBookmarkOperation(bookmark),
    });
    return;
  }
  if (preferredBookmark(existing.bookmark, bookmark) === bookmark) {
    existing.bookmark = bookmark;
    existing.latestOperation = syntheticBookmarkOperation(bookmark);
  }
}

function syntheticBookmarkOperation(
  bookmark: PublicationBookmark,
): SyncOperation {
  return {
    id: `snapshot:${bookmark.id}`,
    entity: 'bookmark',
    entityId: bookmark.id,
    operation: 'upsert',
    revision: 0,
    createdAt: bookmark.updatedAt,
    payload: bookmark,
  };
}

function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '%252F');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
