export const SYNC_ROOT = '.omnia-reader';
export const PREVIOUS_SYNC_ROOT = '.omnia-reader/v1';
export const SYNC_MANIFEST_PATH = `${SYNC_ROOT}/manifest.json`;

export const LIBRARY_SYNC_FEATURES = [
  'annotations',
  'bookmarks',
  'books',
  'progress',
  'logical-books',
] as const;

export type LibrarySyncFeature = (typeof LIBRARY_SYNC_FEATURES)[number];

export interface LibrarySyncManifest {
  schemaVersion: 2;
  application: 'omnia-reader';
  publicationIdentity: 'sha256';
  features: readonly string[];
}

export function createLibrarySyncManifest(): LibrarySyncManifest {
  return {
    schemaVersion: 2,
    application: 'omnia-reader',
    publicationIdentity: 'sha256',
    features: [...LIBRARY_SYNC_FEATURES],
  };
}

export function isLibrarySyncManifest(
  value: unknown,
): value is LibrarySyncManifest {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 2 ||
    value['application'] !== 'omnia-reader' ||
    value['publicationIdentity'] !== 'sha256' ||
    !Array.isArray(value['features']) ||
    value['features'].length > 32 ||
    !value['features'].every(isFeatureName)
  ) {
    return false;
  }

  const features = new Set(value['features']);
  return (
    features.size === value['features'].length &&
    LIBRARY_SYNC_FEATURES.every((feature) => features.has(feature))
  );
}

export function isLegacyLibrarySyncManifest(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['application'] !== 'omnia-reader' ||
    value['publicationIdentity'] !== 'sha256' ||
    !Array.isArray(value['features']) ||
    value['features'].length > 32 ||
    !value['features'].every(isFeatureName)
  ) {
    return false;
  }
  const features = new Set(value['features']);
  return (
    features.size === value['features'].length &&
    ['annotations', 'bookmarks', 'books', 'progress'].every((feature) =>
      features.has(feature),
    ) &&
    !features.has('logical-books')
  );
}

function isFeatureName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
