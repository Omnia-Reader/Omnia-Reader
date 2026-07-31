import type { PublicationFormat, PublicationLocator } from './publication';

const BOOK_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ANNOTATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ANNOTATION_STYLES = ['highlight', 'underline', 'strikethrough'] as const;
const CUSTOM_ANNOTATION_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const PUBLICATION_ANNOTATION_COLOR_OPTIONS = [
  { value: 'orange', label: 'Orange', hex: '#E69F00' },
  { value: 'sky-blue', label: 'Sky blue', hex: '#56B4E9' },
  { value: 'bluish-green', label: 'Bluish green', hex: '#009E73' },
  { value: 'yellow', label: 'Yellow', hex: '#F0E442' },
  { value: 'dark-blue', label: 'Dark blue', hex: '#0072B2' },
  { value: 'vermilion', label: 'Vermilion', hex: '#D55E00' },
  { value: 'purple', label: 'Purple', hex: '#CC79A7' },
  { value: 'brown', label: 'Brown', hex: '#8C564B' },
  { value: 'gray', label: 'Gray', hex: '#7F7F7F' },
] as const;

export const PUBLICATION_ANNOTATION_BLACK_COLOR_OPTION = {
  value: 'black',
  label: 'Black',
  hex: '#000000',
} as const;

const LEGACY_PUBLICATION_ANNOTATION_COLOR_OPTIONS = [
  { value: 'green', label: 'Green', hex: '#15803d' },
  { value: 'red', label: 'Red', hex: '#b91c1c' },
  { value: 'blue', label: 'Blue', hex: '#1d4ed8' },
  { value: 'cyan', label: 'Cyan', hex: '#22d3ee' },
  { value: 'pink', label: 'Pink', hex: '#f472b6' },
] as const;

const SUPPORTED_PUBLICATION_ANNOTATION_COLOR_OPTIONS = [
  PUBLICATION_ANNOTATION_BLACK_COLOR_OPTION,
  ...PUBLICATION_ANNOTATION_COLOR_OPTIONS,
  ...LEGACY_PUBLICATION_ANNOTATION_COLOR_OPTIONS,
] as const;

export type PublicationAnnotationNamedColor =
  (typeof SUPPORTED_PUBLICATION_ANNOTATION_COLOR_OPTIONS)[number]['value'];
export type PublicationAnnotationColor =
  | PublicationAnnotationNamedColor
  | `#${string}`;
export type PublicationAnnotationStyle = (typeof ANNOTATION_STYLES)[number];

export interface PublicationAnnotationDecoration {
  readonly style: PublicationAnnotationStyle;
  readonly color: PublicationAnnotationColor;
}

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
  /**
   * Missing on records created before decoration styles were introduced.
   * Readers must treat an omitted style as a traditional highlight.
   */
  style?: PublicationAnnotationStyle;
  /**
   * Independent visual layers applied to the selected range. Missing on
   * legacy records, which are interpreted from `style` and `color`.
   *
   * An empty list represents a note-only annotation.
   */
  decorations?: readonly PublicationAnnotationDecoration[];
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
    isPublicationAnnotationColor(value['color']) &&
    (value['style'] === undefined ||
      ANNOTATION_STYLES.includes(
        value['style'] as PublicationAnnotationStyle,
      )) &&
    (value['note'] === undefined || isBoundedString(value['note'], 16_384)) &&
    isAnnotationDecorations(value['decorations'], value['note']) &&
    isCanonicalTimestamp(createdAt) &&
    isCanonicalTimestamp(updatedAt) &&
    createdAt <= updatedAt &&
    (deletedAt === undefined ||
      (isCanonicalTimestamp(deletedAt) && deletedAt === updatedAt))
  );
}

export function annotationDecorations(
  annotation: PublicationAnnotation,
): readonly PublicationAnnotationDecoration[] {
  return (
    annotation.decorations ?? [
      {
        style: annotation.style ?? 'highlight',
        color: annotation.color,
      },
    ]
  );
}

export function annotationHasStyle(
  annotation: PublicationAnnotation,
  style: PublicationAnnotationStyle,
): boolean {
  return annotationDecorations(annotation).some(
    (decoration) => decoration.style === style,
  );
}

export function isPublicationAnnotationColor(
  value: unknown,
): value is PublicationAnnotationColor {
  return (
    (typeof value === 'string' &&
      SUPPORTED_PUBLICATION_ANNOTATION_COLOR_OPTIONS.some(
        (option) => option.value === value,
      )) ||
    (typeof value === 'string' && CUSTOM_ANNOTATION_COLOR_PATTERN.test(value))
  );
}

export function publicationAnnotationColorHex(
  color: PublicationAnnotationColor,
): `#${string}` {
  const preset = SUPPORTED_PUBLICATION_ANNOTATION_COLOR_OPTIONS.find(
    (option) => option.value === color,
  );
  return (preset?.hex ?? color.toLowerCase()) as `#${string}`;
}

export function publicationAnnotationColorLabel(
  color: PublicationAnnotationColor,
): string {
  return (
    SUPPORTED_PUBLICATION_ANNOTATION_COLOR_OPTIONS.find(
      (option) => option.value === color,
    )?.label ?? color.toUpperCase()
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

function isAnnotationDecorations(
  value: unknown,
  note: unknown,
): value is readonly PublicationAnnotationDecoration[] | undefined {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || value.length > ANNOTATION_STYLES.length) {
    return false;
  }
  if (value.length === 0) {
    return isBoundedString(note, 16_384);
  }
  const styles = new Set<PublicationAnnotationStyle>();
  for (const decoration of value) {
    if (
      !isRecord(decoration) ||
      !ANNOTATION_STYLES.includes(
        decoration['style'] as PublicationAnnotationStyle,
      ) ||
      !isPublicationAnnotationColor(decoration['color'])
    ) {
      return false;
    }
    const style = decoration['style'] as PublicationAnnotationStyle;
    if (styles.has(style)) {
      return false;
    }
    styles.add(style);
  }
  return true;
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
