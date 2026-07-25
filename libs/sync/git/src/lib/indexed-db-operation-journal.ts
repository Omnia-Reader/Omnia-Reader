import {
  NewSyncOperation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';

const DATABASE_NAME = 'omnia-reader-sync';
const DATABASE_VERSION = 1;
const OPERATIONS_STORE = 'operations';
const REVISIONS_STORE = 'revisions';

interface StoredRevision {
  entityKey: string;
  revision: number;
}

export class IndexedDbOperationJournal implements SyncOperationJournal {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async append(input: NewSyncOperation): Promise<SyncOperation> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [OPERATIONS_STORE, REVISIONS_STORE],
        'readwrite',
      );
      const entityKey = `${input.entity}:${input.entityId}`;
      const revisions = transaction.objectStore(REVISIONS_STORE);
      const request = revisions.get(entityKey);

      request.addEventListener('success', () => {
        const previous = request.result as StoredRevision | undefined;
        const revision = (previous?.revision ?? 0) + 1;
        const operation: SyncOperation = {
          ...input,
          id: crypto.randomUUID(),
          revision,
          createdAt: new Date().toISOString(),
        };
        revisions.put({ entityKey, revision } satisfies StoredRevision);
        transaction.objectStore(OPERATIONS_STORE).put(operation);
        transaction.addEventListener('complete', () => resolve(operation));
      });
      request.addEventListener('error', () =>
        reject(request.error ?? new Error('Unable to read sync revision')),
      );
      transaction.addEventListener('error', () =>
        reject(transaction.error ?? new Error('Unable to append sync change')),
      );
      transaction.addEventListener('abort', () =>
        reject(transaction.error ?? new Error('Sync journal update aborted')),
      );
    });
  }

  async pending(): Promise<readonly SyncOperation[]> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(OPERATIONS_STORE, 'readonly')
        .objectStore(OPERATIONS_STORE)
        .getAll();
      request.addEventListener('success', () => {
        const operations = request.result as SyncOperation[];
        resolve(
          operations.sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.id.localeCompare(right.id),
          ),
        );
      });
      request.addEventListener('error', () =>
        reject(request.error ?? new Error('Unable to read sync changes')),
      );
    });
  }

  async acknowledge(operationIds: readonly string[]): Promise<void> {
    if (operationIds.length === 0) {
      return;
    }

    const database = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, 'readwrite');
      const operations = transaction.objectStore(OPERATIONS_STORE);
      operationIds.forEach((operationId) => operations.delete(operationId));
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('error', () =>
        reject(
          transaction.error ?? new Error('Unable to acknowledge sync changes'),
        ),
      );
      transaction.addEventListener('abort', () =>
        reject(
          transaction.error ?? new Error('Sync acknowledgement was aborted'),
        ),
      );
    });
  }

  private async database(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.addEventListener('upgradeneeded', () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
            database.createObjectStore(OPERATIONS_STORE, { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains(REVISIONS_STORE)) {
            database.createObjectStore(REVISIONS_STORE, {
              keyPath: 'entityKey',
            });
          }
        });
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () =>
          reject(request.error ?? new Error('Unable to open the sync journal')),
        );
      });
    }
    return this.databasePromise;
  }
}
