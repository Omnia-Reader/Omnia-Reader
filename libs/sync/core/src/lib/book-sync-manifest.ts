import { BookRecord, PublicationFormat } from '@omnia-reader/reader/domain';
import { SYNC_ROOT } from './library-sync-manifest';

export const BOOKS_ROOT = `${SYNC_ROOT}/books`;

export interface BookSyncManifest {
  schemaVersion: 1;
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
    schemaVersion: 1,
    bookId: book.id,
    format: book.format,
    fileName: book.fileName,
    mediaType: book.mediaType,
    size: book.size,
    sha256,
    objectPath: bookObjectPath(book.id, book.format),
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

export function bookManifestPath(bookId: string): string {
  return `${BOOKS_ROOT}/${pathSegment(bookId)}/book.json`;
}

export function bookObjectPath(
  bookId: string,
  format: PublicationFormat,
): string {
  return `${BOOKS_ROOT}/${pathSegment(bookId)}/publication.${format}`;
}

export function isBookSyncManifest(value: unknown): value is BookSyncManifest {
  if (!isRecord(value)) {
    return false;
  }
  const bookId = value['bookId'];
  const format = value['format'];
  const sha256 = bookIdSha256(bookId);
  return (
    value['schemaVersion'] === 1 &&
    sha256 !== null &&
    (format === 'epub' || format === 'pdf') &&
    isBoundedString(value['fileName']) &&
    isBoundedString(value['mediaType']) &&
    Number.isSafeInteger(value['size']) &&
    (value['size'] as number) > 0 &&
    value['sha256'] === sha256 &&
    value['objectPath'] === bookObjectPath(bookId as string, format) &&
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
