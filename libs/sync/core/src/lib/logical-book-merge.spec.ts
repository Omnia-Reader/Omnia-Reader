import {
  LogicalBookChange,
  LogicalBookRecord,
} from '@omnia-reader/reader/domain';
import { foldLogicalBookChanges } from './logical-book-merge';

const variantId = `sha256:${'a'.repeat(64)}`;
const pdfVariantId = `sha256:${'d'.repeat(64)}`;
const firstId = `logical:sha256:${'b'.repeat(64)}` as const;
const secondId = `logical:sha256:${'c'.repeat(64)}` as const;
const thirdId = `logical:sha256:${'e'.repeat(64)}` as const;

describe('logical book causal merge', () => {
  it('applies descendants after parents and folds preference independently', () => {
    const first = change('change:a', [], [book(firstId)]);
    const preference = {
      ...change('change:b', ['change:a'], []),
      kind: 'preference' as const,
      preferenceEffects: [
        {
          logicalBookId: firstId,
          preference: {
            schemaVersion: 1 as const,
            logicalBookId: firstId,
            preferredFormat: 'epub' as const,
            winningChangeId: 'change:b',
            preferenceHeads: ['change:b'],
            updatedAt: '2026-07-31T08:00:00.000Z',
            deviceId: 'device-b',
          },
        },
      ],
    };
    const result = foldLogicalBookChanges([preference, first]);
    expect(result.books).toHaveLength(1);
    expect(result.preferences[0].preferredFormat).toBe('epub');
    expect(result.heads).toEqual(['change:b']);
  });

  it('retains accepted membership and creates a deterministic open conflict', () => {
    const accepted = change('change:a', [], [book(firstId)]);
    const competing = change('change:z', [], [book(secondId)]);
    const first = foldLogicalBookChanges([accepted, competing]);
    const second = foldLogicalBookChanges([competing, accepted]);
    expect(first.reconciliations).toEqual(second.reconciliations);
    expect(first.reconciliations[0]).toMatchObject({
      status: 'open',
      affectedVariantIds: [variantId],
      acceptedMembership: [
        { logicalBookId: firstId, format: 'epub', variantId },
      ],
      rejectedMembership: [
        { logicalBookId: secondId, format: 'epub', variantId },
      ],
    });
    expect(first.books).toEqual([book(firstId)]);
  });

  it('does not apply removals or partial proposals when membership conflicts', () => {
    const pdfOnly = {
      ...book(secondId),
      variants: { pdf: pdfVariantId },
    };
    const initialEpub = change('change:a', [], [book(firstId)]);
    const initialPdf = change('change:b', [], [pdfOnly]);
    const competingAssociation = {
      ...change(
        'change:z',
        [],
        [
          {
            ...book(thirdId),
            variants: { epub: variantId, pdf: pdfVariantId },
          },
        ],
      ),
      kind: 'associate' as const,
      removedLogicalBookIds: [firstId],
    };

    const result = foldLogicalBookChanges([
      initialEpub,
      initialPdf,
      competingAssociation,
    ]);

    expect(result.books).toEqual([book(firstId), pdfOnly]);
    expect(result.reconciliations[0].acceptedMembership).toEqual([
      { logicalBookId: firstId, format: 'epub', variantId },
      { logicalBookId: secondId, format: 'pdf', variantId: pdfVariantId },
    ]);
    expect(result.reconciliations[0].rejectedMembership).toEqual([
      { logicalBookId: thirdId, format: 'epub', variantId },
      { logicalBookId: thirdId, format: 'pdf', variantId: pdfVariantId },
    ]);
  });
});

function book(id: LogicalBookRecord['id']): LogicalBookRecord {
  return {
    schemaVersion: 1,
    id,
    title: 'Book',
    authors: [],
    importedAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    coverState: 'pending',
    variants: { epub: variantId },
  };
}

function change(
  changeId: string,
  parents: string[],
  resultingBooks: LogicalBookRecord[],
): LogicalBookChange {
  return {
    schemaVersion: 1,
    changeId,
    kind: 'bootstrap',
    parents,
    resultingBooks,
    removedLogicalBookIds: [],
    createdAt: '2026-07-31T08:00:00.000Z',
    deviceId: changeId,
    appVersion: '0.0.0',
  };
}
