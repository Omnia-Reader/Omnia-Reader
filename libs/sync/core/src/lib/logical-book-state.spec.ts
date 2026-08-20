import { LogicalBookChange } from '@omnia-reader/reader/domain';
import { bookObjectPath } from './book-sync-manifest';
import {
  emptyLogicalBookState,
  LOGICAL_BOOK_STATE_MAX_BYTES,
  mergeLogicalBookChangesIntoState,
  parseLogicalBookState,
  serializeLogicalBookState,
} from './logical-book-state';

const digest = 'a'.repeat(64);
const variant = {
  id: `sha256:${digest}`,
  format: 'epub' as const,
  fileName: 'State Book.epub',
  mediaType: 'application/epub+zip',
  size: 4,
  title: 'State Book',
  authors: [],
  importedAt: '2026-08-03T08:00:00.000Z',
};
const logicalBook = {
  schemaVersion: 1 as const,
  id: `logical:sha256:${digest}` as const,
  title: variant.title,
  authors: [],
  importedAt: variant.importedAt,
  updatedAt: variant.importedAt,
  coverState: 'pending' as const,
  variants: { epub: variant.id },
};

describe('canonical logical book state', () => {
  it('serializes deterministically and round-trips a valid state', () => {
    const state = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      upsertChange(),
    ]);

    const serialized = serializeLogicalBookState(state);

    expect(parseLogicalBookState(serialized)).toEqual(state);
    expect(serializeLogicalBookState(parseLogicalBookState(serialized))).toBe(
      serialized,
    );
    expect(state.variants[0]?.objectPath).toBe(bookObjectPath(variant));
    expect(state.heads).toEqual(['change:device-a:upsert']);
  });

  it('rejects malformed, oversized, duplicate, and inconsistent state', () => {
    expect(() => parseLogicalBookState('{')).toThrow('not valid JSON');
    expect(() =>
      parseLogicalBookState('x'.repeat(LOGICAL_BOOK_STATE_MAX_BYTES + 1)),
    ).toThrow('safe document bound');

    const state = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      upsertChange(),
    ]);
    expect(() =>
      parseLogicalBookState(
        JSON.stringify({ ...state, books: [state.books[0], state.books[0]] }),
      ),
    ).toThrow('schema validation');
    expect(() =>
      parseLogicalBookState(JSON.stringify({ ...state, variants: [] })),
    ).toThrow('schema validation');
  });

  it('keeps concurrent deletion and preference tombstones against stale changes', () => {
    const preference = {
      schemaVersion: 1 as const,
      logicalBookId: logicalBook.id,
      preferredFormat: 'epub' as const,
      winningChangeId: 'change:device-a:preference',
      preferenceHeads: ['change:device-a:preference'],
      updatedAt: '2026-08-03T08:30:00.000Z',
      deviceId: 'device-a',
    };
    const preferred: LogicalBookChange = {
      ...baseChange('change:device-a:preference', preference.updatedAt),
      kind: 'preference',
      preferenceEffects: [{ logicalBookId: logicalBook.id, preference }],
    };
    const removed: LogicalBookChange = {
      ...baseChange('change:device-a:remove', '2026-08-03T10:00:00.000Z'),
      kind: 'delete-book',
      removedLogicalBookIds: [logicalBook.id],
      variantEffects: [
        { operation: 'delete', variantId: variant.id, format: 'epub' },
      ],
      preferenceEffects: [{ logicalBookId: logicalBook.id, preference: null }],
    };
    const stale = {
      ...upsertChange(),
      changeId: 'change:device-b:stale',
      createdAt: '2026-08-03T09:00:00.000Z',
    };

    const removedState = mergeLogicalBookChangesIntoState(
      emptyLogicalBookState(),
      [upsertChange(), preferred, removed],
    );
    const state = mergeLogicalBookChangesIntoState(removedState, [stale]);

    expect(state.books).toEqual([]);
    expect(state.variants).toEqual([]);
    expect(state.removedBooks).toHaveLength(1);
    expect(state.removedVariants).toHaveLength(1);
    expect(state.preferences).toMatchObject([{ preference: null }]);
  });

  it('allows an explicit causal reimport after deletion', () => {
    const removed: LogicalBookChange = {
      ...baseChange('change:z-remove', '2026-08-03T10:00:00.000Z'),
      kind: 'delete-book',
      removedLogicalBookIds: [logicalBook.id],
      variantEffects: [
        { operation: 'delete', variantId: variant.id, format: 'epub' },
      ],
    };
    const reimport: LogicalBookChange = {
      ...upsertChange(),
      changeId: 'change:a-reimport',
      parents: [removed.changeId],
      createdAt: '2026-08-03T08:00:00.000Z',
    };
    const removedState = mergeLogicalBookChangesIntoState(
      emptyLogicalBookState(),
      [upsertChange(), removed],
    );

    const state = mergeLogicalBookChangesIntoState(removedState, [reimport]);

    expect(state.books).toMatchObject([{ book: logicalBook }]);
    expect(state.variants).toMatchObject([{ variant }]);
    expect(state.removedBooks).toEqual([]);
    expect(state.removedVariants).toEqual([]);
  });

  it('replays the same immutable change idempotently', () => {
    const change = upsertChange();
    const once = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      change,
    ]);
    const twice = mergeLogicalBookChangesIntoState(once, [change]);

    expect(twice).toEqual(once);
  });

  it('rejects conflicting content under one immutable change identity', () => {
    expect(() =>
      mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
        upsertChange(),
        { ...upsertChange(), deviceId: 'different-device' },
      ]),
    ).toThrow('Conflicting immutable logical change documents');
  });

  it('creates the same deterministic reconciliation for competing membership', () => {
    const competingBook = {
      ...logicalBook,
      id: `logical:sha256:${'c'.repeat(64)}` as const,
      title: 'Competing book',
    };
    const competing: LogicalBookChange = {
      ...baseChange('change:device-b:competing', '2026-08-03T09:00:00.000Z'),
      kind: 'associate',
      deviceId: 'device-b',
      resultingBooks: [competingBook],
      variantEffects: [
        { operation: 'upsert', variant, objectPath: bookObjectPath(variant) },
      ],
    };

    const forward = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      upsertChange(),
      competing,
    ]);
    const reversed = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      competing,
      upsertChange(),
    ]);

    expect(reversed).toEqual(forward);
    expect(forward.books.map((entry) => entry.book.id)).toEqual([
      logicalBook.id,
    ]);
    expect(forward.reconciliations).toMatchObject([
      {
        reconciliation: {
          status: 'open',
          conflictingChangeIds: [
            'change:device-a:upsert',
            'change:device-b:competing',
          ],
        },
      },
    ]);
  });

  it('orders concurrent updates by change ID instead of untrusted device time', () => {
    const lexicographicWinner = {
      ...upsertChange(),
      changeId: 'change:z-device',
      createdAt: '2026-08-03T08:00:00.000Z',
      resultingBooks: [{ ...logicalBook, title: 'Lexicographic winner' }],
    };
    const clockSkewedLoser = {
      ...upsertChange(),
      changeId: 'change:a-device',
      createdAt: '2026-08-03T23:00:00.000Z',
      resultingBooks: [{ ...logicalBook, title: 'Clock-skewed loser' }],
    };

    const forward = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      lexicographicWinner,
      clockSkewedLoser,
    ]);
    const reversed = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      clockSkewedLoser,
      lexicographicWinner,
    ]);

    expect(reversed).toEqual(forward);
    expect(forward.books[0]?.book.title).toBe('Lexicographic winner');
    expect(forward.books[0]?.clock.changeId).toBe('change:z-device');
  });

  it('lets a causal descendant win despite an older device timestamp and ID', () => {
    const parent = {
      ...upsertChange(),
      changeId: 'change:z-parent',
      createdAt: '2026-08-03T23:00:00.000Z',
      resultingBooks: [{ ...logicalBook, title: 'Parent' }],
    };
    const descendant = {
      ...upsertChange(),
      changeId: 'change:a-descendant',
      parents: [parent.changeId],
      createdAt: '2026-08-03T08:00:00.000Z',
      resultingBooks: [{ ...logicalBook, title: 'Descendant' }],
    };

    const state = mergeLogicalBookChangesIntoState(emptyLogicalBookState(), [
      descendant,
      parent,
    ]);

    expect(state.books[0]?.book.title).toBe('Descendant');
    expect(state.books[0]?.clock.changeId).toBe(descendant.changeId);
  });
});

function upsertChange(): LogicalBookChange {
  return {
    ...baseChange('change:device-a:upsert', variant.importedAt),
    kind: 'bootstrap',
    resultingBooks: [logicalBook],
    variantEffects: [
      { operation: 'upsert', variant, objectPath: bookObjectPath(variant) },
    ],
  };
}

function baseChange(changeId: string, createdAt: string): LogicalBookChange {
  return {
    schemaVersion: 1,
    changeId,
    kind: 'metadata',
    parents: [],
    resultingBooks: [],
    removedLogicalBookIds: [],
    preferenceEffects: [],
    resolvesConflictIds: [],
    createdAt,
    deviceId: 'device-a',
    appVersion: '0.0.0',
  };
}
