import {
  ApplicationConfig,
  DestroyRef,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, Router, RouteReuseStrategy } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideServiceWorker } from '@angular/service-worker';
import {
  BrowserLibraryRepository,
  LIBRARY_QUARANTINE_REPOSITORY,
  LIBRARY_REPOSITORY,
} from '@omnia-reader/library/data-access';
import { PLATFORM_PORT, providePlatform } from '@omnia-reader/platform';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  LibraryRepository,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  ACTIVE_SYNC_TRANSPORT,
  AUTO_SYNC_SCHEDULER,
  AnnotationSyncService,
  AutoSyncScheduler,
  BookSyncService,
  BookmarkSyncService,
  BrowserSyncProviderSelection,
  LibrarySyncCoordinator,
  LibrarySyncManifestService,
  LibrarySyncTransport,
  LIBRARY_SYNC_SERVICE,
  NotifyingSyncOperationJournal,
  ProgressDocumentRepository,
  ProgressSyncService,
  SelectedLibrarySyncTransport,
  SyncActivityNotifier,
  SYNC_PROVIDER_SELECTION,
  SyncProviderSelection,
  SyncWorker,
} from '@omnia-reader/sync/core';
import {
  GITHUB_GATEWAY,
  GitHubGateway,
  GitHubGatewayClient,
  IndexedDbOperationJournal,
  SYNC_OPERATION_JOURNAL,
} from '@omnia-reader/sync/git';
import {
  MEGA_GATEWAY,
  MegaGateway,
  MegaGatewayClient,
} from '@omnia-reader/sync/mega';
import { appRoutes } from './app.routes';
import { BackNavigationService } from './back-navigation.service';
import { BookDeepLinkService } from './book-deep-link.service';
import { PublicationImportService } from './features/library/publication-import.service';
import { ReaderRouteReuseStrategy } from './reader-route-reuse-strategy';

function createReaderEngineRegistry(): ReaderEngineRegistry {
  const registry = new ReaderEngineRegistry();
  registry.register('epub', async () => {
    const { EpubReaderEngine } = await import('@omnia-reader/reader/epub');
    return new EpubReaderEngine();
  });
  registry.register('pdf', async () => {
    const { PdfReaderEngine } = await import('@omnia-reader/reader/pdf');
    return new PdfReaderEngine();
  });
  return registry;
}

function createLibrarySyncService(
  remote: LibrarySyncTransport,
  journal: SyncOperationJournal,
  repository: LibraryRepository & ProgressDocumentRepository,
): SyncWorker {
  return new LibrarySyncCoordinator({
    schema: new LibrarySyncManifestService(remote),
    books: new BookSyncService(remote, journal, repository),
    progress: new ProgressSyncService(remote, journal, repository),
    bookmarks: new BookmarkSyncService(remote, journal, repository),
    annotations: new AnnotationSyncService(remote, journal, repository),
  });
}

function createSelectedSyncTransport(
  selection: SyncProviderSelection,
  git: GitHubGateway,
  mega: MegaGateway,
): LibrarySyncTransport {
  return new SelectedLibrarySyncTransport(selection, { git, mega });
}

function createSyncJournal(
  activity: SyncActivityNotifier,
): SyncOperationJournal {
  return new NotifyingSyncOperationJournal(
    new IndexedDbOperationJournal(),
    activity,
  );
}

function createAutoSyncScheduler(
  sync: SyncWorker,
  selection: SyncProviderSelection,
  activity: SyncActivityNotifier,
): AutoSyncScheduler {
  return new AutoSyncScheduler(sync, selection, activity);
}

function initializeAutomaticSync(): void {
  const scheduler = inject(AUTO_SYNC_SCHEDULER);
  const platform = inject(PLATFORM_PORT);
  const stopBackgroundListener = platform.onBackground(() =>
    scheduler.requestImmediate('background'),
  );

  scheduler.start();
  inject(DestroyRef).onDestroy(() => {
    stopBackgroundListener();
    scheduler.stop();
  });
}

async function initializePublicationIngress(): Promise<void> {
  const platform = inject(PLATFORM_PORT);
  const publicationImports = inject(PublicationImportService);
  const router = inject(Router);
  const destroyRef = inject(DestroyRef);
  const stopOpenedListener = await platform.onPublicationsOpened(
    async (sources) => {
      try {
        publicationImports.clearError();
        const books = await publicationImports.importPublications(sources);
        if (books.length === 1) {
          await router.navigate(['/reader', books[0].id]);
        } else if (books.length > 1) {
          await router.navigate(['/library']);
        }
      } catch (error) {
        publicationImports.reportError(error);
        await router.navigate(['/library']);
      }
    },
  );
  destroyRef.onDestroy(stopOpenedListener);
}

async function initializeBackNavigation(): Promise<void> {
  const backNavigation = inject(BackNavigationService);
  const destroyRef = inject(DestroyRef);
  const stopBackNavigation = await backNavigation.start();
  destroyRef.onDestroy(stopBackNavigation);
}

async function initializeBookDeepLinks(): Promise<void> {
  const deepLinks = inject(BookDeepLinkService);
  const destroyRef = inject(DestroyRef);
  const stopDeepLinks = await deepLinks.start();
  destroyRef.onDestroy(stopDeepLinks);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    {
      provide: RouteReuseStrategy,
      useClass: ReaderRouteReuseStrategy,
    },
    provideAnimationsAsync(),
    providePlatform(),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    {
      provide: BrowserLibraryRepository,
      useFactory: () => new BrowserLibraryRepository(),
    },
    {
      provide: LIBRARY_REPOSITORY,
      useExisting: BrowserLibraryRepository,
    },
    {
      provide: LIBRARY_QUARANTINE_REPOSITORY,
      useExisting: BrowserLibraryRepository,
    },
    {
      provide: ReaderEngineRegistry,
      useFactory: createReaderEngineRegistry,
    },
    SyncActivityNotifier,
    {
      provide: SYNC_OPERATION_JOURNAL,
      useFactory: createSyncJournal,
      deps: [SyncActivityNotifier],
    },
    {
      provide: GITHUB_GATEWAY,
      useFactory: () => new GitHubGatewayClient(),
    },
    {
      provide: MEGA_GATEWAY,
      useFactory: () => new MegaGatewayClient(),
    },
    {
      provide: SYNC_PROVIDER_SELECTION,
      useFactory: () => new BrowserSyncProviderSelection(),
    },
    {
      provide: ACTIVE_SYNC_TRANSPORT,
      useFactory: createSelectedSyncTransport,
      deps: [SYNC_PROVIDER_SELECTION, GITHUB_GATEWAY, MEGA_GATEWAY],
    },
    {
      provide: LIBRARY_SYNC_SERVICE,
      useFactory: createLibrarySyncService,
      deps: [ACTIVE_SYNC_TRANSPORT, SYNC_OPERATION_JOURNAL, LIBRARY_REPOSITORY],
    },
    {
      provide: AUTO_SYNC_SCHEDULER,
      useFactory: createAutoSyncScheduler,
      deps: [
        LIBRARY_SYNC_SERVICE,
        SYNC_PROVIDER_SELECTION,
        SyncActivityNotifier,
      ],
    },
    provideAppInitializer(initializeAutomaticSync),
    provideAppInitializer(initializePublicationIngress),
    provideAppInitializer(initializeBookDeepLinks),
    provideAppInitializer(initializeBackNavigation),
  ],
};
