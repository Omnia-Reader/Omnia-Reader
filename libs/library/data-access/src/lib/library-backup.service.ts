import { Inject, Injectable, InjectionToken } from '@angular/core';
import {
  BookRecord,
  BookSource,
  isBookRecord,
  isPublicationAnnotation,
  isPublicationBookmark,
  isReaderPreferences,
  isReadingProgress,
  LibraryRepository,
  preferredAnnotation,
  preferredBookmark,
  ProgressDocumentRepository,
  PublicationAnnotation,
  PublicationBookmark,
  PublicationFormat,
  ReaderPreferences,
  ReadingProgress,
} from '@omnia-reader/reader/domain';
import type { Entry, FileEntry } from '@zip.js/zip.js';
import { LIBRARY_REPOSITORY } from './library-repository.token';
import { publicationFingerprint } from './publication-fingerprint';

export const LIBRARY_BACKUP_MEDIA_TYPE =
  'application/vnd.omnia-reader.backup+zip';
const MANIFEST_PATH = 'manifest.json';
const MAX_MANIFEST_SIZE = 2 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_001;
const MAX_BOOKS = 10_000;
const MAX_PROGRESS_DOCUMENTS = 50_000;
const MAX_BOOKMARKS = 50_000;
const MAX_ANNOTATIONS = 50_000;
const MAX_TOTAL_UNCOMPRESSED_SIZE = 50 * 1024 * 1024 * 1024;

export const LIBRARY_BACKUP_FINGERPRINTER = new InjectionToken<
  (blob: Blob) => Promise<string>
>('LIBRARY_BACKUP_FINGERPRINTER', {
  factory: () => publicationFingerprint,
});

export interface LibraryBackupExport {
  blob: Blob;
  fileName: string;
  bookCount: number;
}

export interface LibraryBackupExportSummary {
  fileName: string;
  bookCount: number;
}

export interface LibraryBackupExportProgress {
  completedBooks: number;
  totalBooks: number;
  processedBytes: number;
  totalBytes: number;
}

export interface LibraryBackupExportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LibraryBackupExportProgress) => void;
}

export interface LibraryBackupImportResult {
  booksAdded: number;
  booksUpdated: number;
  progressRestored: number;
  progressDocumentsRestored: number;
  preferencesRestored: number;
  bookmarksRestored: number;
  annotationsRestored: number;
}

interface BackupBook {
  record: BookRecord;
  path: string;
  sha256: string;
}

interface LibraryBackupManifest {
  schemaVersion: 3;
  application: 'omnia-reader';
  createdAt: string;
  books: BackupBook[];
  progress: ReadingProgress[];
  progressDocuments: ReadingProgress[];
  preferences: ReaderPreferences[];
  bookmarks: PublicationBookmark[];
  annotations: PublicationAnnotation[];
}

interface VersionTwoLibraryBackupManifest {
  schemaVersion: 2;
  application: 'omnia-reader';
  createdAt: string;
  books: BackupBook[];
  progress: ReadingProgress[];
  preferences: ReaderPreferences[];
  bookmarks: PublicationBookmark[];
  annotations: PublicationAnnotation[];
}

interface LegacyLibraryBackupManifest {
  schemaVersion: 1;
  application: 'omnia-reader';
  createdAt: string;
  books: BackupBook[];
  progress: ReadingProgress[];
  preferences: ReaderPreferences[];
  /**
   * Version 1 called bookmarks "annotations". It never contained highlights.
   */
  annotations: PublicationBookmark[];
}

interface ValidatedBackup {
  manifest: LibraryBackupManifest;
  publications: Map<string, Blob>;
}

interface PreparedBackup {
  books: readonly BookRecord[];
  manifest: LibraryBackupManifest;
  fileName: string;
}

class ArchiveBookSource implements BookSource {
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

@Injectable({ providedIn: 'root' })
export class LibraryBackupService {
  constructor(
    @Inject(LIBRARY_REPOSITORY)
    private readonly repository: LibraryRepository & ProgressDocumentRepository,
    @Inject(LIBRARY_BACKUP_FINGERPRINTER)
    private readonly fingerprinter: (blob: Blob) => Promise<string>,
  ) {}

  backupFileName(now = new Date()): string {
    return `omnia-reader-backup-${dateStamp(now)}.omnia-backup`;
  }

