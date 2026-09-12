import { describe, expect, it, vi } from 'vitest';
import { LibrarySyncTransport } from './library-sync-transport';
import {
  BrowserSyncProviderSelection,
  SelectedLibrarySyncTransport,
  SYNC_PROVIDER_MATURITY_POLICY,
  syncProviderPresentation,
} from './sync-provider-selection';

describe('sync provider presentation', () => {
  it('keeps both production providers experimental until release evidence promotes them', () => {
    expect(SYNC_PROVIDER_MATURITY_POLICY).toEqual({
      git: 'experimental',
      mega: 'experimental',
    });
    expect(syncProviderPresentation('git')).toMatchObject({
      name: 'Git + LFS',
      maturityLabel: 'Experimental',
      consequence: expect.stringContaining('keep another backup'),
    });
    expect(syncProviderPresentation('mega')).toMatchObject({
      name: 'MEGA',
      maturityLabel: 'Experimental',
      consequence: expect.stringContaining('keep another backup'),
    });
  });

  it('derives supported copy only from an explicit policy, never selection history', () => {
    const storage = new MemoryStorage();
    const selection = new BrowserSyncProviderSelection(storage);
    selection.select('git');
    selection.select('mega');
    storage.setItem('omnia-reader.sync-provider-history', 'successful');
    const policy = { git: 'supported', mega: 'experimental' } as const;

    expect(syncProviderPresentation('git', policy)).toEqual({
      provider: 'git',
      name: 'Git + LFS',
      maturity: 'supported',
      maturityLabel: 'Supported',
      consequence:
        'Validated for production synchronization on supported platforms.',
    });
    expect(syncProviderPresentation('mega', policy).maturity).toBe(
      'experimental',
    );
    expect(syncProviderPresentation('git').maturity).toBe('experimental');
  });
});

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

  it('keeps provider selection usable when browser storage is unavailable', () => {
    const storage = new MemoryStorage();
    storage.rejectAccess = true;
    const selection = new BrowserSyncProviderSelection(storage);
    const listener = vi.fn();
    selection.subscribe(listener);

    expect(selection.current()).toBeNull();
    expect(() => selection.select('git')).not.toThrow();
    expect(selection.current()).toBe('git');
    expect(() => selection.clear()).not.toThrow();
    expect(selection.current()).toBeNull();
    expect(listener.mock.calls).toEqual([[null], ['git'], [null]]);
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

  it('forwards confined inventory and raw entry deletion to the selected provider', async () => {
    const selection = new BrowserSyncProviderSelection(new MemoryStorage());
    const entry = {
      path: '.omnia-reader/v1/obsolete.bin',
      revision: 'revision-1',
      kind: 'object' as const,
    };
    const listEntries = vi.fn().mockResolvedValue([entry]);
    const deleteEntries = vi.fn().mockResolvedValue(undefined);
    const transport = new SelectedLibrarySyncTransport(selection, {
      git: { listEntries, deleteEntries } as unknown as LibrarySyncTransport,
      mega: {} as LibrarySyncTransport,
    });
    selection.select('git');

    await expect(transport.listEntries('.omnia-reader/v1')).resolves.toEqual([
      entry,
    ]);
    await expect(
      transport.deleteEntries([
        { path: entry.path, expectedRevision: entry.revision },
      ]),
    ).resolves.toBeUndefined();
    expect(deleteEntries).toHaveBeenCalledWith([
      { path: entry.path, expectedRevision: entry.revision },
    ]);
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  rejectAccess = false;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    this.assertAccessible();
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.assertAccessible();
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.assertAccessible();
    this.values.set(key, value);
  }

  private assertAccessible(): void {
    if (this.rejectAccess) {
      throw new DOMException('Storage denied', 'SecurityError');
    }
  }
}
