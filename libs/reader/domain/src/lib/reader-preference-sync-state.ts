import type {
  EpubReaderPreferences,
  PdfReaderPreferences,
} from './reader-preferences';

const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 256;

export const EPUB_READER_PREFERENCE_FIELDS = [
  'theme',
  'fontFamily',
  'fontSizePercent',
  'lineHeight',
  'paragraphSpacingRem',
  'marginPercent',
  'maxLineWidthRem',
  'flow',
  'spread',
] as const;

export const PDF_READER_PREFERENCE_FIELDS = [
  'zoomMode',
  'zoomPercent',
  'rotation',
] as const;

export type EpubReaderPreferenceField =
  (typeof EPUB_READER_PREFERENCE_FIELDS)[number];
export type PdfReaderPreferenceField =
  (typeof PDF_READER_PREFERENCE_FIELDS)[number];

type EpubPreferenceValues = Omit<EpubReaderPreferences, 'format'>;
type PdfPreferenceValues = Omit<PdfReaderPreferences, 'format'>;

export interface ReaderPreferenceRegister<Value> {
  readonly value: Value;
  readonly revision: number;
  readonly deviceId: string;
  readonly changeId: string;
}

export type ReaderPreferenceRegisters<Values> = {
  readonly [Field in keyof Values]?: ReaderPreferenceRegister<Values[Field]>;
};

export interface ReaderPreferenceSyncState {
  readonly schemaVersion: 1;
  readonly epub: ReaderPreferenceRegisters<EpubPreferenceValues>;
  readonly pdf: ReaderPreferenceRegisters<PdfPreferenceValues>;
}

type EpubReaderPreferenceChange = {
  [Field in EpubReaderPreferenceField]: {
    readonly schemaVersion: 1;
    readonly format: 'epub';
    readonly field: Field;
    readonly register: ReaderPreferenceRegister<EpubPreferenceValues[Field]>;
  };
}[EpubReaderPreferenceField];

type PdfReaderPreferenceChange = {
  [Field in PdfReaderPreferenceField]: {
    readonly schemaVersion: 1;
    readonly format: 'pdf';
    readonly field: Field;
    readonly register: ReaderPreferenceRegister<PdfPreferenceValues[Field]>;
  };
}[PdfReaderPreferenceField];

export type ReaderPreferenceChange =
  | EpubReaderPreferenceChange
  | PdfReaderPreferenceChange;

export interface ReaderPreferenceSyncMetadata {
  readonly schemaVersion: 1;
  readonly destinationId: string;
  readonly baseline: 'remote' | 'seeded';
  readonly state: ReaderPreferenceSyncState;
}

export interface ReaderPreferenceChangeOutbox {
  listPendingReaderPreferenceChanges(): Promise<
    readonly ReaderPreferenceChange[]
  >;
  acknowledgePendingReaderPreferenceChanges(
    changeIds: readonly string[],
  ): Promise<void>;
}

export interface ReaderPreferenceSyncPersistence
  extends ReaderPreferenceChangeOutbox {
  saveReaderPreferencesWithChange(
    preferences: EpubReaderPreferences | PdfReaderPreferences,
    change: ReaderPreferenceChange,
  ): Promise<void>;
  getReaderPreferenceSyncMetadata(
    destinationId: string,
  ): Promise<ReaderPreferenceSyncMetadata | null>;
  saveReaderPreferenceSyncMetadata(
    metadata: ReaderPreferenceSyncMetadata,
  ): Promise<void>;
}

export function isReaderPreferenceChange(
  value: unknown,
): value is ReaderPreferenceChange {
  return (
    isExactRecord(value, ['schemaVersion', 'format', 'field', 'register']) &&
    value['schemaVersion'] === 1 &&
    (value['format'] === 'epub' || value['format'] === 'pdf') &&
    typeof value['field'] === 'string' &&
    isPreferenceRegister(value['register']) &&
    isPreferenceValue(
      value['format'],
      value['field'],
      value['register']['value'],
    )
  );
}

