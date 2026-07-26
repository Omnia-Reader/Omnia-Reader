import type { BookRecord, ReadingProgress } from '@omnia-reader/reader/domain';

export type LibraryViewMode = 'grid' | 'list';
export type LibrarySortMode = 'recent' | 'title' | 'author' | 'added';
export type LibraryReadingStatus = 'all' | 'reading' | 'finished' | 'unread';

export interface LibraryViewPreferences {
  viewMode: LibraryViewMode;
  sortMode: LibrarySortMode;
}

export interface LibraryBookProgressSummary {
  percent: number;
  label: string;
  actionLabel: string;
}

export interface LibraryPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VIEW_MODE_KEY = 'omnia-reader.library.view';
const SORT_MODE_KEY = 'omnia-reader.library.sort';
const DEFAULT_PREFERENCES: LibraryViewPreferences = {
  viewMode: 'grid',
  sortMode: 'recent',
};
const titleCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function selectLibraryBooks(
  books: readonly BookRecord[],
  query: string,
  sortMode: LibrarySortMode,
  readingStatus: LibraryReadingStatus = 'all',
  progressSummaries: ReadonlyMap<
    string,
    LibraryBookProgressSummary
  > = new Map(),
): readonly BookRecord[] {
  const needle = normalizeSearchText(query.trim());
  return books
    .filter(
      (book) =>
        matchesReadingStatus(book.id, readingStatus, progressSummaries) &&
        (!needle || searchableBookText(book).includes(needle)),
    )
    .sort((left, right) => compareBooks(left, right, sortMode));
}

export function bookActivityTimestamp(book: BookRecord): string {
  return book.lastOpenedAt ?? book.importedAt;
}

export function summarizeReadingProgress(
  progress: ReadingProgress,
): LibraryBookProgressSummary {
  const totalProgression =
    progress.locator.locations?.totalProgression ??
    progress.furthestTotalProgression;
  const percent = Math.round(
    Math.min(
      1,
      Math.max(0, Number.isFinite(totalProgression) ? totalProgression : 0),
    ) * 100,
  );

  return percent === 100
    ? {
        percent,
        label: 'Finished',
        actionLabel: 'Open finished book',
      }
    : {
        percent,
        label: `${percent}% read`,
        actionLabel: 'Continue reading',
      };
}

export function loadLibraryViewPreferences(
  storage: LibraryPreferenceStorage | null = resolveStorage(),
): LibraryViewPreferences {
  if (!storage) {
    return { ...DEFAULT_PREFERENCES };
  }
  try {
    const viewMode = storage.getItem(VIEW_MODE_KEY);
    const sortMode = storage.getItem(SORT_MODE_KEY);
    return {
      viewMode: isLibraryViewMode(viewMode)
        ? viewMode
        : DEFAULT_PREFERENCES.viewMode,
      sortMode: isLibrarySortMode(sortMode)
        ? sortMode
        : DEFAULT_PREFERENCES.sortMode,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function saveLibraryViewPreferences(
  preferences: LibraryViewPreferences,
  storage: LibraryPreferenceStorage | null = resolveStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(VIEW_MODE_KEY, preferences.viewMode);
    storage.setItem(SORT_MODE_KEY, preferences.sortMode);
  } catch {
    // Library controls remain usable when storage is unavailable or full.
  }
}

export function isLibraryViewMode(
  value: string | null,
): value is LibraryViewMode {
  return value === 'grid' || value === 'list';
}

export function isLibrarySortMode(
  value: string | null,
): value is LibrarySortMode {
  return (
    value === 'recent' ||
    value === 'title' ||
    value === 'author' ||
    value === 'added'
  );
}

export function isLibraryReadingStatus(
  value: string | null,
): value is LibraryReadingStatus {
  return (
    value === 'all' ||
    value === 'reading' ||
    value === 'finished' ||
    value === 'unread'
  );
}

function matchesReadingStatus(
  bookId: string,
  readingStatus: LibraryReadingStatus,
  progressSummaries: ReadonlyMap<string, LibraryBookProgressSummary>,
): boolean {
  if (readingStatus === 'all') {
    return true;
  }
  const progress = progressSummaries.get(bookId);
  if (readingStatus === 'unread') {
    return !progress;
  }
  if (!progress) {
    return false;
  }
  return readingStatus === 'finished'
    ? progress.percent === 100
    : progress.percent < 100;
}

function compareBooks(
  left: BookRecord,
  right: BookRecord,
  sortMode: LibrarySortMode,
): number {
  let comparison = 0;
  switch (sortMode) {
    case 'recent':
      comparison = bookActivityTimestamp(right).localeCompare(
        bookActivityTimestamp(left),
      );
      break;
    case 'added':
      comparison = right.importedAt.localeCompare(left.importedAt);
      break;
    case 'author':
      comparison = compareAuthors(left, right);
      break;
    case 'title':
      comparison = titleCollator.compare(left.title, right.title);
      break;
  }
  return (
    comparison ||
    titleCollator.compare(left.title, right.title) ||
    left.id.localeCompare(right.id)
  );
}

function compareAuthors(left: BookRecord, right: BookRecord): number {
  const leftAuthor = left.authors.join(', ').trim();
  const rightAuthor = right.authors.join(', ').trim();
  if (!leftAuthor && rightAuthor) {
    return 1;
  }
  if (leftAuthor && !rightAuthor) {
    return -1;
  }
  return titleCollator.compare(leftAuthor, rightAuthor);
}

function searchableBookText(book: BookRecord): string {
  return normalizeSearchText(
    [
      book.title,
      ...book.authors,
      book.fileName,
      book.publisher ?? '',
      book.format,
    ].join('\n'),
  );
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function resolveStorage(): LibraryPreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
