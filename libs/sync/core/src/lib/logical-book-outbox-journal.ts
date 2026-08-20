import {
  isLogicalBookChange,
  LogicalBookChangeOutbox,
  NewSyncOperation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';

const OUTBOX_OPERATION_PREFIX = 'logical-book-outbox:';

/**
 * Presents atomically committed logical changes through the existing journal
 * contract until the normal IndexedDB journal has accepted them. Duplicate
 * journal/outbox views are intentional and safe because logical changes have
 * immutable identities and the sync fold deduplicates them by change ID.
 */
export class LogicalBookOutboxJournal implements SyncOperationJournal {
  constructor(
    private readonly delegate: SyncOperationJournal,
    private readonly outbox: LogicalBookChangeOutbox,
  ) {}

  async append(input: NewSyncOperation): Promise<SyncOperation> {
    const operation = await this.delegate.append(input);
    if (
      input.entity === 'logical-book-change' &&
      isLogicalBookChange(input.payload) &&
      input.payload.changeId === input.entityId
    ) {
      await this.outbox
        .acknowledgePendingLogicalBookChanges([input.entityId])
        .catch(() => undefined);
    }
    return operation;
  }

  async pending(): Promise<readonly SyncOperation[]> {
    const [pending, logicalChanges] = await Promise.all([
      this.delegate.pending(),
      this.outbox.listPendingLogicalBookChanges(),
    ]);
    return [
      ...pending,
      ...logicalChanges.map(
        (change): SyncOperation => ({
          id: `${OUTBOX_OPERATION_PREFIX}${change.changeId}`,
          entity: 'logical-book-change',
          entityId: change.changeId,
          operation: 'upsert',
          revision: 1,
          createdAt: change.createdAt,
          payload: change,
        }),
      ),
    ].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  async acknowledge(operationIds: readonly string[]): Promise<void> {
    const outboxChangeIds = operationIds
      .filter((operationId) => operationId.startsWith(OUTBOX_OPERATION_PREFIX))
      .map((operationId) => operationId.slice(OUTBOX_OPERATION_PREFIX.length));
    const delegateIds = operationIds.filter(
      (operationId) => !operationId.startsWith(OUTBOX_OPERATION_PREFIX),
    );
    await Promise.all([
      this.delegate.acknowledge(delegateIds),
      this.outbox.acknowledgePendingLogicalBookChanges(outboxChangeIds),
    ]);
  }
}
