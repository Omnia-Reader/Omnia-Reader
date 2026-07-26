import type { BookRecord, ReadingProgress } from '@omnia-reader/reader/domain';
import {
  bookActivityTimestamp,
  loadLibraryViewPreferences,
  saveLibraryViewPreferences,
  selectLibraryBooks,
  summarizeReadingProgress,
  type LibraryPreferenceStorage,
} from './library-view';

describe('library view', () => {
  const books: readonly BookRecord[] = [
    createBook({
      id: 'algebra-10',
      title: 'Álgebra 10',
      authors: ['Zoë Martin'],
      publisher: 'Éditions Omnia',
      importedAt: '2026-07-22T08:00:00.000Z',
    }),
    createBook({
      id: 'algebra-2',
      title: 'Algebra 2',
      authors: ['Ada Reader'],
      importedAt: '2026-07-23T08:00:00.000Z',
      lastOpenedAt: '2026-07-25T08:00:00.000Z',
    }),
    createBook({
      id: 'untitled',
      title: 'Reading Notes',
      authors: [],
      importedAt: '2026-07-24T08:00:00.000Z',
    }),
  ];

  it('searches normalized title, author, publisher, file name, and format text', () => {
    expect(titles(selectLibraryBooks(books, 'algebra', 'title'))).toEqual([
      'Algebra 2',
      'Álgebra 10',
    ]);
    expect(titles(selectLibraryBooks(books, 'zoe', 'title'))).toEqual([
      'Álgebra 10',
    ]);
    expect(
      titles(selectLibraryBooks(books, 'editions omnia', 'title')),
    ).toEqual(['Álgebra 10']);
    expect(
      titles(selectLibraryBooks(books, 'reading-notes.epub', 'title')),
    ).toEqual(['Reading Notes']);
    expect(selectLibraryBooks(books, 'epub', 'title')).toHaveLength(3);
  });

  it('sorts by recent activity, imported date, title, and author deterministically', () => {
    expect(titles(selectLibraryBooks(books, '', 'recent'))).toEqual([
      'Algebra 2',
      'Reading Notes',
      'Álgebra 10',
    ]);
    expect(titles(selectLibraryBooks(books, '', 'added'))).toEqual([
      'Reading Notes',
      'Algebra 2',
      'Álgebra 10',
    ]);
    expect(titles(selectLibraryBooks(books, '', 'title'))).toEqual([
      'Algebra 2',
      'Álgebra 10',
      'Reading Notes',
    ]);
    expect(titles(selectLibraryBooks(books, '', 'author'))).toEqual([
      'Algebra 2',
      'Álgebra 10',
      'Reading Notes',
    ]);
  });

  it('does not reorder the repository-owned book array', () => {
    const originalOrder = [...books];

    selectLibraryBooks(books, '', 'title');

    expect(books).toEqual(originalOrder);
  });

  it('filters unread, in-progress, and finished books using durable progress', () => {
    const progressSummaries = new Map([
      [
        'algebra-10',
        {
          percent: 0,
          label: '0% read',
          actionLabel: 'Continue reading',
        },
      ],
      [
        'algebra-2',
        {
          percent: 100,
          label: 'Finished',
          actionLabel: 'Open finished book',
        },
      ],
    ]);

    expect(
      titles(
        selectLibraryBooks(books, '', 'title', 'reading', progressSummaries),
      ),
    ).toEqual(['Álgebra 10']);
    expect(
      titles(
        selectLibraryBooks(books, '', 'title', 'finished', progressSummaries),
      ),
    ).toEqual(['Algebra 2']);
    expect(
      titles(
        selectLibraryBooks(books, '', 'title', 'unread', progressSummaries),
      ),
    ).toEqual(['Reading Notes']);
  });

  it('composes reading status with normalized search and sorting', () => {
    const progressSummaries = new Map([
      [
        'algebra-10',
        {
          percent: 42,
          label: '42% read',
          actionLabel: 'Continue reading',
        },
      ],
      [
        'algebra-2',
        {
          percent: 70,
          label: '70% read',
          actionLabel: 'Continue reading',
        },
      ],
    ]);

    expect(
      titles(
        selectLibraryBooks(
          books,
          'algebra',
          'author',
          'reading',
          progressSummaries,
        ),
      ),
    ).toEqual(['Algebra 2', 'Álgebra 10']);
  });

  it('uses the last-opened timestamp as recent activity when available', () => {
    expect(bookActivityTimestamp(books[0])).toBe(books[0].importedAt);
    expect(bookActivityTimestamp(books[1])).toBe(books[1].lastOpenedAt);
  });

  it('summarizes the current durable reading position for the library', () => {
    expect(summarizeReadingProgress(createProgress(0.42, 0.7))).toEqual({
      percent: 42,
      label: '42% read',
      actionLabel: 'Continue reading',
    });
  });

  it('falls back to furthest progress and identifies finished books', () => {
    expect(summarizeReadingProgress(createProgress(undefined, 0.58))).toEqual({
      percent: 58,
      label: '58% read',
      actionLabel: 'Continue reading',
    });
    expect(summarizeReadingProgress(createProgress(1, 1))).toEqual({
      percent: 100,
      label: 'Finished',
      actionLabel: 'Open finished book',
    });
  });

  it('persists validated view and sort preferences', () => {
    const values = new Map<string, string>();
    const storage: LibraryPreferenceStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };

    saveLibraryViewPreferences(
      { viewMode: 'list', sortMode: 'author' },
      storage,
    );

    expect(loadLibraryViewPreferences(storage)).toEqual({
      viewMode: 'list',
      sortMode: 'author',
    });
  });

  it('falls back safely when preference storage is absent, invalid, or unavailable', () => {
    expect(loadLibraryViewPreferences(null)).toEqual({
      viewMode: 'grid',
      sortMode: 'recent',
    });
    expect(
      loadLibraryViewPreferences({
        getItem: () => 'unsupported',
        setItem: vi.fn(),
      }),
    ).toEqual({
      viewMode: 'grid',
      sortMode: 'recent',
    });
    expect(
      loadLibraryViewPreferences({
        getItem: () => {
          throw new Error('storage denied');
        },
        setItem: vi.fn(),
      }),
    ).toEqual({
      viewMode: 'grid',
      sortMode: 'recent',
    });
    expect(() =>
      saveLibraryViewPreferences(
        { viewMode: 'list', sortMode: 'title' },
        {
          getItem: vi.fn(),
          setItem: () => {
            throw new Error('storage full');
          },
        },
      ),
    ).not.toThrow();
  });
});

function createBook(
  overrides: Partial<BookRecord> & Pick<BookRecord, 'id' | 'title' | 'authors'>,
): BookRecord {
  return {
    format: 'epub',
    fileName: `${overrides.title.toLowerCase().replace(/ /g, '-')}.epub`,
    mediaType: 'application/epub+zip',
    size: 1_024,
    importedAt: '2026-07-20T08:00:00.000Z',
    ...overrides,
  };
}

function titles(books: readonly BookRecord[]): string[] {
  return books.map((book) => book.title);
}

function createProgress(
  totalProgression: number | undefined,
  furthestTotalProgression: number,
): ReadingProgress {
  return {
    schemaVersion: 1,
    bookId: `sha256:${'a'.repeat(64)}`,
    format: 'epub',
    deviceId: 'test-device',
    locator: {
      href: 'chapter.xhtml',
      type: 'application/xhtml+xml',
      locations:
        totalProgression === undefined ? undefined : { totalProgression },
    },
    furthestTotalProgression,
    updatedAt: '2026-07-26T00:00:00.000Z',
    appVersion: '0.0.0',
  };
}
