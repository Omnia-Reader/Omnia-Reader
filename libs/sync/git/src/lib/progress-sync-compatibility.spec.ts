import {
  ProgressSyncService,
  progressDocumentPath as coreProgressDocumentPath,
} from '@omnia-reader/sync/core';
import { progressDocumentPath } from './git-paths';
import { GitSyncService } from './git-sync-service';

describe('sync-git progress compatibility exports', () => {
  it('delegate provider-neutral progress policy to sync-core', () => {
    const identity = {
      bookId: `sha256:${'a'.repeat(64)}`,
      deviceId: 'device-a',
    };

    expect(GitSyncService).toBe(ProgressSyncService);
    expect(progressDocumentPath(identity)).toBe(
      coreProgressDocumentPath(identity),
    );
  });
});
