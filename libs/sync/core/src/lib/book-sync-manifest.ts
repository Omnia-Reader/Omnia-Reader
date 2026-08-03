import { BookRecord, PublicationFormat } from '@omnia-reader/reader/domain';
import { PREVIOUS_SYNC_ROOT, SYNC_ROOT } from './library-sync-manifest';

export const LEGACY_BOOKS_ROOT = `${PREVIOUS_SYNC_ROOT}/books`;
export const BOOKS_ROOT = `${SYNC_ROOT}/library`;
export const BOOK_DELETIONS_ROOT = `${SYNC_ROOT}/.deletions/books`;

export interface BookSyncManifest {
  schemaVersion: 2;
  bookId: string;
  format: PublicationFormat;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
  objectPath: string;
  title: string;
  authors: string[];
  language?: string;
  publisher?: string;
  identifier?: string;
  importedAt: string;
  updatedAt: string;
  appVersion: string;
}

export interface BookSyncDeletionTombstone {
  schemaVersion: 2;
  deleted: true;
  bookId: string;
  format: PublicationFormat;
  fileName: string;
  objectPath: string;
  deletedAt: string;
  appVersion: string;
}

export type BookSyncDocument = BookSyncManifest | BookSyncDeletionTombstone;

type BookPathRecord = Pick<BookRecord, 'format' | 'fileName'> & {
  id?: string;
  bookId?: string;
};

export function createBookSyncManifest(
  book: BookRecord,
  updatedAt = book.lastOpenedAt ?? book.importedAt,
  appVersion = '0.0.0',
): BookSyncManifest {
  const sha256 = bookIdSha256(book.id);
  if (!sha256) {
    throw new TypeError('Book IDs must be SHA-256 fingerprints');
  }
  return {
    schemaVersion: 2,
    bookId: book.id,
    format: book.format,
    fileName: book.fileName,
    mediaType: book.mediaType,
    size: book.size,
    sha256,
    objectPath: bookObjectPath(book),
    title: book.title,
    authors: [...book.authors],
    ...(book.language ? { language: book.language } : {}),
    ...(book.publisher ? { publisher: book.publisher } : {}),
    ...(book.identifier ? { identifier: book.identifier } : {}),
    importedAt: book.importedAt,
    updatedAt,
    appVersion,
  };
}

export function createBookSyncDeletionTombstone(
  book: Pick<BookRecord, 'id' | 'format' | 'fileName'>,
  deletedAt = new Date().toISOString(),
  appVersion = '0.0.0',
): BookSyncDeletionTombstone {
  if (!bookIdSha256(book.id)) {
    throw new TypeError('Book IDs must be SHA-256 fingerprints');
  }
  return {
    schemaVersion: 2,
    deleted: true,
    bookId: book.id,
    format: book.format,
    fileName: book.fileName,
    objectPath: bookObjectPath(book),
    deletedAt,
    appVersion,
  };
}

export function bookManifestPath(book: BookPathRecord): string {
  return `${bookDirectoryPath(book)}/book.json`;
}

export function bookDeletionPath(bookId: string): string {
  const sha256 = bookIdSha256(bookId);
  if (!sha256) {
    throw new TypeError('Book IDs must be SHA-256 fingerprints');
  }
  return `${BOOK_DELETIONS_ROOT}/${sha256}.json`;
}

export function bookObjectPath(book: BookPathRecord): string {
  return `${bookDirectoryPath(book)}/${readableFileName(book.fileName, book.format)}`;
}

export function legacyBookManifestPath(bookId: string): string {
  return `${LEGACY_BOOKS_ROOT}/${pathSegment(bookId)}/book.json`;
}

export function legacyBookObjectPath(
  bookId: string,
  format: PublicationFormat,
): string {
  return `${LEGACY_BOOKS_ROOT}/${pathSegment(bookId)}/publication.${format}`;
}

