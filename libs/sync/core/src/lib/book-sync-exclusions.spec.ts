import { describe, expect, it } from 'vitest';
import { BrowserBookSyncExclusions } from './book-sync-exclusions';

describe('BrowserBookSyncExclusions', () => {
  const firstBookId = `sha256:${'a'.repeat(64)}`;
  const secondBookId = `sha256:${'b'.repeat(64)}`;

  it('persists device-local exclusions and allows an explicit re-import', () => {
    const storage = new MemoryStorage();
    const exclusions = new BrowserBookSyncExclusions(storage);

    exclusions.exclude(secondBookId);
    exclusions.exclude(firstBookId);

    const restored = new BrowserBookSyncExclusions(storage);
    expect(restored.isExcluded(firstBookId)).toBe(true);
    expect(restored.isExcluded(secondBookId)).toBe(true);

    restored.include(firstBookId);
    expect(new BrowserBookSyncExclusions(storage).isExcluded(firstBookId)).toBe(
      false,
    );
    expect(
      new BrowserBookSyncExclusions(storage).isExcluded(secondBookId),
    ).toBe(true);
  });

  it('ignores malformed persisted state and validates new book IDs', () => {
    const storage = new MemoryStorage();
    storage.setItem('omnia-reader.sync-excluded-books', '{"schemaVersion":2}');
    const exclusions = new BrowserBookSyncExclusions(storage);

    expect(exclusions.isExcluded(firstBookId)).toBe(false);
    expect(() => exclusions.exclude('not-a-book-id')).toThrow(
      'Book sync exclusions require a SHA-256 book ID',
    );
  });

  it('retains current-session exclusions when browser storage rejects writes', () => {
    const exclusions = new BrowserBookSyncExclusions({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('Storage denied', 'SecurityError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });

    exclusions.exclude(firstBookId);

    expect(exclusions.isExcluded(firstBookId)).toBe(true);
  });

  it('keeps an explicit include authoritative when a persisted update fails', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'omnia-reader.sync-excluded-books',
      JSON.stringify({ schemaVersion: 1, bookIds: [firstBookId] }),
    );
    storage.rejectWrites = true;
    const exclusions = new BrowserBookSyncExclusions(storage);

    expect(exclusions.isExcluded(firstBookId)).toBe(true);
    exclusions.include(firstBookId);

    expect(exclusions.isExcluded(firstBookId)).toBe(false);
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  rejectWrites = false;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.rejectWrites) {
      throw new DOMException('Storage denied', 'SecurityError');
    }
    this.values.set(key, value);
  }
}
