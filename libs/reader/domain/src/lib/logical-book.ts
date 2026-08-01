import type { BookRecord, PublicationFormat } from './publication';

export type LogicalBookId = `logical:sha256:${string}`;
export type LogicalChangeId = string;
export type LogicalCausalHead = LogicalChangeId;
export type MembershipConflictId = string;

export interface LogicalMutationIdentity {
  changeId: LogicalChangeId;
  parents: LogicalChangeId[];
  createdAt: string;
  deviceId: string;
  appVersion: string;
}

export type VariantAvailability =
  | { status: 'checking'; cause?: never }
  | { status: 'healthy'; cause?: never }
  | {
      status: 'unavailable';
      cause: 'missing' | 'evicted' | 'inaccessible' | 'incomplete';
    }
  | {
      status: 'quarantined';
      cause: 'integrity-invalid' | 'unsupported' | 'malformed-reference';
    };

export interface LogicalBookRecord {
  schemaVersion: 1;
  id: LogicalBookId;
  title: string;
  authors: string[];
  language?: string;
  publisher?: string;
  identifier?: string;
  importedAt: string;
  updatedAt: string;
  coverState: 'pending' | 'available' | 'unavailable';
  variants: Partial<Record<PublicationFormat, string>>;
}

export interface LogicalBookFormatPreference {
  schemaVersion: 1;
  logicalBookId: LogicalBookId;
  preferredFormat: PublicationFormat;
  winningChangeId: LogicalChangeId;
  preferenceHeads: LogicalChangeId[];
  updatedAt: string;
  deviceId: string;
}

export interface MembershipTuple {
  logicalBookId: LogicalBookId;
  format: PublicationFormat;
  variantId: string;
}

export interface MembershipReconciliation {
  schemaVersion: 1;
  conflictId: string;
  status: 'open' | 'resolved';
  conflictingChangeIds: LogicalChangeId[];
  affectedVariantIds: string[];
  acceptedMembership: MembershipTuple[];
  rejectedMembership: MembershipTuple[];
  resolvedByChangeId?: LogicalChangeId;
  detectedAt: string;
}

export type LogicalBookChangeKind =
  | 'bootstrap'
  | 'add-variant'
  | 'associate'
  | 'detach'
  | 'delete-variant'
  | 'delete-book'
  | 'metadata'
  | 'preference'
  | 'reconcile-membership';

export interface LogicalBookChange {
  schemaVersion: 1;
  changeId: LogicalChangeId;
  kind: LogicalBookChangeKind;
  parents: LogicalChangeId[];
  resultingBooks: LogicalBookRecord[];
  removedLogicalBookIds: LogicalBookId[];
  variantEffects?: LogicalVariantEffect[];
  preferenceEffects?: LogicalPreferenceEffect[];
  resolvesConflictIds?: MembershipConflictId[];
  createdAt: string;
  deviceId: string;
  appVersion: string;
}

export type LogicalVariantEffect =
  | { operation: 'upsert'; variant: BookRecord; objectPath: string }
  | {
      operation: 'delete';
      variantId: string;
      format: PublicationFormat;
    };

export interface LogicalPreferenceEffect {
  logicalBookId: LogicalBookId;
  preference: LogicalBookFormatPreference | null;
}

export interface LogicalBookMutationResult {
  createdLogicalBookIds: LogicalBookId[];
  updatedLogicalBookIds: LogicalBookId[];
  deletedLogicalBookIds: LogicalBookId[];
  createdVariantIds: string[];
  deletedVariantIds: string[];
  resultingBooks: LogicalBookRecord[];
  change: LogicalBookChange;
}

export interface LogicalLibrarySnapshot {
  revision: string;
  logicalBooks: LogicalBookRecord[];
  preferences: LogicalBookFormatPreference[];
  reconciliations: MembershipReconciliation[];
}

