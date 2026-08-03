import {
  BookRecord,
  isBookRecord,
  isLogicalBookFormatPreference,
  isLogicalBookId,
  isLogicalBookRecord,
  isMembershipReconciliation,
  isVariantId,
  LogicalBookChange,
  LogicalBookFormatPreference,
  LogicalBookId,
  LogicalBookRecord,
  MembershipReconciliation,
  MembershipTuple,
  PublicationFormat,
} from '@omnia-reader/reader/domain';
import { bookObjectPath } from './book-sync-manifest';
import {
  isSynchronizedLogicalBookChange,
  parseLogicalBookChange,
  serializeLogicalBookChange,
} from './logical-book-change';
import { SYNC_ROOT } from './library-sync-manifest';

export const LOGICAL_BOOK_STATE_PATH = `${SYNC_ROOT}/logical-books/state.json`;
export const LOGICAL_BOOK_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const LOGICAL_BOOK_STATE_MAX_RECORDS = 20_000;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

export interface LogicalBookStateClock {
  changeId: string;
  createdAt: string;
  deviceId: string;
}

export interface LogicalBookStateDocument {
  schemaVersion: 1;
  heads: string[];
  books: Array<{ book: LogicalBookRecord; clock: LogicalBookStateClock }>;
  removedBooks: Array<{
    logicalBookId: LogicalBookId;
    clock: LogicalBookStateClock;
  }>;
  variants: Array<{
    variant: BookRecord;
    objectPath: string;
    clock: LogicalBookStateClock;
  }>;
  removedVariants: Array<{
    variantId: string;
    format: PublicationFormat;
    clock: LogicalBookStateClock;
  }>;
  preferences: Array<{
    logicalBookId: LogicalBookId;
    preference: LogicalBookFormatPreference | null;
    clock: LogicalBookStateClock;
  }>;
  reconciliations: Array<{
    reconciliation: MembershipReconciliation;
    clock: LogicalBookStateClock;
  }>;
}

export function emptyLogicalBookState(): LogicalBookStateDocument {
  return {
    schemaVersion: 1,
    heads: [],
    books: [],
    removedBooks: [],
    variants: [],
    removedVariants: [],
    preferences: [],
    reconciliations: [],
  };
}

export function serializeLogicalBookState(
  state: LogicalBookStateDocument,
): string {
  const canonical = canonicalizeLogicalBookState(state);
  if (!isLogicalBookStateDocument(canonical)) {
    throw new TypeError('Logical book state failed schema validation');
  }
  const content = `${JSON.stringify(canonical, null, 2)}\n`;
  if (
    new TextEncoder().encode(content).byteLength > LOGICAL_BOOK_STATE_MAX_BYTES
  ) {
    throw new TypeError('Logical book state exceeds the safe document bound');
  }
  return content;
}

export function parseLogicalBookState(
  content: string,
): LogicalBookStateDocument {
  if (
    new TextEncoder().encode(content).byteLength > LOGICAL_BOOK_STATE_MAX_BYTES
  ) {
    throw new TypeError('Logical book state exceeds the safe document bound');
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TypeError('Logical book state is not valid JSON');
  }
  if (!isLogicalBookStateDocument(value)) {
    throw new TypeError('Logical book state failed schema validation');
  }
  return canonicalizeLogicalBookState(value);
}

export function mergeLogicalBookChangesIntoState(
  initial: LogicalBookStateDocument,
  changes: readonly LogicalBookChange[],
): LogicalBookStateDocument {
  let state = canonicalizeLogicalBookState(initial);
  const identities = new Map<string, string>();
  for (const change of changes) {
    if (!isSynchronizedLogicalBookChange(change)) {
      throw new TypeError('Logical book change failed schema validation');
    }
    const identity = serializeLogicalBookChange(change);
    const current = identities.get(change.changeId);
    if (current && current !== identity) {
      throw new Error('Conflicting immutable logical change documents');
    }
    identities.set(change.changeId, identity);
  }
  for (const change of orderChanges(
    [...identities.values()].map(parseLogicalBookChange),
  )) {
    state = applyChange(state, change);
  }
  return canonicalizeLogicalBookState(state);
}

