import {
  BrowserPublicationBinaryStorage,
  IndexedDbPublicationBinary,
  parseStoredPublicationBinary,
} from './publication-binary-storage';

describe('BrowserPublicationBinaryStorage', () => {
  it('stores, reads, and removes publication bytes in OPFS', async () => {
    const opfs = fakeOpfs();
    const storage = new BrowserPublicationBinaryStorage(opfs.manager);
    const publication = new Blob(['publication bytes'], {
      type: 'application/epub+zip',
    });

    const stored = await storage.save({
      bookId: `sha256:${'a'.repeat(64)}`,
      format: 'epub',
      fileName: 'Book.epub',
      mediaType: publication.type,
      blob: publication,
    });

    expect(stored).toMatchObject({
      schemaVersion: 2,
      storage: 'opfs',
      opfsFileName: `${'a'.repeat(64)}.epub`,
      size: publication.size,
    });
    await expect(storage.open(stored)).resolves.toMatchObject({
      size: publication.size,
      type: publication.type,
    });

    await storage.remove(stored);
    await expect(storage.open(stored)).resolves.toBeNull();
  });

  it('falls back to IndexedDB when OPFS is unavailable', async () => {
    const storage = new BrowserPublicationBinaryStorage({
      getDirectory: async () => {
        throw new Error('OPFS disabled');
      },
    } as unknown as StorageManager);
    const publication = new Blob(['fallback'], { type: 'application/pdf' });

    const stored = await storage.save({
      bookId: `sha256:${'b'.repeat(64)}`,
      format: 'pdf',
      fileName: 'Book.pdf',
      mediaType: publication.type,
      blob: publication,
    });

    expect(stored).toMatchObject({
      schemaVersion: 2,
      storage: 'indexeddb',
      size: publication.size,
    });
    expect(stored).not.toHaveProperty('blob');
    await expect(storage.open(stored)).resolves.toMatchObject({
      size: publication.size,
      type: publication.type,
    });
  });

  it('does not request optional persistence in the critical write path', async () => {
    const opfs = fakeOpfs();
    const persist = vi.fn(() => new Promise<boolean>(() => undefined));
    const storage = new BrowserPublicationBinaryStorage({
      ...opfs.manager,
      persist,
    } as StorageManager);
    const publication = new Blob(['publication bytes'], {
      type: 'application/epub+zip',
    });

    const stored = await storage.save({
      bookId: `sha256:${'e'.repeat(64)}`,
      format: 'epub',
      fileName: 'Book.epub',
      mediaType: publication.type,
      blob: publication,
    });

    expect(stored.storage).toBe('opfs');
    expect(persist).not.toHaveBeenCalled();
  });

  it('migrates a legacy IndexedDB blob without dropping its fallback first', async () => {
    const storage = new BrowserPublicationBinaryStorage(fakeOpfs().manager);
    const publication = new Blob(['legacy'], {
      type: 'application/epub+zip',
    });
    const legacy: IndexedDbPublicationBinary = {
      schemaVersion: 2,
      storage: 'indexeddb',
      bookId: `sha256:${'c'.repeat(64)}`,
      fileName: 'Legacy.epub',
      mediaType: publication.type,
      size: publication.size,
      blob: publication,
    };

    const migrated = await storage.migrate(legacy, 'epub');

    expect(migrated.storage).toBe('opfs');
    await expect(storage.open(migrated)).resolves.toMatchObject({
      size: publication.size,
    });
    await expect(storage.open(legacy)).resolves.toBe(publication);
  });

  it('rejects malformed binary references as corrupt records', () => {
    expect(
      parseStoredPublicationBinary({
        schemaVersion: 2,
        storage: 'opfs',
        bookId: `sha256:${'d'.repeat(64)}`,
        fileName: 'Book.epub',
        mediaType: 'application/epub+zip',
        size: 42,
        opfsFileName: '../outside.epub',
      }),
    ).toBeNull();
    expect(
      parseStoredPublicationBinary({
        schemaVersion: 2,
        storage: 'unknown',
        bookId: `sha256:${'d'.repeat(64)}`,
        fileName: 'Book.epub',
        mediaType: 'application/epub+zip',
        size: 4,
        blob: new Blob(['book']),
      }),
    ).toBeNull();
  });
});

function fakeOpfs(): { manager: StorageManager } {
  const files = new Map<string, Blob>();
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) {
        throw new DOMException('Missing', 'NotFoundError');
      }
      let pending = files.get(name) ?? new Blob();
      return {
        async createWritable() {
          return {
            async write(blob: Blob) {
              pending = blob;
            },
            async close() {
              files.set(name, pending);
            },
            async abort() {
              pending = files.get(name) ?? new Blob();
            },
          };
        },
        async getFile() {
          const file = files.get(name);
          if (!file) {
            throw new DOMException('Missing', 'NotFoundError');
          }
          return file;
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };
  const root = {
    async getDirectoryHandle() {
      return directory;
    },
  };
  return {
    manager: {
      async getDirectory() {
        return root;
      },
    } as unknown as StorageManager,
  };
}
