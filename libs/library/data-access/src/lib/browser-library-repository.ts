import {
  BookRecord,
  BookSource,
  detectPublicationFormat,
  isBookRecord,
  isReaderPreferences,
  isReadingProgress,
  LibraryRepository,
  MetadataUpdateOptions,
  isPublicationAnnotation,
  isPublicationBookmark,
  PublicationAnnotation,
  PublicationBookmark,
  PublicationMetadata,
  PublicationFormat,
  ReaderPreferences,
  ReadingProgress,
} from '@omnia-reader/reader/domain';
import type { LibraryQuarantineRepository } from './library-quarantine.token';
import {
  BrowserPublicationBinaryStorage,
  parseStoredPublicationBinary,
  PublicationBinaryStorage,
  StoredPublicationBinary,
} from './publication-binary-storage';
import { publicationFingerprint } from './publication-fingerprint';

export { publicationFingerprint } from './publication-fingerprint';

const DATABASE_NAME = 'omnia-reader';
const DATABASE_VERSION = 8;
const BOOKS_STORE = 'books';
const BINARIES_STORE = 'binaries';
const COVERS_STORE = 'covers';
const PROGRESS_STORE = 'progress';
const PROGRESS_DOCUMENTS_STORE = 'progressDocuments';
const PROGRESS_DOCUMENT_BOOK_ID_INDEX = 'bookId';
const PREFERENCES_STORE = 'preferences';
const BOOKMARKS_STORE = 'bookmarks';
const BOOKMARK_BOOK_ID_INDEX = 'bookId';
const ANNOTATIONS_STORE = 'annotations';
const ANNOTATION_BOOK_ID_INDEX = 'bookId';
const QUARANTINE_STORE = 'quarantine';

type ActiveLibraryStore =
  | typeof BOOKS_STORE
  | typeof BINARIES_STORE
  | typeof COVERS_STORE
  | typeof PROGRESS_STORE
  | typeof PROGRESS_DOCUMENTS_STORE
  | typeof PREFERENCES_STORE
  | typeof BOOKMARKS_STORE
  | typeof ANNOTATIONS_STORE;

export interface QuarantinedLibraryRecord {
  id?: number;
  storeName: ActiveLibraryStore;
  recordKey: IDBValidKey;
  value: unknown;
  reason: string;
  quarantinedAt: string;
}

interface StoredEntry {
  key: IDBValidKey;
  value: unknown;
}

type RuntimeValidator<T> = (value: unknown) => value is T;

interface StoredCoverBytes {
  bookId: string;
  mediaType: string;
  bytes: ArrayBuffer;
}

interface LegacyStoredCover {
  bookId: string;
  blob: Blob;
}

class StoredBookSource implements BookSource {
  readonly size: number;

  constructor(
    readonly name: string,
    readonly mediaType: string,
    private readonly blob: Blob,
  ) {
    this.size = blob.size;
  }

  async open(): Promise<Blob> {
    return this.blob;
  }
}

