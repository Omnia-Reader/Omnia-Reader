import type { Page } from '@playwright/test';
import { canonicalInventoryFields } from './recovery-compatibility-matrix';

export async function clearStoredPublicationBinaries(
  page: Page,
): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('binaries', 'readwrite');
      transaction.objectStore('binaries').clear();
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('error', () => reject(transaction.error));
    });
    database.close();
  });
}

export function inventoryWithoutAvailability(
  inventory: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    canonicalInventoryFields
      .filter((field) => field !== 'availability')
      .map((field) => [field, inventory[field]]),
  );
}

export async function publicationBinaryEvidence(
  page: Page,
): Promise<readonly { bookId: string; size: number; sha256: string }[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('omnia-reader');
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const records = await new Promise<Record<string, unknown>[]>(
      (resolve, reject) => {
        const request = database
          .transaction('binaries', 'readonly')
          .objectStore('binaries')
          .getAll();
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      },
    );
    database.close();

    const evidence = await Promise.all(
      records.map(async (record) => {
        let bytes: ArrayBuffer;
        if (
          record['storage'] === 'opfs' &&
          typeof record['opfsFileName'] === 'string'
        ) {
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle('publications-v1');
          const handle = await directory.getFileHandle(record['opfsFileName']);
          bytes = await (await handle.getFile()).arrayBuffer();
        } else if (record['blob'] instanceof Blob) {
          bytes = await record['blob'].arrayBuffer();
        } else if (record['bytes'] instanceof ArrayBuffer) {
          bytes = record['bytes'];
        } else {
          throw new Error('Stored publication bytes are unavailable');
        }
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return {
          bookId: String(record['bookId']),
          size: bytes.byteLength,
          sha256: [...new Uint8Array(hash)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(''),
        };
      }),
    );
    return evidence.sort((left, right) =>
      left.bookId.localeCompare(right.bookId),
    );
  });
}

export async function canonicalRecoveryInventory(
  page: Page,
): Promise<Record<string, unknown>> {
  const inventory = await page.evaluate(async () => {
    const readStores = async (
      databaseName: string,
      storeNames: readonly string[],
      allowMissingDatabase = false,
    ): Promise<Record<string, unknown[]>> => {
      const empty = Object.fromEntries(
        storeNames.map((storeName) => [storeName, []]),
      ) as Record<string, unknown[]>;
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === databaseName)) {
        if (allowMissingDatabase) return empty;
        throw new Error(`IndexedDB database "${databaseName}" is missing`);
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      try {
        const transaction = database.transaction([...storeNames], 'readonly');
        const records = await Promise.all(
          storeNames.map(
            (storeName) =>
              new Promise<unknown[]>((resolve, reject) => {
                const request = transaction.objectStore(storeName).getAll();
                request.addEventListener('success', () =>
                  resolve(request.result),
                );
                request.addEventListener('error', () => reject(request.error));
              }),
          ),
        );
        return Object.fromEntries(
          storeNames.map((storeName, index) => [
            storeName,
            records[index] ?? [],
          ]),
        );
      } finally {
        database.close();
      }
    };

    const digest = async (bytes: ArrayBuffer): Promise<string> => {
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    };

    const normalize = async (value: unknown): Promise<unknown> => {
      if (value instanceof Blob) {
        const bytes = await value.arrayBuffer();
        return {
          type: value.type,
          size: value.size,
          sha256: await digest(bytes),
        };
      }
      if (value instanceof ArrayBuffer) {
        return { size: value.byteLength, sha256: await digest(value) };
      }
      if (ArrayBuffer.isView(value)) {
        const bytes = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        );
        return { size: value.byteLength, sha256: await digest(bytes) };
      }
      if (Array.isArray(value)) {
        return Promise.all(value.map((item) => normalize(item)));
      }
      if (value && typeof value === 'object') {
        const entries = await Promise.all(
          Object.entries(value).map(
            async ([key, item]) => [key, await normalize(item)] as const,
          ),
        );
        return Object.fromEntries(
          entries.sort(([left], [right]) => left.localeCompare(right)),
        );
      }
      return value;
    };

    const library = await readStores('omnia-reader', [
      'books',
      'binaries',
      'covers',
      'progress',
      'progressDocuments',
      'bookmarks',
      'annotations',
      'logicalBooks',
      'logicalBookCovers',
      'logicalBookPreferences',
      'logicalBookChangeOutbox',
    ]);
    const sync = await readStores('omnia-reader-sync', ['operations'], true);
    const bookmarks = library['bookmarks'] ?? [];
    const annotations = library['annotations'] ?? [];
    const tombstones = [...bookmarks, ...annotations].filter(
      (record) =>
        !!record &&
        typeof record === 'object' &&
        'deletedAt' in record &&
        typeof record.deletedAt === 'string',
    );
    const exclusions = localStorage.getItem('omnia-reader.sync-excluded-books');

    return normalize({
      membership: library['logicalBooks'],
      exactHashesAndSizes: (library['books'] ?? []).map((record) => {
        const book = record as { id?: unknown; size?: unknown };
        return { id: book.id, size: book.size };
      }),
      availability: library['binaries'],
      preferredFormat: library['logicalBookPreferences'],
      progress: library['progress'],
      progressDocuments: library['progressDocuments'],
      bookmarks,
      annotations,
      tombstones,
      exclusions,
      pendingJournalOperations: {
        journal: sync['operations'],
        logicalChangeOutbox: library['logicalBookChangeOutbox'],
      },
      coversAndCatalogOwnership: {
        covers: library['covers'],
        logicalBookCovers: library['logicalBookCovers'],
        books: (library['books'] ?? []).map((record) => {
          const book = record as { id?: unknown };
          return book.id;
        }),
        logicalBooks: library['logicalBooks'],
      },
    });
  });
  return inventory as Record<string, unknown>;
}
