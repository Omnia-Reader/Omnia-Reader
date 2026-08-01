import {
  BookRecord,
  BookSource,
  detectPublicationFormat,
  isBookRecord,
  isLogicalBookFormatPreference,
  isLogicalBookRecord,
  isMembershipReconciliation,
  isReaderPreferences,
  isReadingProgress,
  LibraryRepository,
  LogicalBookFormatPreference,
  LogicalBookChange,
  LogicalBookId,
  LogicalBookMutationResult,
  LogicalBookRecord,
  LogicalLibrarySnapshot,
  LogicalMutationIdentity,
  AddLogicalBookVariantResult,
  MembershipReconciliationDecision,
  logicalBookFromVariant,
  singletonLogicalBookId,
  MembershipReconciliation,
  MetadataUpdateOptions,
  isPublicationAnnotation,
  isPublicationBookmark,
  PublicationAnnotation,
  PublicationBookmark,
  PublicationMetadata,
  PublicationFormat,
  ReaderPreferences,
  ReadingProgress,
  VariantAvailability,
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
const DATABASE_VERSION = 9;
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
const LOGICAL_BOOKS_STORE = 'logicalBooks';
const LOGICAL_BOOK_EPUB_INDEX = 'epubVariantId';
const LOGICAL_BOOK_PDF_INDEX = 'pdfVariantId';
const LOGICAL_BOOK_COVERS_STORE = 'logicalBookCovers';
const LOGICAL_BOOK_PREFERENCES_STORE = 'logicalBookPreferences';
const LOGICAL_BOOK_RECONCILIATIONS_STORE = 'logicalBookReconciliations';

type ActiveLibraryStore =
  | typeof BOOKS_STORE
  | typeof BINARIES_STORE
  | typeof COVERS_STORE
  | typeof PROGRESS_STORE
  | typeof PROGRESS_DOCUMENTS_STORE
  | typeof PREFERENCES_STORE
  | typeof BOOKMARKS_STORE
  | typeof ANNOTATIONS_STORE
  | typeof LOGICAL_BOOKS_STORE
  | typeof LOGICAL_BOOK_COVERS_STORE
  | typeof LOGICAL_BOOK_PREFERENCES_STORE
  | typeof LOGICAL_BOOK_RECONCILIATIONS_STORE;

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

interface StoredLogicalCoverBytes {
  logicalBookId: LogicalBookId;
  mediaType: string;
  bytes: ArrayBuffer;
}

interface StoredLogicalCoverBlob {
  logicalBookId: LogicalBookId;
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
    private readonly databaseName = DATABASE_NAME,
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

  async listLogicalBooks(): Promise<readonly LogicalBookRecord[]> {
    const records = await this.readAllValidated(
      LOGICAL_BOOKS_STORE,
      isLogicalBookRecord,
      'Logical book failed schema validation',
    );
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  getLogicalBook(
    logicalBookId: LogicalBookId,
  ): Promise<LogicalBookRecord | null> {
    return this.readValidated(
      LOGICAL_BOOKS_STORE,
      logicalBookId,
      (value): value is LogicalBookRecord =>
        isLogicalBookRecord(value) && value.id === logicalBookId,
      'Logical book failed identity or schema validation',
    );
  }

  async findLogicalBookByVariant(
    variantId: string,
  ): Promise<LogicalBookRecord | null> {
    for (const index of [LOGICAL_BOOK_EPUB_INDEX, LOGICAL_BOOK_PDF_INDEX]) {
      const matches = await this.readAllByIndexValidated(
        LOGICAL_BOOKS_STORE,
        index,
        variantId,
        isLogicalBookRecord,
        'Logical book failed membership or schema validation',
      );
      if (matches.length > 0) return matches[0];
    }
    return null;
  }

  async getLogicalBookCover(
    logicalBookId: LogicalBookId,
  ): Promise<Blob | null> {
    const stored = await this.readValidated(
      LOGICAL_BOOK_COVERS_STORE,
      logicalBookId,
      (value): value is StoredLogicalCoverBytes | StoredLogicalCoverBlob =>
        isRecord(value) &&
        value['logicalBookId'] === logicalBookId &&
        (value['blob'] instanceof Blob ||
          (typeof value['mediaType'] === 'string' &&
            value['mediaType'].length > 0 &&
            asArrayBuffer(value['bytes']) !== null)),
      'Logical book cover failed identity or schema validation',
    );
    if (!stored) return null;
    if ('blob' in stored) return stored.blob;
    return new Blob([stored.bytes], { type: stored.mediaType });
  }

  getLogicalBookFormatPreference(
    logicalBookId: LogicalBookId,
  ): Promise<LogicalBookFormatPreference | null> {
    return this.readValidated(
      LOGICAL_BOOK_PREFERENCES_STORE,
      logicalBookId,
      (value): value is LogicalBookFormatPreference =>
        isLogicalBookFormatPreference(value) &&
        value.logicalBookId === logicalBookId,
      'Logical book preference failed identity or schema validation',
    );
  }

  async listOpenMembershipReconciliations(): Promise<
    readonly MembershipReconciliation[]
  > {
    const records = await this.readAllValidated(
      LOGICAL_BOOK_RECONCILIATIONS_STORE,
      isMembershipReconciliation,
      'Membership reconciliation failed schema validation',
    );
    return records
      .filter((record) => record.status === 'open')
      .sort((left, right) => left.conflictId.localeCompare(right.conflictId));
  }

  async getLogicalLibrarySnapshot(): Promise<LogicalLibrarySnapshot> {
    const database = await this.database();
    const transaction = database.transaction(
      [
        LOGICAL_BOOKS_STORE,
        LOGICAL_BOOK_PREFERENCES_STORE,
        LOGICAL_BOOK_RECONCILIATIONS_STORE,
      ],
      'readonly',
    );
    const [rawBooks, rawPreferences, rawReconciliations] = await Promise.all([
      idbRequest(transaction.objectStore(LOGICAL_BOOKS_STORE).getAll()),
      idbRequest(
        transaction.objectStore(LOGICAL_BOOK_PREFERENCES_STORE).getAll(),
      ),
      idbRequest(
        transaction.objectStore(LOGICAL_BOOK_RECONCILIATIONS_STORE).getAll(),
      ),
    ]);
    await idbTransactionComplete(transaction);
    const logicalBooks = rawBooks
      .filter(isLogicalBookRecord)
      .sort((left, right) => left.id.localeCompare(right.id));
    const preferences = rawPreferences
      .filter(isLogicalBookFormatPreference)
      .sort((left, right) =>
        left.logicalBookId.localeCompare(right.logicalBookId),
      );
    const reconciliations = rawReconciliations
      .filter(isMembershipReconciliation)
      .sort((left, right) => left.conflictId.localeCompare(right.conflictId));
    return {
      revision: JSON.stringify({ logicalBooks, preferences, reconciliations }),
      logicalBooks,
      preferences,
      reconciliations,
    };
  }

  async replaceLogicalBookState(
    logicalBooks: readonly LogicalBookRecord[],
    preferences: readonly LogicalBookFormatPreference[],
    reconciliations: readonly MembershipReconciliation[],
    covers?: ReadonlyMap<LogicalBookId, Blob>,
  ): Promise<void> {
    if (
      !logicalBooks.every(isLogicalBookRecord) ||
      !preferences.every(isLogicalBookFormatPreference) ||
      !reconciliations.every(isMembershipReconciliation)
    ) {
      throw new TypeError('Synchronized logical-book state is invalid');
    }
    const variants = new Set<string>();
    const logicalBookIds = new Set(logicalBooks.map((book) => book.id));
    for (const logicalBook of logicalBooks) {
      for (const [format, variantId] of Object.entries(
        logicalBook.variants,
      ) as [PublicationFormat, string][]) {
        if (variants.has(variantId))
          throw new Error('A variant has multiple owners');
        const variant = await this.getBook(variantId);
        if (!variant || variant.format !== format) {
          throw new Error(
            'Synchronized membership references a missing variant',
          );
        }
        variants.add(variantId);
      }
    }
    const storedCovers = await Promise.all(
      [...(covers ?? new Map<LogicalBookId, Blob>())].map(
        async ([logicalBookId, cover]) => {
          if (!logicalBookIds.has(logicalBookId)) {
            throw new Error('A logical cover has no owning book');
          }
          return {
            logicalBookId,
            mediaType: cover.type || 'application/octet-stream',
            bytes: await blobBytes(cover),
          } satisfies StoredLogicalCoverBytes;
        },
      ),
    );
    await this.writeTransaction(
      [
        LOGICAL_BOOKS_STORE,
        LOGICAL_BOOK_COVERS_STORE,
        LOGICAL_BOOK_PREFERENCES_STORE,
        LOGICAL_BOOK_RECONCILIATIONS_STORE,
      ],
      (transaction) => {
        const booksStore = transaction.objectStore(LOGICAL_BOOKS_STORE);
        const preferencesStore = transaction.objectStore(
          LOGICAL_BOOK_PREFERENCES_STORE,
        );
        const reconciliationsStore = transaction.objectStore(
          LOGICAL_BOOK_RECONCILIATIONS_STORE,
        );
        const coversStore = transaction.objectStore(LOGICAL_BOOK_COVERS_STORE);
        booksStore.clear();
        if (covers) coversStore.clear();
        preferencesStore.clear();
        reconciliationsStore.clear();
        logicalBooks.forEach((book) => booksStore.put(book));
        if (covers) storedCovers.forEach((cover) => coversStore.put(cover));
        preferences.forEach((preference) => preferencesStore.put(preference));
        reconciliations.forEach((reconciliation) =>
          reconciliationsStore.put(reconciliation),
        );
      },
    );
  }

  async addVariant(
    logicalBookId: LogicalBookId,
    variant: BookRecord,
    source: BookSource,
    mutationIdentity: LogicalMutationIdentity,
    cover?: Blob,
  ): Promise<AddLogicalBookVariantResult> {
    if (!isBookRecord(variant)) {
      throw new TypeError('Candidate publication metadata is invalid');
    }
    const destination = await this.getLogicalBook(logicalBookId);
    if (!destination) {
      throw new Error(`Logical book "${logicalBookId}" was not found`);
    }
    const owner = await this.findLogicalBookByVariant(variant.id);
    if (owner?.id === logicalBookId) {
      return { status: 'already-member', logicalBookId };
    }
    if (owner) {
      return { status: 'belongs-to-other-book', logicalBookId: owner.id };
    }
    const occupied = destination.variants[variant.format];
    if (occupied) {
      return {
        status: 'same-format-conflict',
        logicalBookId,
        existingVariantId: occupied,
      };
    }

    const opened = await source.open();
    const blob = opened instanceof Blob ? opened : new Blob([opened]);
    if (
      source.size !== blob.size ||
      variant.size !== blob.size ||
      (await detectPublicationBlobFormat(blob)) !== variant.format ||
      (await this.fingerprinter(blob)) !== variant.id
    ) {
      throw new Error('Candidate publication failed exact-source validation');
    }
    const staged = await this.binaryStorage.save({
      bookId: variant.id,
      format: variant.format,
      fileName: variant.fileName,
      mediaType: variant.mediaType,
      blob,
    });
    const storedCover = cover
      ? {
          bookId: variant.id,
          mediaType: cover.type,
          bytes: await blobBytes(cover),
        }
      : null;
    const updated: LogicalBookRecord = {
      ...destination,
      variants: { ...destination.variants, [variant.format]: variant.id },
      updatedAt: mutationIdentity.createdAt,
    };
    const change = {
      ...logicalChange('add-variant', mutationIdentity, [updated], []),
      variantEffects: [
        {
          operation: 'upsert' as const,
          variant,
          objectPath: `.omnia-reader/v1/books/${variant.id.slice(
            'sha256:'.length,
          )}/publication.${variant.format}`,
        },
      ],
    };
    try {
      const database = await this.database();
      const transaction = database.transaction(
        storedCover
          ? [BOOKS_STORE, BINARIES_STORE, COVERS_STORE, LOGICAL_BOOKS_STORE]
          : [BOOKS_STORE, BINARIES_STORE, LOGICAL_BOOKS_STORE],
        'readwrite',
      );
      const completion = idbTransactionComplete(transaction);
      const current = await idbRequest<unknown>(
        transaction.objectStore(LOGICAL_BOOKS_STORE).get(logicalBookId),
      );
      if (
        !isLogicalBookRecord(current) ||
        JSON.stringify(current) !== JSON.stringify(destination)
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error('Logical book changed before add-format commit');
      }
      transaction.objectStore(BOOKS_STORE).add(variant);
      transaction.objectStore(BINARIES_STORE).add(staged);
      if (storedCover) transaction.objectStore(COVERS_STORE).add(storedCover);
      transaction.objectStore(LOGICAL_BOOKS_STORE).put(updated);
      await completion;
    } catch (error) {
      await this.binaryStorage.remove(staged);
      throw error;
    }
    return {
      status: 'added',
      mutation: {
        createdLogicalBookIds: [],
        updatedLogicalBookIds: [logicalBookId],
        deletedLogicalBookIds: [],
        createdVariantIds: [variant.id],
        deletedVariantIds: [],
        resultingBooks: [updated],
        change,
      },
    };
  }

  async associate(
    destinationLogicalBookId: LogicalBookId,
    sourceLogicalBookId: LogicalBookId,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    if (destinationLogicalBookId === sourceLogicalBookId) {
      throw new Error('A logical book cannot be associated with itself');
    }
    const [destination, source] = await Promise.all([
      this.getLogicalBook(destinationLogicalBookId),
      this.getLogicalBook(sourceLogicalBookId),
    ]);
    if (!destination || !source) {
      throw new Error('One of the selected logical books was not found');
    }
    for (const format of ['epub', 'pdf'] as const) {
      if (destination.variants[format] && source.variants[format]) {
        throw new Error(
          `Both logical books already contain a ${format.toUpperCase()} variant`,
        );
      }
    }
    const updated: LogicalBookRecord = {
      ...destination,
      variants: { ...destination.variants, ...source.variants },
      updatedAt: mutationIdentity.createdAt,
    };
    const change = logicalChange(
      'associate',
      mutationIdentity,
      [updated],
      [sourceLogicalBookId],
    );
    const database = await this.database();
    const transaction = database.transaction(
      [
        LOGICAL_BOOKS_STORE,
        LOGICAL_BOOK_COVERS_STORE,
        LOGICAL_BOOK_PREFERENCES_STORE,
      ],
      'readwrite',
    );
    const completion = idbTransactionComplete(transaction);
    const store = transaction.objectStore(LOGICAL_BOOKS_STORE);
    const [currentDestination, currentSource] = await Promise.all([
      idbRequest<unknown>(store.get(destinationLogicalBookId)),
      idbRequest<unknown>(store.get(sourceLogicalBookId)),
    ]);
    if (
      JSON.stringify(currentDestination) !== JSON.stringify(destination) ||
      JSON.stringify(currentSource) !== JSON.stringify(source)
    ) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw new Error('Logical membership changed before association commit');
    }
    store.delete(sourceLogicalBookId);
    store.put(updated);
    transaction
      .objectStore(LOGICAL_BOOK_COVERS_STORE)
      .delete(sourceLogicalBookId);
    transaction
      .objectStore(LOGICAL_BOOK_PREFERENCES_STORE)
      .delete(sourceLogicalBookId);
    await completion;
    return {
      createdLogicalBookIds: [],
      updatedLogicalBookIds: [destinationLogicalBookId],
      deletedLogicalBookIds: [sourceLogicalBookId],
      createdVariantIds: [],
      deletedVariantIds: [],
      resultingBooks: [updated],
      change,
    };
  }

  async detachVariant(
    logicalBookId: LogicalBookId,
    variantId: string,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    const [logicalBook, variant, preference, variantCover] = await Promise.all([
      this.getLogicalBook(logicalBookId),
      this.getBook(variantId),
      this.getLogicalBookFormatPreference(logicalBookId),
      this.getBookCover(variantId),
    ]);
    if (!logicalBook || !variant)
      throw new Error('Logical book or variant was not found');
    if (Object.keys(logicalBook.variants).length !== 2) {
      throw new Error('Only a two-format logical book can be detached');
    }
    if (logicalBook.variants[variant.format] !== variantId) {
      throw new Error('The selected variant is not a current member');
    }
    const remainingFormat: PublicationFormat =
      variant.format === 'epub' ? 'pdf' : 'epub';
    const remainingVariantId = logicalBook.variants[remainingFormat];
    if (!remainingVariantId)
      throw new Error('Detach would create an empty logical book');
    const canonicalId = singletonLogicalBookId(variantId);
    const canonicalOwner = await this.getLogicalBook(canonicalId);
    const detachedId =
      canonicalId !== logicalBookId && !canonicalOwner
        ? canonicalId
        : await derivedLogicalBookId(variantId, mutationIdentity.changeId);
    const updated: LogicalBookRecord = {
      ...logicalBook,
      variants: { [remainingFormat]: remainingVariantId },
      updatedAt: mutationIdentity.createdAt,
    };
    const detached: LogicalBookRecord = {
      ...logicalBookFromVariant(variant, mutationIdentity.createdAt),
      id: detachedId,
    };
    const detachedCover = variantCover
      ? {
          logicalBookId: detachedId,
          mediaType: variantCover.type,
          bytes: await blobBytes(variantCover),
        }
      : null;
    const updatedPreference =
      preference?.preferredFormat === variant.format
        ? ({
            ...preference,
            preferredFormat: remainingFormat,
            winningChangeId: mutationIdentity.changeId,
            preferenceHeads: [mutationIdentity.changeId],
            updatedAt: mutationIdentity.createdAt,
            deviceId: mutationIdentity.deviceId,
          } satisfies LogicalBookFormatPreference)
        : preference;
    const change = logicalChange(
      'detach',
      mutationIdentity,
      [updated, detached],
      [],
    );
    await this.writeTransaction(
      [
        LOGICAL_BOOKS_STORE,
        LOGICAL_BOOK_COVERS_STORE,
        LOGICAL_BOOK_PREFERENCES_STORE,
      ],
      (transaction) => {
        transaction.objectStore(LOGICAL_BOOKS_STORE).put(updated);
        transaction.objectStore(LOGICAL_BOOKS_STORE).add(detached);
        if (detachedCover) {
          transaction.objectStore(LOGICAL_BOOK_COVERS_STORE).put(detachedCover);
        }
        if (updatedPreference) {
          transaction
            .objectStore(LOGICAL_BOOK_PREFERENCES_STORE)
            .put(updatedPreference);
        }
      },
    );
    return {
      createdLogicalBookIds: [detachedId],
      updatedLogicalBookIds: [logicalBookId],
      deletedLogicalBookIds: [],
      createdVariantIds: [],
      deletedVariantIds: [],
      resultingBooks: [updated, detached],
      change,
    };
  }

  async deleteVariant(
    logicalBookId: LogicalBookId,
    variantId: string | null,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    const logicalBook = await this.getLogicalBook(logicalBookId);
    if (!logicalBook)
      throw new Error(`Logical book "${logicalBookId}" was not found`);
    const members = Object.values(logicalBook.variants).filter(
      (id): id is string => !!id,
    );
    const targets = variantId === null ? members : [variantId];
    if (targets.some((target) => !members.includes(target))) {
      throw new Error('The selected variant is not a current member');
    }
    const cleanup = await Promise.all(
      targets.map(async (target) => ({
        target,
        stored: await this.getStoredBinary(target),
        progressDocuments: await this.listProgressDocuments(target),
        bookmarks: await this.listBookmarks(target, true),
        annotations: await this.listAnnotations(target, true),
      })),
    );
    const remainingEntries = Object.entries(logicalBook.variants).filter(
      ([, id]) => !!id && !targets.includes(id),
    ) as [PublicationFormat, string][];
    const remaining = Object.fromEntries(remainingEntries) as Partial<
      Record<PublicationFormat, string>
    >;
    const updated =
      remainingEntries.length > 0
        ? ({
            ...logicalBook,
            variants: remaining,
            updatedAt: mutationIdentity.createdAt,
          } satisfies LogicalBookRecord)
        : null;
    const preference = await this.getLogicalBookFormatPreference(logicalBookId);
    const remainingFormat = remainingEntries[0]?.[0];
    const change = {
      ...logicalChange(
        updated ? 'delete-variant' : 'delete-book',
        mutationIdentity,
        updated ? [updated] : [],
        updated ? [] : [logicalBookId],
      ),
      variantEffects: targets.map((target) => {
        const format: PublicationFormat =
          logicalBook.variants.epub === target ? 'epub' : 'pdf';
        return { operation: 'delete' as const, variantId: target, format };
      }),
    };
    await this.writeTransaction(
      [
        BOOKS_STORE,
        BINARIES_STORE,
        COVERS_STORE,
        PROGRESS_STORE,
        PROGRESS_DOCUMENTS_STORE,
        BOOKMARKS_STORE,
        ANNOTATIONS_STORE,
        LOGICAL_BOOKS_STORE,
        LOGICAL_BOOK_COVERS_STORE,
        LOGICAL_BOOK_PREFERENCES_STORE,
      ],
      (transaction) => {
        for (const item of cleanup) {
          transaction.objectStore(BOOKS_STORE).delete(item.target);
          transaction.objectStore(BINARIES_STORE).delete(item.target);
          transaction.objectStore(COVERS_STORE).delete(item.target);
          transaction.objectStore(PROGRESS_STORE).delete(item.target);
          for (const progress of item.progressDocuments) {
            transaction
              .objectStore(PROGRESS_DOCUMENTS_STORE)
              .delete([progress.bookId, progress.deviceId]);
          }
          for (const bookmark of item.bookmarks) {
            transaction.objectStore(BOOKMARKS_STORE).delete(bookmark.id);
          }
          for (const annotation of item.annotations) {
            transaction.objectStore(ANNOTATIONS_STORE).delete(annotation.id);
          }
        }
        if (updated) {
          transaction.objectStore(LOGICAL_BOOKS_STORE).put(updated);
          if (
            preference &&
            remainingFormat &&
            preference.preferredFormat !== remainingFormat
          ) {
            transaction.objectStore(LOGICAL_BOOK_PREFERENCES_STORE).put({
              ...preference,
              preferredFormat: remainingFormat,
              winningChangeId: mutationIdentity.changeId,
              preferenceHeads: [mutationIdentity.changeId],
              updatedAt: mutationIdentity.createdAt,
              deviceId: mutationIdentity.deviceId,
            } satisfies LogicalBookFormatPreference);
          }
        } else {
          transaction.objectStore(LOGICAL_BOOKS_STORE).delete(logicalBookId);
          transaction
            .objectStore(LOGICAL_BOOK_COVERS_STORE)
            .delete(logicalBookId);
          transaction
            .objectStore(LOGICAL_BOOK_PREFERENCES_STORE)
            .delete(logicalBookId);
        }
      },
    );
    await Promise.all(
      cleanup.map((item) =>
        item.stored
          ? this.binaryStorage.remove(item.stored).catch(() => undefined)
          : Promise.resolve(),
      ),
    );
    return {
      createdLogicalBookIds: [],
      updatedLogicalBookIds: updated ? [logicalBookId] : [],
      deletedLogicalBookIds: updated ? [] : [logicalBookId],
      createdVariantIds: [],
      deletedVariantIds: targets,
      resultingBooks: updated ? [updated] : [],
      change,
    };
  }

  async saveLogicalBookFormatPreference(
    logicalBookId: LogicalBookId,
    preferredFormat: PublicationFormat,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookChange | null> {
    const logicalBook = await this.getLogicalBook(logicalBookId);
    if (!logicalBook || !logicalBook.variants[preferredFormat]) {
      throw new Error('Preferred format is not a current logical-book member');
    }
    const current = await this.getLogicalBookFormatPreference(logicalBookId);
    if (current?.preferredFormat === preferredFormat) return null;
    const preference: LogicalBookFormatPreference = {
      schemaVersion: 1,
      logicalBookId,
      preferredFormat,
      winningChangeId: mutationIdentity.changeId,
      preferenceHeads: [mutationIdentity.changeId],
      updatedAt: mutationIdentity.createdAt,
      deviceId: mutationIdentity.deviceId,
    };
    const change = {
      ...logicalChange(
        'preference',
        {
          ...mutationIdentity,
          parents: [
            ...new Set([
              ...mutationIdentity.parents,
              ...(current?.preferenceHeads ?? []),
            ]),
          ].sort(),
        },
        [],
        [],
      ),
      preferenceEffects: [{ logicalBookId, preference }],
    };
    await this.write(LOGICAL_BOOK_PREFERENCES_STORE, preference);
    return change;
  }

  async reconcileMembership(
    conflictId: string,
    decision: MembershipReconciliationDecision,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult> {
    const raw = await this.read<unknown>(
      LOGICAL_BOOK_RECONCILIATIONS_STORE,
      conflictId,
    );
    if (!isMembershipReconciliation(raw) || raw.status !== 'open') {
      throw new Error('Membership reconciliation is no longer open');
    }
    const before = await this.listLogicalBooks();
    const books = new Map(
      before.map((book) => [
        book.id,
        { ...book, variants: { ...book.variants } },
      ]),
    );
    let selected = raw.acceptedMembership;
    if (decision.kind === 'accept-rejected') {
      selected = raw.rejectedMembership.filter(
        (membership) => membership.logicalBookId === decision.logicalBookId,
      );
      if (selected.length === 0)
        throw new Error('The selected competing membership is stale');
    }
    if (decision.kind === 'make-standalone') {
      const variant = await this.getBook(decision.variantId);
      if (!variant || !raw.affectedVariantIds.includes(variant.id)) {
        throw new Error('The selected variant is not part of this conflict');
      }
      const canonical = singletonLogicalBookId(variant.id);
      const id = books.has(canonical)
        ? await derivedLogicalBookId(variant.id, mutationIdentity.changeId)
        : canonical;
      selected = [
        ...raw.acceptedMembership.filter(
          (membership) => membership.variantId !== variant.id,
        ),
        { logicalBookId: id, format: variant.format, variantId: variant.id },
      ];
      books.set(id, {
        ...logicalBookFromVariant(variant, mutationIdentity.createdAt),
        id,
      });
    }
    for (const variantId of raw.affectedVariantIds) {
      for (const [id, book] of books) {
        const variants = { ...book.variants };
        if (variants.epub === variantId) delete variants.epub;
        if (variants.pdf === variantId) delete variants.pdf;
        if (!variants.epub && !variants.pdf) books.delete(id);
        else
          books.set(id, {
            ...book,
            variants,
            updatedAt: mutationIdentity.createdAt,
          });
      }
    }
    for (const membership of selected) {
      const variant = await this.getBook(membership.variantId);
      if (!variant || variant.format !== membership.format) {
        throw new Error('Reconciliation references an invalid variant');
      }
      const current = books.get(membership.logicalBookId);
      if (current) {
        const occupied = current.variants[membership.format];
        if (occupied && occupied !== membership.variantId) {
          throw new Error('Reconciliation would violate format cardinality');
        }
        books.set(membership.logicalBookId, {
          ...current,
          variants: {
            ...current.variants,
            [membership.format]: membership.variantId,
          },
          updatedAt: mutationIdentity.createdAt,
        });
      } else {
        books.set(membership.logicalBookId, {
          ...logicalBookFromVariant(variant, mutationIdentity.createdAt),
          id: membership.logicalBookId,
        });
      }
    }
    const after = [...books.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const resolved: MembershipReconciliation = {
      ...raw,
      status: 'resolved',
      resolvedByChangeId: mutationIdentity.changeId,
    };
    const beforeIds = new Set(before.map((book) => book.id));
    const afterIds = new Set(after.map((book) => book.id));
    const created = [...afterIds].filter((id) => !beforeIds.has(id));
    const deleted = [...beforeIds].filter((id) => !afterIds.has(id));
    const updated = [...afterIds].filter((id) => beforeIds.has(id));
    const change = {
      ...logicalChange(
        'reconcile-membership',
        mutationIdentity,
        after,
        deleted,
      ),
      resolvesConflictIds: [conflictId],
    };
    const preferencesToDelete = (
      await this.getLogicalLibrarySnapshot()
    ).preferences
      .filter(
        (preference) =>
          !books.get(preference.logicalBookId)?.variants[
            preference.preferredFormat
          ],
      )
      .map((preference) => preference.logicalBookId);
    await this.writeTransaction(
      [
        LOGICAL_BOOKS_STORE,
        LOGICAL_BOOK_PREFERENCES_STORE,
        LOGICAL_BOOK_RECONCILIATIONS_STORE,
      ],
      (transaction) => {
        const booksStore = transaction.objectStore(LOGICAL_BOOKS_STORE);
        booksStore.clear();
        after.forEach((book) => booksStore.put(book));
        transaction
          .objectStore(LOGICAL_BOOK_RECONCILIATIONS_STORE)
          .put(resolved);
        for (const logicalBookId of preferencesToDelete) {
          transaction
            .objectStore(LOGICAL_BOOK_PREFERENCES_STORE)
            .delete(logicalBookId);
        }
      },
    );
    return {
      createdLogicalBookIds: created,
      updatedLogicalBookIds: updated,
      deletedLogicalBookIds: deleted,
      createdVariantIds: [],
      deletedVariantIds: [],
      resultingBooks: after,
      change,
    };
  }

  async resolveVariantAvailability(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, VariantAvailability>> {
    const result = new Map<string, VariantAvailability>();
    for (const variantId of [...new Set(variantIds)]) {
      const book = await this.getBook(variantId);
      if (!book) {
        result.set(variantId, {
          status: 'quarantined',
          cause: 'malformed-reference',
        });
        continue;
      }
      const raw = await this.read<unknown>(BINARIES_STORE, variantId);
      if (raw === null) {
        result.set(variantId, { status: 'unavailable', cause: 'missing' });
        continue;
      }
      const stored = parseStoredPublicationBinary(raw);
      if (!stored || stored.bookId !== variantId) {
        await this.quarantineStoredBinary(
          variantId,
          'Publication binary reference failed identity or schema validation',
        );
        result.set(variantId, {
          status: 'quarantined',
          cause: 'malformed-reference',
        });
        continue;
      }
      result.set(variantId, { status: 'checking' });
    }
    return result;
  }

  async openHealthyVariant(variantId: string): Promise<
    | { availability: { status: 'healthy' }; source: BookSource }
    | {
        availability: Exclude<VariantAvailability, { status: 'healthy' }>;
      }
  > {
    const book = await this.getBook(variantId);
    if (!book) {
      return {
        availability: { status: 'quarantined', cause: 'malformed-reference' },
      };
    }
    const raw = await this.read<unknown>(BINARIES_STORE, variantId);
    if (raw === null) {
      return { availability: { status: 'unavailable', cause: 'missing' } };
    }
    const stored = parseStoredPublicationBinary(raw);
    if (!stored || stored.bookId !== variantId) {
      await this.quarantineStoredBinary(
        variantId,
        'Publication binary reference failed identity or schema validation',
      );
      return {
        availability: { status: 'quarantined', cause: 'malformed-reference' },
      };
    }
    const blob = await this.binaryStorage.open(stored);
    if (!blob) {
      return {
        availability: {
          status: 'unavailable',
          cause: stored.storage === 'opfs' ? 'evicted' : 'inaccessible',
        },
      };
    }
    if (blob.size !== book.size) {
      return { availability: { status: 'unavailable', cause: 'incomplete' } };
    }
    const format = await detectPublicationBlobFormat(blob);
    if (format !== book.format) {
      await this.quarantineStoredBinary(
        variantId,
        'Publication format mismatch',
      );
      return { availability: { status: 'quarantined', cause: 'unsupported' } };
    }
    if ((await this.fingerprinter(blob)) !== book.id) {
      await this.quarantineStoredBinary(
        variantId,
        'Publication digest mismatch',
      );
      return {
        availability: { status: 'quarantined', cause: 'integrity-invalid' },
      };
    }
    const migrated = await this.binaryStorage.migrate(stored, book.format);
    if (migrated !== stored) {
      try {
        await this.write(BINARIES_STORE, migrated);
      } catch {
        await this.binaryStorage.remove(migrated);
      }
    }
    return {
      availability: { status: 'healthy' },
      source: new StoredBookSource(stored.fileName, stored.mediaType, blob),
    };
  }

  async replaceVariantSource(
    variantId: string,
    source: BookSource,
  ): Promise<void> {
    const book = await this.getBook(variantId);
    if (!book) throw new Error(`Book "${variantId}" was not found`);
    const opened = await source.open();
    const blob = opened instanceof Blob ? opened : new Blob([opened]);
    const format = await detectPublicationBlobFormat(blob);
    if (
      blob.size !== book.size ||
      format !== book.format ||
      (await this.fingerprinter(blob)) !== book.id
    ) {
      throw new Error('Replacement publication failed exact-source validation');
    }
    await this.replaceStoredBinary(book, blob, source.name, source.mediaType);
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
      const logicalBook = logicalBookFromVariant(record);
      await this.writeTransaction(
        [BOOKS_STORE, BINARIES_STORE, LOGICAL_BOOKS_STORE],
        (transaction) => {
          transaction.objectStore(BOOKS_STORE).put(record);
          transaction.objectStore(BINARIES_STORE).put(binary);
          transaction.objectStore(LOGICAL_BOOKS_STORE).put(logicalBook);
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
        existing
          ? [BINARIES_STORE]
          : [BOOKS_STORE, BINARIES_STORE, LOGICAL_BOOKS_STORE],
        (transaction) => {
          if (!existing) {
            transaction.objectStore(BOOKS_STORE).put(book);
            transaction
              .objectStore(LOGICAL_BOOKS_STORE)
              .put(logicalBookFromVariant(book));
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
    const owner = await this.findLogicalBookByVariant(bookId);
    const updateLogicalCatalog =
      !!owner && Object.keys(owner.variants).length === 1;

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
    const storeNames: ActiveLibraryStore[] = [BOOKS_STORE];
    if (metadata.cover) storeNames.push(COVERS_STORE);
    if (updateLogicalCatalog) storeNames.push(LOGICAL_BOOKS_STORE);
    if (metadata.cover && owner) storeNames.push(LOGICAL_BOOK_COVERS_STORE);
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
        if (owner) {
          transaction.objectStore(LOGICAL_BOOK_COVERS_STORE).put({
            logicalBookId: owner.id,
            mediaType: storedCover.mediaType,
            bytes: storedCover.bytes,
          } satisfies StoredLogicalCoverBytes);
        }
      }
      if (updateLogicalCatalog && owner) {
        transaction.objectStore(LOGICAL_BOOKS_STORE).put({
          ...owner,
          title: updated.title,
          authors: updated.authors,
          language: updated.language,
          publisher: updated.publisher,
          identifier: updated.identifier,
          coverState: updated.coverState ?? owner.coverState,
          updatedAt: new Date().toISOString(),
        } satisfies LogicalBookRecord);
      }
    });
    return updated;
  }

  async removeBook(bookId: string): Promise<void> {
    const [stored, progressDocuments, bookmarks, annotations, owner] =
      await Promise.all([
        this.getStoredBinary(bookId),
        this.listProgressDocuments(bookId),
        this.listBookmarks(bookId, true),
        this.listAnnotations(bookId, true),
        this.findLogicalBookByVariant(bookId),
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
        LOGICAL_BOOKS_STORE,
        LOGICAL_BOOK_COVERS_STORE,
        LOGICAL_BOOK_PREFERENCES_STORE,
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
        if (owner) {
          const variants = { ...owner.variants };
          if (variants.epub === bookId) delete variants.epub;
          if (variants.pdf === bookId) delete variants.pdf;
          if (variants.epub || variants.pdf) {
            transaction.objectStore(LOGICAL_BOOKS_STORE).put({
              ...owner,
              variants,
              updatedAt: new Date().toISOString(),
            } satisfies LogicalBookRecord);
          } else {
            transaction.objectStore(LOGICAL_BOOKS_STORE).delete(owner.id);
            transaction.objectStore(LOGICAL_BOOK_COVERS_STORE).delete(owner.id);
            transaction
              .objectStore(LOGICAL_BOOK_PREFERENCES_STORE)
              .delete(owner.id);
          }
        }
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
        const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
        request.addEventListener('upgradeneeded', (event) => {
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
          if (!database.objectStoreNames.contains(LOGICAL_BOOKS_STORE)) {
            const store = database.createObjectStore(LOGICAL_BOOKS_STORE, {
              keyPath: 'id',
            });
            store.createIndex(LOGICAL_BOOK_EPUB_INDEX, 'variants.epub', {
              unique: true,
            });
            store.createIndex(LOGICAL_BOOK_PDF_INDEX, 'variants.pdf', {
              unique: true,
            });
          }
          if (!database.objectStoreNames.contains(LOGICAL_BOOK_COVERS_STORE)) {
            database.createObjectStore(LOGICAL_BOOK_COVERS_STORE, {
              keyPath: 'logicalBookId',
            });
          }
          if (
            !database.objectStoreNames.contains(LOGICAL_BOOK_PREFERENCES_STORE)
          ) {
            database.createObjectStore(LOGICAL_BOOK_PREFERENCES_STORE, {
              keyPath: 'logicalBookId',
            });
          }
          if (
            !database.objectStoreNames.contains(
              LOGICAL_BOOK_RECONCILIATIONS_STORE,
            )
          ) {
            database.createObjectStore(LOGICAL_BOOK_RECONCILIATIONS_STORE, {
              keyPath: 'conflictId',
            });
          }
          if (
            (event as IDBVersionChangeEvent).oldVersion < 9 &&
            request.transaction
          ) {
            this.migrateSingletonLogicalBooks(request.transaction);
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

  private migrateSingletonLogicalBooks(transaction: IDBTransaction): void {
    const books = transaction.objectStore(BOOKS_STORE);
    const logicalBooks = transaction.objectStore(LOGICAL_BOOKS_STORE);
    const quarantine = transaction.objectStore(QUARANTINE_STORE);
    const covers = transaction.objectStore(COVERS_STORE);
    const logicalCovers = transaction.objectStore(LOGICAL_BOOK_COVERS_STORE);
    const cursorRequest = books.openCursor();
    cursorRequest.addEventListener('success', () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const value = cursor.value as unknown;
      if (!isBookRecord(value)) {
        quarantine.add({
          storeName: BOOKS_STORE,
          recordKey: cursor.primaryKey,
          value,
          reason: 'Book metadata failed schema validation during v9 migration',
          quarantinedAt: new Date().toISOString(),
        } satisfies QuarantinedLibraryRecord);
        cursor.delete();
        cursor.continue();
        return;
      }

      const logicalBook = logicalBookFromVariant(value);
      logicalBooks.put(logicalBook);
      const coverRequest = covers.get(value.id);
      coverRequest.addEventListener('success', () => {
        const cover = coverRequest.result as unknown;
        if (cover !== undefined && isStoredCover(cover, value.id)) {
          const legacy = cover as Partial<LegacyStoredCover>;
          if (legacy.blob instanceof Blob) {
            logicalCovers.put({
              logicalBookId: logicalBook.id,
              blob: legacy.blob,
            } satisfies StoredLogicalCoverBlob);
          } else {
            const current = cover as Partial<StoredCoverBytes>;
            const bytes = asArrayBuffer(current.bytes);
            if (bytes && typeof current.mediaType === 'string') {
              logicalCovers.put({
                logicalBookId: logicalBook.id,
                mediaType: current.mediaType,
                bytes,
              } satisfies StoredLogicalCoverBytes);
            }
          }
        }
      });
      cursor.continue();
    });
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
    fileName = book.fileName,
    mediaType = book.mediaType,
  ): Promise<void> {
    const replacement = await this.binaryStorage.save({
      bookId: book.id,
      format: book.format,
      fileName,
      mediaType,
      blob,
    });
    try {
      await this.write(BINARIES_STORE, replacement);
    } catch (error) {
      await this.binaryStorage.remove(replacement);
      throw error;
    }
  }

  private async quarantineStoredBinary(
    bookId: string,
    reason: string,
  ): Promise<void> {
    await this.quarantineInvalidRecord(
      BINARIES_STORE,
      bookId,
      (_candidate): _candidate is never => false,
      reason,
    );
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

async function detectPublicationBlobFormat(
  blob: Blob,
): Promise<PublicationFormat | null> {
  const bytes = new Uint8Array(
    await blobBytes(blob),
    0,
    Math.min(5, blob.size),
  );
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'pdf';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  ) {
    return 'epub';
  }
  return null;
}

function logicalChange(
  kind: LogicalBookChange['kind'],
  identity: LogicalMutationIdentity,
  resultingBooks: LogicalBookRecord[],
  removedLogicalBookIds: LogicalBookId[],
): LogicalBookChange {
  return {
    schemaVersion: 1,
    changeId: identity.changeId,
    kind,
    parents: [...identity.parents].sort(),
    resultingBooks,
    removedLogicalBookIds,
    createdAt: identity.createdAt,
    deviceId: identity.deviceId,
    appVersion: identity.appVersion,
  };
}

async function derivedLogicalBookId(
  variantId: string,
  changeId: string,
): Promise<LogicalBookId> {
  const bytes = new TextEncoder().encode(
    `omnia-logical:${variantId}:${changeId}`,
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `logical:sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('IndexedDB request failed')),
    );
  });
}

function idbTransactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
    );
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed')),
    );
  });
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