export type AddLogicalBookVariantResult =
  | { status: 'added'; mutation: LogicalBookMutationResult }
  | { status: 'already-member'; logicalBookId: LogicalBookId }
  | { status: 'belongs-to-other-book'; logicalBookId: LogicalBookId }
  | {
      status: 'same-format-conflict';
      logicalBookId: LogicalBookId;
      existingVariantId: string;
    };

export type MembershipReconciliationDecision =
  | { kind: 'keep-accepted' }
  | { kind: 'accept-rejected'; logicalBookId: LogicalBookId }
  | { kind: 'make-standalone'; variantId: string };

export function isLogicalBookChange(
  value: unknown,
): value is LogicalBookChange {
  if (!isRecord(value)) return false;
  const kinds: LogicalBookChangeKind[] = [
    'bootstrap',
    'add-variant',
    'associate',
    'detach',
    'delete-variant',
    'delete-book',
    'metadata',
    'preference',
    'reconcile-membership',
  ];
  return (
    value['schemaVersion'] === 1 &&
    isOpaqueId(value['changeId']) &&
    kinds.includes(value['kind'] as LogicalBookChangeKind) &&
    isSortedUniqueIdsAllowEmpty(value['parents'], 32) &&
    isBoundedArray(value['resultingBooks'], 2, isLogicalBookRecord) &&
    isBoundedArray(value['removedLogicalBookIds'], 2, isLogicalBookId) &&
    isCanonicalTimestamp(value['createdAt']) &&
    isBoundedString(value['deviceId'], 256) &&
    isBoundedString(value['appVersion'], 128)
  );
}

export function isLogicalBookMutationResult(
  value: unknown,
): value is LogicalBookMutationResult {
  return (
    isRecord(value) &&
    isBoundedArray(value['createdLogicalBookIds'], 2, isLogicalBookId) &&
    isBoundedArray(value['updatedLogicalBookIds'], 2, isLogicalBookId) &&
    isBoundedArray(value['deletedLogicalBookIds'], 2, isLogicalBookId) &&
    isBoundedArray(value['createdVariantIds'], 2, isVariantId) &&
    isBoundedArray(value['deletedVariantIds'], 2, isVariantId) &&
    isBoundedArray(value['resultingBooks'], 2, isLogicalBookRecord) &&
    isLogicalBookChange(value['change'])
  );
}

