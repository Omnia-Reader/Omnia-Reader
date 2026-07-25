import { ReadingProgress } from '@omnia-reader/reader/domain';
import { isReadingProgress, mergeDeviceProgress } from './progress-merge';

const BOOK_ID = `sha256:${'a'.repeat(64)}`;

describe('mergeDeviceProgress', () => {
  it('selects the newest locator and preserves the furthest progress', () => {
    const earlier = progress('device-a', '2026-07-24T10:00:00.000Z', 0.8);
    const newer = progress('device-b', '2026-07-24T11:00:00.000Z', 0.4);

    const merged = mergeDeviceProgress([earlier, newer]);

    expect(merged.current).toBe(newer);
    expect(merged.furthestTotalProgression).toBe(0.8);
    expect(merged.documents).toEqual([earlier, newer]);
  });

  it('breaks equal timestamps deterministically by device ID', () => {
    const timestamp = '2026-07-24T11:00:00.000Z';

    const merged = mergeDeviceProgress([
      progress('device-a', timestamp, 0.2),
      progress('device-z', timestamp, 0.3),
    ]);

    expect(merged.current?.deviceId).toBe('device-z');
  });

  it('filters malformed and future-schema progress', () => {
    const merged = mergeDeviceProgress([
      progress('device-a', '2026-07-24T11:00:00.000Z', 0.3),
      { schemaVersion: 2 },
      { schemaVersion: 1, bookId: 'broken' },
    ] as ReadingProgress[]);

    expect(merged.documents).toHaveLength(1);
  });

  it('accepts PDF page locators without a resource href', () => {
    expect(
      isReadingProgress({
        ...progress('device-a', '2026-07-24T11:00:00.000Z', 0.3),
        format: 'pdf',
        locator: {
          href: '',
          type: 'application/pdf',
          locations: { fragments: ['page=2'], position: 2 },
        },
      }),
    ).toBe(true);
  });

  it.each([
    { updatedAt: 'not-a-date' },
    { furthestTotalProgression: Number.NaN },
    { furthestTotalProgression: 1.1 },
    { deviceId: '' },
    { appVersion: '' },
    { locator: { href: '', type: 'application/xhtml+xml' } },
    {
      locator: {
        href: 'chapter.xhtml',
        type: 'application/xhtml+xml',
        locations: { progression: -1 },
      },
    },
  ])('rejects malformed fields: %o', (patch) => {
    expect(
      isReadingProgress({
        ...progress('device-a', '2026-07-24T11:00:00.000Z', 0.3),
        ...patch,
      }),
    ).toBe(false);
  });
});

function progress(
  deviceId: string,
  updatedAt: string,
  furthestTotalProgression: number,
): ReadingProgress {
  return {
    schemaVersion: 1,
    bookId: BOOK_ID,
    format: 'epub',
    deviceId,
    locator: {
      href: 'chapter.xhtml',
      type: 'application/xhtml+xml',
    },
    furthestTotalProgression,
    updatedAt,
    appVersion: '0.0.0',
  };
}
