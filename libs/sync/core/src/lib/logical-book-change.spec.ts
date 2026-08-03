import { LogicalBookChange } from '@omnia-reader/reader/domain';
import { bookObjectPath } from './book-sync-manifest';
import {
  isSynchronizedLogicalBookChange,
  logicalBookChangePath,
  parseLogicalBookChange,
  serializeLogicalBookChange,
} from './logical-book-change';

const variantId = `sha256:${'a'.repeat(64)}`;
const logicalId = `logical:sha256:${'b'.repeat(64)}` as const;
const change: LogicalBookChange = {
  schemaVersion: 1,
  changeId: 'change:device-a:1',
  kind: 'add-variant',
  parents: [],
  resultingBooks: [
    {
      schemaVersion: 1,
      id: logicalId,
      title: 'Book',
      authors: [],
      importedAt: '2026-07-31T08:00:00.000Z',
      updatedAt: '2026-07-31T08:00:00.000Z',
      coverState: 'pending',
      variants: { epub: variantId },
    },
  ],
  removedLogicalBookIds: [],
  variantEffects: [
    {
      operation: 'upsert',
      variant: {
        id: variantId,
        format: 'epub',
        fileName: 'book.epub',
        mediaType: 'application/epub+zip',
        size: 42,
        title: 'Book',
        authors: [],
        importedAt: '2026-07-31T08:00:00.000Z',
      },
      objectPath: bookObjectPath({
        id: variantId,
        format: 'epub',
        fileName: 'book.epub',
      }),
    },
  ],
  preferenceEffects: [],
  resolvesConflictIds: [],
  createdAt: '2026-07-31T08:00:00.000Z',
  deviceId: 'device-a',
  appVersion: '0.0.0',
};

describe('logical book change synchronization', () => {
  it('uses a confined path and canonical round-trip serialization', () => {
    expect(logicalBookChangePath(change.changeId)).toBe(
      '.omnia-reader/logical-books/changes/change%3Adevice-a%3A1.json',
    );
    expect(parseLogicalBookChange(serializeLogicalBookChange(change))).toEqual(
      change,
    );
  });

  it('rejects unsafe paths and device-local availability', () => {
    const [variantEffect] = change.variantEffects ?? [];
    if (!variantEffect) {
      throw new Error('The fixture must contain one variant effect');
    }
    expect(
      isSynchronizedLogicalBookChange({
        ...change,
        variantEffects: [
          { ...variantEffect, objectPath: '../publication.epub' },
        ],
      }),
    ).toBe(false);
    expect(
      isSynchronizedLogicalBookChange({
        ...change,
        availability: { status: 'healthy' },
      }),
    ).toBe(false);
  });

  it('accepts only the exact legacy digest path for existing changes', () => {
    const [variantEffect] = change.variantEffects ?? [];
    if (!variantEffect || variantEffect.operation !== 'upsert') {
      throw new Error('The fixture must contain one upsert variant effect');
    }
    const legacyPath = `.omnia-reader/v1/books/${'a'.repeat(64)}/publication.epub`;

    expect(
      isSynchronizedLogicalBookChange({
        ...change,
        variantEffects: [{ ...variantEffect, objectPath: legacyPath }],
      }),
    ).toBe(true);
    expect(
      isSynchronizedLogicalBookChange({
        ...change,
        variantEffects: [
          {
            ...variantEffect,
            objectPath: `.omnia-reader/v1/books/${'b'.repeat(64)}/publication.epub`,
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSynchronizedLogicalBookChange({
        ...change,
        variantEffects: [
          {
            ...variantEffect,
            objectPath: `.omnia-reader/v1/books/${'a'.repeat(64)}/publication.pdf`,
          },
        ],
      }),
    ).toBe(false);
  });
});
