import type {
  BookRecord,
  LogicalBookFormatPreference,
  LogicalBookRecord,
  PublicationFormat,
  ReadingProgress,
  VariantAvailability,
} from '@omnia-reader/reader/domain';

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

export interface LogicalLibraryCard {
  id: string;
  title: string;
  authors: string[];
  publisher?: string;
  format: PublicationFormat;
  fileName: string;
  mediaType: string;
  size: number;
  importedAt: string;
  lastOpenedAt?: string;
  logicalBook: LogicalBookRecord;
  variants: Partial<Record<PublicationFormat, BookRecord>>;
  progress: Partial<Record<PublicationFormat, LibraryBookProgressSummary>>;
  availability: Partial<Record<PublicationFormat, VariantAvailability>>;
  preferredFormat?: PublicationFormat;
}

export function createLogicalLibraryCards(
  logicalBooks: readonly LogicalBookRecord[],
  variants: readonly BookRecord[],
  progress: readonly ReadingProgress[],
  availability: ReadonlyMap<string, VariantAvailability>,
  preferences: readonly LogicalBookFormatPreference[] = [],
): readonly LogicalLibraryCard[] {
  const variantsById = new Map(
    variants.map((variant) => [variant.id, variant]),
  );
  const progressById = new Map(progress.map((entry) => [entry.bookId, entry]));
  const preferencesById = new Map(
    preferences.map((preference) => [preference.logicalBookId, preference]),
  );
  return logicalBooks.map((logicalBook) => {
    const cardVariants: LogicalLibraryCard['variants'] = {};
    const cardProgress: LogicalLibraryCard['progress'] = {};
    const cardAvailability: LogicalLibraryCard['availability'] = {};
    for (const format of ['epub', 'pdf'] as const) {
      const variantId = logicalBook.variants[format];
      if (!variantId) continue;
      const variant = variantsById.get(variantId);
      if (variant) cardVariants[format] = variant;
      const variantProgress = progressById.get(variantId);
      if (variantProgress) {
        cardProgress[format] = summarizeReadingProgress(variantProgress);
      }
      cardAvailability[format] =
        availability.get(variantId) ?? ({ status: 'checking' } as const);
    }
    const availableVariants = Object.values(cardVariants).filter(
      (variant): variant is BookRecord => !!variant,
    );
    const primary = cardVariants.epub ?? cardVariants.pdf;
    return {
      id: logicalBook.id,
      title: logicalBook.title,
      authors: logicalBook.authors,
      publisher: logicalBook.publisher,
      format: primary?.format ?? 'epub',
      fileName: primary?.fileName ?? logicalBook.title,
      mediaType: primary?.mediaType ?? 'application/epub+zip',
      size: availableVariants.reduce(
        (total, variant) => total + variant.size,
        0,
      ),
      importedAt: logicalBook.importedAt,
      lastOpenedAt: latestString(
        availableVariants
          .map((variant) => variant.lastOpenedAt)
          .filter((value): value is string => !!value),
      ),
      logicalBook,
      variants: cardVariants,
      progress: cardProgress,
      availability: cardAvailability,
      preferredFormat: preferencesById.get(logicalBook.id)?.preferredFormat,
    };
  });
}

export function orderedHealthyVariantIds(card: LogicalLibraryCard): string[] {
  const healthyFormats = (['epub', 'pdf'] as const).filter(
    (format) => card.availability[format]?.status === 'healthy',
  );
  if (healthyFormats.length === 0) return [];
  const ordered: PublicationFormat[] = [];
  if (card.preferredFormat && healthyFormats.includes(card.preferredFormat)) {
    ordered.push(card.preferredFormat);
  }
  if (healthyFormats.length === 1) ordered.push(healthyFormats[0]);
  ordered.push('epub', 'pdf');
  return [...new Set(ordered)]
    .filter((format) => healthyFormats.includes(format))
    .map((format) => card.logicalBook.variants[format])
    .filter((id): id is string => !!id);
}

export function selectLogicalLibraryCards(
  cards: readonly LogicalLibraryCard[],
  query: string,
  sortMode: LibrarySortMode,
  readingStatus: LibraryReadingStatus = 'all',
): readonly LogicalLibraryCard[] {
  const needle = normalizeSearchText(query.trim());
  return cards
    .filter((card) => {
      const summaries = Object.values(card.progress);
      const matchesStatus =
        readingStatus === 'all' ||
        (readingStatus === 'unread'
          ? summaries.length === 0
          : readingStatus === 'finished'
            ? summaries.some((summary) => summary?.percent === 100)
            : summaries.some((summary) => !!summary && summary.percent < 100));
      return (
        matchesStatus &&
        (!needle || searchableLogicalCardText(card).includes(needle))
      );
    })
    .sort((left, right) => compareLogicalCards(left, right, sortMode));
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
  const normalizedProgress = Math.min(
    1,
    Math.max(0, Number.isFinite(totalProgression) ? totalProgression : 0),
  );
  const percent =
    normalizedProgress === 1
      ? 100
      : Math.min(99, Math.round(normalizedProgress * 100));

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

function searchableLogicalCardText(card: LogicalLibraryCard): string {
  return normalizeSearchText(
    [
      card.logicalBook.title,
      ...card.logicalBook.authors,
      card.logicalBook.publisher ?? '',
      ...Object.values(card.variants).flatMap((variant) =>
        variant ? [variant.fileName, variant.format] : [],
      ),
    ].join('\n'),
  );
}

function compareLogicalCards(
  left: LogicalLibraryCard,
  right: LogicalLibraryCard,
  sortMode: LibrarySortMode,
): number {
  const leftBook = logicalCardSortRecord(left);
  const rightBook = logicalCardSortRecord(right);
  return compareBooks(leftBook, rightBook, sortMode);
}

function logicalCardSortRecord(card: LogicalLibraryCard): BookRecord {
  const variants = Object.values(card.variants).filter(
    (variant): variant is BookRecord => !!variant,
  );
  const latestActivity = latestString(
    variants
      .map((variant) => variant.lastOpenedAt)
      .filter((value): value is string => !!value),
  );
  const fallback = variants[0];
  return {
    id: card.logicalBook.id,
    format: fallback?.format ?? 'epub',
    fileName: fallback?.fileName ?? card.logicalBook.title,
    mediaType: fallback?.mediaType ?? 'application/epub+zip',
    size: fallback?.size ?? 1,
    title: card.logicalBook.title,
    authors: card.logicalBook.authors,
    language: card.logicalBook.language,
    publisher: card.logicalBook.publisher,
    identifier: card.logicalBook.identifier,
    importedAt: card.logicalBook.importedAt,
    lastOpenedAt: latestActivity,
  };
}

function latestString(values: readonly string[]): string | undefined {
  const ordered = [...values].sort();
  return ordered[ordered.length - 1];
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
