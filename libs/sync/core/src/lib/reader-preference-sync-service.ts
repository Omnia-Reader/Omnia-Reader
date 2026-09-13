import {
  DEFAULT_EPUB_READER_PREFERENCES,
  DEFAULT_PDF_READER_PREFERENCES,
  EPUB_READER_PREFERENCE_FIELDS,
  PDF_READER_PREFERENCE_FIELDS,
  isReaderPreferenceChange,
  mergeReaderPreferenceSyncStates,
  parseReaderPreferenceSyncState,
  readerPreferencesFromSyncState,
  serializeReaderPreferenceSyncState,
  type LibraryRepository,
  type ReaderPreferenceChange,
  type ReaderPreferenceRegister,
  type ReaderPreferenceSyncPersistence,
  type ReaderPreferenceSyncState,
  type SyncOperation,
  type SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import type { SyncWorkerResult } from './library-sync-coordinator';
import {
  type LibrarySyncTransport,
  type RemoteDocument,
  SyncConflictError,
} from './library-sync-transport';

export const READER_PREFERENCE_SYNC_PATH =
  '.omnia-reader/preferences/state.json';

export type ReaderPreferenceSyncRepository = Pick<
  LibraryRepository,
  'getReaderPreferences' | 'saveReaderPreferences'
> &
  ReaderPreferenceSyncPersistence;

export interface ReaderPreferenceSyncOptions {
  destinationId: string;
  deviceId: string;
  createChangeId: (format: 'epub' | 'pdf', field: string) => string;
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

const EMPTY_STATE: ReaderPreferenceSyncState = {
  schemaVersion: 1,
  epub: {},
  pdf: {},
};

export class ReaderPreferenceSyncService {
  private readonly maxConflictRetries: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private activeSync: Promise<SyncWorkerResult> | null = null;

  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly journal: SyncOperationJournal,
    private readonly repository: ReaderPreferenceSyncRepository,
    private readonly options: ReaderPreferenceSyncOptions,
  ) {
    this.maxConflictRetries = options.maxConflictRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.wait = options.wait ?? wait;
  }

  synchronize(): Promise<SyncWorkerResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization().finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  private async runSynchronization(): Promise<SyncWorkerResult> {
    await this.relayOutbox();
    const pending = await this.journal.pending();
    const accepted = pending.filter(isPreferenceOperation);
    const rejectedOperations =
      pending.filter((operation) => operation.entity === 'preference').length -
      accepted.length;
    const changes = uniqueChanges(accepted);
    const metadata = await this.repository.getReaderPreferenceSyncMetadata(
      this.options.destinationId,
    );
    let conflicts = 0;

    for (let attempt = 0; ; attempt += 1) {
      const current = await this.remote.read(READER_PREFERENCE_SYNC_PATH);
      const remoteState = parseRemoteState(current);
      if (current && !remoteState) {
        return {
          pulled: 0,
          pushed: 0,
          conflicts,
          rejected: rejectedOperations + 1,
        };
      }

      let state = metadata?.state ?? EMPTY_STATE;
      let baseline: 'remote' | 'seeded' = metadata?.baseline ?? 'seeded';
      if (!metadata && remoteState) {
        state = remoteState;
        baseline = 'remote';
      } else if (!metadata && !remoteState) {
        state = await this.seedState();
      } else if (remoteState) {
        state = mergeReaderPreferenceSyncStates(state, remoteState);
      }
      for (const change of changes) {
        state = mergeReaderPreferenceSyncStates(state, stateForChange(change));
      }

      const content = serializeReaderPreferenceSyncState(state);
      let pushed = 0;
      try {
        if (
          !remoteState ||
          serializeReaderPreferenceSyncState(remoteState) !== content
        ) {
          await this.remote.write({
            path: READER_PREFERENCE_SYNC_PATH,
            content,
            expectedRevision: current?.revision,
            message: 'Update Omnia Reader preferences',
          });
          pushed = 1;
        }

        const verified = parseRemoteState(
          await this.remote.read(READER_PREFERENCE_SYNC_PATH),
        );
        if (
          !verified ||
          serializeReaderPreferenceSyncState(verified) !== content
        ) {
          throw new SyncConflictError(
            'Reader preference state changed before verification',
          );
        }
        await this.repository.saveSynchronizedReaderPreferences(
          [
            readerPreferencesFromSyncState('epub', state),
            readerPreferencesFromSyncState('pdf', state),
          ],
          {
            schemaVersion: 1,
            destinationId: this.options.destinationId,
            baseline,
            state,
          },
        );
        await this.journal.acknowledge(
          accepted.map((operation) => operation.id),
        );
        return {
          pulled: current ? 1 : 0,
          pushed,
          conflicts,
          rejected: rejectedOperations,
        };
      } catch (error) {
        if (
          !(error instanceof SyncConflictError) ||
          attempt >= this.maxConflictRetries
        ) {
          throw error;
        }
        conflicts += 1;
        await this.wait(this.retryDelayMs * 2 ** attempt);
      }
    }
  }

  private async relayOutbox(): Promise<void> {
    const [outbox, pending] = await Promise.all([
      this.repository.listPendingReaderPreferenceChanges(),
      this.journal.pending(),
    ]);
    const relayed = new Set(
      pending
        .filter(isPreferenceOperation)
        .map((operation) => operation.entityId),
    );
    for (const change of outbox) {
      const changeId = change.register.changeId;
      if (!relayed.has(changeId)) {
        await this.journal.append({
          entity: 'preference',
          entityId: changeId,
          operation: 'upsert',
          payload: change,
        });
      }
      await this.repository.acknowledgePendingReaderPreferenceChanges([
        changeId,
      ]);
    }
  }

  private async seedState(): Promise<ReaderPreferenceSyncState> {
    let state = EMPTY_STATE;
    const epub = await this.repository.getReaderPreferences('epub');
    if (epub?.format === 'epub') {
      for (const field of EPUB_READER_PREFERENCE_FIELDS) {
        if (epub[field] !== DEFAULT_EPUB_READER_PREFERENCES[field]) {
          state = mergeReaderPreferenceSyncStates(
            state,
            stateForSeed(
              'epub',
              field,
              epub[field],
              this.options.deviceId,
              this.options.createChangeId('epub', field),
            ),
          );
        }
      }
    }
    const pdf = await this.repository.getReaderPreferences('pdf');
    if (pdf?.format === 'pdf') {
      for (const field of PDF_READER_PREFERENCE_FIELDS) {
        if (pdf[field] !== DEFAULT_PDF_READER_PREFERENCES[field]) {
          state = mergeReaderPreferenceSyncStates(
            state,
            stateForSeed(
              'pdf',
              field,
              pdf[field],
              this.options.deviceId,
              this.options.createChangeId('pdf', field),
            ),
          );
        }
      }
    }
    return state;
  }
}

function parseRemoteState(
  document: RemoteDocument | null,
): ReaderPreferenceSyncState | null {
  if (!document || document.path !== READER_PREFERENCE_SYNC_PATH) return null;
  try {
    return parseReaderPreferenceSyncState(document.content);
  } catch {
    return null;
  }
}

type PreferenceSyncOperation = SyncOperation & {
  readonly entity: 'preference';
  readonly operation: 'upsert';
  readonly payload: ReaderPreferenceChange;
};

function isPreferenceOperation(
  operation: SyncOperation,
): operation is PreferenceSyncOperation {
  return (
    operation.entity === 'preference' &&
    operation.operation === 'upsert' &&
    isReaderPreferenceChange(operation.payload) &&
    operation.entityId === operation.payload.register.changeId
  );
}

function uniqueChanges(
  operations: readonly SyncOperation[],
): ReaderPreferenceChange[] {
  const changes = new Map<string, ReaderPreferenceChange>();
  for (const operation of operations) {
    if (isPreferenceOperation(operation)) {
      changes.set(operation.entityId, operation.payload);
    }
  }
  return [...changes.values()];
}

function stateForChange(
  change: ReaderPreferenceChange,
): ReaderPreferenceSyncState {
  return stateForSeed(
    change.format,
    change.field,
    change.register.value,
    change.register.deviceId,
    change.register.changeId,
    change.register.revision,
  );
}

function stateForSeed(
  format: 'epub' | 'pdf',
  field: string,
  value: unknown,
  deviceId: string,
  changeId: string,
  revision = 1,
): ReaderPreferenceSyncState {
  const register: ReaderPreferenceRegister<unknown> = {
    value,
    revision,
    deviceId,
    changeId,
  };
  const state = {
    schemaVersion: 1,
    epub: format === 'epub' ? { [field]: register } : {},
    pdf: format === 'pdf' ? { [field]: register } : {},
  };
  return state as ReaderPreferenceSyncState;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
