import {
  createLibrarySyncManifest,
  isLibrarySyncManifest,
  LIBRARY_SYNC_FEATURES,
  SYNC_MANIFEST_PATH,
} from './library-sync-manifest';

describe('library sync manifest', () => {
  it('creates the canonical root contract', () => {
    expect(SYNC_MANIFEST_PATH).toBe('.omnia-reader/v1/manifest.json');
    expect(createLibrarySyncManifest()).toEqual({
      schemaVersion: 1,
      application: 'omnia-reader',
      publicationIdentity: 'sha256',
      features: LIBRARY_SYNC_FEATURES,
    });
  });

  it('accepts compatible optional features', () => {
    expect(
      isLibrarySyncManifest({
        ...createLibrarySyncManifest(),
        features: [...LIBRARY_SYNC_FEATURES, 'reading-statistics'],
      }),
    ).toBe(true);
  });

  it.each([
    { ...createLibrarySyncManifest(), schemaVersion: 2 },
    { ...createLibrarySyncManifest(), application: 'another-reader' },
    { ...createLibrarySyncManifest(), publicationIdentity: 'sha1' },
    {
      ...createLibrarySyncManifest(),
      features: LIBRARY_SYNC_FEATURES.filter(
        (feature) => feature !== 'progress',
      ),
    },
    {
      ...createLibrarySyncManifest(),
      features: [...LIBRARY_SYNC_FEATURES, 'progress'],
    },
    {
      ...createLibrarySyncManifest(),
      features: [...LIBRARY_SYNC_FEATURES, '../escape'],
    },
  ])('rejects an incompatible root contract', (manifest) => {
    expect(isLibrarySyncManifest(manifest)).toBe(false);
  });
});