  async exportArchive(
    now = new Date(),
    options: LibraryBackupExportOptions = {},
  ): Promise<LibraryBackupExport> {
    const zip = await import('@zip.js/zip.js');
    const prepared = await this.prepareBackup(now);
    const blobWriter = new zip.BlobWriter(LIBRARY_BACKUP_MEDIA_TYPE);
    const writer = new zip.ZipWriter(blobWriter, {
      keepOrder: true,
      signal: options.signal,
      useWebWorkers: true,
    });
    try {
      await this.addArchiveEntries(writer, zip, prepared, options);
      const blob = await writer.close();
      return {
        blob: blob.slice(0, blob.size, LIBRARY_BACKUP_MEDIA_TYPE),
        fileName: prepared.fileName,
        bookCount: prepared.books.length,
      };
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw cancellationError(error, options.signal);
    }
  }

  async exportArchiveTo(
    writable: WritableStream<Uint8Array>,
    now = new Date(),
    options: LibraryBackupExportOptions = {},
  ): Promise<LibraryBackupExportSummary> {
    const zip = await import('@zip.js/zip.js');
    const prepared = await this.prepareBackup(now);
    const writer = new zip.ZipWriter(writable, {
      keepOrder: true,
      preventClose: true,
      signal: options.signal,
      useWebWorkers: true,
    });
    try {
      await this.addArchiveEntries(writer, zip, prepared, options);
      await writer.close(undefined, { preventClose: true });
      await closeWritable(writable);
      return {
        fileName: prepared.fileName,
        bookCount: prepared.books.length,
      };
    } catch (error) {
      await writer
        .close(undefined, { preventClose: true })
        .catch(() => undefined);
      await abortWritable(writable, error);
      throw cancellationError(error, options.signal);
    }
  }

  private async prepareBackup(now: Date): Promise<PreparedBackup> {
    const books = [...(await this.repository.listBooks())].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (books.length > MAX_BOOKS) {
      throw new Error(
        `Cannot back up more than ${MAX_BOOKS.toLocaleString('en-US')} publications`,
      );
    }
    const bookIds = new Set(books.map((book) => book.id));
    const progress = (await this.repository.listProgress())
      .filter((item) => bookIds.has(item.bookId))
      .sort((left, right) => left.bookId.localeCompare(right.bookId));
    const progressDocuments = mergeProgressDocuments([
      ...(await this.repository.listProgressDocuments()),
      ...progress,
    ]).filter((item) => bookIds.has(item.bookId));
    const bookmarks = await this.repository.listBookmarks(undefined, true);
    const annotations = await this.repository.listAnnotations(undefined, true);
    const includedBookmarks = bookmarks
      .filter((bookmark) => bookIds.has(bookmark.bookId))
      .sort((left, right) => left.id.localeCompare(right.id));
    const includedAnnotations = annotations
      .filter((annotation) => bookIds.has(annotation.bookId))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (
      progressDocuments.length > MAX_PROGRESS_DOCUMENTS ||
      includedBookmarks.length > MAX_BOOKMARKS ||
      includedAnnotations.length > MAX_ANNOTATIONS
    ) {
      throw new Error(
        'Cannot back up the library because its state exceeds the supported archive limits',
      );
    }
    const preferences = (
      await Promise.all([
        this.repository.getReaderPreferences('epub'),
        this.repository.getReaderPreferences('pdf'),
      ])
    ).filter((value): value is ReaderPreferences => value !== null);
    const manifest: LibraryBackupManifest = {
      schemaVersion: 3,
      application: 'omnia-reader',
      createdAt: now.toISOString(),
      books: books.map((record) => ({
        record,
        path: publicationPath(record),
        sha256: record.id,
      })),
      progress,
      progressDocuments,
      preferences: preferences.sort((left, right) =>
        left.format.localeCompare(right.format),
      ),
      bookmarks: includedBookmarks,
      annotations: includedAnnotations,
    };
    return {
      books,
      manifest,
      fileName: this.backupFileName(now),
    };
  }

