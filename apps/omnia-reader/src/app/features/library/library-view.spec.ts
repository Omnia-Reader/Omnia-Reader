import type { BookRecord } from '@omnia-reader/reader/domain';
import {
  bookActivityTimestamp,
  loadLibraryViewPreferences,
  saveLibraryViewPreferences,
  selectLibraryBooks,
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

  it('uses the last-opened timestamp as recent activity when available', () => {
    expect(bookActivityTimestamp(books[0])).toBe(books[0].importedAt);
    expect(bookActivityTimestamp(books[1])).toBe(books[1].lastOpenedAt);
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
