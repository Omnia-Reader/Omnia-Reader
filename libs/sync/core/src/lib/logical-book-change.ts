import {
  BookRecord,
  isBookRecord,
  isLogicalBookChange,
  isLogicalBookFormatPreference,
  isLogicalBookId,
  isVariantId,
  LogicalBookChange,
  LogicalPreferenceEffect,
  LogicalVariantEffect,
} from '@omnia-reader/reader/domain';
import { bookObjectPath, LEGACY_BOOKS_ROOT } from './book-sync-manifest';
import { SYNC_ROOT } from './library-sync-manifest';

const CHANGE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

export function logicalBookChangePath(changeId: string): string {
  if (!CHANGE_ID.test(changeId))
    throw new TypeError('Logical change ID is unsafe');
  return `${SYNC_ROOT}/logical-books/changes/${encodeURIComponent(changeId)}.json`;
}

export function isSynchronizedLogicalBookChange(
  value: unknown,
): value is LogicalBookChange {
  if (!isLogicalBookChange(value) || containsAvailability(value)) return false;
  const variantEffects = value.variantEffects ?? [];
  const preferenceEffects = value.preferenceEffects ?? [];
  const resolves = value.resolvesConflictIds ?? [];
  return (
    variantEffects.length <= 4 &&
    variantEffects.every(isVariantEffect) &&
    preferenceEffects.length <= 2 &&
    preferenceEffects.every(isPreferenceEffect) &&
    resolves.length <= 32 &&
    resolves.every((id) => typeof id === 'string' && CHANGE_ID.test(id)) &&
    new Set(resolves).size === resolves.length
  );
}

export function serializeLogicalBookChange(change: LogicalBookChange): string {
  if (!isSynchronizedLogicalBookChange(change)) {
    throw new TypeError('Logical book change is invalid');
  }
  const canonical: LogicalBookChange = {
    ...change,
    parents: [...change.parents].sort(),
    resultingBooks: [...change.resultingBooks].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    removedLogicalBookIds: [...change.removedLogicalBookIds].sort(),
    variantEffects: [...(change.variantEffects ?? [])].sort(
      compareVariantEffects,
    ),
    preferenceEffects: [...(change.preferenceEffects ?? [])].sort(
      (left, right) => left.logicalBookId.localeCompare(right.logicalBookId),
    ),
    resolvesConflictIds: [...(change.resolvesConflictIds ?? [])].sort(),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function parseLogicalBookChange(content: string): LogicalBookChange {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TypeError('Logical book change is not valid JSON');
  }
  if (!isSynchronizedLogicalBookChange(value)) {
    throw new TypeError('Logical book change failed schema validation');
  }
  return value;
}

function isVariantEffect(value: unknown): value is LogicalVariantEffect {
  if (!isRecord(value)) return false;
  if (value['operation'] === 'delete') {
    return (
      isVariantId(value['variantId']) &&
      (value['format'] === 'epub' || value['format'] === 'pdf')
    );
  }
  return (
    value['operation'] === 'upsert' &&
    isBookRecord(value['variant']) &&
    typeof value['objectPath'] === 'string' &&
    isSafeObjectPath(value['objectPath'], value['variant'])
  );
}

function isPreferenceEffect(value: unknown): value is LogicalPreferenceEffect {
  return (
    isRecord(value) &&
    isLogicalBookId(value['logicalBookId']) &&
    (value['preference'] === null ||
      (isLogicalBookFormatPreference(value['preference']) &&
        value['preference'].logicalBookId === value['logicalBookId']))
  );
}

function isSafeObjectPath(path: string, variant: BookRecord): boolean {
  const digest = variant.id.slice('sha256:'.length);
  return (
    path === bookObjectPath(variant) ||
    path === `${LEGACY_BOOKS_ROOT}/${digest}/publication.${variant.format}`
  );
}

function containsAvailability(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAvailability);
  if (!isRecord(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'availability')) return true;
  return Object.entries(value).some(
    ([key, child]) =>
      (key === 'status' &&
        ['checking', 'healthy', 'unavailable', 'quarantined'].includes(
          String(child),
        )) ||
      containsAvailability(child),
  );
}

function compareVariantEffects(
  left: LogicalVariantEffect,
  right: LogicalVariantEffect,
): number {
  const leftId = left.operation === 'upsert' ? left.variant.id : left.variantId;
  const rightId =
    right.operation === 'upsert' ? right.variant.id : right.variantId;
  return (
    leftId.localeCompare(rightId) ||
    left.operation.localeCompare(right.operation)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