export function logicalBookStateView(state: LogicalBookStateDocument): {
  books: LogicalBookRecord[];
  preferences: LogicalBookFormatPreference[];
  reconciliations: MembershipReconciliation[];
} {
  return {
    books: state.books.map((entry) => entry.book),
    preferences: state.preferences.flatMap((entry) =>
      entry.preference ? [entry.preference] : [],
    ),
    reconciliations: state.reconciliations.map((entry) => entry.reconciliation),
  };
}

function applyChange(
  state: LogicalBookStateDocument,
  change: LogicalBookChange,
): LogicalBookStateDocument {
  const clock = clockOf(change);
  const books = new Map(state.books.map((entry) => [entry.book.id, entry]));
  const removedBooks = new Map(
    state.removedBooks.map((entry) => [entry.logicalBookId, entry]),
  );
  const candidateBooks = new Map(books);
  const candidateRemovedBooks = new Map(removedBooks);

  for (const logicalBookId of change.removedLogicalBookIds) {
    if (
      !clockWins(clock, books.get(logicalBookId)?.clock) ||
      !clockWins(clock, removedBooks.get(logicalBookId)?.clock)
    )
      continue;
    candidateBooks.delete(logicalBookId);
    candidateRemovedBooks.set(logicalBookId, { logicalBookId, clock });
  }

  const competing: Array<{
    proposed: LogicalBookRecord;
    conflicts: MembershipTuple[];
  }> = [];
  for (const proposed of change.resultingBooks) {
    if (
      !clockWins(clock, books.get(proposed.id)?.clock) ||
      !clockWins(clock, removedBooks.get(proposed.id)?.clock)
    )
      continue;
    const conflicts = membershipConflicts(proposed, candidateBooks);
    if (conflicts.length > 0) competing.push({ proposed, conflicts });
    else {
      candidateBooks.set(proposed.id, { book: proposed, clock });
      candidateRemovedBooks.delete(proposed.id);
    }
  }

  const reconciliations = new Map(
    state.reconciliations.map((entry) => [
      entry.reconciliation.conflictId,
      entry,
    ]),
  );
  if (competing.length === 0) {
    books.clear();
    candidateBooks.forEach((entry, id) => books.set(id, entry));
    removedBooks.clear();
    candidateRemovedBooks.forEach((entry, id) => removedBooks.set(id, entry));
  } else {
    const rejectedMembership = competing.flatMap(({ proposed }) =>
      memberships(proposed),
    );
    const proposedVariantIds = new Set(
      rejectedMembership.map((entry) => entry.variantId),
    );
    const acceptedMembership = [...books.values()]
      .filter(({ book }) =>
        Object.values(book.variants).some(
          (id) => id && proposedVariantIds.has(id),
        ),
      )
      .flatMap(({ book }) => memberships(book));
    const conflictingChangeIds = [
      change.changeId,
      ...acceptedMembership.map(
        (entry) =>
          books.get(entry.logicalBookId)?.clock.changeId ?? 'change:bootstrap',
      ),
    ];
    const affectedVariantIds = [
      ...new Set(
        [...acceptedMembership, ...rejectedMembership].map(
          (entry) => entry.variantId,
        ),
      ),
    ].sort();
    const conflictId = deterministicConflictId(
      conflictingChangeIds,
      affectedVariantIds,
    );
    if (clockWins(clock, reconciliations.get(conflictId)?.clock)) {
      reconciliations.set(conflictId, {
        clock,
        reconciliation: {
          schemaVersion: 1,
          conflictId,
          status: 'open',
          conflictingChangeIds: [...new Set(conflictingChangeIds)].sort(),
          affectedVariantIds,
          acceptedMembership,
          rejectedMembership,
          detectedAt: change.createdAt,
        },
      });
    }
  }

  const preferences = new Map(
    state.preferences.map((entry) => [entry.logicalBookId, entry]),
  );
  for (const effect of change.preferenceEffects ?? []) {
    if (clockWins(clock, preferences.get(effect.logicalBookId)?.clock)) {
      preferences.set(effect.logicalBookId, {
        logicalBookId: effect.logicalBookId,
        preference: effect.preference,
        clock,
      });
    }
  }
  for (const conflictId of change.resolvesConflictIds ?? []) {
    const current = reconciliations.get(conflictId);
    if (current && clockWins(clock, current.clock)) {
      reconciliations.set(conflictId, {
        clock,
        reconciliation: {
          ...current.reconciliation,
          status: 'resolved',
          resolvedByChangeId: change.changeId,
        },
      });
    }
  }

  const variants = new Map(
    state.variants.map((entry) => [entry.variant.id, entry]),
  );
  const removedVariants = new Map(
    state.removedVariants.map((entry) => [entry.variantId, entry]),
  );
  const activeVariantIds = new Set(
    [...books.values()].flatMap(({ book }) => Object.values(book.variants)),
  );
  for (const effect of change.variantEffects ?? []) {
    const variantId =
      effect.operation === 'upsert' ? effect.variant.id : effect.variantId;
    if (
      !clockWins(clock, variants.get(variantId)?.clock) ||
      !clockWins(clock, removedVariants.get(variantId)?.clock)
    )
      continue;
    if (effect.operation === 'delete') {
      variants.delete(variantId);
      removedVariants.set(variantId, {
        variantId,
        format: effect.format,
        clock,
      });
    } else if (activeVariantIds.has(variantId)) {
      variants.set(variantId, {
        variant: effect.variant,
        objectPath: bookObjectPath(effect.variant),
        clock,
      });
      removedVariants.delete(variantId);
    }
  }
  for (const variantId of variants.keys()) {
    if (!activeVariantIds.has(variantId)) variants.delete(variantId);
  }

  const next: LogicalBookStateDocument = {
    schemaVersion: 1,
    heads: [],
    books: [...books.values()],
    removedBooks: [...removedBooks.values()],
    variants: [...variants.values()],
    removedVariants: [...removedVariants.values()],
    preferences: [...preferences.values()],
    reconciliations: [...reconciliations.values()],
  };
  next.heads = stateClocks(next).map((entry) => entry.changeId);
  return next;
}

