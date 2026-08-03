import {
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  PendingReadingStateSyncWorker,
  SyncWorker,
  SyncWorkerOptions,
  SyncWorkerResult,
  throwIfSyncAborted,
} from './library-sync-coordinator';
import { LibrarySyncTransport } from './library-sync-transport';
import {
  SyncProviderKind,
  SyncProviderSelection,
} from './sync-provider-selection';

const STORAGE_KEY = 'omnia-reader.sync-checkpoint';
const MAX_STORED_CHECKPOINT_LENGTH = 2_048;
const MAX_REVISION_LENGTH = 1_024;
const UNCHANGED_RESULT: SyncWorkerResult = {
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  rejected: 0,
  unchanged: true,
};

interface StoredSyncCheckpoint {
  schemaVersion: 3;
  git?: string;
  mega?: string;
}

export interface SyncCheckpointStore {
  read(provider: SyncProviderKind): string | null;
  write(provider: SyncProviderKind, revision: string | null): void;
}

/**
 * Best-effort, device-local evidence used only to avoid a redundant provider
 * walk. The durable journal and complete merge remain authoritative.
 */
export class BrowserSyncCheckpointStore implements SyncCheckpointStore {
  constructor(
    private readonly storage: Storage | undefined = browserStorage(),
  ) {}

  read(provider: SyncProviderKind): string | null {
    try {
      const serialized = this.storage?.getItem(STORAGE_KEY);
      if (!serialized || serialized.length > MAX_STORED_CHECKPOINT_LENGTH) {
        return null;
      }
      const value: unknown = JSON.parse(serialized);
      if (!isStoredSyncCheckpoint(value)) {
        return null;
      }
      return value[provider] ?? null;
    } catch {
      return null;
    }
  }

  write(provider: SyncProviderKind, revision: string | null): void {
    try {
      const current = this.readStored();
      if (revision === null) {
        delete current[provider];
      } else if (validRevision(revision)) {
        current[provider] = revision;
      } else {
        delete current[provider];
      }
      const serialized = JSON.stringify(current);
      if (serialized.length > MAX_STORED_CHECKPOINT_LENGTH) {
        this.storage?.removeItem(STORAGE_KEY);
        return;
      }
      this.storage?.setItem(STORAGE_KEY, serialized);
    } catch {
      // A performance checkpoint can never affect authoritative sync behavior.
    }
  }

  private readStored(): StoredSyncCheckpoint {
    const serialized = this.storage?.getItem(STORAGE_KEY);
    if (!serialized || serialized.length > MAX_STORED_CHECKPOINT_LENGTH) {
      return { schemaVersion: 3 };
    }
    const value: unknown = JSON.parse(serialized);
    return isStoredSyncCheckpoint(value) ? { ...value } : { schemaVersion: 3 };
  }
}

/**
 * Uses an opaque remote revision to bypass the expensive coordinator only when
 * both local durable work and remote changes are proven absent.
 */
export class ChangeAwareSyncWorker implements SyncWorker {
  private activeSync: Promise<SyncWorkerResult> | null = null;
  private readingStateContinuationScope: string | null = null;

  constructor(
    private readonly delegate: SyncWorker,
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly selection: SyncProviderSelection,
    private readonly checkpoints: SyncCheckpointStore = new BrowserSyncCheckpointStore(),
    private readonly readingStateWorker?: PendingReadingStateSyncWorker,
  ) {}

