import { BookRecord } from '@omnia-reader/reader/domain';
import { describe, expect, it } from 'vitest';
import {
  bookManifestPath,
  bookObjectPath,
  createBookSyncManifest,
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
