import {
  isLogicalBookFormatPreference,
  isLogicalBookChange,
  isLogicalBookMutationResult,
  isLogicalBookRecord,
  isMembershipReconciliation,
  isVariantAvailability,
  singletonLogicalBookId,
} from './logical-book';

const EPUB_ID = `sha256:${'a'.repeat(64)}`;
const PDF_ID = `sha256:${'b'.repeat(64)}`;
const LOGICAL_ID = `logical:sha256:${'c'.repeat(64)}`;
const NOW = '2026-07-31T08:00:00.000Z';

describe('logical book domain', () => {
  it('validates a non-empty one-variant-per-format aggregate', () => {
    expect(
      isLogicalBookRecord({
        schemaVersion: 1,
        id: LOGICAL_ID,
        title: 'A logical book',
        authors: ['Omnia'],
        importedAt: NOW,
        updatedAt: NOW,
        coverState: 'pending',
        variants: { epub: EPUB_ID, pdf: PDF_ID },
      }),
    ).toBe(true);
    expect(
      isLogicalBookRecord({
        schemaVersion: 1,
        id: LOGICAL_ID,
        title: 'Empty',
        authors: [],
        importedAt: NOW,
        updatedAt: NOW,
        coverState: 'pending',
        variants: {},
      }),
    ).toBe(false);
  });

  it('validates the synchronized preferred-format register', () => {
    expect(
      isLogicalBookFormatPreference({
        schemaVersion: 1,
        logicalBookId: LOGICAL_ID,
        preferredFormat: 'pdf',
        winningChangeId: 'change:device-a:1',
        preferenceHeads: ['change:device-a:1'],
        updatedAt: NOW,
        deviceId: 'device-a',
      }),
    ).toBe(true);
  });

  it('validates canonical availability status and cause combinations', () => {
    expect(isVariantAvailability({ status: 'checking' })).toBe(true);
    expect(isVariantAvailability({ status: 'healthy' })).toBe(true);
    expect(
      isVariantAvailability({ status: 'unavailable', cause: 'missing' }),
    ).toBe(true);
    expect(
      isVariantAvailability({
        status: 'quarantined',
        cause: 'integrity-invalid',
      }),
    ).toBe(true);
    expect(isVariantAvailability({ status: 'healthy', cause: 'missing' })).toBe(
      false,
    );
  });

  it('validates bounded reconciliation authority', () => {
    expect(
      isMembershipReconciliation({
        schemaVersion: 1,
        conflictId: 'conflict:membership:a-b',
        status: 'open',
        conflictingChangeIds: ['change:a', 'change:b'],
        affectedVariantIds: [EPUB_ID],
        acceptedMembership: [
          { logicalBookId: LOGICAL_ID, format: 'epub', variantId: EPUB_ID },
        ],
        rejectedMembership: [
          {
            logicalBookId: `logical:sha256:${'d'.repeat(64)}`,
            format: 'epub',
            variantId: EPUB_ID,
          },
        ],
        detectedAt: NOW,
      }),
    ).toBe(true);
  });

  it('derives a stable logical namespace from an exact variant ID', () => {
    expect(singletonLogicalBookId(EPUB_ID)).toBe(
      `logical:sha256:${'a'.repeat(64)}`,
    );
    expect(() => singletonLogicalBookId('unsafe')).toThrow();
  });

  it('validates bounded logical changes and mutation results', () => {
    const logicalBook = {
      schemaVersion: 1 as const,
      id: LOGICAL_ID,
      title: 'A logical book',
      authors: ['Omnia'],
      importedAt: NOW,
      updatedAt: NOW,
      coverState: 'pending' as const,
      variants: { epub: EPUB_ID },
    };
    const change = {
      schemaVersion: 1 as const,
      changeId: 'change:device-a:1',
      kind: 'bootstrap' as const,
      parents: [],
      resultingBooks: [logicalBook],
      removedLogicalBookIds: [],
      createdAt: NOW,
      deviceId: 'device-a',
      appVersion: '0.1.0',
    };
    expect(isLogicalBookChange(change)).toBe(true);
    expect(
      isLogicalBookMutationResult({
        createdLogicalBookIds: [LOGICAL_ID],
        updatedLogicalBookIds: [],
        deletedLogicalBookIds: [],
        createdVariantIds: [EPUB_ID],
        deletedVariantIds: [],
        resultingBooks: [logicalBook],
        change,
      }),
    ).toBe(true);
    expect(
      isLogicalBookChange({ ...change, parents: Array(33).fill('change:a') }),
    ).toBe(false);
  });
});
