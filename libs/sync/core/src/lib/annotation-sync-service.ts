import {
  isPublicationAnnotation,
  LibraryRepository,
  preferredAnnotation,
  PublicationAnnotation,
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

export const ANNOTATIONS_ROOT = `${SYNC_ROOT}/annotations`;

interface PendingAnnotationWrite {
  annotation: PublicationAnnotation;
  operationIds: string[];
}

export interface AnnotationSyncOptions {
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MAX_CONFLICT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;

export class AnnotationSyncService {
  private readonly maxConflictRetries: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private activeSync: Promise<SyncWorkerResult> | null = null;

  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly repository: LibraryRepository,
    options: AnnotationSyncOptions = {},
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
    const documents = await this.remote.list(ANNOTATIONS_ROOT);
    let pulled = 0;
    let rejected = 0;

    for (const document of documents) {
      const incoming = parseAnnotationDocument(document);
      if (!incoming || annotationDocumentPath(incoming) !== document.path) {
        rejected += 1;
        continue;
      }
      const book = await this.repository.getBook(incoming.bookId);
      if (!book || book.format !== incoming.format) {
        rejected += 1;
        continue;
      }

      const current = await this.repository.getAnnotation(incoming.id);
      const selected = preferredAnnotation(current, incoming);
      if (selected === incoming) {
        await this.repository.saveAnnotation(incoming);
      }
      pulled += 1;
    }

    return { pulled, pushed: 0, conflicts: 0, rejected };
  }

  async push(): Promise<SyncWorkerResult> {
    const pending = await this.journal.pending();
    const annotationOperations = pending.filter(
      (operation) => operation.entity === 'annotation',
    );
    const writes = coalesceAnnotationOperations(annotationOperations);
    for (const annotation of await this.repository.listAnnotations(
      undefined,
      true,
    )) {
      if (isPublicationAnnotation(annotation)) {
        mergeSnapshot(writes.documents, annotation);
      }
    }

    let pushed = 0;
    let conflicts = 0;
    let rejected = annotationOperations.length - writes.acceptedOperationCount;
    for (const write of writes.documents.values()) {
      const result = await this.pushAnnotation(write);
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

  private async pushAnnotation(
    pending: PendingAnnotationWrite,
  ): Promise<{ pushed: boolean; conflicts: number; rejected: number }> {
    const path = annotationDocumentPath(pending.annotation);
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      const current = await this.remote.read(path);
      const remoteAnnotation = current
        ? parseAnnotationDocument(current)
        : null;
      if (
        current &&
        (!remoteAnnotation ||
          remoteAnnotation.id !== pending.annotation.id ||
          remoteAnnotation.bookId !== pending.annotation.bookId)
      ) {
        return {
          pushed: false,
          conflicts,
          rejected: pending.operationIds.length,
        };
      }

      const annotation = remoteAnnotation
        ? preferredAnnotation(remoteAnnotation, pending.annotation)
        : pending.annotation;
      if (annotation === remoteAnnotation) {
        await this.repository.saveAnnotation(annotation);
      }
      const content = serializeAnnotation(annotation);
      if (current?.content === content) {
        await this.journal.acknowledge(pending.operationIds);
        return { pushed: true, conflicts, rejected: 0 };
      }

      try {
        await this.remote.write({
          path,
          content,
          expectedRevision: current?.revision,
          message: `${annotation.deletedAt ? 'Delete' : 'Update'} annotation for ${annotation.bookId}`,
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

export function annotationDocumentPath(
  annotation: PublicationAnnotation,
): string {
  return `${ANNOTATIONS_ROOT}/${pathSegment(annotation.bookId)}/${pathSegment(annotation.id)}.json`;
}

function parseAnnotationDocument(
  document: Pick<RemoteDocument, 'content'>,
): PublicationAnnotation | null {
  try {
    const value: unknown = JSON.parse(document.content);
    return isPublicationAnnotation(value) ? value : null;
  } catch {
    return null;
  }
}

function serializeAnnotation(annotation: PublicationAnnotation): string {
  return `${JSON.stringify(annotation, null, 2)}\n`;
}

function coalesceAnnotationOperations(operations: readonly SyncOperation[]): {
  documents: Map<string, PendingAnnotationWrite>;
  acceptedOperationCount: number;
} {
  const documents = new Map<string, PendingAnnotationWrite>();
  let acceptedOperationCount = 0;
  for (const operation of operations) {
    if (
      operation.entity !== 'annotation' ||
      operation.operation !== 'upsert' ||
      !isPublicationAnnotation(operation.payload) ||
      operation.entityId !== operation.payload.id
    ) {
      continue;
    }
    acceptedOperationCount += 1;
    const path = annotationDocumentPath(operation.payload);
    const existing = documents.get(path);
    if (!existing) {
      documents.set(path, {
        annotation: operation.payload,
        operationIds: [operation.id],
      });
      continue;
    }

    existing.operationIds.push(operation.id);
    if (
      preferredAnnotation(existing.annotation, operation.payload) ===
      operation.payload
    ) {
      existing.annotation = operation.payload;
    }
  }
  return { documents, acceptedOperationCount };
}

function mergeSnapshot(
  documents: Map<string, PendingAnnotationWrite>,
  annotation: PublicationAnnotation,
): void {
  const path = annotationDocumentPath(annotation);
  const existing = documents.get(path);
  if (!existing) {
    documents.set(path, { annotation, operationIds: [] });
    return;
  }
  if (preferredAnnotation(existing.annotation, annotation) === annotation) {
    existing.annotation = annotation;
  }
}

function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '%252F');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
