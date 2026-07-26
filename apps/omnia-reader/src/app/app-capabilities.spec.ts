import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearUnavailableRemoteSyncSelection,
  LocalOnlySyncOperationJournal,
} from './app-capabilities';

describe('local-reader capabilities', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the selected provider in synchronization-enabled builds', () => {
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', { removeItem });

    clearUnavailableRemoteSyncSelection();

    expect(removeItem).not.toHaveBeenCalled();
  });

  it('clears a legacy provider choice from an explicit local-only build', () => {
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', { removeItem });

    clearUnavailableRemoteSyncSelection(false);

    expect(removeItem).toHaveBeenCalledWith('omnia-reader.sync-provider');
  });

  it('does not accumulate provider operations in local-only builds', async () => {
    const journal = new LocalOnlySyncOperationJournal();

    const operation = await journal.append({
      entity: 'progress',
      entityId: 'book-1',
      operation: 'upsert',
      payload: { local: true },
    });

    expect(operation).toMatchObject({
      entity: 'progress',
      entityId: 'book-1',
      operation: 'upsert',
      revision: 1,
    });
    await expect(journal.pending()).resolves.toEqual([]);
    await expect(journal.acknowledge([operation.id])).resolves.toBeUndefined();
  });
});
