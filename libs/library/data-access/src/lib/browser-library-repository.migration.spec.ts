import 'fake-indexeddb/auto';
import { BrowserLibraryRepository } from './browser-library-repository';

const BOOK = {
  id: `sha256:${'e'.repeat(64)}`,
  format: 'pdf' as const,
  fileName: 'preserved.pdf',
  mediaType: 'application/pdf',
  size: 128,
  title: 'Preserved across migration',
  authors: ['Omnia'],
  importedAt: '2026-07-25T08:00:00.000Z',
};

describe('BrowserLibraryRepository schema migration', () => {
  it('adds the progress document cache without losing version 7 books', async () => {
    const legacy = await openDatabase(7, (database) => {
      database.createObjectStore('books', { keyPath: 'id' }).put(BOOK);
      database.createObjectStore('quarantine', {
        keyPath: 'id',
        autoIncrement: true,
      });
    });
    legacy.close();

    const repository = new BrowserLibraryRepository();

    await expect(repository.listBooks()).resolves.toEqual([BOOK]);
    await expect(repository.listQuarantinedRecords()).resolves.toEqual([]);
    const migrated = await openDatabase();
    expect(migrated.version).toBe(8);
    expect([...migrated.objectStoreNames]).toContain('quarantine');
    expect([...migrated.objectStoreNames]).toContain('progressDocuments');
    migrated.close();
  });
});

function openDatabase(
  version?: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open('omnia-reader')
        : indexedDB.open('omnia-reader', version);
    request.addEventListener('upgradeneeded', () => upgrade?.(request.result));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Unable to open the test library')),
    );
  });
}
