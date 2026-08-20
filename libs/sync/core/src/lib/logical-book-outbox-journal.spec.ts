import {
  LogicalBookChange,
  LogicalBookChangeOutbox,
  NewSyncOperation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { LogicalBookOutboxJournal } from './logical-book-outbox-journal';

describe('LogicalBookOutboxJournal', () => {
  it('REC-add-post-commit-pre-journal exposes a durable change when journal append fails', async () => {
    const change = logicalChange('change:add');
    const outbox = new MemoryOutbox([change]);
    const delegate = new MemoryJournal();
    delegate.appendError = new Error('journal unavailable');
    const journal = new LogicalBookOutboxJournal(delegate, outbox);

    await expect(journal.append(operation(change))).rejects.toThrow(
      'journal unavailable',
    );
    await expect(journal.pending()).resolves.toEqual([
      expect.objectContaining({
        entity: 'logical-book-change',
        entityId: change.changeId,
        payload: change,
      }),
    ]);
  });

  it('removes the outbox copy after the normal journal accepts the change', async () => {
    const change = logicalChange('change:associate');
    const outbox = new MemoryOutbox([change]);
    const delegate = new MemoryJournal();
    const journal = new LogicalBookOutboxJournal(delegate, outbox);

    await expect(journal.append(operation(change))).resolves.toMatchObject({
      entityId: change.changeId,
    });
    await expect(outbox.listPendingLogicalBookChanges()).resolves.toEqual([]);
    await expect(journal.pending()).resolves.toHaveLength(1);
  });

  it('retains the outbox copy when the accepted payload names another change', async () => {
    const change = logicalChange('change:expected');
    const outbox = new MemoryOutbox([change]);
    const journal = new LogicalBookOutboxJournal(new MemoryJournal(), outbox);

    await journal.append({
      ...operation(change),
      payload: logicalChange('change:different'),
    });

    await expect(outbox.listPendingLogicalBookChanges()).resolves.toEqual([
      change,
    ]);
  });

  it('retains the outbox copy when the accepted payload is invalid', async () => {
    const change = logicalChange('change:invalid-payload');
    const outbox = new MemoryOutbox([change]);
    const journal = new LogicalBookOutboxJournal(new MemoryJournal(), outbox);

    await journal.append({
      ...operation(change),
      payload: { changeId: change.changeId },
    });

    await expect(outbox.listPendingLogicalBookChanges()).resolves.toEqual([
      change,
    ]);
  });

  it('acknowledges recovered outbox work only after the sync worker accepts it', async () => {
    const change = logicalChange('change:preference');
    const outbox = new MemoryOutbox([change]);
    const journal = new LogicalBookOutboxJournal(new MemoryJournal(), outbox);
    const [pending] = await journal.pending();

    await journal.acknowledge([pending.id]);

    await expect(outbox.listPendingLogicalBookChanges()).resolves.toEqual([]);
  });
});

class MemoryOutbox implements LogicalBookChangeOutbox {
  constructor(private changes: LogicalBookChange[]) {}

  async listPendingLogicalBookChanges() {
    return this.changes;
  }

  async acknowledgePendingLogicalBookChanges(changeIds: readonly string[]) {
    this.changes = this.changes.filter(
      (change) => !changeIds.includes(change.changeId),
    );
  }
}

class MemoryJournal implements SyncOperationJournal {
  readonly operations: SyncOperation[] = [];
  appendError: Error | null = null;

  async append(input: NewSyncOperation): Promise<SyncOperation> {
    if (this.appendError) throw this.appendError;
    const stored: SyncOperation = {
      ...input,
      id: `operation:${this.operations.length + 1}`,
      revision: this.operations.length + 1,
      createdAt: '2026-08-20T12:00:00.000Z',
    };
    this.operations.push(stored);
    return stored;
  }

  async pending() {
    return this.operations;
  }

  async acknowledge(operationIds: readonly string[]) {
    for (const operationId of operationIds) {
      const index = this.operations.findIndex(
        (operation) => operation.id === operationId,
      );
      if (index >= 0) this.operations.splice(index, 1);
    }
  }
}

function logicalChange(changeId: string): LogicalBookChange {
  return {
    schemaVersion: 1,
    changeId,
    kind: 'metadata',
    parents: [],
    resultingBooks: [],
    removedLogicalBookIds: [],
    createdAt: '2026-08-20T12:00:00.000Z',
    deviceId: 'test-device',
    appVersion: '0.0.0',
  };
}

function operation(change: LogicalBookChange): NewSyncOperation {
  return {
    entity: 'logical-book-change',
    entityId: change.changeId,
    operation: 'upsert',
    payload: change,
  };
}