  private async addArchiveEntries<Type>(
    writer: import('@zip.js/zip.js').ZipWriter<Type>,
    zip: typeof import('@zip.js/zip.js'),
    prepared: PreparedBackup,
    options: LibraryBackupExportOptions,
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const manifest = JSON.stringify(prepared.manifest, null, 2);
    if (new TextEncoder().encode(manifest).byteLength > MAX_MANIFEST_SIZE) {
      throw new Error(
        'Cannot back up the library because its manifest exceeds the supported size limit',
      );
    }
    await writer.add(MANIFEST_PATH, new zip.TextReader(manifest), {
      level: 6,
      signal: options.signal,
    });
    const totalBytes = prepared.books.reduce(
      (total, book) => total + book.size,
      0,
    );
    let processedBytes = 0;
    options.onProgress?.({
      completedBooks: 0,
      totalBooks: prepared.books.length,
      processedBytes,
      totalBytes,
    });

    for (const [index, book] of prepared.books.entries()) {
      options.signal?.throwIfAborted();
      const source = await this.repository.getBookSource(book.id);
      if (!source) {
        throw new Error(
          `Cannot back up "${book.title}" because its publication file is missing`,
        );
      }
      const opened = await source.open();
      options.signal?.throwIfAborted();
      const blob = opened instanceof Blob ? opened : new Blob([opened]);
      if (blob.size !== book.size) {
        throw new Error(
          `Cannot back up "${book.title}" because its publication file is incomplete`,
        );
      }
      await writer.add(publicationPath(book), new zip.BlobReader(blob), {
        level: 0,
        signal: options.signal,
      });
      processedBytes += blob.size;
      options.onProgress?.({
        completedBooks: index + 1,
        totalBooks: prepared.books.length,
        processedBytes,
        totalBytes,
      });
    }
  }

  async importArchive(archive: Blob): Promise<LibraryBackupImportResult> {
    const validated = await this.validateArchive(archive);
    const existingBookIds = new Set(
      (await this.repository.listBooks()).map((book) => book.id),
    );
    const addedBookIds: string[] = [];
    let booksUpdated = 0;
    let progressRestored = 0;
    let progressDocumentsRestored = 0;
    let preferencesRestored = 0;
    let bookmarksRestored = 0;
    let annotationsRestored = 0;

    try {
      for (const item of validated.manifest.books) {
        const blob = validated.publications.get(item.path);
        if (!blob) {
          throw new Error(`Backup entry "${item.path}" is missing`);
        }
        await this.repository.storeSyncedBook(
          item.record,
          new ArchiveBookSource(
            item.record.fileName,
            item.record.mediaType,
            blob,
          ),
        );
        if (existingBookIds.has(item.record.id)) {
          await this.repository.updateMetadata(item.record.id, {
            title: item.record.title,
            authors: item.record.authors,
            language: item.record.language,
            publisher: item.record.publisher,
            identifier: item.record.identifier,
          });
          booksUpdated += 1;
        } else {
          addedBookIds.push(item.record.id);
        }
      }

      for (const progress of validated.manifest.progress) {
        const current = await this.repository.getProgress(progress.bookId);
        const selected = preferredProgress(current, progress);
        if (!current || !sameProgress(current, selected)) {
          await this.repository.saveProgress(selected);
          progressRestored += 1;
        }
      }
      const currentDocuments = new Map(
        (await this.repository.listProgressDocuments()).map((progress) => [
          progressDocumentKey(progress),
          progress,
        ]),
      );
      const importedDocuments = mergeProgressDocuments([
        ...validated.manifest.progressDocuments,
        ...validated.manifest.progress,
      ]);
      for (const imported of importedDocuments) {
        const key = progressDocumentKey(imported);
        const current = currentDocuments.get(key);
        const selected = current
          ? mergeProgressDocument(current, imported)
          : imported;
        if (!current || !sameProgress(current, selected)) {
          await this.repository.saveProgressDocument(selected);
          currentDocuments.set(key, selected);
          progressDocumentsRestored += 1;
        }
      }
      for (const bookmark of validated.manifest.bookmarks) {
        const current = await this.repository.getBookmark(bookmark.id);
        if (preferredBookmark(current, bookmark) === bookmark) {
          await this.repository.saveBookmark(bookmark);
          bookmarksRestored += 1;
        }
      }
      for (const annotation of validated.manifest.annotations) {
        const current = await this.repository.getAnnotation(annotation.id);
        if (preferredAnnotation(current, annotation) === annotation) {
          await this.repository.saveAnnotation(annotation);
          annotationsRestored += 1;
        }
      }
      for (const preferences of validated.manifest.preferences) {
        await this.repository.saveReaderPreferences(preferences);
        preferencesRestored += 1;
      }
    } catch (error) {
      await Promise.allSettled(
        addedBookIds.map((bookId) => this.repository.removeBook(bookId)),
      );
      throw error;
    }

    return {
      booksAdded: addedBookIds.length,
      booksUpdated,
      progressRestored,
      progressDocumentsRestored,
      preferencesRestored,
      bookmarksRestored,
      annotationsRestored,
    };
  }

