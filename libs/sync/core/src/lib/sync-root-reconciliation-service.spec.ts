import { describe, expect, it } from 'vitest';
import type {
  DocumentDeleteRequest,
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectDeleteRequest,
  ObjectUploadRequest,
  RemoteDocument,
  RemoteObject,
  RemoteSyncEntry,
  RemoteSyncEntryDeleteRequest,
} from './library-sync-transport';
import { SyncConflictError } from './library-sync-transport';
import { SyncRootReconciliationService } from './sync-root-reconciliation-service';
import {
  bookManifestPath,
  bookObjectPath,
  createBookSyncManifest,
} from './book-sync-manifest';

describe('SyncRootReconciliationService', () => {
  it('copies and verifies previous-root documents and objects before cleanup', async () => {
    const remote = new MemoryTransport();
    remote.seedDocument(
      '.omnia-reader/v1/progress/book/device.json',
      '{"objectPath":".omnia-reader/v1/library/Book--aaaaaaaaaaaa/Book.epub"}\n',
    );
    remote.seedObject(
      '.omnia-reader/v1/library/Book--aaaaaaaaaaaa/Book.epub',
      new Blob(['book'], { type: 'application/epub+zip' }),
      '92719fe0cf8cd51592af31ee8a5736d79f7273777fa3f7b70bfe993a4cd32180',
    );
    remote.seedObject(
      '.omnia-reader/v1/obsolete.bin',
      new Blob(['old']),
      'b'.repeat(64),
    );
    const service = new SyncRootReconciliationService(remote);

    await expect(service.prepare()).resolves.toMatchObject({ pushed: 2 });
    expect(
      remote.documents.get('.omnia-reader/progress/book/device.json')?.content,
    ).toContain('.omnia-reader/library/Book--aaaaaaaaaaaa/Book.epub');
    expect(
      remote.objects.get('.omnia-reader/library/Book--aaaaaaaaaaaa/Book.epub')
        ?.sha256,
    ).toBe('92719fe0cf8cd51592af31ee8a5736d79f7273777fa3f7b70bfe993a4cd32180');
    expect(
      remote.documents.has('.omnia-reader/v1/progress/book/device.json'),
    ).toBe(true);

    await expect(service.cleanup()).resolves.toMatchObject({ pushed: 3 });
    expect(remote.deletionBatches).toHaveLength(1);
    expect(remote.deletionBatches[0]).toHaveLength(3);
    expect(
      [...remote.documents.keys(), ...remote.objects.keys()].some((path) =>
        path.startsWith('.omnia-reader/v1/'),
      ),
    ).toBe(false);
  });

  it('does not delete the previous copy when current content conflicts', async () => {
    const remote = new MemoryTransport();
    remote.seedDocument(
      '.omnia-reader/v1/progress/book/device.json',
      '{"value":1}\n',
    );
    remote.seedDocument(
      '.omnia-reader/progress/book/device.json',
      '{"value":2}\n',
    );
    const service = new SyncRootReconciliationService(remote);

    await expect(service.prepare()).rejects.toBeInstanceOf(SyncConflictError);
    expect(
      remote.documents.has('.omnia-reader/v1/progress/book/device.json'),
    ).toBe(true);
  });

  it('merges identical current and previous records without rewriting them', async () => {
    const remote = new MemoryTransport();
    const content = '{\n  "value": 1\n}\n';
    const sourcePath = '.omnia-reader/v1/progress/book/device.json';
    const targetPath = '.omnia-reader/progress/book/device.json';
    remote.seedDocument(sourcePath, content);
    remote.seedDocument(targetPath, content);
    const service = new SyncRootReconciliationService(remote);

    await expect(service.prepare()).resolves.toEqual({
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      rejected: 0,
    });
    expect(remote.writeRequests).toEqual([]);
    await expect(service.cleanup()).resolves.toMatchObject({ pushed: 1 });
    expect(remote.documents.has(sourcePath)).toBe(false);
    expect(remote.documents.get(targetPath)?.content).toBe(content);
  });

  it.each([
    {
      name: 'an entry outside the requested root',
      entries: [
        {
          path: '.omnia-reader/escape.json',
          revision: 'hostile-1',
          kind: 'document' as const,
        },
      ],
    },
    {
      name: 'duplicate paths',
      entries: [
        {
          path: '.omnia-reader/v1/progress/book/device.json',
          revision: 'hostile-1',
          kind: 'document' as const,
        },
        {
          path: '.omnia-reader/v1/progress/book/device.json',
          revision: 'hostile-2',
          kind: 'document' as const,
        },
      ],
    },
  ])('rejects provider inventory containing $name', async ({ entries }) => {
    const remote = new MemoryTransport();
    remote.inventoryOverride = entries;
    const service = new SyncRootReconciliationService(remote);

    await expect(service.prepare()).rejects.toBeInstanceOf(TypeError);
    expect(remote.writeRequests).toEqual([]);
  });

  it.each([
    {
      name: 'declared size',
      content: new Blob(['boo'], { type: 'application/pdf' }),
    },
    {
      name: 'declared digest',
      content: new Blob(['boox'], { type: 'application/pdf' }),
    },
  ])('rejects migration bytes with the wrong $name', async ({ content }) => {
    const remote = new MemoryTransport();
    const path = '.omnia-reader/v1/library/Book--92719fe0cf8c/Book.pdf';
    remote.seedObject(
      path,
      new Blob(['book'], { type: 'application/pdf' }),
      '92719fe0cf8cd51592af31ee8a5736d79f7273777fa3f7b70bfe993a4cd32180',
    );
    remote.downloadOverride = content;
    const service = new SyncRootReconciliationService(remote);

    await expect(service.prepare()).rejects.toThrow(
      'Previous sync object failed integrity verification',
    );
    expect(remote.uploadRequests).toEqual([]);
    expect(remote.objects.has(path)).toBe(true);
  });

  it('moves a remote-only hash-addressed v1 publication to its named path', async () => {
    const remote = new MemoryTransport();
    const digest =
      '92719fe0cf8cd51592af31ee8a5736d79f7273777fa3f7b70bfe993a4cd32180';
    const book = {
      id: `sha256:${digest}`,
      format: 'pdf' as const,
      fileName: 'Exact Name.pdf',
      mediaType: 'application/pdf',
      size: 4,
      title: 'Exact Name',
      authors: [],
      importedAt: '2026-08-02T08:00:00.000Z',
    };
    const directory = `.omnia-reader/v1/books/${digest}`;
    const objectPath = `${directory}/publication.pdf`;
    remote.seedDocument(
      `${directory}/book.json`,
      `${JSON.stringify({ ...createBookSyncManifest(book), objectPath }, null, 2)}\n`,
    );
    remote.seedObject(
      objectPath,
      new Blob(['book'], { type: 'application/pdf' }),
      digest,
    );
    remote.seedDocument(
      '.omnia-reader/v1/logical-books/changes/change.json',
      `${JSON.stringify({
        variantEffects: [{ operation: 'upsert', variant: book, objectPath }],
      })}\n`,
    );
    const service = new SyncRootReconciliationService(remote);

    await expect(service.prepare()).resolves.toMatchObject({ pushed: 3 });
    expect(remote.documents.has(bookManifestPath(book))).toBe(true);
    expect(remote.objects.get(bookObjectPath(book))).toMatchObject({
      sha256: digest,
      size: 4,
    });
    expect(
      remote.documents.get('.omnia-reader/logical-books/changes/change.json')
        ?.content,
    ).toContain(`"objectPath": "${bookObjectPath(book)}"`);
    await service.cleanup();
    expect(remote.documents.has(`${directory}/book.json`)).toBe(false);
    expect(remote.objects.has(objectPath)).toBe(false);
  });

  it.each([
    {
      name: 'object path',
      mutate: (manifest: Record<string, unknown>) => ({
        ...manifest,
        objectPath: '.omnia-reader/v1/escape/publication.pdf',
      }),
    },
    {
      name: 'media type',
      mutate: (manifest: Record<string, unknown>) => ({
        ...manifest,
        mediaType: 'text/plain',
      }),
    },
  ])(
    'fails closed for a legacy manifest with an invalid $name',
    async ({ mutate }) => {
      const remote = new MemoryTransport();
      const digest =
        '92719fe0cf8cd51592af31ee8a5736d79f7273777fa3f7b70bfe993a4cd32180';
      const book = {
        id: `sha256:${digest}`,
        format: 'pdf' as const,
        fileName: 'Exact Name.pdf',
        mediaType: 'application/pdf',
        size: 4,
        title: 'Exact Name',
        authors: [],
        importedAt: '2026-08-02T08:00:00.000Z',
      };
      const directory = `.omnia-reader/v1/books/${digest}`;
      const objectPath = `${directory}/publication.pdf`;
      remote.seedDocument(
        `${directory}/book.json`,
        `${JSON.stringify(mutate({ ...createBookSyncManifest(book), objectPath }), null, 2)}\n`,
      );
      remote.seedObject(
        objectPath,
        new Blob(['book'], { type: 'application/pdf' }),
        digest,
      );
      const service = new SyncRootReconciliationService(remote);

      await expect(service.prepare()).rejects.toThrow(
        'Previous sync book manifest is invalid',
      );
      expect(remote.writeRequests).toEqual([]);
      expect(remote.uploadRequests).toEqual([]);
      expect(remote.documents.has(`${directory}/book.json`)).toBe(true);
      expect(remote.objects.has(objectPath)).toBe(true);
    },
  );
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  readonly objects = new Map<string, RemoteObject>();
  private readonly blobs = new Map<string, Blob>();
  readonly deletionBatches: RemoteSyncEntryDeleteRequest[][] = [];
  readonly writeRequests: DocumentWriteRequest[] = [];
  readonly uploadRequests: ObjectUploadRequest[] = [];
  inventoryOverride?: readonly RemoteSyncEntry[];
  downloadOverride?: Blob;
  private revision = 0;

  seedDocument(path: string, content: string): void {
    this.documents.set(path, { path, content, revision: this.nextRevision() });
  }

  seedObject(path: string, blob: Blob, sha256: string): void {
    this.blobs.set(path, blob);
    this.objects.set(path, {
      path,
      revision: this.nextRevision(),
      size: blob.size,
      sha256,
    });
  }

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    return [...this.documents.values()].filter(
      (entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`),
    );
  }

  async listEntries(prefix: string): Promise<readonly RemoteSyncEntry[]> {
    if (this.inventoryOverride) return this.inventoryOverride;
    return [
      ...[...this.documents.values()].map((entry) => ({
        path: entry.path,
        revision: entry.revision,
        kind: 'document' as const,
      })),
      ...[...this.objects.values()].map((entry) => ({
        path: entry.path,
        revision: entry.revision,
        kind: 'object' as const,
      })),
    ].filter(
      (entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`),
    );
  }

  async read(path: string): Promise<RemoteDocument | null> {
    return this.documents.get(path) ?? null;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    this.writeRequests.push(request);
    const document = {
      path: request.path,
      content: request.content,
      revision: this.nextRevision(),
    };
    this.documents.set(request.path, document);
    return document;
  }

  async deleteDocument(request: DocumentDeleteRequest): Promise<void> {
    this.documents.delete(request.path);
  }

  async headObject(path: string): Promise<RemoteObject | null> {
    return this.objects.get(path) ?? null;
  }

  async downloadObject(path: string): Promise<Blob> {
    if (this.downloadOverride) return this.downloadOverride;
    const blob = this.blobs.get(path);
    if (!blob) throw new Error('missing object');
    return blob;
  }

  async uploadObject(request: ObjectUploadRequest): Promise<RemoteObject> {
    this.uploadRequests.push(request);
    this.blobs.set(request.path, request.content);
    const object = {
      path: request.path,
      revision: this.nextRevision(),
      size: request.size,
      sha256: request.sha256,
    };
    this.objects.set(request.path, object);
    return object;
  }

  async deleteObject(request: ObjectDeleteRequest): Promise<void> {
    this.objects.delete(request.path);
    this.blobs.delete(request.path);
  }

  async deleteEntry(request: RemoteSyncEntryDeleteRequest): Promise<void> {
    this.documents.delete(request.path);
    this.objects.delete(request.path);
    this.blobs.delete(request.path);
  }

  async deleteEntries(
    requests: readonly RemoteSyncEntryDeleteRequest[],
  ): Promise<void> {
    this.deletionBatches.push([...requests]);
    for (const request of requests) {
      await this.deleteEntry(request);
    }
  }

  private nextRevision(): string {
    this.revision += 1;
    return `revision-${this.revision}`;
  }
}