function canonicalizeLogicalBookState(
  state: LogicalBookStateDocument,
): LogicalBookStateDocument {
  const canonical: LogicalBookStateDocument = {
    schemaVersion: 1,
    heads: [...new Set(state.heads)].sort(),
    books: [...state.books].sort((left, right) =>
      left.book.id.localeCompare(right.book.id),
    ),
    removedBooks: [...state.removedBooks].sort((left, right) =>
      left.logicalBookId.localeCompare(right.logicalBookId),
    ),
    variants: [...state.variants].sort((left, right) =>
      left.variant.id.localeCompare(right.variant.id),
    ),
    removedVariants: [...state.removedVariants].sort((left, right) =>
      left.variantId.localeCompare(right.variantId),
    ),
    preferences: [...state.preferences].sort((left, right) =>
      left.logicalBookId.localeCompare(right.logicalBookId),
    ),
    reconciliations: [...state.reconciliations].sort((left, right) =>
      left.reconciliation.conflictId.localeCompare(
        right.reconciliation.conflictId,
      ),
    ),
  };
  canonical.heads = [
    ...new Set(stateClocks(canonical).map((clock) => clock.changeId)),
  ].sort();
  return canonical;
}

function isLogicalBookStateDocument(
  value: unknown,
): value is LogicalBookStateDocument {
  if (!isRecord(value) || value['schemaVersion'] !== 1) return false;
  const heads = value['heads'];
  const books = value['books'];
  const removedBooks = value['removedBooks'];
  const variants = value['variants'];
  const removedVariants = value['removedVariants'];
  const preferences = value['preferences'];
  const reconciliations = value['reconciliations'];
  if (
    !Array.isArray(heads) ||
    !Array.isArray(books) ||
    !Array.isArray(removedBooks) ||
    !Array.isArray(variants) ||
    !Array.isArray(removedVariants) ||
    !Array.isArray(preferences) ||
    !Array.isArray(reconciliations)
  )
    return false;
  const count =
    books.length +
    removedBooks.length +
    variants.length +
    removedVariants.length +
    preferences.length +
    reconciliations.length;
  if (
    count > LOGICAL_BOOK_STATE_MAX_RECORDS ||
    !isSortedUniqueStrings(heads, OPAQUE_ID)
  )
    return false;
  if (
    !books.every(
      (entry) =>
        isRecord(entry) &&
        isLogicalBookRecord(entry['book']) &&
        isClock(entry['clock']),
    ) ||
    !uniqueBy(books, (entry) => (entry as { book: LogicalBookRecord }).book.id)
  )
    return false;
  if (
    !removedBooks.every(
      (entry) =>
        isRecord(entry) &&
        isLogicalBookId(entry['logicalBookId']) &&
        isClock(entry['clock']),
    ) ||
    !uniqueBy(removedBooks, (entry) =>
      String((entry as Record<string, unknown>)['logicalBookId']),
    )
  )
    return false;
  if (
    !variants.every(
      (entry) =>
        isRecord(entry) &&
        isBookRecord(entry['variant']) &&
        entry['objectPath'] === bookObjectPath(entry['variant']) &&
        isClock(entry['clock']),
    ) ||
    !uniqueBy(
      variants,
      (entry) => (entry as { variant: BookRecord }).variant.id,
    )
  )
    return false;
  if (
    !removedVariants.every(
      (entry) =>
        isRecord(entry) &&
        isVariantId(entry['variantId']) &&
        (entry['format'] === 'epub' || entry['format'] === 'pdf') &&
        isClock(entry['clock']),
    ) ||
    !uniqueBy(removedVariants, (entry) =>
      String((entry as Record<string, unknown>)['variantId']),
    )
  )
    return false;
  if (
    !preferences.every(
      (entry) =>
        isRecord(entry) &&
        isLogicalBookId(entry['logicalBookId']) &&
        (entry['preference'] === null ||
          (isLogicalBookFormatPreference(entry['preference']) &&
            entry['preference'].logicalBookId === entry['logicalBookId'])) &&
        isClock(entry['clock']),
    ) ||
    !uniqueBy(preferences, (entry) =>
      String((entry as Record<string, unknown>)['logicalBookId']),
    )
  )
    return false;
  if (
    !reconciliations.every(
      (entry) =>
        isRecord(entry) &&
        isMembershipReconciliation(entry['reconciliation']) &&
        isClock(entry['clock']),
    ) ||
    !uniqueBy(
      reconciliations,
      (entry) =>
        (entry as { reconciliation: MembershipReconciliation }).reconciliation
          .conflictId,
    )
  )
    return false;
  const bookMap = new Map(
    (books as LogicalBookStateDocument['books']).map((entry) => [
      entry.book.id,
      entry,
    ]),
  );
  const removedBookMap = new Map(
    (removedBooks as LogicalBookStateDocument['removedBooks']).map((entry) => [
      entry.logicalBookId,
      entry,
    ]),
  );
  if (
    [...bookMap].some(
      ([id, active]) =>
        compareClocks(active.clock, removedBookMap.get(id)?.clock) <= 0,
    )
  )
    return false;
  const variantMap = new Map(
    (variants as LogicalBookStateDocument['variants']).map((entry) => [
      entry.variant.id,
      entry,
    ]),
  );
  const removedVariantMap = new Map(
    (removedVariants as LogicalBookStateDocument['removedVariants']).map(
      (entry) => [entry.variantId, entry],
    ),
  );
  if (
    [...variantMap].some(
      ([id, active]) =>
        compareClocks(active.clock, removedVariantMap.get(id)?.clock) <= 0,
    )
  )
    return false;
  const membershipsSeen = new Set<string>();
  for (const { book } of bookMap.values()) {
    for (const [format, id] of Object.entries(book.variants)) {
      const variant = variantMap.get(id as string)?.variant;
      const membership = `${format}:${id}`;
      if (
        !variant ||
        variant.format !== format ||
        membershipsSeen.has(membership)
      )
        return false;
      membershipsSeen.add(membership);
    }
  }
  if (
    [...variantMap.keys()].some(
      (id) =>
        !membershipsSeen.has(`${variantMap.get(id)?.variant.format}:${id}`),
    )
  )
    return false;
  const expectedHeads = [
    ...new Set(
      stateClocks(value as unknown as LogicalBookStateDocument).map(
        (clock) => clock.changeId,
      ),
    ),
  ].sort();
  return JSON.stringify(heads) === JSON.stringify(expectedHeads);
}

