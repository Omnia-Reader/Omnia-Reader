import {
  PublicationLocator,
  ReaderPageStatus,
} from '@omnia-reader/reader/domain';

export function epubLocationToLocator(
  location: unknown,
): PublicationLocator | null {
  if (!isRecord(location)) {
    return null;
  }

  const displayedLocation = isRecord(location['start'])
    ? location['start']
    : location;
  const href = displayedLocation['href'];
  if (typeof href !== 'string' || !href) {
    return null;
  }

  const cfi = displayedLocation['cfi'];
  const position = displayedLocation['location'];
  const percentage = displayedLocation['percentage'];
  const displayed = displayedLocation['displayed'];
  const progression =
    isRecord(displayed) &&
    typeof displayed['page'] === 'number' &&
    typeof displayed['total'] === 'number' &&
    displayed['total'] > 0
      ? displayed['page'] / displayed['total']
      : undefined;

  return {
    href,
    type: 'application/xhtml+xml',
    locations: {
      fragments: typeof cfi === 'string' ? [cfi] : undefined,
      progression: isProgression(progression) ? progression : undefined,
      position:
        Number.isSafeInteger(position) && Number(position) >= 1
          ? Number(position)
          : undefined,
      totalProgression: isProgression(percentage) ? percentage : undefined,
    },
  };
}

export function epubLocationToPageStatus(
  location: unknown,
): ReaderPageStatus | null {
  if (!isRecord(location)) {
    return null;
  }
  const displayedLocation = isRecord(location['start'])
    ? location['start']
    : location;
  const displayed = displayedLocation['displayed'];
  if (!isRecord(displayed)) {
    return null;
  }
  const current = displayed['page'];
  const total = displayed['total'];
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(total) ||
    Number(current) < 1 ||
    Number(total) < 1 ||
    Number(current) > Number(total)
  ) {
    return null;
  }
  return {
    current: Number(current),
    total: Number(total),
    scope: 'section',
  };
}

export function epubLocationEndsSection(location: unknown): boolean | null {
  if (!isRecord(location)) {
    return null;
  }
  const displayedLocation = isRecord(location['end'])
    ? location['end']
    : isRecord(location['start'])
      ? location['start']
      : location;
  const displayed = displayedLocation['displayed'];
  if (!isRecord(displayed)) {
    return null;
  }
  const page = displayed['page'];
  const total = displayed['total'];
  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(total) ||
    Number(page) < 1 ||
    Number(total) < 1 ||
    Number(page) > Number(total)
  ) {
    return null;
  }
  return Number(page) === Number(total);
}

function isProgression(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