  private async validateArchive(archive: Blob): Promise<ValidatedBackup> {
    if (archive.size === 0) {
      throw new Error('The selected backup is empty');
    }

    const { BlobReader, BlobWriter, TextWriter, ZipReader } = await import(
      '@zip.js/zip.js'
    );
    const reader = new ZipReader(new BlobReader(archive), {
      strictness: 'strict',
      checkSignature: true,
      checkOverlappingEntry: true,
      useWebWorkers: true,
    });
    try {
      const entries = await reader.getEntries();
      validateEntryTable(entries);
      const byPath = new Map(entries.map((entry) => [entry.filename, entry]));
      const manifestEntry = fileEntry(
        byPath.get(MANIFEST_PATH),
        'The backup manifest is missing',
      );
      if (manifestEntry.uncompressedSize > MAX_MANIFEST_SIZE) {
        throw new Error('The backup manifest is too large');
      }
      const manifestText = await manifestEntry.getData(new TextWriter(), {
        checkSignature: true,
        checkAmbiguity: true,
        checkOverlappingEntry: true,
      });
      const manifest = parseManifest(manifestText);
      validateArchiveEntries(manifest, byPath);

      const publications = new Map<string, Blob>();
      for (const book of manifest.books) {
        const entry = fileEntry(
          byPath.get(book.path),
          `Backup entry "${book.path}" is missing`,
        );
        const blob = await entry.getData(
          new BlobWriter(book.record.mediaType),
          {
            checkSignature: true,
            checkAmbiguity: true,
            checkOverlappingEntry: true,
          },
        );
        if (
          blob.size !== book.record.size ||
          (await this.fingerprinter(blob)) !== book.sha256
        ) {
          throw new Error(
            `Backup publication "${book.record.fileName}" failed integrity validation`,
          );
        }
        publications.set(book.path, blob);
      }
      return { manifest, publications };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Backup')) {
        throw error;
      }
      throw new Error(
        error instanceof Error
          ? `Backup validation failed: ${error.message}`
          : 'Backup validation failed',
      );
    } finally {
      await reader.close().catch(() => undefined);
    }
  }
}

function validateEntryTable(entries: readonly Entry[]): void {
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Backup contains an invalid number of entries');
  }
  const paths = new Set<string>();
  let totalSize = 0;
  for (const entry of entries) {
    if (
      entry.directory ||
      entry.encrypted ||
      !isSafeArchivePath(entry.filename) ||
      paths.has(entry.filename)
    ) {
      throw new Error(`Backup contains an unsafe entry "${entry.filename}"`);
    }
    paths.add(entry.filename);
    totalSize += entry.uncompressedSize;
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      totalSize > MAX_TOTAL_UNCOMPRESSED_SIZE
    ) {
      throw new Error('Backup expands beyond the supported size limit');
    }
  }
}

function fileEntry(entry: Entry | undefined, message: string): FileEntry {
  if (!entry || entry.directory) {
    throw new Error(message);
  }
  return entry as FileEntry;
}

function validateArchiveEntries(
  manifest: LibraryBackupManifest,
  entries: ReadonlyMap<string, Entry>,
): void {
  const expectedPaths = new Set([
    MANIFEST_PATH,
    ...manifest.books.map((book) => book.path),
  ]);
  if (
    entries.size !== expectedPaths.size ||
    [...entries.keys()].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error(
      'Backup contains files that are not declared in its manifest',
    );
  }
  for (const book of manifest.books) {
    const entry = entries.get(book.path);
    if (
      !entry ||
      entry.directory ||
      entry.uncompressedSize !== book.record.size
    ) {
      throw new Error(`Backup entry "${book.path}" has an invalid size`);
    }
  }
}

