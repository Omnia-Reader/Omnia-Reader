import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { installBenignBrowserErrorFilter } from './app/browser-error-filter';

installBenignBrowserErrorFilter();
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
