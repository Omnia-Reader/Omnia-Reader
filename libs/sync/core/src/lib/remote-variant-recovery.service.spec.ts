import { BookRecord, LibraryRepository } from '@omnia-reader/reader/domain';
import { bookObjectPath } from './book-sync-manifest';
import { LibrarySyncTransport, RemoteObject } from './library-sync-transport';
import {
  DefaultRemoteVariantRecovery,
  RemoteVariantRecoveryMismatchError,
} from './remote-variant-recovery.service';

describe('DefaultRemoteVariantRecovery', () => {
  const book = record();
  const object = remoteObject(book);
  const headObject = vi.fn();
  const downloadObject = vi.fn();
  const replaceVariantSource = vi.fn();
  let recovery: DefaultRemoteVariantRecovery;

  beforeEach(() => {
    vi.clearAllMocks();
    headObject.mockResolvedValue(object);
    downloadObject.mockResolvedValue(new Blob(['test']));
    replaceVariantSource.mockResolvedValue(undefined);
    recovery = new DefaultRemoteVariantRecovery(
      { headObject, downloadObject } as unknown as LibrarySyncTransport,
      { replaceVariantSource } as unknown as LibraryRepository,
    );
  });

  it('advertises recovery only for the canonical exact remote object', async () => {
    await expect(recovery.probe(book)).resolves.toEqual(object);
    expect(headObject).toHaveBeenCalledWith(bookObjectPath(book));

    headObject.mockResolvedValueOnce({ ...object, size: object.size + 1 });
    await expect(recovery.probe(book)).resolves.toBeNull();

    headObject.mockResolvedValueOnce({ ...object, sha256: 'b'.repeat(64) });
    await expect(recovery.probe(book)).resolves.toBeNull();

    headObject.mockResolvedValueOnce({ ...object, path: `${object.path}.pdf` });
    await expect(recovery.probe(book)).resolves.toBeNull();
  });

  it('revalidates metadata, downloads with transfer options, and replaces only the source', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();

    await recovery.recover(book, { signal: controller.signal, onProgress });

    expect(headObject).toHaveBeenCalledWith(bookObjectPath(book));
    expect(downloadObject).toHaveBeenCalledWith(bookObjectPath(book), {
      signal: controller.signal,
      onProgress,
      expectedSize: book.size,
    });
    expect(replaceVariantSource).toHaveBeenCalledOnce();
    const [variantId, source] = replaceVariantSource.mock.calls[0];
    expect(variantId).toBe(book.id);
    expect(source).toMatchObject({
      name: book.fileName,
      mediaType: book.mediaType,
      size: book.size,
    });
    await expect(source.open()).resolves.toEqual(new Blob(['test']));
  });

  it('does not download or mutate when the object changed after discovery', async () => {
    await expect(recovery.probe(book)).resolves.toEqual(object);
    headObject.mockResolvedValueOnce(null);

    await expect(recovery.recover(book)).rejects.toBeInstanceOf(
      RemoteVariantRecoveryMismatchError,
    );
    expect(downloadObject).not.toHaveBeenCalled();
    expect(replaceVariantSource).not.toHaveBeenCalled();
  });

  it.each([
    new DOMException('Cancelled', 'AbortError'),
    new Error('Transfer failed'),
  ])(
    'leaves the local source unchanged when download fails: %s',
    async (failure) => {
      downloadObject.mockRejectedValueOnce(failure);

      await expect(recovery.recover(book)).rejects.toBe(failure);

      expect(replaceVariantSource).not.toHaveBeenCalled();
    },
  );
});

function record(): BookRecord {
  return {
    id: `sha256:${'a'.repeat(64)}`,
    format: 'epub',
    fileName: 'book.epub',
    mediaType: 'application/epub+zip',
    size: 4,
    title: 'Book',
    authors: [],
    importedAt: '2026-07-31T08:00:00.000Z',
  };
}

function remoteObject(book: BookRecord): RemoteObject {
  return {
    path: bookObjectPath(book),
    revision: 'remote-revision',
    size: book.size,
    sha256: book.id.slice('sha256:'.length),
  };
}
