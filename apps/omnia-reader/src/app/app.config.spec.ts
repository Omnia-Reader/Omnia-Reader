import { Provider } from '@angular/core';
import { LibraryRepository } from '@omnia-reader/reader/domain';
import {
  ACTIVE_SYNC_TRANSPORT,
  BOOK_SYNC_EXCLUSIONS,
  ChangeAwareSyncWorker,
  LIBRARY_SYNC_SERVICE,
  LibrarySyncTransport,
  SYNC_PROVIDER_SELECTION,
  SyncProviderSelection,
} from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { appConfig } from './app.config';

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
});
