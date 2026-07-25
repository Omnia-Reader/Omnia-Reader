import { PublicationLocator } from '@omnia-reader/reader/domain';

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
