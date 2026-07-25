import 'fake-indexeddb/auto';
import { IndexedDbOperationJournal } from './indexed-db-operation-journal';

describe('IndexedDbOperationJournal', () => {
  it('persists monotonic revisions until operations are acknowledged', async () => {
    const journal = new IndexedDbOperationJournal();
    const first = await journal.append({
      entity: 'progress',
      entityId: 'sha256:book',
      operation: 'upsert',
      payload: { page: 1 },
    });
    const second = await journal.append({
      entity: 'progress',
      entityId: 'sha256:book',
      operation: 'upsert',
      payload: { page: 2 },
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(await journal.pending()).toEqual([first, second]);

    await journal.acknowledge([first.id]);

    expect(await journal.pending()).toEqual([second]);
  });
});
