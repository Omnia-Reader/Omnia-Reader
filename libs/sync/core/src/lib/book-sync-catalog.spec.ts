import { describe, expect, it, vi } from 'vitest';
import { bookManifestPath, createBookSyncManifest } from './book-sync-manifest';
import { BOOK_CATALOG_PATH, updateBookSyncCatalog } from './book-sync-catalog';
import type {
  LibrarySyncTransport,
  RemoteDocument,
} from './library-sync-transport';

describe('updateBookSyncCatalog', () => {
  it('uses a supplied publication snapshot without listing it again', async () => {
    const manifest = createBookSyncManifest({
      id: `sha256:${'a'.repeat(64)}`,
      format: 'epub',
      fileName: 'Fixture.epub',
      mediaType: 'application/epub+zip',
      size: 7,
      title: 'Fixture',
      authors: ['Reader'],
      importedAt: '2026-08-02T10:00:00.000Z',
    });
    const documents: readonly RemoteDocument[] = [
      {
        path: bookManifestPath(manifest),
        revision: 'manifest-1',
        content: `${JSON.stringify(manifest, null, 2)}\n`,
      },
    ];
    const list = vi.fn().mockRejectedValue(new Error('unexpected list'));
    const read = vi.fn().mockResolvedValue(null);
    const write = vi.fn().mockImplementation(async (request) => ({
      path: request.path,
      revision: 'catalog-1',
      content: request.content,
    }));
    const remote = { list, read, write } as unknown as LibrarySyncTransport;

    await updateBookSyncCatalog(remote, { remoteDocuments: documents });

    expect(list).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(BOOK_CATALOG_PATH);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        path: BOOK_CATALOG_PATH,
        content: expect.stringContaining('[Fixture]'),
      }),
    );
  });
});