export class BrowserLibraryRepository
  implements LibraryRepository, LibraryQuarantineRepository
{
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly binaryStorage: PublicationBinaryStorage = new BrowserPublicationBinaryStorage(),
    private readonly fingerprinter: (
      blob: Blob,
    ) => Promise<string> = publicationFingerprint,
  ) {}

  async listBooks(): Promise<readonly BookRecord[]> {
    const records = await this.readAllValidated(
      BOOKS_STORE,
      isBookRecord,
      'Book metadata failed schema validation',
    );
    return records.sort((left, right) =>
      right.importedAt.localeCompare(left.importedAt),
    );
  }

  getBook(bookId: string): Promise<BookRecord | null> {
    return this.readValidated(
      BOOKS_STORE,
      bookId,
      (value): value is BookRecord =>
        isBookRecord(value) && value.id === bookId,
      'Book metadata failed identity or schema validation',
    );
  }

  async getBookSource(bookId: string): Promise<BookSource | null> {
    let stored = await this.getStoredBinary(bookId);
    const book = await this.getBook(bookId);
    if (!stored || !book) {
      return null;
    }

    const migrated = await this.binaryStorage.migrate(stored, book.format);
    if (migrated !== stored) {
      try {
        await this.write(BINARIES_STORE, migrated);
        stored = migrated;
      } catch {
        await this.binaryStorage.remove(migrated);
      }
    }

    const blob = await this.binaryStorage.open(stored);
    return blob
      ? new StoredBookSource(stored.fileName, stored.mediaType, blob)
      : null;
  }

  async getBookCover(bookId: string): Promise<Blob | null> {
    const stored = await this.readValidated(
      COVERS_STORE,
      bookId,
      (value): value is StoredCoverBytes | LegacyStoredCover =>
        isStoredCover(value, bookId),
      'Cover cache failed identity or schema validation',
    );
    if (!stored) {
      return null;
    }
    const legacy = stored as Partial<LegacyStoredCover>;
    if (legacy.blob instanceof Blob) {
      return legacy.blob;
    }
    const current = stored as Partial<StoredCoverBytes>;
    const bytes = asArrayBuffer(current.bytes);
    return bytes && typeof current.mediaType === 'string'
      ? new Blob([bytes], { type: current.mediaType })
      : null;
  }

  async importBook(source: BookSource): Promise<BookRecord> {
    const opened = await source.open();
    const blob = opened instanceof Blob ? opened : new Blob([opened]);
    const id = await this.fingerprinter(blob);
    const existing = await this.getBook(id);

    if (existing) {
      if (!(await this.getBookSource(id).catch(() => null))) {
        await this.replaceStoredBinary(existing, blob);
      }
      return existing;
    }

    const format = detectPublicationFormat(source.name, source.mediaType);
    if (!format) {
      throw new Error(
        `Unsupported publication "${source.name}" (${source.mediaType || 'unknown type'})`,
      );
    }
    const record: BookRecord = {
      id,
      format,
      fileName: source.name,
      mediaType:
        source.mediaType ||
        (format === 'epub' ? 'application/epub+zip' : 'application/pdf'),
      size: blob.size,
      title: titleFromFileName(source.name),
      authors: [],
      importedAt: new Date().toISOString(),
    };
    const binary = await this.binaryStorage.save({
      bookId: id,
      format,
      fileName: record.fileName,
      mediaType: record.mediaType,
      blob,
    });

    try {
      await this.writeTransaction(
        [BOOKS_STORE, BINARIES_STORE],
        (transaction) => {
          transaction.objectStore(BOOKS_STORE).put(record);
          transaction.objectStore(BINARIES_STORE).put(binary);
        },
      );
    } catch (error) {
      await this.binaryStorage.remove(binary);
      throw error;
    }

    return record;
  }

  async storeSyncedBook(book: BookRecord, source: BookSource): Promise<void> {
    if (!isBookRecord(book)) {
      throw new TypeError('Synchronized publication metadata is invalid');
    }
    const existing = await this.getBook(book.id);
    if (existing && (await this.getBookSource(book.id).catch(() => null))) {
      return;
    }
    const opened = await source.open();
    const blob = opened instanceof Blob ? opened : new Blob([opened]);
    const fingerprint = await this.fingerprinter(blob);
    const format = detectPublicationFormat(book.fileName, book.mediaType);
    if (
      fingerprint !== book.id ||
      blob.size !== book.size ||
      format !== book.format
    ) {
      throw new Error('Synchronized publication failed integrity validation');
    }

    const binary = await this.binaryStorage.save({
      bookId: book.id,
      format: book.format,
      fileName: book.fileName,
      mediaType: book.mediaType,
      blob,
    });
    try {
      await this.writeTransaction(
        existing ? [BINARIES_STORE] : [BOOKS_STORE, BINARIES_STORE],
        (transaction) => {
          if (!existing) {
            transaction.objectStore(BOOKS_STORE).put(book);
          }
          transaction.objectStore(BINARIES_STORE).put(binary);
        },
      );
    } catch (error) {
      await this.binaryStorage.remove(binary);
      throw error;
    }
  }

  async updateMetadata(
    bookId: string,
    metadata: PublicationMetadata,
    options: MetadataUpdateOptions = {},
  ): Promise<BookRecord> {
    const current = await this.getBook(bookId);

    if (!current) {
      throw new Error(`Book "${bookId}" was not found`);
    }

    const updated: BookRecord = {
      ...current,
      title: metadata.title || current.title,
      authors: metadata.authors,
      language: metadata.language ?? current.language,
      publisher: metadata.publisher ?? current.publisher,
      identifier: metadata.identifier ?? current.identifier,
      lastOpenedAt: options.markOpened
        ? new Date().toISOString()
        : current.lastOpenedAt,
      coverState: metadata.cover
        ? 'available'
        : options.markCoverUnavailable
          ? 'unavailable'
          : current.coverState,
    };
    const storeNames = metadata.cover
      ? [BOOKS_STORE, COVERS_STORE]
      : [BOOKS_STORE];
    const storedCover = metadata.cover
      ? {
          bookId,
          mediaType: metadata.cover.type,
          bytes: await blobBytes(metadata.cover),
        }
      : null;
    await this.writeTransaction(storeNames, (transaction) => {
      transaction.objectStore(BOOKS_STORE).put(updated);
      if (storedCover) {
        transaction.objectStore(COVERS_STORE).put(storedCover);
      }
    });
    return updated;
  }

  async removeBook(bookId: string): Promise<void> {
    const [stored, progressDocuments, bookmarks, annotations] =
      await Promise.all([
        this.getStoredBinary(bookId),
        this.listProgressDocuments(bookId),
        this.listBookmarks(bookId, true),
        this.listAnnotations(bookId, true),
      ]);
    await this.writeTransaction(
      [
        BOOKS_STORE,
        BINARIES_STORE,
        COVERS_STORE,
        PROGRESS_STORE,
        PROGRESS_DOCUMENTS_STORE,
        BOOKMARKS_STORE,
        ANNOTATIONS_STORE,
      ],
      (transaction) => {
        transaction.objectStore(BOOKS_STORE).delete(bookId);
        transaction.objectStore(BINARIES_STORE).delete(bookId);
        transaction.objectStore(COVERS_STORE).delete(bookId);
        transaction.objectStore(PROGRESS_STORE).delete(bookId);
        const progressDocumentsStore = transaction.objectStore(
          PROGRESS_DOCUMENTS_STORE,
        );
        progressDocuments.forEach((progress) =>
          progressDocumentsStore.delete([progress.bookId, progress.deviceId]),
        );
        const bookmarkStore = transaction.objectStore(BOOKMARKS_STORE);
        bookmarks.forEach((bookmark) => bookmarkStore.delete(bookmark.id));
        const annotationStore = transaction.objectStore(ANNOTATIONS_STORE);
        annotations.forEach((annotation) =>
          annotationStore.delete(annotation.id),
        );
      },
    );
    if (stored) {
      await this.binaryStorage.remove(stored);
    }
  }

  async getProgress(bookId: string): Promise<ReadingProgress | null> {
    const book = await this.getBook(bookId);
    return this.readValidated(
      PROGRESS_STORE,
      bookId,
      (value): value is ReadingProgress =>
        !!book &&
        isReadingProgress(value) &&
        value.bookId === bookId &&
        value.format === book.format,
      'Reading progress failed publication or schema validation',
    );
  }

  async listProgress(): Promise<readonly ReadingProgress[]> {
    const books = new Map(
      (await this.listBooks()).map((book) => [book.id, book]),
    );
    return this.readAllValidated(
      PROGRESS_STORE,
      (value): value is ReadingProgress => {
        if (!isReadingProgress(value)) {
          return false;
        }
        return books.get(value.bookId)?.format === value.format;
      },
      'Reading progress failed publication or schema validation',
    );
  }

  async saveProgress(progress: ReadingProgress): Promise<void> {
    if (!isReadingProgress(progress)) {
      throw new TypeError('Reading progress record is invalid');
    }
    const book = await this.getBook(progress.bookId);
    if (!book || book.format !== progress.format) {
      throw new Error('Reading progress publication is not available');
    }
    await this.write(PROGRESS_STORE, progress);
  }

  async listProgressDocuments(
    bookId?: string,
  ): Promise<readonly ReadingProgress[]> {
    const books = new Map(
      (await this.listBooks()).map((book) => [book.id, book]),
    );
    const documents =
      bookId === undefined
        ? await this.readAllValidated(
            PROGRESS_DOCUMENTS_STORE,
            (value): value is ReadingProgress =>
              isReadingProgress(value) &&
              books.get(value.bookId)?.format === value.format,
            'Progress document failed publication or schema validation',
          )
        : await this.readAllByIndexValidated(
            PROGRESS_DOCUMENTS_STORE,
            PROGRESS_DOCUMENT_BOOK_ID_INDEX,
            bookId,
            (value): value is ReadingProgress =>
              isReadingProgress(value) &&
              value.bookId === bookId &&
              books.get(value.bookId)?.format === value.format,
            'Progress document failed publication or schema validation',
          );
    return documents.sort(
      (left, right) =>
        left.bookId.localeCompare(right.bookId) ||
        left.deviceId.localeCompare(right.deviceId),
    );
  }

  async saveProgressDocument(progress: ReadingProgress): Promise<void> {
    if (!isReadingProgress(progress)) {
      throw new TypeError('Progress document is invalid');
    }
    const book = await this.getBook(progress.bookId);
    if (!book || book.format !== progress.format) {
      throw new Error('Progress document publication is not available');
    }
    await this.write(PROGRESS_DOCUMENTS_STORE, progress);
  }

  async getBookmark(bookmarkId: string): Promise<PublicationBookmark | null> {
    const bookmark = await this.readValidated(
      BOOKMARKS_STORE,
      bookmarkId,
      (value): value is PublicationBookmark =>
        isPublicationBookmark(value) && value.id === bookmarkId,
      'Bookmark failed identity or schema validation',
    );
    if (!bookmark) {
      return null;
    }
    const book = await this.getBook(bookmark.bookId);
    if (book?.format === bookmark.format) {
      return bookmark;
    }
    await this.quarantineInvalidRecord(
      BOOKMARKS_STORE,
      bookmarkId,
      (value): value is PublicationBookmark =>
        isPublicationBookmark(value) &&
        value.id === bookmarkId &&
        !!book &&
        value.bookId === book.id &&
        value.format === book.format,
      'Bookmark publication is missing or mismatched',
    );
    return null;
  }

  async listBookmarks(
    bookId?: string,
    includeDeleted = false,
  ): Promise<readonly PublicationBookmark[]> {
    const books = new Map(
      (await this.listBooks()).map((book) => [book.id, book]),
    );
    const bookmarks =
      bookId === undefined
        ? await this.readAllValidated(
            BOOKMARKS_STORE,
            (value): value is PublicationBookmark =>
              isPublicationBookmark(value) &&
              books.get(value.bookId)?.format === value.format,
            'Bookmark failed publication or schema validation',
          )
        : await this.readAllByIndexValidated(
            BOOKMARKS_STORE,
            BOOKMARK_BOOK_ID_INDEX,
            bookId,
            (value): value is PublicationBookmark =>
              isPublicationBookmark(value) &&
              value.bookId === bookId &&
              books.get(value.bookId)?.format === value.format,
            'Bookmark failed publication or schema validation',
          );
    return bookmarks
      .filter((bookmark) => includeDeleted || bookmark.deletedAt === undefined)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      );
  }

  async saveBookmark(bookmark: PublicationBookmark): Promise<void> {
    if (!isPublicationBookmark(bookmark)) {
      throw new TypeError('Bookmark record is invalid');
    }
    const book = await this.getBook(bookmark.bookId);
    if (!book || book.format !== bookmark.format) {
      throw new Error('Bookmark publication is not available');
    }
    await this.write(BOOKMARKS_STORE, bookmark);
  }

  async getAnnotation(
    annotationId: string,
  ): Promise<PublicationAnnotation | null> {
    const annotation = await this.readValidated(
      ANNOTATIONS_STORE,
      annotationId,
      (value): value is PublicationAnnotation =>
        isPublicationAnnotation(value) && value.id === annotationId,
      'Annotation failed identity or schema validation',
    );
    if (!annotation) {
      return null;
    }
    const book = await this.getBook(annotation.bookId);
    if (book?.format === annotation.format) {
      return annotation;
    }
    await this.quarantineInvalidRecord(
      ANNOTATIONS_STORE,
      annotationId,
      (value): value is PublicationAnnotation =>
        isPublicationAnnotation(value) &&
        value.id === annotationId &&
        !!book &&
        value.bookId === book.id &&
        value.format === book.format,
      'Annotation publication is missing or mismatched',
    );
    return null;
  }

  async listAnnotations(
    bookId?: string,
    includeDeleted = false,
  ): Promise<readonly PublicationAnnotation[]> {
    const books = new Map(
      (await this.listBooks()).map((book) => [book.id, book]),
    );
    const annotations =
      bookId === undefined
        ? await this.readAllValidated(
            ANNOTATIONS_STORE,
            (value): value is PublicationAnnotation =>
              isPublicationAnnotation(value) &&
              books.get(value.bookId)?.format === value.format,
            'Annotation failed publication or schema validation',
          )
        : await this.readAllByIndexValidated(
            ANNOTATIONS_STORE,
            ANNOTATION_BOOK_ID_INDEX,
            bookId,
            (value): value is PublicationAnnotation =>
              isPublicationAnnotation(value) &&
              value.bookId === bookId &&
              books.get(value.bookId)?.format === value.format,
            'Annotation failed publication or schema validation',
          );
    return annotations
      .filter(
        (annotation) => includeDeleted || annotation.deletedAt === undefined,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      );
  }

  async saveAnnotation(annotation: PublicationAnnotation): Promise<void> {
    if (!isPublicationAnnotation(annotation)) {
      throw new TypeError('Annotation record is invalid');
    }
    const book = await this.getBook(annotation.bookId);
    if (!book || book.format !== annotation.format) {
      throw new Error('Annotation publication is not available');
    }
    await this.write(ANNOTATIONS_STORE, annotation);
  }

  getReaderPreferences(
    format: PublicationFormat,
  ): Promise<ReaderPreferences | null> {
    return this.readValidated(
      PREFERENCES_STORE,
      format,
      (value): value is ReaderPreferences =>
        isReaderPreferences(value) && value.format === format,
      'Reader preferences failed format or schema validation',
    );
  }

  saveReaderPreferences(preferences: ReaderPreferences): Promise<void> {
    if (!isReaderPreferences(preferences)) {
      return Promise.reject(new TypeError('Reader preferences are invalid'));
    }
    return this.write(PREFERENCES_STORE, preferences);
  }

  async listQuarantinedRecords(): Promise<readonly QuarantinedLibraryRecord[]> {
    const records =
      await this.readAll<QuarantinedLibraryRecord>(QUARANTINE_STORE);
    return records.sort(
      (left, right) =>
        right.quarantinedAt.localeCompare(left.quarantinedAt) ||
        Number(right.id ?? 0) - Number(left.id ?? 0),
    );
  }

  private async database(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.addEventListener('upgradeneeded', () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(BOOKS_STORE)) {
            database.createObjectStore(BOOKS_STORE, { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains(BINARIES_STORE)) {
            database.createObjectStore(BINARIES_STORE, { keyPath: 'bookId' });
          }
          if (!database.objectStoreNames.contains(COVERS_STORE)) {
            database.createObjectStore(COVERS_STORE, { keyPath: 'bookId' });
          }
          if (!database.objectStoreNames.contains(PROGRESS_STORE)) {
            database.createObjectStore(PROGRESS_STORE, { keyPath: 'bookId' });
          }
          if (!database.objectStoreNames.contains(PROGRESS_DOCUMENTS_STORE)) {
            database
              .createObjectStore(PROGRESS_DOCUMENTS_STORE, {
                keyPath: ['bookId', 'deviceId'],
              })
              .createIndex(PROGRESS_DOCUMENT_BOOK_ID_INDEX, 'bookId');
          }
          if (!database.objectStoreNames.contains(PREFERENCES_STORE)) {
            database.createObjectStore(PREFERENCES_STORE, {
              keyPath: 'format',
            });
          }
          if (!database.objectStoreNames.contains(BOOKMARKS_STORE)) {
            database
              .createObjectStore(BOOKMARKS_STORE, { keyPath: 'id' })
              .createIndex(BOOKMARK_BOOK_ID_INDEX, 'bookId');
          }
          if (!database.objectStoreNames.contains(ANNOTATIONS_STORE)) {
            database
              .createObjectStore(ANNOTATIONS_STORE, { keyPath: 'id' })
              .createIndex(ANNOTATION_BOOK_ID_INDEX, 'bookId');
          }
          if (!database.objectStoreNames.contains(QUARANTINE_STORE)) {
            database.createObjectStore(QUARANTINE_STORE, {
              keyPath: 'id',
              autoIncrement: true,
            });
          }
        });
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () =>
          reject(request.error ?? new Error('Unable to open the library')),
        );
      });
    }
    return this.databasePromise;
  }

  private async read<T>(
    storeName: string,
    key: IDBValidKey,
  ): Promise<T | null> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(storeName, 'readonly')
        .objectStore(storeName)
        .get(key);
      request.addEventListener('success', () =>
        resolve((request.result as T | undefined) ?? null),
      );
      request.addEventListener('error', () =>
        reject(request.error ?? new Error(`Unable to read ${storeName}`)),
      );
    });
  }

  private async readValidated<T>(
    storeName: ActiveLibraryStore,
    key: IDBValidKey,
    validator: RuntimeValidator<T>,
    reason: string,
  ): Promise<T | null> {
    const value = await this.read<unknown>(storeName, key);
    if (value === null) {
      return null;
    }
    if (validator(value)) {
      return value;
    }
    await this.quarantineInvalidRecord(storeName, key, validator, reason);
    return null;
  }

  private async readAll<T>(storeName: string): Promise<T[]> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(storeName, 'readonly')
        .objectStore(storeName)
        .getAll();
      request.addEventListener('success', () => resolve(request.result as T[]));
      request.addEventListener('error', () =>
        reject(request.error ?? new Error(`Unable to list ${storeName}`)),
      );
    });
  }

  private async readAllValidated<T>(
    storeName: ActiveLibraryStore,
    validator: RuntimeValidator<T>,
    reason: string,
  ): Promise<T[]> {
    return this.validatedEntries(
      storeName,
      await this.readAllEntries(storeName),
      validator,
      reason,
    );
  }

  private async readAllByIndexValidated<T>(
    storeName: ActiveLibraryStore,
    indexName: string,
    key: IDBValidKey,
    validator: RuntimeValidator<T>,
    reason: string,
  ): Promise<T[]> {
    return this.validatedEntries(
      storeName,
      await this.readAllEntries(storeName, indexName, key),
      validator,
      reason,
    );
  }

  private async readAllEntries(
    storeName: ActiveLibraryStore,
    indexName?: string,
    query?: IDBValidKey | IDBKeyRange,
  ): Promise<StoredEntry[]> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const store = database
        .transaction(storeName, 'readonly')
        .objectStore(storeName);
      const source = indexName ? store.index(indexName) : store;
      const records: StoredEntry[] = [];
      const request = source.openCursor(query);
      request.addEventListener('success', () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(records);
          return;
        }
        records.push({ key: cursor.primaryKey, value: cursor.value });
        cursor.continue();
      });
      request.addEventListener('error', () =>
        reject(request.error ?? new Error(`Unable to list ${storeName}`)),
      );
    });
  }

  private async validatedEntries<T>(
    storeName: ActiveLibraryStore,
    entries: readonly StoredEntry[],
    validator: RuntimeValidator<T>,
    reason: string,
  ): Promise<T[]> {
    const valid: T[] = [];
    for (const entry of entries) {
      if (validator(entry.value)) {
        valid.push(entry.value);
      } else {
        await this.quarantineInvalidRecord(
          storeName,
          entry.key,
          validator,
          reason,
        );
      }
    }
    return valid;
  }

  private async quarantineInvalidRecord<T>(
    storeName: ActiveLibraryStore,
    key: IDBValidKey,
    validator: RuntimeValidator<T>,
    reason: string,
  ): Promise<void> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [storeName, QUARANTINE_STORE],
        'readwrite',
      );
      const source = transaction.objectStore(storeName);
      const request = source.get(key);
      request.addEventListener('success', () => {
        const current = request.result as unknown;
        if (current === undefined || validator(current)) {
          return;
        }
        transaction.objectStore(QUARANTINE_STORE).add({
          storeName,
          recordKey: key,
          value: current,
          reason,
          quarantinedAt: new Date().toISOString(),
        } satisfies QuarantinedLibraryRecord);
        source.delete(key);
      });
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('error', () =>
        reject(
          transaction.error ??
            new Error(`Unable to quarantine invalid ${storeName} record`),
        ),
      );
      transaction.addEventListener('abort', () =>
        reject(
          transaction.error ??
            new Error(`Unable to quarantine invalid ${storeName} record`),
        ),
      );
    });
  }

  private async getStoredBinary(
    bookId: string,
  ): Promise<StoredPublicationBinary | null> {
    const value = await this.read<unknown>(BINARIES_STORE, bookId);
    if (value === null) {
      return null;
    }
    const parsed = parseStoredPublicationBinary(value);
    if (parsed) {
      return parsed;
    }
    await this.quarantineInvalidRecord(
      BINARIES_STORE,
      bookId,
      (candidate): candidate is StoredPublicationBinary =>
        parseStoredPublicationBinary(candidate) !== null,
      'Publication binary reference failed identity or schema validation',
    );
    return null;
  }

  private async replaceStoredBinary(
    book: BookRecord,
    blob: Blob,
  ): Promise<void> {
    const replacement = await this.binaryStorage.save({
      bookId: book.id,
      format: book.format,
      fileName: book.fileName,
      mediaType: book.mediaType,
      blob,
    });
    try {
      await this.write(BINARIES_STORE, replacement);
    } catch (error) {
      await this.binaryStorage.remove(replacement);
      throw error;
    }
  }

  private async write(storeName: string, value: unknown): Promise<void> {
    return this.writeTransaction([storeName], (transaction) => {
      transaction.objectStore(storeName).put(value);
    });
  }

  private async writeTransaction(
    storeNames: string[],
    mutate: (transaction: IDBTransaction) => void,
  ): Promise<void> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeNames, 'readwrite');
      mutate(transaction);
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('error', () =>
        reject(transaction.error ?? new Error('Library update failed')),
      );
      transaction.addEventListener('abort', () =>
        reject(transaction.error ?? new Error('Library update was aborted')),
      );
    });
  }
}

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.(epub|pdf)$/i, '') || 'Untitled publication';
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read cover bytes'));
      }
    });
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read cover bytes')),
    );
    reader.readAsArrayBuffer(blob);
  });
}

function isStoredCover(
  value: unknown,
  expectedBookId: string,
): value is StoredCoverBytes | LegacyStoredCover {
  if (
    !isRecord(value) ||
    value['bookId'] !== expectedBookId ||
    !/^sha256:[a-f0-9]{64}$/.test(expectedBookId)
  ) {
    return false;
  }
  if (value['blob'] instanceof Blob) {
    return true;
  }
  return (
    typeof value['mediaType'] === 'string' &&
    value['mediaType'].length > 0 &&
    value['mediaType'].length <= 128 &&
    asArrayBuffer(value['bytes']) !== null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  ) {
    return value as ArrayBuffer;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  return null;
}
