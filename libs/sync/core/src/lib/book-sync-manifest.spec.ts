import { BookRecord } from '@omnia-reader/reader/domain';
import { describe, expect, it } from 'vitest';
import {
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

    expect(manifest.objectPath).toBe(bookObjectPath(book.id, 'epub'));
    expect(bookManifestPath(book.id)).toContain('sha256%3A');
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
      schemaVersion: 1,
      deleted: true,
      bookId: book.id,
      format: 'epub',
      objectPath: bookObjectPath(book.id, 'epub'),
      deletedAt: '2026-07-25T02:00:00.000Z',
      appVersion: '1.0.0',
    });
    expect(isBookSyncDeletionTombstone(tombstone)).toBe(true);
    expect(isBookSyncDocument(tombstone)).toBe(true);
    expect(isBookSyncManifest(tombstone)).toBe(false);
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