function orderChanges(changes: LogicalBookChange[]): LogicalBookChange[] {
  const byId = new Map(changes.map((change) => [change.changeId, change]));
  return changes.sort((left, right) =>
    isAncestor(left.changeId, right.changeId, byId)
      ? -1
      : isAncestor(right.changeId, left.changeId, byId)
        ? 1
        : compareClocks(clockOf(left), clockOf(right)),
  );
}

function isAncestor(
  ancestorId: string,
  descendantId: string,
  changes: ReadonlyMap<string, LogicalBookChange>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(descendantId)) return false;
  seen.add(descendantId);
  const descendant = changes.get(descendantId);
  return !!descendant?.parents.some(
    (parent) =>
      parent === ancestorId || isAncestor(ancestorId, parent, changes, seen),
  );
}

function clockOf(change: LogicalBookChange): LogicalBookStateClock {
  return {
    changeId: change.changeId,
    createdAt: change.createdAt,
    deviceId: change.deviceId,
  };
}

function clockWins(
  candidate: LogicalBookStateClock,
  current?: LogicalBookStateClock,
): boolean {
  return !current || compareClocks(candidate, current) > 0;
}

function compareClocks(
  left: LogicalBookStateClock,
  right?: LogicalBookStateClock,
): number {
  if (!right) return 1;
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.changeId.localeCompare(right.changeId)
  );
}

