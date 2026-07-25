import { InjectionToken } from '@angular/core';
import { LibraryRepository } from '@omnia-reader/reader/domain';

export const LIBRARY_REPOSITORY = new InjectionToken<LibraryRepository>(
  'LIBRARY_REPOSITORY',
);
