import type { PublicationFormat, PublicationLocator } from './publication';

const BOOK_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ANNOTATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;

export type PublicationAnnotationColor = (typeof ANNOTATION_COLORS)[number];

/**
 * A format-neutral text annotation.
 *
 * EPUB engines anchor `locator.locations.fragments` with a CFI. PDF engines
 * use the page position plus a text selector. The quote stored in
 * `locator.text` lets an engine repair an anchor when the publication layout
 * changes without making the synchronized record renderer-specific.
 */
export interface PublicationAnnotation {
  schemaVersion: 1;
  id: string;
  bookId: string;
  format: PublicationFormat;
  deviceId: string;
  locator: PublicationLocator;
  color: PublicationAnnotationColor;
  note?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export function isPublicationAnnotation(
  value: unknown,
): value is PublicationAnnotation {
  if (!isRecord(value)) {
    return false;
  }

  const locator = value['locator'];
  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];
  const deletedAt = value['deletedAt'];
  return (
    value['schemaVersion'] === 1 &&
    typeof value['id'] === 'string' &&
    ANNOTATION_ID_PATTERN.test(value['id']) &&
    typeof value['bookId'] === 'string' &&
    BOOK_ID_PATTERN.test(value['bookId']) &&
    (value['format'] === 'epub' || value['format'] === 'pdf') &&
    isBoundedString(value['deviceId'], 128) &&
    isPublicationLocator(locator, value['format']) &&
    isRecord(locator.text) &&
    isBoundedString(locator.text['highlight'], 4096) &&
    ANNOTATION_COLORS.includes(value['color'] as PublicationAnnotationColor) &&
    (value['note'] === undefined || isBoundedString(value['note'], 16_384)) &&
    isCanonicalTimestamp(createdAt) &&
    isCanonicalTimestamp(updatedAt) &&
    createdAt <= updatedAt &&
    (deletedAt === undefined ||
      (isCanonicalTimestamp(deletedAt) && deletedAt === updatedAt))
  );
}

/**
 * Last-writer-wins with deterministic tie-breaking so replicas converge even
 * when two writes have the same wall-clock timestamp.
 */
export function preferredAnnotation(
  local: PublicationAnnotation | null,
  incoming: PublicationAnnotation,
): PublicationAnnotation {
  if (!local) {
    return incoming;
  }
  return compareAnnotations(incoming, local) > 0 ? incoming : local;
}

function compareAnnotations(
  left: PublicationAnnotation,
  right: PublicationAnnotation,
): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.deviceId.localeCompare(right.deviceId) ||
    stableJson(left).localeCompare(stableJson(right))
  );
}

function isPublicationLocator(
  value: unknown,
  format: unknown,
): value is PublicationLocator {
  if (
    !isRecord(value) ||
    typeof value['href'] !== 'string' ||
    value['href'].length > 8192 ||
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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
