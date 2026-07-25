import {
  PublicationBookmark,
  isPublicationBookmark,
  preferredBookmark,
} from './publication-bookmark';

const BOOKMARK: PublicationBookmark = {
  schemaVersion: 1,
  id: '1f8df2d8-d1cc-4df4-b3cb-f3e797d8e075',
  bookId: `sha256:${'a'.repeat(64)}`,
  format: 'pdf',
  deviceId: 'device-a',
  locator: {
    href: '',
    type: 'application/pdf',
    title: 'Page 4',
    locations: {
      fragments: ['page=4'],
      position: 4,
      totalProgression: 0.3,
    },
  },
  label: 'Page 4',
  createdAt: '2026-07-25T08:00:00.000Z',
  updatedAt: '2026-07-25T08:00:00.000Z',
};

describe('PublicationBookmark', () => {
  it('accepts a bounded versioned PDF bookmark', () => {
    expect(isPublicationBookmark(BOOKMARK)).toBe(true);
  });

  it('requires a canonical tombstone timestamp matching the update', () => {
    expect(
      isPublicationBookmark({
        ...BOOKMARK,
        deletedAt: '2026-07-25T09:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      isPublicationBookmark({
        ...BOOKMARK,
        updatedAt: '2026-07-25T09:00:00.000Z',
        deletedAt: '2026-07-25T09:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('merges concurrent updates deterministically', () => {
    const newer = {
      ...BOOKMARK,
      deviceId: 'device-b',
      updatedAt: '2026-07-25T09:00:00.000Z',
      deletedAt: '2026-07-25T09:00:00.000Z',
    };

    expect(preferredBookmark(BOOKMARK, newer)).toBe(newer);
    expect(preferredBookmark(newer, BOOKMARK)).toBe(newer);
  });
});
