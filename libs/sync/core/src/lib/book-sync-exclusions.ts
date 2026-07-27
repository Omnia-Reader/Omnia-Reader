const STORAGE_KEY = 'omnia-reader.sync-excluded-books';
const MAX_EXCLUDED_BOOKS = 10_000;
const BOOK_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface StoredBookSyncExclusions {
  schemaVersion: 1;
  bookIds: string[];
}

export interface BookSyncExclusions {
  isExcluded(bookId: string): boolean;
  exclude(bookId: string): void;
  include(bookId: string): void;
}

export class BrowserBookSyncExclusions implements BookSyncExclusions {
  private readonly memory = new Set<string>();
  private loaded = false;

  constructor(
    private readonly storage: Storage | undefined = browserStorage(),
  ) {}

  isExcluded(bookId: string): boolean {
    return this.read().has(bookId);
  }

  exclude(bookId: string): void {
    assertBookId(bookId);
    const exclusions = this.read();
    exclusions.add(bookId);
    this.persist(exclusions);
  }

  include(bookId: string): void {
    assertBookId(bookId);
    const exclusions = this.read();
    exclusions.delete(bookId);
    this.persist(exclusions);
  }

  private read(): Set<string> {
    this.load();
    return new Set(this.memory);
  }

  private load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const value = this.storage?.getItem(STORAGE_KEY);
      if (!value) {
        return;
      }
      const parsed: unknown = JSON.parse(value);
      if (!isStoredBookSyncExclusions(parsed)) {
        return;
      }
      parsed.bookIds.forEach((bookId) => this.memory.add(bookId));
    } catch {
      // The in-memory copy preserves current-session behavior when browser
      // storage is restricted, corrupt, or temporarily unavailable.
    }
  }

  private persist(exclusions: Set<string>): void {
    this.memory.clear();
    exclusions.forEach((bookId) => this.memory.add(bookId));
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          bookIds: [...exclusions].sort(),
        } satisfies StoredBookSyncExclusions),
      );
    } catch {
      // Local reading and removal remain available if persistence is denied.
    }
  }
}

export const NO_BOOK_SYNC_EXCLUSIONS: BookSyncExclusions = {
  isExcluded: () => false,
  exclude: () => undefined,
  include: () => undefined,
};

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function assertBookId(bookId: string): void {
  if (!BOOK_ID_PATTERN.test(bookId)) {
    throw new TypeError('Book sync exclusions require a SHA-256 book ID');
  }
}

function isStoredBookSyncExclusions(
  value: unknown,
): value is StoredBookSyncExclusions {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('schemaVersion' in value) ||
    !('bookIds' in value)
  ) {
    return false;
  }
  const candidate = value as Partial<StoredBookSyncExclusions>;
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.bookIds) &&
    candidate.bookIds.length <= MAX_EXCLUDED_BOOKS &&
    candidate.bookIds.every(
      (bookId) => typeof bookId === 'string' && BOOK_ID_PATTERN.test(bookId),
    )
  );
}
