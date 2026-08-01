import {
  LogicalBookChange,
  LogicalBookFormatPreference,
  LogicalBookRecord,
  MembershipReconciliation,
  MembershipTuple,
  PublicationFormat,
} from '@omnia-reader/reader/domain';

export interface LogicalBookMergeResult {
  books: LogicalBookRecord[];
  preferences: LogicalBookFormatPreference[];
  reconciliations: MembershipReconciliation[];
  heads: string[];
  appliedChangeIds: string[];
}

export function foldLogicalBookChanges(
  changes: readonly LogicalBookChange[],
): LogicalBookMergeResult {
  const byId = new Map(changes.map((change) => [change.changeId, change]));
  if (byId.size !== changes.length)
    throw new Error('Duplicate logical change ID');
  const ordered = [...changes].sort((left, right) =>
    isAncestor(left.changeId, right.changeId, byId)
      ? -1
      : isAncestor(right.changeId, left.changeId, byId)
        ? 1
        : left.changeId.localeCompare(right.changeId),
  );
  const books = new Map<string, LogicalBookRecord>();
  const preferences = new Map<string, LogicalBookFormatPreference>();
  const reconciliations = new Map<string, MembershipReconciliation>();

  for (const change of ordered) {
    const candidateBooks = new Map(books);
    for (const removedId of change.removedLogicalBookIds)
      candidateBooks.delete(removedId);
    const competing: Array<{
      proposed: LogicalBookRecord;
      conflicts: MembershipTuple[];
    }> = [];
    for (const proposed of change.resultingBooks) {
      const conflicts = membershipConflicts(proposed, candidateBooks);
      if (conflicts.length === 0) {
        candidateBooks.set(proposed.id, proposed);
      } else {
        competing.push({ proposed, conflicts });
      }
    }
    if (competing.length === 0) {
      books.clear();
      candidateBooks.forEach((book, id) => books.set(id, book));
    } else {
      const rejectedMembership = competing.flatMap(({ proposed }) =>
        memberships(proposed),
      );
      const proposedVariantIds = new Set(
        rejectedMembership.map((membership) => membership.variantId),
      );
      const acceptedMembership = [...books.values()]
        .filter((book) =>
          Object.values(book.variants).some(
            (variantId) => variantId && proposedVariantIds.has(variantId),
          ),
        )
        .flatMap(memberships);
      const conflictingChanges = [
        change.changeId,
        ...acceptedMembership.map((membership) =>
          ownerChangeId(membership.logicalBookId, ordered),
        ),
      ];
      const affectedVariantIds = [
        ...new Set(
          [...acceptedMembership, ...rejectedMembership].map(
            (membership) => membership.variantId,
          ),
        ),
      ].sort();
      const conflictId = deterministicConflictId(
        conflictingChanges,
        affectedVariantIds,
      );
      reconciliations.set(conflictId, {
        schemaVersion: 1,
        conflictId,
        status: 'open',
        conflictingChangeIds: [...new Set(conflictingChanges)].sort(),
        affectedVariantIds,
        acceptedMembership,
        rejectedMembership,
        detectedAt: change.createdAt,
      });
    }
    for (const effect of change.preferenceEffects ?? []) {
      if (effect.preference === null) preferences.delete(effect.logicalBookId);
      else preferences.set(effect.logicalBookId, effect.preference);
    }
    for (const conflictId of change.resolvesConflictIds ?? []) {
      const conflict = reconciliations.get(conflictId);
      if (conflict) {
        reconciliations.set(conflictId, {
          ...conflict,
          status: 'resolved',
          resolvedByChangeId: change.changeId,
        });
      }
    }
  }

  const parentIds = new Set(ordered.flatMap((change) => change.parents));
  return {
    books: [...books.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    preferences: [...preferences.values()].sort((left, right) =>
      left.logicalBookId.localeCompare(right.logicalBookId),
    ),
    reconciliations: [...reconciliations.values()].sort((left, right) =>
      left.conflictId.localeCompare(right.conflictId),
    ),
    heads: ordered
      .map((change) => change.changeId)
      .filter((id) => !parentIds.has(id))
      .sort(),
    appliedChangeIds: ordered.map((change) => change.changeId),
  };
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
  books: ReadonlyMap<string, LogicalBookRecord>,
): MembershipTuple[] {
  const conflicts: MembershipTuple[] = [];
  for (const [format, variantId] of Object.entries(proposed.variants) as [
    PublicationFormat,
    string,
  ][]) {
    for (const current of books.values()) {
      if (
        current.id !== proposed.id &&
        current.variants[format] === variantId
      ) {
        conflicts.push({ logicalBookId: current.id, format, variantId });
      }
    }
  }
  return conflicts;
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

function ownerChangeId(
  logicalBookId: string,
  ordered: readonly LogicalBookChange[],
): string {
  return (
    [...ordered]
      .reverse()
      .find((change) =>
        change.resultingBooks.some((book) => book.id === logicalBookId),
      )?.changeId ?? 'change:bootstrap'
  );
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
