import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'library',
  },
  {
    path: 'library',
    loadComponent: () =>
      import('./features/library/library-page.component').then(
        (module) => module.LibraryPageComponent,
      ),
  },
  {
    path: 'reader/:bookId',
    loadComponent: () =>
      import('./features/reader/reader-page.component').then(
        (module) => module.ReaderPageComponent,
      ),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings-page.component').then(
        (module) => module.SettingsPageComponent,
      ),
  },
  {
    path: 'settings/sync',
    loadComponent: () =>
      import('./features/settings/sync-settings-page.component').then(
        (module) => module.SyncSettingsPageComponent,
      ),
  },
  {
    path: 'viewer',
    redirectTo: 'library',
  },
  {
    path: '**',
    redirectTo: 'library',
  },
];
