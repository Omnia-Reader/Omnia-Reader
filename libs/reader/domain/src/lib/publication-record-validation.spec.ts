import {
  DEFAULT_EPUB_READER_PREFERENCES,
  DEFAULT_PDF_READER_PREFERENCES,
} from './reader-preferences';
import {
  isBookRecord,
  isPublicationLocator,
  isReaderPreferences,
  isReadingProgress,
} from './publication-record-validation';

const BOOK_ID = `sha256:${'a'.repeat(64)}`;

describe('publication record validation', () => {
  const locator = {
    href: 'chapter.xhtml',
    type: 'application/xhtml+xml',
    locations: {
      fragments: ['epubcfi(/6/2!/4/2)'],
      progression: 0.25,
      position: 2,
      totalProgression: 0.4,
    },
    text: { highlight: 'portable quote' },
  };

  it('accepts bounded canonical book and progress records', () => {
    expect(
      isBookRecord({
        id: BOOK_ID,
        format: 'epub',
        fileName: 'fixture.epub',
        mediaType: 'application/epub+zip',
        size: 1_024,
        title: 'Fixture',
        authors: ['Omnia'],
        importedAt: '2026-07-25T08:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isReadingProgress({
        schemaVersion: 1,
        bookId: BOOK_ID,
        format: 'epub',
        deviceId: 'validation-test',
        locator,
        furthestTotalProgression: 0.4,
        updatedAt: '2026-07-25T08:00:00.000Z',
        appVersion: '1.0.0',
      }),
    ).toBe(true);
  });

  it('rejects unsafe identifiers, timestamps, and locator bounds', () => {
    expect(
      isBookRecord({
        id: '../not-a-book',
        format: 'epub',
        fileName: 'fixture.epub',
        mediaType: 'application/epub+zip',
        size: 1,
        title: 'Fixture',
        authors: [],
        importedAt: 'yesterday',
      }),
    ).toBe(false);
    expect(
      isPublicationLocator(
        {
          ...locator,
          locations: { progression: 1.01 },
        },
        'epub',
      ),
    ).toBe(false);
  });

  it('accepts supported preferences and rejects out-of-range values', () => {
    expect(isReaderPreferences(DEFAULT_EPUB_READER_PREFERENCES)).toBe(true);
    expect(DEFAULT_EPUB_READER_PREFERENCES.flow).toBe('auto');
    expect(isReaderPreferences(DEFAULT_PDF_READER_PREFERENCES)).toBe(true);
    expect(
      isReaderPreferences({
        ...DEFAULT_EPUB_READER_PREFERENCES,
        fontSizePercent: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
    expect(
      isReaderPreferences({
        ...DEFAULT_PDF_READER_PREFERENCES,
        rotation: 45,
      }),
    ).toBe(false);
    expect(
      isReaderPreferences({
        ...DEFAULT_EPUB_READER_PREFERENCES,
        flow: 'publication-decides-sometimes',
      }),
    ).toBe(false);
  });
});
