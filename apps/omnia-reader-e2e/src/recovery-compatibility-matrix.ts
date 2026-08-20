export const canonicalInventoryFields = [
  'membership',
  'exactHashesAndSizes',
  'availability',
  'preferredFormat',
  'progress',
  'progressDocuments',
  'bookmarks',
  'annotations',
  'tombstones',
  'exclusions',
  'pendingJournalOperations',
  'coversAndCatalogOwnership',
] as const;

export type CanonicalInventoryField = (typeof canonicalInventoryFields)[number];

type RecoveryOperation =
  | 'add'
  | 'associate'
  | 'detach'
  | 'delete-non-last'
  | 'preference-change'
  | 'exact-source-replacement';

export interface RecoveryMatrixRow {
  id: string;
  owner: 'storage' | 'offline' | 'sync';
  operation: string;
  recoveryPoint: string;
  expectedState: 'before' | 'after';
  inventory: readonly CanonicalInventoryField[];
}

const operations: readonly RecoveryOperation[] = [
  'add',
  'associate',
  'detach',
  'delete-non-last',
  'preference-change',
  'exact-source-replacement',
];

const localRows: RecoveryMatrixRow[] = operations.flatMap((operation) =>
  ['before-transaction', 'transaction-abort', 'post-commit-pre-journal'].map(
    (recoveryPoint) => ({
      id: `REC-${operation}-${recoveryPoint}`,
      owner: 'storage' as const,
      operation,
      recoveryPoint,
      expectedState:
        recoveryPoint === 'post-commit-pre-journal'
          ? ('after' as const)
          : ('before' as const),
      inventory: canonicalInventoryFields,
    }),
  ),
);

const syncRows: RecoveryMatrixRow[] = operations.flatMap((operation) =>
  ['interrupted-upload', 'interrupted-download'].map((recoveryPoint) => ({
    id: `REC-${operation}-${recoveryPoint}`,
    owner: 'sync' as const,
    operation,
    recoveryPoint,
    expectedState: 'after' as const,
    inventory: canonicalInventoryFields,
  })),
);

const offlineRows: RecoveryMatrixRow[] = operations.map((operation) => ({
  id: `REC-${operation}-offline-restart`,
  owner: 'offline',
  operation,
  recoveryPoint: 'offline-restart',
  expectedState: 'after',
  inventory: canonicalInventoryFields,
}));

const cancellationRows: RecoveryMatrixRow[] = [
  'picker',
  'association',
  'detach',
  'delete',
  'replace-source',
].map((operation) => ({
  id: `REC-${operation}-cancelled`,
  owner: 'storage',
  operation,
  recoveryPoint: 'cancelled',
  expectedState: 'before',
  inventory: canonicalInventoryFields,
}));

const validationRows: RecoveryMatrixRow[] = [
  'unsupported',
  'corrupt',
  'duplicate-here',
  'duplicate-elsewhere',
  'occupied-format',
  'replacement-identity-mismatch',
  'replacement-format-mismatch',
].map((operation) => ({
  id: `REC-validation-${operation}`,
  owner: 'storage',
  operation,
  recoveryPoint: 'validation-rejection',
  expectedState: 'before',
  inventory: canonicalInventoryFields,
}));

export const recoveryMatrixRows: readonly RecoveryMatrixRow[] = [
  ...localRows,
  ...syncRows,
  ...offlineRows,
  ...cancellationRows,
  ...validationRows,
];

export interface CompatibilityMatrixRow {
  id: string;
  owner: 'migration' | 'backup' | 'sync';
  scenario: string;
  inventory: readonly CanonicalInventoryField[];
  providers?: readonly ['git', 'mega'];
}

export const compatibilityMatrixRows: readonly CompatibilityMatrixRow[] = [
  ...['singleton-epub', 'singleton-pdf', 'mixed-library'].map((scenario) => ({
    id: `COMP-v8-${scenario}`,
    owner: 'migration' as const,
    scenario,
    inventory: canonicalInventoryFields,
  })),
  ...[1, 2, 3, 4].map((schema) => ({
    id: `COMP-backup-schema-${schema}`,
    owner: 'backup' as const,
    scenario: `schema-${schema}`,
    inventory: canonicalInventoryFields,
  })),
  ...[
    'interrupted-association-restart',
    'new-new-non-conflicting-membership',
    'new-new-conflicting-membership',
    'concurrent-preferred-formats',
    'legacy-sync-read',
    'unsupported-newer-mixed-refusal',
    'membership-deletion-tombstone-exclusion',
  ].map((scenario) => ({
    id: `COMP-sync-${scenario}`,
    owner: 'sync' as const,
    scenario,
    inventory: canonicalInventoryFields,
    providers: ['git', 'mega'] as const,
  })),
];

export function rowsOwnedBy<T extends { owner: string }>(
  rows: readonly T[],
  owner: T['owner'],
): readonly T[] {
  return rows.filter((row) => row.owner === owner);
}

export function assertClosedMatrix(
  rows: readonly { id: string; inventory: readonly string[] }[],
  expectedSize: number,
): void {
  if (rows.length !== expectedSize) {
    throw new Error(`Expected ${expectedSize} rows, received ${rows.length}`);
  }
  if (new Set(rows.map(({ id }) => id)).size !== expectedSize) {
    throw new Error('Matrix row IDs must be unique');
  }
  for (const row of rows) {
    if (
      row.inventory.length !== canonicalInventoryFields.length ||
      canonicalInventoryFields.some((field) => !row.inventory.includes(field))
    ) {
      throw new Error(`${row.id} does not compare the canonical inventory`);
    }
  }
}
