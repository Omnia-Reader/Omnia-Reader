import { InjectionToken } from '@angular/core';
import { LIBRARY_SYNC_SERVICE } from '@omnia-reader/sync/core';
import { GitHubGateway } from './github-gateway-client';

export const GITHUB_GATEWAY = new InjectionToken<GitHubGateway>(
  'GITHUB_GATEWAY',
);

/** @deprecated Use LIBRARY_SYNC_SERVICE. */
export const GIT_SYNC_SERVICE = LIBRARY_SYNC_SERVICE;

export { LIBRARY_SYNC_SERVICE };
