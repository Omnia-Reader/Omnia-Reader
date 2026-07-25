import type { PublicationFormat, PublicationLocator } from './publication';

const BOOK_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BOOKMARK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface PublicationBookmark {
  schemaVersion: 1;
  id: string;
  bookId: string;
  format: PublicationFormat;
  deviceId: string;
  locator: PublicationLocator;
  label: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export function isPublicationBookmark(
  value: unknown,
): value is PublicationBookmark {
  if (!isRecord(value)) {
    return false;
  }

  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];
  const deletedAt = value['deletedAt'];
  return (
    value['schemaVersion'] === 1 &&
    typeof value['id'] === 'string' &&
    BOOKMARK_ID_PATTERN.test(value['id']) &&
    typeof value['bookId'] === 'string' &&
    BOOK_ID_PATTERN.test(value['bookId']) &&
    (value['format'] === 'epub' || value['format'] === 'pdf') &&
    isBoundedString(value['deviceId'], 128) &&
    isBoundedString(value['label'], 512) &&
    isPublicationLocator(value['locator'], value['format']) &&
    isCanonicalTimestamp(createdAt) &&
    isCanonicalTimestamp(updatedAt) &&
    createdAt <= updatedAt &&
    (deletedAt === undefined ||
      (isCanonicalTimestamp(deletedAt) && deletedAt === updatedAt))
  );
}

export function preferredBookmark(
  local: PublicationBookmark | null,
  incoming: PublicationBookmark,
): PublicationBookmark {
  if (!local) {
    return incoming;
  }
  return compareBookmarks(incoming, local) > 0 ? incoming : local;
}

function compareBookmarks(
  left: PublicationBookmark,
  right: PublicationBookmark,
): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.deviceId.localeCompare(right.deviceId) ||
    left.id.localeCompare(right.id)
  );
}

function isPublicationLocator(
  value: unknown,
  format: unknown,
): value is PublicationLocator {
  if (
    !isRecord(value) ||
    typeof value['href'] !== 'string' ||
    (format !== 'pdf' && value['href'].length === 0) ||
    !isBoundedString(value['type'], 256) ||
    (value['title'] !== undefined && !isBoundedString(value['title'], 512))
  ) {
    return false;
  }

  const locations = value['locations'];
  if (locations !== undefined) {
    if (!isRecord(locations)) {
      return false;
    }
    if (
      locations['fragments'] !== undefined &&
      (!Array.isArray(locations['fragments']) ||
        locations['fragments'].length > 16 ||
        !locations['fragments'].every((fragment) =>
          isBoundedString(fragment, 2048),
        ))
    ) {
      return false;
    }
    if (
      locations['progression'] !== undefined &&
      !isProgression(locations['progression'])
    ) {
      return false;
    }
    if (
      locations['totalProgression'] !== undefined &&
      !isProgression(locations['totalProgression'])
    ) {
      return false;
    }
    const position = locations['position'];
    if (
      position !== undefined &&
      (!Number.isSafeInteger(position) || (position as number) < 1)
    ) {
      return false;
    }
  }

  const text = value['text'];
  return (
    text === undefined ||
    (isRecord(text) &&
      ['before', 'highlight', 'after'].every(
        (key) =>
          text[key] === undefined ||
          (typeof text[key] === 'string' &&
            (text[key] as string).length <= 4096),
      ))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}

function isProgression(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}
