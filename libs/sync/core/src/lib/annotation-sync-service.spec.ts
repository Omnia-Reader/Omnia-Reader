import {
  BookRecord,
  LibraryRepository,
  NewSyncOperation,
  PublicationAnnotation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  AnnotationSyncService,
  annotationDocumentPath,
} from './annotation-sync-service';
import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';

const BOOK: BookRecord = {
  id: `sha256:${'a'.repeat(64)}`,
  format: 'pdf',
  fileName: 'book.pdf',
  mediaType: 'application/pdf',
  size: 10,
  title: 'Book',
  authors: [],
  importedAt: '2026-07-25T08:00:00.000Z',
};

const ANNOTATION: PublicationAnnotation = {
  schemaVersion: 1,
  id: 'f5783eed-baf7-44d9-833f-960e29b3b32a',
  bookId: BOOK.id,
  format: 'pdf',
  deviceId: 'device-a',
  locator: {
    href: '',
    type: 'application/pdf',
    title: 'Page 3',
    locations: {
      fragments: ['pdf-text=3:4:23'],
      position: 3,
    },
    text: { highlight: 'synchronized quote' },
  },
  color: 'yellow',
  note: 'A synchronized note.',
  createdAt: '2026-07-25T08:30:00.000Z',
  updatedAt: '2026-07-25T08:30:00.000Z',
};

describe('AnnotationSyncService', () => {
  it('pushes complete annotation records and acknowledges journal entries', async () => {
    const remote = new MemoryTransport();
    const journal = new MemoryJournal([operation('annotation-op', ANNOTATION)]);
    const service = new AnnotationSyncService(
      remote,
      journal,
      annotationRepository(ANNOTATION),
    );

    const result = await service.push();
    const document = remote.documents.get(annotationDocumentPath(ANNOTATION));

    expect(result).toMatchObject({ pushed: 1, rejected: 0 });
    expect(journal.acknowledged).toEqual(['annotation-op']);
    expect(JSON.parse(document?.content ?? '')).toEqual(ANNOTATION);
  });

  it('creates a pending annotation without a preflight read or prefix list', async () => {
    const remote = new MemoryTransport();
    const pending = operation('annotation-op', ANNOTATION);
    const journal = new MemoryJournal([pending]);
    const service = new AnnotationSyncService(
      remote,
      journal,
      annotationRepository(ANNOTATION),
    );

    await expect(service.synchronizePending([pending])).resolves.toMatchObject({
      pushed: 1,
      rejected: 0,
    });

    expect(remote.listRequests).toBe(0);
    expect(remote.readRequests).toBe(0);
    expect(journal.acknowledged).toEqual(['annotation-op']);
  });

  it('falls back to one exact read when a create candidate already exists remotely', async () => {
    const remote = new MemoryTransport([
      remoteDocument(ANNOTATION, `${JSON.stringify(ANNOTATION, null, 2)}\n`),
    ]);
    const pending = operation('annotation-op', ANNOTATION);
    const journal = new MemoryJournal([pending]);
    const service = new AnnotationSyncService(
      remote,
      journal,
      annotationRepository(ANNOTATION),
    );

    await expect(service.synchronizePending([pending])).resolves.toMatchObject({
      pushed: 0,
      conflicts: 1,
      rejected: 0,
    });

    expect(remote.readRequests).toBe(1);
    expect(journal.acknowledged).toEqual(['annotation-op']);
  });

  it('publishes the latest local annotation when it changed after the batch snapshot', async () => {
    const remote = new MemoryTransport();
    const current = {
      ...ANNOTATION,
      note: 'Latest local note',
      updatedAt: '2026-07-25T08:31:00.000Z',
    };
    const pending = operation('annotation-op', ANNOTATION);
    const service = new AnnotationSyncService(
      remote,
      new MemoryJournal([pending]),
      annotationRepository(current),
    );

    await service.synchronizePending([pending]);

    expect(
      JSON.parse(
        remote.documents.get(annotationDocumentPath(current))?.content ?? '',
      ),
    ).toEqual(current);
  });

  it('reuses the pulled snapshot and reports no push for an identical annotation', async () => {
    const remote = new MemoryTransport([
      remoteDocument(ANNOTATION, `${JSON.stringify(ANNOTATION, null, 2)}\n`),
    ]);
    const service = new AnnotationSyncService(
      remote,
      new MemoryJournal(),
      annotationRepository(ANNOTATION),
    );

    await expect(service.synchronize()).resolves.toMatchObject({
      pushed: 0,
      rejected: 0,
    });
    expect(remote.readRequests).toBe(0);
  });

  it('pulls a newer deletion tombstone without resurrecting the annotation', async () => {
    const deletedAt = '2026-07-25T09:00:00.000Z';
    const tombstone: PublicationAnnotation = {
      ...ANNOTATION,
      deviceId: 'device-b',
      updatedAt: deletedAt,
      deletedAt,
    };
    const remote = new MemoryTransport([
      remoteDocument(tombstone, JSON.stringify(tombstone)),
    ]);
    const repository = annotationRepository(ANNOTATION);
    const service = new AnnotationSyncService(
      remote,
      new MemoryJournal(),
      repository,
    );

    await expect(service.pull()).resolves.toMatchObject({
      pulled: 1,
      rejected: 0,
    });
    await expect(repository.getAnnotation(ANNOTATION.id)).resolves.toEqual(
      tombstone,
    );
    await expect(repository.listAnnotations(BOOK.id)).resolves.toEqual([]);
  });

  it('rejects malformed and orphaned remote annotation documents', async () => {
    const orphan = {
      ...ANNOTATION,
      bookId: `sha256:${'b'.repeat(64)}`,
    };
    const remote = new MemoryTransport([
      {
        path: annotationDocumentPath(ANNOTATION),
        content: '{invalid',
        revision: 'bad-json',
      },
      remoteDocument(orphan, JSON.stringify(orphan)),
    ]);

    await expect(
      new AnnotationSyncService(
        remote,
        new MemoryJournal(),
        annotationRepository(),
      ).pull(),
    ).resolves.toMatchObject({ pulled: 0, rejected: 2 });
  });

  it('retries optimistic conflicts before publishing the latest annotation', async () => {
    const remote = new MemoryTransport();
    remote.conflictsRemaining = 1;
    const wait = vi.fn(async () => undefined);
    const service = new AnnotationSyncService(
      remote,
      new MemoryJournal([operation('retry-op', ANNOTATION)]),
      annotationRepository(ANNOTATION),
      { retryDelayMs: 1, wait },
    );

    await expect(service.push()).resolves.toMatchObject({
      pushed: 1,
      conflicts: 1,
    });
    expect(wait).toHaveBeenCalledWith(1);
  });
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  conflictsRemaining = 0;
  readRequests = 0;
  listRequests = 0;

  constructor(documents: readonly RemoteDocument[] = []) {
    documents.forEach((document) =>
      this.documents.set(document.path, document),
    );
  }

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    this.listRequests += 1;
    return [...this.documents.values()].filter((document) =>
      document.path.startsWith(prefix),
    );
  }

  async read(path: string): Promise<RemoteDocument | null> {
    this.readRequests += 1;
    return this.documents.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new SyncConflictError();
    }
    const current = this.documents.get(request.path);
    if (
      (request.expectedRevision === undefined && current) ||
      (request.expectedRevision !== undefined &&
        request.expectedRevision !== current?.revision)
    ) {
      throw new SyncConflictError();
    }
    const document: RemoteDocument = {
      path: request.path,
      content: request.content,
      revision: String(this.documents.size + 1),
    };
    this.documents.set(document.path, document);
    return document;
  }

  async headObject(): Promise<null> {
    return null;
  }

  async downloadObject(): Promise<Blob> {
    throw new Error('Not used');
  }

  async uploadObject(): Promise<never> {
    throw new Error('Not used');
  }
}

