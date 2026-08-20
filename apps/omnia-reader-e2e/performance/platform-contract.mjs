export const PLATFORM_PROFILE_IDS = Object.freeze({
  1: Object.freeze([
    'desktop-web-v1',
    'mobile-web-v1',
    'packaged-desktop-v1',
    'android-v1',
  ]),
  2: Object.freeze([
    'desktop-web-v2',
    'mobile-web-v2',
    'packaged-desktop-v2',
    'android-v2',
  ]),
});

export const PLATFORM_LIFECYCLE_STATES = Object.freeze([
  'CREATED',
  'QUALIFIED',
  'LAUNCHED',
  'REVALIDATED',
  'SAMPLING',
  'EVALUATED',
  'PROMOTED',
  'ABORTED',
]);

export const PLATFORM_LIMITS = Object.freeze({
  maximumDiagnosticBytes: 64 * 1024,
  maximumOwnedResources: 128,
  maximumTimeoutMs: 86_400_000,
  terminationGraceMs: 1_000,
});