const VARIANT_ID = /^sha256:[a-f0-9]{64}$/;
const LOGICAL_BOOK_ID = /^logical:sha256:[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

export function singletonLogicalBookId(variantId: string): LogicalBookId {
  if (!isVariantId(variantId)) {
    throw new TypeError('Variant ID must be an exact SHA-256 publication ID');
  }
  return `logical:sha256:${variantId.slice('sha256:'.length)}`;
}

export function logicalBookFromVariant(
  variant: BookRecord,
  now = variant.importedAt,
): LogicalBookRecord {
  return {
    schemaVersion: 1,
    id: singletonLogicalBookId(variant.id),
    title: variant.title,
    authors: [...variant.authors],
    ...(variant.language ? { language: variant.language } : {}),
    ...(variant.publisher ? { publisher: variant.publisher } : {}),
    ...(variant.identifier ? { identifier: variant.identifier } : {}),
    importedAt: variant.importedAt,
    updatedAt: now,
    coverState: variant.coverState ?? 'pending',
    variants: { [variant.format]: variant.id },
  };
}

export function isVariantId(value: unknown): value is string {
  return typeof value === 'string' && VARIANT_ID.test(value);
}

export function isLogicalBookId(value: unknown): value is LogicalBookId {
  return typeof value === 'string' && LOGICAL_BOOK_ID.test(value);
}

export function isVariantAvailability(
  value: unknown,
): value is VariantAvailability {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (value['status'] === 'checking' || value['status'] === 'healthy') {
    return keys.every((key) => key === 'status');
  }
  if (value['status'] === 'unavailable') {
    return (
      keys.every((key) => key === 'status' || key === 'cause') &&
      ['missing', 'evicted', 'inaccessible', 'incomplete'].includes(
        String(value['cause']),
      )
    );
  }
  return (
    value['status'] === 'quarantined' &&
    keys.every((key) => key === 'status' || key === 'cause') &&
    ['integrity-invalid', 'unsupported', 'malformed-reference'].includes(
      String(value['cause']),
    )
  );
}

export function isLogicalBookRecord(
  value: unknown,
): value is LogicalBookRecord {
  if (!isRecord(value) || !isRecord(value['variants'])) return false;
  const variants = value['variants'];
  const epub = variants['epub'];
  const pdf = variants['pdf'];
  return (
    value['schemaVersion'] === 1 &&
    isLogicalBookId(value['id']) &&
    isBoundedString(value['title'], 1_024) &&
    isAuthors(value['authors']) &&
    isOptionalBoundedString(value['language'], 128) &&
    isOptionalBoundedString(value['publisher'], 1_024) &&
    isOptionalBoundedString(value['identifier'], 1_024) &&
    isCanonicalTimestamp(value['importedAt']) &&
    isCanonicalTimestamp(value['updatedAt']) &&
    ['pending', 'available', 'unavailable'].includes(
      String(value['coverState']),
    ) &&
    (epub === undefined || isVariantId(epub)) &&
    (pdf === undefined || isVariantId(pdf)) &&
    (epub !== undefined || pdf !== undefined) &&
    (epub === undefined || pdf === undefined || epub !== pdf) &&
    Object.keys(variants).every((key) => key === 'epub' || key === 'pdf')
  );
}

export function isLogicalBookFormatPreference(
  value: unknown,
): value is LogicalBookFormatPreference {
  return (
    isRecord(value) &&
    value['schemaVersion'] === 1 &&
    isLogicalBookId(value['logicalBookId']) &&
    (value['preferredFormat'] === 'epub' ||
      value['preferredFormat'] === 'pdf') &&
    isOpaqueId(value['winningChangeId']) &&
    isSortedUniqueIds(value['preferenceHeads'], 32) &&
    (value['preferenceHeads'] as unknown[]).includes(
      value['winningChangeId'],
    ) &&
    isCanonicalTimestamp(value['updatedAt']) &&
    isBoundedString(value['deviceId'], 256)
  );
}

export function isMembershipReconciliation(
  value: unknown,
): value is MembershipReconciliation {
  if (!isRecord(value)) return false;
  const status = value['status'];
  const resolvedBy = value['resolvedByChangeId'];
  return (
    value['schemaVersion'] === 1 &&
    isOpaqueId(value['conflictId']) &&
    (status === 'open' || status === 'resolved') &&
    isSortedUniqueIds(value['conflictingChangeIds'], 32) &&
    isSortedUniqueVariantIds(value['affectedVariantIds'], 32) &&
    isMemberships(value['acceptedMembership']) &&
    isMemberships(value['rejectedMembership']) &&
    (status === 'open' ? resolvedBy === undefined : isOpaqueId(resolvedBy)) &&
    isCanonicalTimestamp(value['detectedAt'])
  );
}

function isMemberships(value: unknown): value is MembershipTuple[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 4 &&
    value.every(
      (item) =>
        isRecord(item) &&
        isLogicalBookId(item['logicalBookId']) &&
        (item['format'] === 'epub' || item['format'] === 'pdf') &&
        isVariantId(item['variantId']),
    )
  );
}

function isSortedUniqueVariantIds(value: unknown, max: number): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(isVariantId) &&
    new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry)
  );
}

function isSortedUniqueIds(value: unknown, max: number): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(isOpaqueId) &&
    new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry)
  );
}

function isSortedUniqueIdsAllowEmpty(value: unknown, max: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(isOpaqueId) &&
    new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry)
  );
}

function isBoundedArray<T>(
  value: unknown,
  max: number,
  validator: (entry: unknown) => entry is T,
): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(validator);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isAuthors(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((author) => isBoundedString(author, 512))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || isBoundedString(value, max);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}
