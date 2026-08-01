import {
  BookRecord,
  LogicalBookFormatPreference,
  logicalBookFromVariant,
  MembershipReconciliation,
} from '@omnia-reader/reader/domain';
import {
  createLogicalBookCheckpoint,
  LOGICAL_CHECKPOINT_CHANGE_INTERVAL,
  shouldCreateLogicalBookCheckpoint,
  verifyLogicalBookCheckpointPage,
} from './logical-book-checkpoint';

describe('logical-book checkpoints', () => {
  it('writes deterministic pages with preference heads and reconciliation authority', async () => {
    const books = Array.from({ length: 101 }, (_, index) =>
      logicalBookFromVariant(book(index)),
    ).reverse();
    const logicalBookId = books[0].id;
    const preference: LogicalBookFormatPreference = {
      schemaVersion: 1,
      logicalBookId,
      preferredFormat: 'pdf',
      winningChangeId: 'change:preference',
      preferenceHeads: ['change:preference'],
      updatedAt: '2026-07-31T12:00:00.000Z',
      deviceId: 'device:test',
    };
    const reconciliation: MembershipReconciliation = {
      schemaVersion: 1,
      conflictId: 'conflict:test',
      status: 'resolved',
      conflictingChangeIds: ['change:a', 'change:b'],
      affectedVariantIds: [books[0].variants.pdf!],
      acceptedMembership: [
        {
          logicalBookId,
          format: 'pdf',
          variantId: books[0].variants.pdf!,
        },
      ],
      rejectedMembership: [
        {
          logicalBookId,
          format: 'pdf',
          variantId: books[0].variants.pdf!,
        },
      ],
      resolvedByChangeId: 'change:resolution',
      detectedAt: '2026-07-31T12:00:00.000Z',
    };

    const checkpoint = await createLogicalBookCheckpoint({
      checkpointId: 'checkpoint:test',
      heads: ['change:z', 'change:a', 'change:z'],
      changeIds: ['change:2', 'change:1'],
      books,
      preferences: [preference],
      reconciliations: [reconciliation],
      createdAt: '2026-07-31T13:00:00.000Z',
    });

    expect(checkpoint.index.includedHeads).toEqual(['change:a', 'change:z']);
    expect(checkpoint.index.includedChangeIds).toEqual([
      'change:1',
      'change:2',
    ]);
    expect(checkpoint.pages).toHaveLength(2);
    const first = await verifyLogicalBookCheckpointPage(
      checkpoint.pages[0].descriptor,
      checkpoint.pages[0].content,
    );
    const second = await verifyLogicalBookCheckpointPage(
      checkpoint.pages[1].descriptor,
      checkpoint.pages[1].content,
    );
    expect(first.books).toHaveLength(100);
    expect(first.preferences).toEqual([preference]);
    expect(first.reconciliations).toEqual([reconciliation]);
    expect(second.books).toHaveLength(1);
    expect(second.preferences).toEqual([]);
    expect(second.reconciliations).toEqual([]);
  });

  it('rejects an interrupted or modified page and enforces the compaction threshold', async () => {
    const checkpoint = await createLogicalBookCheckpoint({
      checkpointId: 'checkpoint:integrity',
      heads: [],
      changeIds: [],
      books: [logicalBookFromVariant(book(1))],
      preferences: [],
      reconciliations: [],
      createdAt: '2026-07-31T13:00:00.000Z',
    });
    await expect(
      verifyLogicalBookCheckpointPage(
        checkpoint.pages[0].descriptor,
        `${checkpoint.pages[0].content} `,
      ),
    ).rejects.toThrow('integrity validation');
    expect(
      shouldCreateLogicalBookCheckpoint(LOGICAL_CHECKPOINT_CHANGE_INTERVAL - 1),
    ).toBe(false);
    expect(
      shouldCreateLogicalBookCheckpoint(LOGICAL_CHECKPOINT_CHANGE_INTERVAL),
    ).toBe(true);
  });
});

function book(index: number): BookRecord {
  const digest = index.toString(16).padStart(64, '0');
  return {
    id: `sha256:${digest}`,
    format: 'pdf',
    fileName: `${index}.pdf`,
    mediaType: 'application/pdf',
    size: index + 1,
    title: `Book ${index}`,
    authors: [],
    importedAt: '2026-07-31T10:00:00.000Z',
  };
}