export function isReaderPreferenceSyncMetadata(
  value: unknown,
): value is ReaderPreferenceSyncMetadata {
  return (
    isExactRecord(value, [
      'schemaVersion',
      'destinationId',
      'baseline',
      'state',
    ]) &&
    value['schemaVersion'] === 1 &&
    isBoundedId(value['destinationId']) &&
    (value['baseline'] === 'remote' || value['baseline'] === 'seeded') &&
    isReaderPreferenceSyncState(value['state'])
  );
}

export function readerPreferenceChangeMatches(
  preferences: EpubReaderPreferences | PdfReaderPreferences,
  change: ReaderPreferenceChange,
): boolean {
  return (
    preferences.format === change.format &&
    (preferences as unknown as Record<string, unknown>)[change.field] ===
      change.register.value
  );
}

export function isReaderPreferenceSyncState(
  value: unknown,
): value is ReaderPreferenceSyncState {
  return (
    isExactRecord(value, ['schemaVersion', 'epub', 'pdf']) &&
    value['schemaVersion'] === 1 &&
    isPreferenceSection(value['epub'], 'epub') &&
    isPreferenceSection(value['pdf'], 'pdf')
  );
}

export function parseReaderPreferenceSyncState(
  document: string,
): ReaderPreferenceSyncState {
  if (new TextEncoder().encode(document).byteLength > MAX_DOCUMENT_BYTES) {
    throw new TypeError('Reader preference synchronization state is too large');
  }

  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch {
    throw new TypeError('Reader preference synchronization state is invalid');
  }

  if (
    hasDuplicateJsonObjectKeys(document) ||
    !isReaderPreferenceSyncState(value)
  ) {
    throw new TypeError('Reader preference synchronization state is invalid');
  }
  return value;
}

export function serializeReaderPreferenceSyncState(
  state: ReaderPreferenceSyncState,
): string {
  if (!isReaderPreferenceSyncState(state)) {
    throw new TypeError('Reader preference synchronization state is invalid');
  }
  return JSON.stringify({
    schemaVersion: 1,
    epub: canonicalSection(state.epub, EPUB_READER_PREFERENCE_FIELDS),
    pdf: canonicalSection(state.pdf, PDF_READER_PREFERENCE_FIELDS),
  });
}

export function mergeReaderPreferenceSyncStates(
  left: ReaderPreferenceSyncState,
  right: ReaderPreferenceSyncState,
): ReaderPreferenceSyncState {
  if (
    !isReaderPreferenceSyncState(left) ||
    !isReaderPreferenceSyncState(right)
  ) {
    throw new TypeError('Reader preference synchronization state is invalid');
  }
  return {
    schemaVersion: 1,
    epub: mergeSections(left.epub, right.epub, EPUB_READER_PREFERENCE_FIELDS),
    pdf: mergeSections(left.pdf, right.pdf, PDF_READER_PREFERENCE_FIELDS),
  };
}

function mergeSections<Values>(
  left: ReaderPreferenceRegisters<Values>,
  right: ReaderPreferenceRegisters<Values>,
  fields: readonly (keyof Values)[],
): ReaderPreferenceRegisters<Values> {
  const result: Partial<{
    [Field in keyof Values]: ReaderPreferenceRegister<Values[Field]>;
  }> = {};
  for (const field of fields) {
    const leftRegister = left[field];
    const rightRegister = right[field];
    const winner = preferredRegister(leftRegister, rightRegister);
    if (winner) {
      result[field] = { ...winner };
    }
  }
  return result;
}

function preferredRegister<Value>(
  left: ReaderPreferenceRegister<Value> | undefined,
  right: ReaderPreferenceRegister<Value> | undefined,
): ReaderPreferenceRegister<Value> | undefined {
  if (!left) return right;
  if (!right) return left;
  return compareRegisters(right, left) > 0 ? right : left;
}

function compareRegisters<Value>(
  left: ReaderPreferenceRegister<Value>,
  right: ReaderPreferenceRegister<Value>,
): number {
  return (
    left.revision - right.revision ||
    left.deviceId.localeCompare(right.deviceId) ||
    left.changeId.localeCompare(right.changeId)
  );
}

