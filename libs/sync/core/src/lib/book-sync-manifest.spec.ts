import { BookRecord } from '@omnia-reader/reader/domain';
import { describe, expect, it } from 'vitest';
import {
  bookDeletionPath,
  bookManifestPath,
  bookObjectPath,
  createBookSyncDeletionTombstone,
  createBookSyncManifest,
  isBookSyncDeletionTombstone,
  isBookSyncDocument,
  isBookSyncManifest,
  manifestBookRecord,
} from './book-sync-manifest';

const book: BookRecord = {
  id: `sha256:${'a'.repeat(64)}`,
  format: 'epub',
  fileName: 'A Book.epub',
  mediaType: 'application/epub+zip',
  size: 123,
  title: 'A Book',
  authors: ['Author'],
  language: 'en',
  publisher: 'Omnia Press',
  identifier: 'urn:isbn:9780000000000',
  importedAt: '2026-07-25T00:00:00.000Z',
};

describe('book sync manifest', () => {
  it('creates deterministic paths for an exact publication edition', () => {
    const manifest = createBookSyncManifest(
      book,
      '2026-07-25T01:00:00.000Z',
      '1.0.0',
    );

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.objectPath).toBe(bookObjectPath(book));
    expect(manifest.objectPath).toBe(
      `.omnia-reader/v1/library/A Book--${'a'.repeat(12)}/A Book.epub`,
    );
    expect(bookManifestPath(book)).toBe(
      `.omnia-reader/v1/library/A Book--${'a'.repeat(12)}/book.json`,
    );
    expect(isBookSyncManifest(manifest)).toBe(true);
    expect(manifestBookRecord(manifest)).toEqual(book);
  });

  it('creates and validates a durable remote-deletion tombstone', () => {
    const tombstone = createBookSyncDeletionTombstone(
      book,
      '2026-07-25T02:00:00.000Z',
      '1.0.0',
    );

    expect(tombstone).toEqual({
      schemaVersion: 2,
      deleted: true,
      bookId: book.id,
      format: 'epub',
      fileName: book.fileName,
      objectPath: bookObjectPath(book),
      deletedAt: '2026-07-25T02:00:00.000Z',
      appVersion: '1.0.0',
    });
    expect(isBookSyncDeletionTombstone(tombstone)).toBe(true);
    expect(isBookSyncDocument(tombstone)).toBe(true);
    expect(isBookSyncManifest(tombstone)).toBe(false);
  });

  it('rejects obsolete schema-v1 records', () => {
    const manifest = {
      ...createBookSyncManifest(book),
      schemaVersion: 1,
    };
    const tombstone = {
      ...createBookSyncDeletionTombstone(book, '2026-07-25T02:00:00.000Z'),
      schemaVersion: 1,
    };

    expect(isBookSyncManifest(manifest)).toBe(false);
    expect(isBookSyncDeletionTombstone(tombstone)).toBe(false);
    expect(bookDeletionPath(book.id)).toBe(
      `.omnia-reader/v1/.deletions/books/${'a'.repeat(64)}.json`,
    );
  });

  it('confines unsafe source names while keeping the path recognizable', () => {
    const manifest = createBookSyncManifest({
      ...book,
      fileName: '../A: Book?.epub',
    });

    expect(manifest.objectPath).toBe(
      `.omnia-reader/v1/library/-A- Book---${'a'.repeat(12)}/-A- Book-.epub`,
    );
    expect(isBookSyncManifest(manifest)).toBe(true);
  });

  it.each([
    ['wrong object path', { objectPath: '../publication.epub' }],
    ['invalid timestamp', { deletedAt: 'today' }],
    ['missing discriminator', { deleted: false }],
    ['unsupported format', { format: 'mobi' }],
  ])('rejects a tombstone with %s', (_label, patch) => {
    const tombstone = {
      ...createBookSyncDeletionTombstone(book, '2026-07-25T02:00:00.000Z'),
      ...patch,
    };

    expect(isBookSyncDeletionTombstone(tombstone)).toBe(false);
    expect(isBookSyncDocument(tombstone)).toBe(false);
  });

  it.each([
    ['wrong digest', { sha256: 'b'.repeat(64) }],
    ['wrong object path', { objectPath: '../publication.epub' }],
    ['unsafe size', { size: -1 }],
    ['invalid timestamp', { updatedAt: 'today' }],
    ['unsupported format', { format: 'mobi' }],
  ])('rejects %s', (_label, patch) => {
    const manifest = {
      ...createBookSyncManifest(book, '2026-07-25T01:00:00.000Z'),
      ...patch,
    };

    expect(isBookSyncManifest(manifest)).toBe(false);
  });
});
