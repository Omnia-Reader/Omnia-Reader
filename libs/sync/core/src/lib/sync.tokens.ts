import { InjectionToken } from '@angular/core';
import { AutoSyncScheduler } from './auto-sync-scheduler';
import { SyncWorker } from './library-sync-coordinator';
import { LibrarySyncTransport } from './library-sync-transport';
import { SyncProviderSelection } from './sync-provider-selection';

export const SYNC_PROVIDER_SELECTION =
  new InjectionToken<SyncProviderSelection>('SYNC_PROVIDER_SELECTION');

export const ACTIVE_SYNC_TRANSPORT = new InjectionToken<LibrarySyncTransport>(
  'ACTIVE_SYNC_TRANSPORT',
);

export const LIBRARY_SYNC_SERVICE = new InjectionToken<SyncWorker>(
  'LIBRARY_SYNC_SERVICE',
);

export const AUTO_SYNC_SCHEDULER = new InjectionToken<AutoSyncScheduler>(
  'AUTO_SYNC_SCHEDULER',
);
