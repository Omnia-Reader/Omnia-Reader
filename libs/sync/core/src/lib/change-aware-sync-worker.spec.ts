import {
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserSyncCheckpointStore,
  ChangeAwareSyncWorker,
  SyncCheckpointStore,
} from './change-aware-sync-worker';
import { SyncWorker, SyncWorkerResult } from './library-sync-coordinator';
import { LibrarySyncTransport } from './library-sync-transport';
import { SyncProviderSelection } from './sync-provider-selection';

const EMPTY_RESULT: SyncWorkerResult = {
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  rejected: 0,
};
const UNCHANGED_RESULT: SyncWorkerResult = {
  ...EMPTY_RESULT,
  unchanged: true,
};

describe('ChangeAwareSyncWorker', () => {
  it('finishes a trusted unchanged Git sync with one probe and no delegate work', async () => {
    const delegate = worker();
    const remote = revisionTransport('repository:main:a');
    const checkpoints = checkpointStore('repository:main:a');
    const sync = createWorker({ delegate, remote, checkpoints });
    const startedAt = performance.now();

    await expect(sync.synchronize()).resolves.toEqual(UNCHANGED_RESULT);

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(remote.destinationRevision).toHaveBeenCalledTimes(1);
    expect(delegate.synchronize).not.toHaveBeenCalled();
    expect(checkpoints.write).not.toHaveBeenCalled();
  });

  it('persists a checkpoint after a stable complete pass and reuses it after restart', async () => {
    const storage = memoryStorage();
    const checkpoints = new BrowserSyncCheckpointStore(storage);
    const firstDelegate = worker();
    const firstRemote = revisionTransport(
      'repository:main:a',
      'repository:main:a',
    );
    const first = createWorker({
      delegate: firstDelegate,
      remote: firstRemote,
      checkpoints,
    });

    await expect(first.synchronize()).resolves.toEqual(EMPTY_RESULT);
    expect(firstDelegate.synchronize).toHaveBeenCalledTimes(1);
    expect(storage.getItem('omnia-reader.sync-checkpoint')).toBe(
      '{"schemaVersion":1,"git":"repository:main:a"}',
    );

    const restartedDelegate = worker();
    const restarted = createWorker({
      delegate: restartedDelegate,
      remote: revisionTransport('repository:main:a'),
      checkpoints: new BrowserSyncCheckpointStore(storage),
    });

    await expect(restarted.synchronize()).resolves.toEqual(UNCHANGED_RESULT);
    expect(restartedDelegate.synchronize).not.toHaveBeenCalled();
  });

  it('runs complete sync for pending local work even when the checkpoint matches', async () => {
    const delegate = worker();
    const remote = revisionTransport('repository:main:a', 'repository:main:a');
    const journal = operationJournal([pendingOperation()]);
    journal.pending
      .mockResolvedValueOnce([pendingOperation()])
      .mockResolvedValueOnce([]);
    const sync = createWorker({
      delegate,
      remote,
      journal,
      checkpoints: checkpointStore('repository:main:a'),
    });

    await sync.synchronize();

    expect(delegate.synchronize).toHaveBeenCalledTimes(1);
  });

  it('runs complete sync when local work appears during the revision probe', async () => {
    const delegate = worker();
    const journal = operationJournal([]);
    journal.pending
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingOperation()])
      .mockResolvedValueOnce([]);
    const sync = createWorker({
      delegate,
      remote: revisionTransport('repository:main:a', 'repository:main:a'),
      journal,
      checkpoints: checkpointStore('repository:main:a'),
    });

    await sync.synchronize();

    expect(delegate.synchronize).toHaveBeenCalledTimes(1);
  });

  it('runs complete sync when the remote changed and trusts only a stable pass', async () => {
    const delegate = worker();
    const checkpoints = checkpointStore('repository:main:a');
    const sync = createWorker({
      delegate,
      remote: revisionTransport('repository:main:b', 'repository:main:b'),
      checkpoints,
    });

    await sync.synchronize();

    expect(delegate.synchronize).toHaveBeenCalledTimes(1);
    expect(checkpoints.write).toHaveBeenLastCalledWith(
      'git',
      'repository:main:b',
    );
  });

  it('stabilizes a mutating pass before checkpointing the resulting revision', async () => {
    const delegate = worker();
    delegate.synchronize
      .mockResolvedValueOnce({ ...EMPTY_RESULT, pushed: 1 })
      .mockResolvedValueOnce(EMPTY_RESULT);
    const checkpoints = checkpointStore(null);
    const sync = createWorker({
      delegate,
      remote: revisionTransport(
        'repository:main:a',
        'repository:main:b',
        'repository:main:b',
      ),
      checkpoints,
    });

    await expect(sync.synchronize()).resolves.toMatchObject({ pushed: 1 });

    expect(delegate.synchronize).toHaveBeenCalledTimes(2);
    expect(checkpoints.write).toHaveBeenLastCalledWith(
      'git',
      'repository:main:b',
    );
  });

  it('does not checkpoint a destination that keeps changing during convergence', async () => {
    const delegate = worker();
    const checkpoints = checkpointStore('repository:main:old');
    const sync = createWorker({
      delegate,
      remote: revisionTransport(
        'repository:main:a',
        'repository:main:b',
        'repository:main:c',
      ),
      checkpoints,
    });

    await sync.synchronize();

    expect(delegate.synchronize).toHaveBeenCalledTimes(2);
    expect(checkpoints.write).toHaveBeenLastCalledWith('git', null);
  });

  it.each([
    [
      'conflicted pass',
      { ...EMPTY_RESULT, conflicts: 1 },
      ['repository:main:a', 'repository:main:a'],
    ],
    [
      'rejected pass',
      { ...EMPTY_RESULT, rejected: 1 },
      ['repository:main:a', 'repository:main:a'],
    ],
  ] as const)(
    'clears the checkpoint after an %s',
    async (_name, result, revisions) => {
      const checkpoints = checkpointStore('repository:main:old');
      const sync = createWorker({
        delegate: worker(result),
        remote: revisionTransport(...revisions),
        checkpoints,
      });

      await sync.synchronize();

      expect(checkpoints.write).toHaveBeenLastCalledWith('git', null);
    },
  );

  it('clears the checkpoint when work remains after the delegate completes', async () => {
    const journal = operationJournal([]);
    journal.pending
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingOperation()]);
    const checkpoints = checkpointStore('repository:main:old');
    const sync = createWorker({
      delegate: worker(),
      remote: revisionTransport('repository:main:new', 'repository:main:new'),
      journal,
      checkpoints,
    });

    await sync.synchronize();

    expect(checkpoints.write).toHaveBeenLastCalledWith('git', null);
  });

  it('does not advance the checkpoint after probe failure, delegate failure, or cancellation', async () => {
    const checkpoints = checkpointStore('repository:main:a');
    const failedProbe = revisionTransport();
    failedProbe.destinationRevision.mockRejectedValue(new Error('offline'));

    await expect(
      createWorker({ remote: failedProbe, checkpoints }).synchronize(),
    ).rejects.toThrow('offline');
    expect(checkpoints.write).not.toHaveBeenCalled();

    const failedDelegate = worker();
    failedDelegate.synchronize.mockRejectedValue(new Error('merge failed'));
    await expect(
      createWorker({
        delegate: failedDelegate,
        remote: revisionTransport('repository:main:b'),
        checkpoints,
      }).synchronize(),
    ).rejects.toThrow('merge failed');
    expect(checkpoints.write).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(
      createWorker({
        remote: revisionTransport('repository:main:b'),
        checkpoints,
      }).synchronize({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(checkpoints.write).not.toHaveBeenCalled();
  });

  it('uses complete synchronization for MEGA and transports without a revision capability', async () => {
    const delegate = worker();
    const selection: SyncProviderSelection = {
      current: () => 'mega',
      select: vi.fn(),
      clear: vi.fn(),
    };
    const sync = createWorker({
      delegate,
      selection,
      remote: {} as LibrarySyncTransport,
    });

    await sync.synchronize();

    expect(delegate.synchronize).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent checks into one active synchronization', async () => {
    let release = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = revisionTransport();
    remote.destinationRevision.mockImplementation(async () => {
      await wait;
      return 'repository:main:a';
    });
    const sync = createWorker({
      remote,
      checkpoints: checkpointStore('repository:main:a'),
    });

    const first = sync.synchronize();
    const second = sync.synchronize();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      UNCHANGED_RESULT,
      UNCHANGED_RESULT,
    ]);
    expect(remote.destinationRevision).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserSyncCheckpointStore', () => {
  it('ignores malformed, unknown, and oversized state', () => {
    const storage = memoryStorage({
      'omnia-reader.sync-checkpoint': JSON.stringify({
        schemaVersion: 2,
        git: 'repository:main:a',
      }),
    });
    const checkpoints = new BrowserSyncCheckpointStore(storage);

    expect(checkpoints.read('git')).toBeNull();

    storage.setItem('omnia-reader.sync-checkpoint', 'x'.repeat(2_049));
    expect(new BrowserSyncCheckpointStore(storage).read('git')).toBeNull();
  });

  it('isolates unavailable storage from synchronization', () => {
    const storage = {
      getItem: () => {
        throw new DOMException('Denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('Denied', 'SecurityError');
      },
      removeItem: vi.fn(),
    } as unknown as Storage;
    const checkpoints = new BrowserSyncCheckpointStore(storage);

    expect(checkpoints.read('git')).toBeNull();
    expect(() => checkpoints.write('git', 'repository:main:a')).not.toThrow();
  });
});

function createWorker(
  overrides: {
    delegate?: ReturnType<typeof worker>;
    remote?: ReturnType<typeof revisionTransport> | LibrarySyncTransport;
    journal?: ReturnType<typeof operationJournal>;
    selection?: SyncProviderSelection;
    checkpoints?: SyncCheckpointStore;
  } = {},
): ChangeAwareSyncWorker {
  return new ChangeAwareSyncWorker(
    overrides.delegate ?? worker(),
    overrides.remote ?? revisionTransport('repository:main:a'),
    overrides.journal ?? operationJournal([]),
    overrides.selection ?? {
      current: () => 'git',
      select: vi.fn(),
      clear: vi.fn(),
    },
    overrides.checkpoints ?? checkpointStore(null),
  );
}

function worker(result: SyncWorkerResult = EMPTY_RESULT) {
  return {
    synchronize: vi.fn<SyncWorker['synchronize']>().mockResolvedValue(result),
  };
}

function revisionTransport(...revisions: readonly string[]) {
  const queue = [...revisions];
  return {
    destinationRevision: vi.fn(
      async () => queue.shift() ?? revisions[revisions.length - 1] ?? '',
    ),
  } as unknown as LibrarySyncTransport & {
    destinationRevision: ReturnType<typeof vi.fn<() => Promise<string>>>;
  };
}

function operationJournal(initial: readonly SyncOperation[]) {
  return {
    append: vi.fn<SyncOperationJournal['append']>(),
    pending: vi
      .fn<SyncOperationJournal['pending']>()
      .mockResolvedValue(initial),
    acknowledge: vi.fn<SyncOperationJournal['acknowledge']>(),
  };
}

function checkpointStore(initial: string | null): SyncCheckpointStore & {
  read: ReturnType<typeof vi.fn<(provider: 'git' | 'mega') => string | null>>;
  write: ReturnType<
    typeof vi.fn<(provider: 'git' | 'mega', revision: string | null) => void>
  >;
} {
  let value = initial;
  return {
    read: vi.fn(() => value),
    write: vi.fn((_provider, revision) => {
      value = revision;
    }),
  };
}

function pendingOperation(): SyncOperation {
  return {
    id: 'operation',
    entity: 'progress',
    entityId: 'book',
    operation: 'upsert',
    revision: 1,
    createdAt: '2026-08-02T00:00:00.000Z',
    payload: {},
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