function canonicalSection<Values>(
  section: ReaderPreferenceRegisters<Values>,
  fields: readonly (keyof Values)[],
): Partial<{
  [Field in keyof Values]: ReaderPreferenceRegister<Values[Field]>;
}> {
  const result: Partial<{
    [Field in keyof Values]: ReaderPreferenceRegister<Values[Field]>;
  }> = {};
  for (const field of fields) {
    const register = section[field];
    if (register) {
      result[field] = {
        value: register.value,
        revision: register.revision,
        deviceId: register.deviceId,
        changeId: register.changeId,
      };
    }
  }
  return result;
}

function isPreferenceSection(value: unknown, format: 'epub' | 'pdf'): boolean {
  if (!isRecord(value)) return false;
  const fields =
    format === 'epub'
      ? EPUB_READER_PREFERENCE_FIELDS
      : PDF_READER_PREFERENCE_FIELDS;
  if (!Object.keys(value).every((key) => fields.includes(key as never))) {
    return false;
  }
  return Object.entries(value).every(
    ([field, register]) =>
      isPreferenceRegister(register) &&
      isPreferenceValue(format, field, register['value']),
  );
}

function isPreferenceRegister(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isExactRecord(value, ['value', 'revision', 'deviceId', 'changeId']) &&
    Number.isSafeInteger(value['revision']) &&
    Number(value['revision']) >= 0 &&
    isBoundedId(value['deviceId']) &&
    isBoundedId(value['changeId'])
  );
}

function isPreferenceValue(
  format: 'epub' | 'pdf',
  field: string,
  value: unknown,
): boolean {
  if (format === 'epub') {
    switch (field) {
      case 'theme':
        return value === 'light' || value === 'sepia' || value === 'dark';
      case 'fontFamily':
        return value === 'serif' || value === 'sans-serif';
      case 'fontSizePercent':
        return isNumberInRange(value, 50, 300);
      case 'lineHeight':
        return isNumberInRange(value, 0.5, 4);
      case 'paragraphSpacingRem':
        return isNumberInRange(value, 0, 10);
      case 'marginPercent':
        return isNumberInRange(value, 0, 40);
      case 'maxLineWidthRem':
        return isNumberInRange(value, 10, 200);
      case 'flow':
        return (
          value === 'auto' || value === 'paginated' || value === 'scrolled'
        );
      case 'spread':
        return value === 'none' || value === 'auto';
      default:
        return false;
    }
  }
  switch (field) {
    case 'zoomMode':
      return (
        value === 'fit-width' || value === 'fit-page' || value === 'custom'
      );
    case 'zoomPercent':
      return isNumberInRange(value, 10, 1_000);
    case 'rotation':
      return value === 0 || value === 90 || value === 180 || value === 270;
    default:
      return false;
  }
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function hasDuplicateJsonObjectKeys(document: string): boolean {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(document[index] ?? '')) index += 1;
  };
  const readString = (): string => {
    const start = index;
    index += 1;
    while (index < document.length) {
      if (document[index] === '\\') {
        index += 2;
      } else if (document[index] === '"') {
        index += 1;
        return JSON.parse(document.slice(start, index)) as string;
      } else {
        index += 1;
      }
    }
    return '';
  };
  const visitValue = (): boolean => {
    skipWhitespace();
    if (document[index] === '{') return visitObject();
    if (document[index] === '[') return visitArray();
    if (document[index] === '"') {
      readString();
      return false;
    }
    while (index < document.length && !/[\s,}\]]/.test(document[index])) {
      index += 1;
    }
    return false;
  };
  const visitObject = (): boolean => {
    const keys = new Set<string>();
    index += 1;
    skipWhitespace();
    while (document[index] !== '}') {
      const key = readString();
      if (keys.has(key)) return true;
      keys.add(key);
      skipWhitespace();
      index += 1;
      if (visitValue()) return true;
      skipWhitespace();
      if (document[index] === ',') {
        index += 1;
        skipWhitespace();
      }
    }
    index += 1;
    return false;
  };
  const visitArray = (): boolean => {
    index += 1;
    skipWhitespace();
    while (document[index] !== ']') {
      if (visitValue()) return true;
      skipWhitespace();
      if (document[index] === ',') {
        index += 1;
        skipWhitespace();
      }
    }
    index += 1;
    return false;
  };
  return visitValue();
}
