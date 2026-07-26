import {
  NewSyncOperation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';

const SYNC_PROVIDER_STORAGE_KEY = 'omnia-reader.sync-provider';

/**
 * GitHub synchronization now has a supported OAuth/session deployment path.
 * Keep the capability explicit so a local-only distribution can still replace
 * this value at build time without changing persistence contracts.
 */
export const REMOTE_SYNC_ENABLED = true;

/**
 * Discard the obsolete provider choice from builds where remote synchronization
 * is unavailable. This prevents a future scheduler or legacy deep link from
 * silently reviving a credential-dependent provider.
 */
export function clearUnavailableRemoteSyncSelection(
  remoteSyncEnabled = REMOTE_SYNC_ENABLED,
): void {
  if (remoteSyncEnabled) {
    return;
  }

  try {
    globalThis.localStorage?.removeItem(SYNC_PROVIDER_STORAGE_KEY);
  } catch {
    // Restricted storage must not prevent the local reader from starting.
  }
}

/**
 * Local mutations are already durable in the library repository. While remote
 * synchronization is out of scope, acknowledge the journal contract in memory
 * without accumulating provider work that cannot be delivered.
 */
export class LocalOnlySyncOperationJournal implements SyncOperationJournal {
  private revision = 0;

  async append(input: NewSyncOperation): Promise<SyncOperation> {
    this.revision += 1;
    return {
      ...input,
      id: `local-only-${this.revision}`,
      revision: this.revision,
      createdAt: new Date().toISOString(),
    };
  }

  async pending(): Promise<readonly SyncOperation[]> {
    return [];
  }

  async acknowledge(operationIds: readonly string[]): Promise<void> {
    void operationIds;
    // There are no remote operations to acknowledge in a local-only build.
  }
}
