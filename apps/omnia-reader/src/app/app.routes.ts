import { Route } from '@angular/router';
import { Viewer } from './components/viewer/viewer';

export const appRoutes: Route[] = [
  {
    path: 'viewer',
    component: Viewer
  }
];
