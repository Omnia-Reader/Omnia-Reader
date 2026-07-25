import { InjectionToken } from '@angular/core';
import type { QuarantinedLibraryRecord } from './browser-library-repository';

export interface LibraryQuarantineRepository {
  listQuarantinedRecords(): Promise<readonly QuarantinedLibraryRecord[]>;
}

export const LIBRARY_QUARANTINE_REPOSITORY =
  new InjectionToken<LibraryQuarantineRepository>(
    'LIBRARY_QUARANTINE_REPOSITORY',
  );