function bookDirectoryPath(book: BookPathRecord): string {
  const sha256 = bookIdSha256(book.id ?? book.bookId);
  if (!sha256) {
    throw new TypeError('Book IDs must be SHA-256 fingerprints');
  }
  const fileName = readableFileName(book.fileName, book.format);
  const stem = fileName.replace(/\.(epub|pdf)$/i, '');
  return `${BOOKS_ROOT}/${stem}--${sha256.slice(0, 12)}`;
}

export function isBookSyncManifest(value: unknown): value is BookSyncManifest {
  if (!isRecord(value)) {
    return false;
  }
  const bookId = value['bookId'];
  const format = value['format'];
  const sha256 = bookIdSha256(bookId);
  return (
    value['schemaVersion'] === 2 &&
    sha256 !== null &&
    (format === 'epub' || format === 'pdf') &&
    isBoundedString(value['fileName']) &&
    isBoundedString(value['mediaType']) &&
    Number.isSafeInteger(value['size']) &&
    (value['size'] as number) > 0 &&
    value['sha256'] === sha256 &&
    value['objectPath'] ===
      bookObjectPath({
        id: bookId as string,
        format,
        fileName: value['fileName'] as string,
      }) &&
    isBoundedString(value['title']) &&
    Array.isArray(value['authors']) &&
    value['authors'].length <= 100 &&
    value['authors'].every(isBoundedString) &&
    isOptionalBoundedString(value['language']) &&
    isOptionalBoundedString(value['publisher']) &&
    isOptionalBoundedString(value['identifier']) &&
    isCanonicalTimestamp(value['importedAt']) &&
    isCanonicalTimestamp(value['updatedAt']) &&
    isBoundedString(value['appVersion'])
  );
}

export function isBookSyncDeletionTombstone(
  value: unknown,
): value is BookSyncDeletionTombstone {
  if (!isRecord(value)) {
    return false;
  }
  const bookId = value['bookId'];
  const format = value['format'];
  return (
    value['schemaVersion'] === 2 &&
    value['deleted'] === true &&
    bookIdSha256(bookId) !== null &&
    (format === 'epub' || format === 'pdf') &&
    isBoundedString(value['fileName']) &&
    value['objectPath'] ===
      bookObjectPath({
        id: bookId as string,
        format,
        fileName: value['fileName'],
      }) &&
    isCanonicalTimestamp(value['deletedAt']) &&
    isBoundedString(value['appVersion'])
  );
}

export function isBookSyncDocument(value: unknown): value is BookSyncDocument {
  return isBookSyncManifest(value) || isBookSyncDeletionTombstone(value);
}

export function manifestBookRecord(manifest: BookSyncManifest): BookRecord {
  return {
    id: manifest.bookId,
    format: manifest.format,
    fileName: manifest.fileName,
    mediaType: manifest.mediaType,
    size: manifest.size,
    title: manifest.title,
    authors: [...manifest.authors],
    ...(manifest.language ? { language: manifest.language } : {}),
    ...(manifest.publisher ? { publisher: manifest.publisher } : {}),
    ...(manifest.identifier ? { identifier: manifest.identifier } : {}),
    importedAt: manifest.importedAt,
  };
}

function bookIdSha256(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^sha256:([a-f0-9]{64})$/.exec(value);
  return match?.[1] ?? null;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '%252F');
}

function readableFileName(value: string, format: PublicationFormat): string {
  const extension = `.${format}`;
  const normalized = [...value.normalize('NFKC')]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? '-' : character;
    })
    .join('')
    .replace(/[/\\<>:"|?*%]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '');
  const withExtension = normalized.toLowerCase().endsWith(extension)
    ? normalized
    : `${normalized || 'Untitled'}${extension}`;
  const stem = withExtension.slice(0, -extension.length).slice(0, 120).trim();
  return `${stem || 'Untitled'}${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function isOptionalBoundedString(value: unknown): value is string | undefined {
  return value === undefined || isBoundedString(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}
