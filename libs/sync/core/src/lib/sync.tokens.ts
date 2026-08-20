import { InjectionToken } from '@angular/core';
import { AutoSyncScheduler } from './auto-sync-scheduler';
import { BookSyncExclusions } from './book-sync-exclusions';
import { SyncWorker } from './library-sync-coordinator';
import { LibrarySyncTransport } from './library-sync-transport';
import { RemoteBookBackupService } from './remote-book-backup-service';
import { RemoteVariantRecovery } from './remote-variant-recovery.service';
import { SyncProviderSelection } from './sync-provider-selection';

export const SYNC_PROVIDER_SELECTION =
  new InjectionToken<SyncProviderSelection>('SYNC_PROVIDER_SELECTION');

export const BOOK_SYNC_EXCLUSIONS = new InjectionToken<BookSyncExclusions>(
  'BOOK_SYNC_EXCLUSIONS',
);

export const ACTIVE_SYNC_TRANSPORT = new InjectionToken<LibrarySyncTransport>(
  'ACTIVE_SYNC_TRANSPORT',
);

export const LIBRARY_SYNC_SERVICE = new InjectionToken<SyncWorker>(
  'LIBRARY_SYNC_SERVICE',
);

export const REMOTE_BOOK_BACKUP_SERVICE =
  new InjectionToken<RemoteBookBackupService>('REMOTE_BOOK_BACKUP_SERVICE');

export const REMOTE_VARIANT_RECOVERY =
  new InjectionToken<RemoteVariantRecovery>('REMOTE_VARIANT_RECOVERY');

export const AUTO_SYNC_SCHEDULER = new InjectionToken<AutoSyncScheduler>(
  'AUTO_SYNC_SCHEDULER',
);
