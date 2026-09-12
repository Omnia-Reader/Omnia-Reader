import { Provider } from '@angular/core';
import { LibraryRepository, PlatformPort } from '@omnia-reader/reader/domain';
import {
  ACTIVE_SYNC_TRANSPORT,
  BOOK_SYNC_EXCLUSIONS,
  ChangeAwareSyncWorker,
  LIBRARY_SYNC_SERVICE,
  LibrarySyncTransport,
  SYNC_PROVIDER_SELECTION,
  SyncProviderSelection,
} from '@omnia-reader/sync/core';
import { GitHubGateway, SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { MegaGateway } from '@omnia-reader/sync/mega';
import { NativeSyncProvider } from '@omnia-reader/sync/native';
import { appConfig, createSelectedSyncTransport } from './app.config';

describe('appConfig synchronization composition', () => {
  it('uses one change-aware worker for shared manual and automatic synchronization', () => {
    const provider = (appConfig.providers as Provider[]).find(
      (candidate) =>
        !!candidate &&
        typeof candidate === 'object' &&
        'provide' in candidate &&
        candidate.provide === LIBRARY_SYNC_SERVICE,
    );
    expect(provider).toBeDefined();
    expect(provider).toMatchObject({
      deps: [
        ACTIVE_SYNC_TRANSPORT,
        SYNC_OPERATION_JOURNAL,
        expect.anything(),
        BOOK_SYNC_EXCLUSIONS,
        SYNC_PROVIDER_SELECTION,
      ],
    });

    const factory = (
      provider as unknown as {
        useFactory: (...values: never[]) => unknown;
      }
    ).useFactory;
    const remote = {} as LibrarySyncTransport;
    const journal = {
      append: vi.fn(),
      pending: vi.fn().mockResolvedValue([]),
      acknowledge: vi.fn(),
    };
    const repository = {} as LibraryRepository;
    const exclusions = {
      isExcluded: () => false,
      exclude: vi.fn(),
      include: vi.fn(),
    };
    const selection: SyncProviderSelection = {
      current: () => 'git',
      select: vi.fn(),
      clear: vi.fn(),
    };

    expect(
      factory(
        remote as never,
        journal as never,
        repository as never,
        exclusions as never,
        selection as never,
      ),
    ).toBeInstanceOf(ChangeAwareSyncWorker);
  });

  it('keeps browser synchronization on the existing same-origin gateways', async () => {
    const git = syncTransport();
    const mega = syncTransport();
    const createNative = vi.fn();
    const destroyRef = { onDestroy: vi.fn() };

    const transport = createSelectedSyncTransport(
      providerSelection('git'),
      git as unknown as GitHubGateway,
      mega as unknown as MegaGateway,
      { kind: 'web' } as PlatformPort,
      destroyRef as never,
      createNative,
    );

    await transport.read('.omnia-reader/manifest.json');
    expect(git.read).toHaveBeenCalledTimes(1);
    expect(mega.read).not.toHaveBeenCalled();
    expect(createNative).not.toHaveBeenCalled();
    expect(destroyRef.onDestroy).not.toHaveBeenCalled();
  });

  it.each(['tauri-desktop', 'tauri-android'] as const)(
    'selects typed native transports and tears them down for %s',
    async (kind) => {
      const browserGit = syncTransport();
      const browserMega = syncTransport();
      const nativeGit = syncTransport();
      const nativeMega = syncTransport();
      const createNative = vi.fn((provider: NativeSyncProvider) =>
        provider === 'git' ? nativeGit : nativeMega,
      );
      let destroy = (): void => undefined;
      const destroyRef = {
        onDestroy: vi.fn((callback: () => void) => {
          destroy = callback;
        }),
      };

      const transport = createSelectedSyncTransport(
        providerSelection('mega'),
        browserGit as unknown as GitHubGateway,
        browserMega as unknown as MegaGateway,
        { kind } as PlatformPort,
        destroyRef as never,
        createNative,
      );
      await transport.read('.omnia-reader/manifest.json');

      expect(createNative.mock.calls.map(([provider]) => provider)).toEqual([
        'git',
        'mega',
      ]);
      expect(nativeMega.read).toHaveBeenCalledTimes(1);
      expect(browserGit.read).not.toHaveBeenCalled();
      expect(browserMega.read).not.toHaveBeenCalled();

      destroy();
      await vi.waitFor(() => {
        expect(nativeGit.dispose).toHaveBeenCalledTimes(1);
        expect(nativeMega.dispose).toHaveBeenCalledTimes(1);
      });
    },
  );
});

function providerSelection(provider: 'git' | 'mega'): SyncProviderSelection {
  return {
    current: () => provider,
    select: vi.fn(),
    clear: vi.fn(),
  };
}

function syncTransport() {
  return {
    destinationRevision: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    listEntries: vi.fn().mockResolvedValue([]),
    deleteEntries: vi.fn().mockResolvedValue(undefined),
    deleteEntry: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn(),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    headObject: vi.fn().mockResolvedValue(null),
    downloadObject: vi.fn(),
    uploadObject: vi.fn(),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}