class MemoryJournal implements SyncOperationJournal {
  readonly acknowledged: string[] = [];

  constructor(private operations: SyncOperation[] = []) {}

  async append(operation: NewSyncOperation): Promise<SyncOperation> {
    void operation;
    throw new Error('Not used');
  }

  async pending(): Promise<readonly SyncOperation[]> {
    return this.operations;
  }

  async acknowledge(operationIds: readonly string[]): Promise<void> {
    this.acknowledged.push(...operationIds);
    this.operations = this.operations.filter(
      (operation) => !operationIds.includes(operation.id),
    );
  }
}

function annotationRepository(
  initial?: PublicationAnnotation,
): LibraryRepository {
  const annotations = new Map<string, PublicationAnnotation>();
  if (initial) {
    annotations.set(initial.id, initial);
  }
  return {
    getBook: async (bookId) => (bookId === BOOK.id ? BOOK : null),
    getAnnotation: async (annotationId) =>
      annotations.get(annotationId) ?? null,
    listAnnotations: async (bookId, includeDeleted = false) =>
      [...annotations.values()].filter(
        (annotation) =>
          (bookId === undefined || annotation.bookId === bookId) &&
          (includeDeleted || annotation.deletedAt === undefined),
      ),
    saveAnnotation: async (annotation) => {
      annotations.set(annotation.id, annotation);
    },
  } as unknown as LibraryRepository;
}

function operation(
  id: string,
  annotation: PublicationAnnotation,
): SyncOperation {
  return {
    id,
    entity: 'annotation',
    entityId: annotation.id,
    operation: 'upsert',
    revision: 1,
    createdAt: annotation.updatedAt,
    payload: annotation,
  };
}

function remoteDocument(
  annotation: PublicationAnnotation,
  content: string,
): RemoteDocument {
  return {
    path: annotationDocumentPath(annotation),
    content,
    revision: annotation.updatedAt,
  };
}
