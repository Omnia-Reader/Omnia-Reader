import {
  NewSyncOperation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';

export type SyncActivityKind = NewSyncOperation['entity'];

export interface SyncActivity {
  kind: SyncActivityKind;
  entityId: string;
}

export type SyncActivityListener = (activity: SyncActivity) => void;

/**
 * A small process-local event boundary between durable writes and automatic
 * synchronization. Listener failures are deliberately isolated: appending to
 * the local journal must remain authoritative even when scheduling fails.
 */
export class SyncActivityNotifier {
  private readonly listeners = new Set<SyncActivityListener>();

  subscribe(listener: SyncActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(activity: SyncActivity): void {
    for (const listener of this.listeners) {
      try {
        listener(activity);
      } catch {
        // Automatic sync is best-effort and must never reject a local write.
      }
    }
  }
}

export class NotifyingSyncOperationJournal implements SyncOperationJournal {
  constructor(
    private readonly delegate: SyncOperationJournal,
    private readonly activity: SyncActivityNotifier,
  ) {}

  async append(input: NewSyncOperation): Promise<SyncOperation> {
    const operation = await this.delegate.append(input);
    this.activity.notify({
      kind: input.entity,
      entityId: input.entityId,
    });
    return operation;
  }

  pending(): Promise<readonly SyncOperation[]> {
    return this.delegate.pending();
  }

  acknowledge(operationIds: readonly string[]): Promise<void> {
    return this.delegate.acknowledge(operationIds);
  }
}
