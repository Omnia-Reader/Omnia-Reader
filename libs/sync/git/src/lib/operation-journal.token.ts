import { InjectionToken } from '@angular/core';
import { SyncOperationJournal } from '@omnia-reader/reader/domain';

export const SYNC_OPERATION_JOURNAL = new InjectionToken<SyncOperationJournal>(
  'SYNC_OPERATION_JOURNAL',
);
