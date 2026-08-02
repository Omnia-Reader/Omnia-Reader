import { describe, expect, it, vi } from 'vitest';
import { LibrarySyncTransport } from './library-sync-transport';
import {
  BrowserSyncProviderSelection,
  SelectedLibrarySyncTransport,
} from './sync-provider-selection';

describe('BrowserSyncProviderSelection', () => {
  it('persists selections and notifies subscribers immediately', () => {
    const storage = new MemoryStorage();
    const selection = new BrowserSyncProviderSelection(storage);
    const listener = vi.fn();
    const unsubscribe = selection.subscribe(listener);

    selection.select('git');
    selection.select('mega');

    expect(listener.mock.calls).toEqual([[null], ['git'], ['mega']]);
    expect(new BrowserSyncProviderSelection(storage).current()).toBe('mega');

    unsubscribe();
    selection.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(selection.current()).toBeNull();
  });

  it('isolates subscriber failures from a valid selection', () => {
    const selection = new BrowserSyncProviderSelection(new MemoryStorage());
    const healthyListener = vi.fn();
    selection.subscribe(() => {
      throw new Error('Presentation failed');
    });
    selection.subscribe(healthyListener);

    expect(() => selection.select('git')).not.toThrow();
    expect(selection.current()).toBe('git');
    expect(healthyListener).toHaveBeenLastCalledWith('git');
  });
});

describe('SelectedLibrarySyncTransport', () => {
  it('forwards a supported destination revision and safely reports an unsupported provider', async () => {
    const storage = new MemoryStorage();
    const selection = new BrowserSyncProviderSelection(storage);
    const destinationRevision = vi
      .fn()
      .mockResolvedValue('repository:main:revision');
    const transport = new SelectedLibrarySyncTransport(selection, {
      git: { destinationRevision } as unknown as LibrarySyncTransport,
      mega: {} as LibrarySyncTransport,
    });

    selection.select('git');
    await expect(transport.destinationRevision()).resolves.toBe(
      'repository:main:revision',
    );
    expect(destinationRevision).toHaveBeenCalledTimes(1);

    selection.select('mega');
    await expect(transport.destinationRevision()).resolves.toBeNull();
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

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
    this.values.set(key, value);
  }
}