function parseManifest(text: string): LibraryBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Backup manifest is not valid JSON');
  }
  if (
    !isRecord(value) ||
    value['application'] !== 'omnia-reader' ||
    !isIsoDate(value['createdAt']) ||
    !Array.isArray(value['books']) ||
    value['books'].length > MAX_BOOKS ||
    !value['books'].every(isBackupBook) ||
    !Array.isArray(value['progress']) ||
    value['progress'].length > MAX_BOOKS ||
    !value['progress'].every(isReadingProgress) ||
    !Array.isArray(value['preferences']) ||
    !value['preferences'].every(isReaderPreferences)
  ) {
    throw new Error('Backup manifest uses an unsupported or invalid schema');
  }

  let manifest: LibraryBackupManifest;
  if (value['schemaVersion'] === 1) {
    if (
      !Array.isArray(value['annotations']) ||
      value['annotations'].length > MAX_BOOKMARKS ||
      !value['annotations'].every(isPublicationBookmark)
    ) {
      throw new Error('Backup manifest uses an unsupported or invalid schema');
    }
    const legacy = value as unknown as LegacyLibraryBackupManifest;
    manifest = {
      schemaVersion: 3,
      application: legacy.application,
      createdAt: legacy.createdAt,
      books: legacy.books,
      progress: legacy.progress,
      progressDocuments: legacy.progress,
      preferences: legacy.preferences,
      bookmarks: legacy.annotations,
      annotations: [],
    };
  } else if (value['schemaVersion'] === 2) {
    if (
      !Array.isArray(value['bookmarks']) ||
      value['bookmarks'].length > MAX_BOOKMARKS ||
      !value['bookmarks'].every(isPublicationBookmark) ||
      !Array.isArray(value['annotations']) ||
      value['annotations'].length > MAX_ANNOTATIONS ||
      !value['annotations'].every(isPublicationAnnotation)
    ) {
      throw new Error('Backup manifest uses an unsupported or invalid schema');
    }
    const versionTwo = value as unknown as VersionTwoLibraryBackupManifest;
    manifest = {
      schemaVersion: 3,
      application: versionTwo.application,
      createdAt: versionTwo.createdAt,
      books: versionTwo.books,
      progress: versionTwo.progress,
      progressDocuments: versionTwo.progress,
      preferences: versionTwo.preferences,
      bookmarks: versionTwo.bookmarks,
      annotations: versionTwo.annotations,
    };
  } else if (value['schemaVersion'] === 3) {
    if (
      !Array.isArray(value['bookmarks']) ||
      value['bookmarks'].length > MAX_BOOKMARKS ||
      !value['bookmarks'].every(isPublicationBookmark) ||
      !Array.isArray(value['annotations']) ||
      value['annotations'].length > MAX_ANNOTATIONS ||
      !value['annotations'].every(isPublicationAnnotation) ||
      !Array.isArray(value['progressDocuments']) ||
      value['progressDocuments'].length > MAX_PROGRESS_DOCUMENTS ||
      !value['progressDocuments'].every(isReadingProgress)
    ) {
      throw new Error('Backup manifest uses an unsupported or invalid schema');
    }
    manifest = value as unknown as LibraryBackupManifest;
  } else {
    throw new Error('Backup manifest uses an unsupported or invalid schema');
  }

  const bookIds = new Set<string>();
  const bookFormats = new Map<string, PublicationFormat>();
  const paths = new Set<string>();
  for (const book of manifest.books) {
    if (
      bookIds.has(book.record.id) ||
      paths.has(book.path) ||
      book.path !== publicationPath(book.record)
    ) {
      throw new Error('Backup manifest contains duplicate publication records');
    }
    bookIds.add(book.record.id);
    bookFormats.set(book.record.id, book.record.format);
    paths.add(book.path);
  }
  if (
    manifest.progress.some(
      (progress) =>
        !bookIds.has(progress.bookId) ||
        bookFormats.get(progress.bookId) !== progress.format,
    )
  ) {
    throw new Error('Backup progress does not match its publication');
  }
  if (
    manifest.progressDocuments.some(
      (progress) =>
        !bookIds.has(progress.bookId) ||
        bookFormats.get(progress.bookId) !== progress.format,
    )
  ) {
    throw new Error('Backup progress documents do not match their publication');
  }
  if (
    manifest.bookmarks.some(
      (bookmark) =>
        !bookIds.has(bookmark.bookId) ||
        bookFormats.get(bookmark.bookId) !== bookmark.format,
    )
  ) {
    throw new Error('Backup bookmarks do not match their publication');
  }
  if (
    manifest.annotations.some(
      (annotation) =>
        !bookIds.has(annotation.bookId) ||
        bookFormats.get(annotation.bookId) !== annotation.format,
    )
  ) {
    throw new Error('Backup annotations do not match their publication');
  }
  if (
    new Set(manifest.progress.map((progress) => progress.bookId)).size !==
      manifest.progress.length ||
    new Set(
      manifest.progressDocuments.map((progress) =>
        progressDocumentKey(progress),
      ),
    ).size !== manifest.progressDocuments.length ||
    new Set(manifest.bookmarks.map((bookmark) => bookmark.id)).size !==
      manifest.bookmarks.length ||
    new Set(manifest.annotations.map((annotation) => annotation.id)).size !==
      manifest.annotations.length ||
    new Set(manifest.preferences.map((preferences) => preferences.format))
      .size !== manifest.preferences.length
  ) {
    throw new Error('Backup manifest contains duplicate state records');
  }
  return manifest;
}

