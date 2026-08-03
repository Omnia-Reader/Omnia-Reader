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
      'a'.repeat(64),
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
    ).toBe('a'.repeat(64));
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

  it('moves a remote-only hash-addressed v1 publication to its named path', async () => {
    const remote = new MemoryTransport();
    const digest = 'c'.repeat(64);
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
});

class MemoryTransport implements LibrarySyncTransport {
  readonly documents = new Map<string, RemoteDocument>();
  readonly objects = new Map<string, RemoteObject>();
  private readonly blobs = new Map<string, Blob>();
  readonly deletionBatches: RemoteSyncEntryDeleteRequest[][] = [];
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
    const blob = this.blobs.get(path);
    if (!blob) throw new Error('missing object');
    return blob;
  }

  async uploadObject(request: ObjectUploadRequest): Promise<RemoteObject> {
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