function isClock(value: unknown): value is LogicalBookStateClock {
  if (
    !isRecord(value) ||
    !OPAQUE_ID.test(String(value['changeId'])) ||
    typeof value['deviceId'] !== 'string' ||
    value['deviceId'].length < 1 ||
    value['deviceId'].length > 256 ||
    typeof value['createdAt'] !== 'string'
  )
    return false;
  const time = Date.parse(value['createdAt']);
  return (
    Number.isFinite(time) && new Date(time).toISOString() === value['createdAt']
  );
}

function stateClocks(state: LogicalBookStateDocument): LogicalBookStateClock[] {
  return [
    ...state.books,
    ...state.removedBooks,
    ...state.variants,
    ...state.removedVariants,
    ...state.preferences,
    ...state.reconciliations,
  ].map((entry) => entry.clock);
}

function memberships(book: LogicalBookRecord): MembershipTuple[] {
  return (Object.entries(book.variants) as [PublicationFormat, string][])
    .map(([format, variantId]) => ({
      logicalBookId: book.id,
      format,
      variantId,
    }))
    .sort(
      (left, right) =>
        left.logicalBookId.localeCompare(right.logicalBookId) ||
        left.format.localeCompare(right.format) ||
        left.variantId.localeCompare(right.variantId),
    );
}

function membershipConflicts(
  proposed: LogicalBookRecord,
  books: ReadonlyMap<string, { book: LogicalBookRecord }>,
): MembershipTuple[] {
  const conflicts: MembershipTuple[] = [];
  for (const [format, variantId] of Object.entries(proposed.variants) as [
    PublicationFormat,
    string,
  ][]) {
    for (const { book } of books.values()) {
      if (book.id !== proposed.id && book.variants[format] === variantId)
        conflicts.push({ logicalBookId: book.id, format, variantId });
    }
  }
  return conflicts;
}

function deterministicConflictId(
  changeIds: readonly string[],
  variantIds: readonly string[],
): string {
  const input = [...changeIds, ...variantIds].sort().join('|');
  let hash = 2166136261;
  for (const character of input) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `conflict:membership:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function uniqueBy(values: unknown[], key: (value: unknown) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

function isSortedUniqueStrings(value: unknown[], pattern: RegExp): boolean {
  return (
    value.every((entry) => typeof entry === 'string' && pattern.test(entry)) &&
    new Set(value).size === value.length &&
    value.every(
      (entry, index) => index === 0 || String(value[index - 1]) < String(entry),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