function isBackupBook(value: unknown): value is BackupBook {
  return (
    isRecord(value) &&
    isBookRecord(value['record']) &&
    typeof value['path'] === 'string' &&
    value['path'].length <= 128 &&
    value['sha256'] === value['record'].id
  );
}

function preferredProgress(
  current: ReadingProgress | null,
  imported: ReadingProgress,
): ReadingProgress {
  if (!current) {
    return imported;
  }
  const selected =
    compareProgressRecency(current, imported) >= 0 ? current : imported;
  const furthestTotalProgression = Math.max(
    current.furthestTotalProgression,
    imported.furthestTotalProgression,
  );
  return selected.furthestTotalProgression === furthestTotalProgression
    ? selected
    : { ...selected, furthestTotalProgression };
}

function mergeProgressDocuments(
  documents: readonly ReadingProgress[],
): ReadingProgress[] {
  const merged = new Map<string, ReadingProgress>();
  for (const progress of documents) {
    const key = progressDocumentKey(progress);
    const current = merged.get(key);
    merged.set(
      key,
      current ? mergeProgressDocument(current, progress) : progress,
    );
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.bookId.localeCompare(right.bookId) ||
      left.deviceId.localeCompare(right.deviceId),
  );
}

function mergeProgressDocument(
  current: ReadingProgress,
  imported: ReadingProgress,
): ReadingProgress {
  if (progressDocumentKey(current) !== progressDocumentKey(imported)) {
    throw new TypeError(
      'Cannot merge progress from different device documents',
    );
  }
  return preferredProgress(current, imported);
}

function compareProgressRecency(
  left: ReadingProgress,
  right: ReadingProgress,
): number {
  const byUpdatedAt = left.updatedAt.localeCompare(right.updatedAt);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  const byDevice = left.deviceId.localeCompare(right.deviceId);
  return byDevice || JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function progressDocumentKey(progress: ReadingProgress): string {
  return `${progress.bookId}\u0000${progress.deviceId}`;
}

function sameProgress(left: ReadingProgress, right: ReadingProgress): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicationPath(book: BookRecord): string {
  return `books/${book.id.slice('sha256:'.length)}.${book.format}`;
}

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function closeWritable(
  writable: WritableStream<Uint8Array>,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

async function abortWritable(
  writable: WritableStream<Uint8Array>,
  reason: unknown,
): Promise<void> {
  if (writable.locked) {
    return;
  }
  const writer = writable.getWriter();
  try {
    await writer.abort(reason);
  } catch {
    // The original export error remains authoritative.
  } finally {
    writer.releaseLock();
  }
}

function cancellationError(
  error: unknown,
  signal: AbortSignal | undefined,
): Error {
  if (signal?.aborted) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Backup export was cancelled', 'AbortError');
  }
  return error instanceof Error
    ? error
    : new Error('The library backup operation failed');
}

function isSafeArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment !== '' && segment !== '..')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}
