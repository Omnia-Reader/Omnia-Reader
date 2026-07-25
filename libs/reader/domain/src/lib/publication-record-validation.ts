import type {
  BookRecord,
  PublicationFormat,
  PublicationLocator,
  ReadingProgress,
} from './publication';
import type { ReaderPreferences } from './reader-preferences';

const SHA256_BOOK_ID = /^sha256:[a-f0-9]{64}$/;

export function isBookRecord(value: unknown): value is BookRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isBookId(value['id']) &&
    isPublicationFormat(value['format']) &&
    isBoundedString(value['fileName'], 512) &&
    isBoundedString(value['mediaType'], 128) &&
    Number.isSafeInteger(value['size']) &&
    Number(value['size']) > 0 &&
    isBoundedString(value['title'], 1_024) &&
    Array.isArray(value['authors']) &&
    value['authors'].length <= 64 &&
    value['authors'].every((author) => isBoundedString(author, 512)) &&
    isOptionalBoundedString(value['language'], 128) &&
    isOptionalBoundedString(value['publisher'], 1_024) &&
    isOptionalBoundedString(value['identifier'], 1_024) &&
    isCanonicalTimestamp(value['importedAt']) &&
    (value['lastOpenedAt'] === undefined ||
      isCanonicalTimestamp(value['lastOpenedAt'])) &&
    (value['coverState'] === undefined ||
      value['coverState'] === 'available' ||
      value['coverState'] === 'unavailable')
  );
}

export function isReadingProgress(value: unknown): value is ReadingProgress {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['schemaVersion'] === 1 &&
    isBookId(value['bookId']) &&
    isPublicationFormat(value['format']) &&
    isBoundedString(value['deviceId'], 256) &&
    isPublicationLocator(value['locator'], value['format']) &&
    isProgression(value['furthestTotalProgression']) &&
    isCanonicalTimestamp(value['updatedAt']) &&
    isBoundedString(value['appVersion'], 128)
  );
}

export function isReaderPreferences(
  value: unknown,
): value is ReaderPreferences {
  if (!isRecord(value)) {
    return false;
  }
  if (value['format'] === 'pdf') {
    return (
      ['fit-width', 'fit-page', 'custom'].includes(String(value['zoomMode'])) &&
      isFiniteNumberInRange(value['zoomPercent'], 10, 1_000) &&
      [0, 90, 180, 270].includes(Number(value['rotation']))
    );
  }
  return (
    value['format'] === 'epub' &&
    ['light', 'sepia', 'dark'].includes(String(value['theme'])) &&
    ['serif', 'sans-serif'].includes(String(value['fontFamily'])) &&
    isFiniteNumberInRange(value['fontSizePercent'], 50, 300) &&
    isFiniteNumberInRange(value['lineHeight'], 0.5, 4) &&
    isFiniteNumberInRange(value['paragraphSpacingRem'], 0, 10) &&
    isFiniteNumberInRange(value['marginPercent'], 0, 40) &&
    isFiniteNumberInRange(value['maxLineWidthRem'], 10, 200) &&
    ['paginated', 'scrolled'].includes(String(value['flow'])) &&
    ['none', 'auto'].includes(String(value['spread']))
  );
}

export function isPublicationLocator(
  value: unknown,
  format: PublicationFormat,
): value is PublicationLocator {
  if (
    !isRecord(value) ||
    typeof value['href'] !== 'string' ||
    value['href'].length > 8_192 ||
    (format !== 'pdf' && value['href'].length === 0) ||
    !isBoundedString(value['type'], 256) ||
    !isOptionalBoundedString(value['title'], 1_024)
  ) {
    return false;
  }

  const locations = value['locations'];
  if (
    locations !== undefined &&
    (!isRecord(locations) ||
      (locations['fragments'] !== undefined &&
        (!Array.isArray(locations['fragments']) ||
          locations['fragments'].length > 32 ||
          !locations['fragments'].every((fragment) =>
            isBoundedString(fragment, 4_096),
          ))) ||
      (locations['progression'] !== undefined &&
        !isProgression(locations['progression'])) ||
      (locations['totalProgression'] !== undefined &&
        !isProgression(locations['totalProgression'])) ||
      (locations['position'] !== undefined &&
        (!Number.isSafeInteger(locations['position']) ||
          Number(locations['position']) < 1)))
  ) {
    return false;
  }

  const text = value['text'];
  return (
    text === undefined ||
    (isRecord(text) &&
      isOptionalBoundedString(text['before'], 16_384) &&
      isOptionalBoundedString(text['highlight'], 16_384) &&
      isOptionalBoundedString(text['after'], 16_384))
  );
}

function isBookId(value: unknown): value is string {
  return typeof value === 'string' && SHA256_BOOK_ID.test(value);
}

function isPublicationFormat(value: unknown): value is PublicationFormat {
  return value === 'epub' || value === 'pdf';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}

function isOptionalBoundedString(
  value: unknown,
  maximum: number,
): value is string | undefined {
  return value === undefined || isBoundedString(value, maximum);
}

function isProgression(value: unknown): value is number {
  return isFiniteNumberInRange(value, 0, 1);
}

function isFiniteNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}