  synchronize(options: SyncWorkerOptions = {}): Promise<SyncWorkerResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization(options).finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  private async runSynchronization(
    options: SyncWorkerOptions,
  ): Promise<SyncWorkerResult> {
    throwIfSyncAborted(options.signal);
    const provider = this.selection.current();
    if (
      provider !== 'git' ||
      typeof this.remote.destinationRevision !== 'function'
    ) {
      this.readingStateContinuationScope = null;
      return this.delegate.synchronize(options);
    }

    const pendingBefore = await this.journal.pending();
    throwIfSyncAborted(options.signal);
    const revisionBefore = await this.remote.destinationRevision({
      signal: options.signal,
    });
    throwIfSyncAborted(options.signal);
    if (revisionBefore === null) {
      return this.delegate.synchronize(options);
    }

    const trustedCheckpoint = safeCheckpointRead(this.checkpoints, provider);
    if (pendingBefore.length === 0 && trustedCheckpoint === revisionBefore) {
      const pendingAfterProbe = await this.journal.pending();
      throwIfSyncAborted(options.signal);
      if (pendingAfterProbe.length === 0) {
        return { ...UNCHANGED_RESULT };
      }
    }

    if (
      this.readingStateWorker &&
      (trustedCheckpoint === revisionBefore ||
        this.readingStateContinuationScope === revisionScope(revisionBefore)) &&
      isReadingStateOnly(pendingBefore)
    ) {
      let result: SyncWorkerResult;
      try {
        result = await this.readingStateWorker.synchronizePending(
          pendingBefore,
          options,
        );
      } catch (error) {
        this.readingStateContinuationScope = null;
        throw error;
      }
      throwIfSyncAborted(options.signal);
      const pendingAfter = await this.journal.pending();
      throwIfSyncAborted(options.signal);
      const canContinue = result.conflicts === 0 && result.rejected === 0;
      this.readingStateContinuationScope = canContinue
        ? revisionScope(revisionBefore)
        : null;
      if (result.pushed > 0 || !canContinue || pendingAfter.length > 0) {
        safeCheckpointWrite(this.checkpoints, provider, null);
      }
      return result;
    }

    this.readingStateContinuationScope = null;
    const result = await this.delegate.synchronize(options);
    throwIfSyncAborted(options.signal);
    const pendingAfter = await this.journal.pending();
    throwIfSyncAborted(options.signal);
    const revisionAfter = await this.remote.destinationRevision({
      signal: options.signal,
    });
    throwIfSyncAborted(options.signal);

    if (
      revisionAfter !== null &&
      pendingAfter.length === 0 &&
      result.conflicts === 0 &&
      result.rejected === 0 &&
      (result.pushed > 0 || revisionBefore !== revisionAfter)
    ) {
      const verification = await this.delegate.synchronize(options);
      throwIfSyncAborted(options.signal);
      const pendingAfterVerification = await this.journal.pending();
      throwIfSyncAborted(options.signal);
      const revisionAfterVerification = await this.remote.destinationRevision({
        signal: options.signal,
      });
      throwIfSyncAborted(options.signal);
      const stable =
        revisionAfterVerification !== null &&
        revisionAfter === revisionAfterVerification &&
        pendingAfterVerification.length === 0 &&
        verification.pushed === 0 &&
        verification.conflicts === 0 &&
        verification.rejected === 0;
      safeCheckpointWrite(
        this.checkpoints,
        provider,
        stable ? revisionAfterVerification : null,
      );
      return combineResults(result, verification);
    }

    const stable =
      revisionAfter !== null &&
      revisionBefore === revisionAfter &&
      pendingAfter.length === 0 &&
      result.pushed === 0 &&
      result.conflicts === 0 &&
      result.rejected === 0;
    safeCheckpointWrite(
      this.checkpoints,
      provider,
      stable ? revisionAfter : null,
    );
    return result;
  }
}

function isReadingStateOnly(operations: readonly SyncOperation[]): boolean {
  return (
    operations.length > 0 &&
    operations.every(
      (operation) =>
        operation.entity === 'progress' ||
        operation.entity === 'bookmark' ||
        operation.entity === 'annotation',
    )
  );
}

function revisionScope(revision: string): string | null {
  const separator = revision.lastIndexOf(':');
  return separator > 0 ? revision.slice(0, separator) : null;
}

function combineResults(
  initial: SyncWorkerResult,
  verification: SyncWorkerResult,
): SyncWorkerResult {
  return {
    ...initial,
    pulled: initial.pulled + verification.pulled,
    pushed: initial.pushed + verification.pushed,
    conflicts: initial.conflicts + verification.conflicts,
    rejected: initial.rejected + verification.rejected,
  };
}

function safeCheckpointRead(
  checkpoints: SyncCheckpointStore,
  provider: SyncProviderKind,
): string | null {
  try {
    const revision = checkpoints.read(provider);
    return revision !== null && validRevision(revision) ? revision : null;
  } catch {
    return null;
  }
}

function safeCheckpointWrite(
  checkpoints: SyncCheckpointStore,
  provider: SyncProviderKind,
  revision: string | null,
): void {
  try {
    checkpoints.write(provider, revision);
  } catch {
    // Checkpoint persistence is an optimization, never a sync prerequisite.
  }
}

function isStoredSyncCheckpoint(value: unknown): value is StoredSyncCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StoredSyncCheckpoint>;
  return (
    candidate.schemaVersion === 3 &&
    (candidate.git === undefined || validRevision(candidate.git)) &&
    (candidate.mega === undefined || validRevision(candidate.mega))
  );
}

function validRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REVISION_LENGTH &&
    !value.includes('\0')
  );
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
