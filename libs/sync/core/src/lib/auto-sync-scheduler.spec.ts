import {
  NewSyncOperation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { vi } from 'vitest';
import {
  AutoSyncEnvironment,
  AutoSyncHistory,
  AutoSyncHistoryStore,
  AutoSyncRateLimitStore,
  AutoSyncScheduler,
} from './auto-sync-scheduler';
import { SyncWorker, SyncWorkerOptions } from './library-sync-coordinator';
import {
  NotifyingSyncOperationJournal,
  SyncActivityNotifier,
} from './sync-activity';
import {
  SyncProviderKind,
  SyncProviderSelection,
} from './sync-provider-selection';

const EMPTY_RESULT = {
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  rejected: 0,
};

describe('AutoSyncScheduler', () => {
  it('coalesces startup and book changes into an immediate synchronization', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);

    scheduler.start();
    activity.notify({ kind: 'book', entityId: 'sha256:book' });
    environment.advance(0);
    await flushPromises();

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(scheduler.status()).toMatchObject({
      phase: 'idle',
      reason: 'book-change',
    });
  });

  it('synchronizes clustered progress one second after activity becomes quiet', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);
    scheduler.start();
    environment.advance(0);
    await flushPromises();

    activity.notify({ kind: 'progress', entityId: 'sha256:book' });
    environment.advance(500);
    activity.notify({ kind: 'progress', entityId: 'sha256:book' });
    environment.advance(999);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(1);

    environment.advance(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);

    expect(scheduler.status().reason).toBe('reading-quiet');
  });

  it('schedules interactive annotation work after a short trailing quiet period', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);
    scheduler.start();
    environment.advance(0);
    await flushPromises();

    activity.notify({ kind: 'annotation', entityId: 'annotation-1' });
    environment.advance(49);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(1);

    environment.advance(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('keeps work queued offline and retries once connectivity returns', async () => {
    const environment = new FakeEnvironment();
    environment.online = false;
    const activity = new SyncActivityNotifier();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);

    scheduler.start();
    activity.notify({ kind: 'book', entityId: 'sha256:book' });
    environment.advance(60_000);
    await flushPromises();

    expect(synchronize).not.toHaveBeenCalled();
    expect(scheduler.status().phase).toBe('offline');

    environment.goOnline();
    environment.advance(0);
    await flushPromises();

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(scheduler.status().phase).toBe('idle');
  });

  it('flushes progress immediately when the application is backgrounded', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);
    scheduler.start();
    environment.advance(0);
    await flushPromises();

    environment.background = true;
    activity.notify({ kind: 'progress', entityId: 'sha256:book' });
    environment.advance(0);
    await flushPromises();

    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(scheduler.status().reason).toBe('background');
  });

  it('checks a visible GitHub destination every ten seconds and suspends in background', async () => {
    const environment = new FakeEnvironment();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(
      environment,
      new SyncActivityNotifier(),
      synchronize,
    );
    scheduler.start();
    environment.advance(0);
    await flushPromises();

    environment.advance(9_999);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(1);
    environment.advance(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);

    environment.goBackground();
    environment.advance(60_000);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);

    environment.goForeground();
    environment.advance(0);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(3);
  });

  it('clears revision polling on stop', async () => {
    const environment = new FakeEnvironment();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(
      environment,
      new SyncActivityNotifier(),
      synchronize,
    );
    scheduler.start();
    environment.advance(0);
    await flushPromises();
    scheduler.stop();

    environment.advance(60_000);
    await flushPromises();

    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it('starts revision polling only after Git becomes the selected provider', async () => {
    const environment = new FakeEnvironment();
    const selection = new FakeProviderSelection('mega');
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(
      environment,
      new SyncActivityNotifier(),
      synchronize,
      undefined,
      undefined,
      selection,
    );
    scheduler.start();
    environment.advance(0);
    await flushPromises();

    environment.advance(60_000);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(1);

    selection.select('git');
    environment.advance(9_999);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(1);

    environment.advance(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('restores the last successful result across scheduler restarts', async () => {
    const historyStore = new MemoryHistoryStore();
    const firstEnvironment = new FakeEnvironment(1_000);
    const firstScheduler = createScheduler(
      firstEnvironment,
      new SyncActivityNotifier(),
      vi.fn().mockResolvedValue({
        pulled: 2,
        pushed: 3,
        conflicts: 1,
        rejected: 0,
      }),
      new MemoryRateLimitStore(),
      historyStore,
    );

    firstScheduler.start();
    firstEnvironment.advance(0);
    await flushPromises();
    firstScheduler.stop();

    const secondScheduler = createScheduler(
      new FakeEnvironment(2_000),
      new SyncActivityNotifier(),
      vi.fn().mockResolvedValue(EMPTY_RESULT),
      new MemoryRateLimitStore(),
      historyStore,
    );

    expect(secondScheduler.status()).toMatchObject({
      phase: 'idle',
      lastSuccessAt: new Date(1_000).toISOString(),
      lastResult: {
        pulled: 2,
        pushed: 3,
        conflicts: 1,
        rejected: 0,
      },
    });
  });

  it('records manual success globally and clears history for a new destination', () => {
    const environment = new FakeEnvironment(5_000);
    const historyStore = new MemoryHistoryStore();
    const scheduler = createScheduler(
      environment,
      new SyncActivityNotifier(),
      vi.fn(),
      new MemoryRateLimitStore(),
      historyStore,
    );

    scheduler.recordManualSuccess({
      pulled: 4,
      pushed: 1,
      conflicts: 0,
      rejected: 2,
    });

    expect(scheduler.status()).toMatchObject({
      phase: 'idle',
      reason: 'manual',
      lastAttemptAt: new Date(5_000).toISOString(),
      lastSuccessAt: new Date(5_000).toISOString(),
      lastResult: {
        pulled: 4,
        pushed: 1,
        conflicts: 0,
        rejected: 2,
      },
    });
    expect(historyStore.read('git')).toEqual({
      lastSuccessAt: new Date(5_000).toISOString(),
      lastResult: {
        pulled: 4,
        pushed: 1,
        conflicts: 0,
        rejected: 2,
      },
    });

    scheduler.clearHistory('git');

    expect(scheduler.status().lastSuccessAt).toBeUndefined();
    expect(scheduler.status().lastResult).toBeUndefined();
    expect(historyStore.read('git')).toBeNull();
  });

  it('ignores malformed persisted synchronization history', () => {
    const localStorage = {
      getItem: vi.fn().mockReturnValue(
        JSON.stringify({
          lastSuccessAt: 'not-a-date',
          lastResult: {
            pulled: -1,
            pushed: 0,
            conflicts: 0,
            rejected: 0,
          },
        }),
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', localStorage);
    try {
      const scheduler = new AutoSyncScheduler(
        { synchronize: vi.fn().mockResolvedValue(EMPTY_RESULT) },
        {
          current: () => 'git',
          select: vi.fn(),
          clear: vi.fn(),
        },
        new SyncActivityNotifier(),
        {
          environment: new FakeEnvironment(),
          rateLimitStore: new MemoryRateLimitStore(),
        },
      );

      expect(scheduler.status().lastSuccessAt).toBeUndefined();
      expect(scheduler.status().lastResult).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces automatic failures without throwing into local activity', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const scheduler = createScheduler(
      environment,
      activity,
      vi.fn().mockRejectedValue(new Error('Provider session expired')),
    );

    scheduler.start();
    environment.advance(0);
    await flushPromises();

    expect(scheduler.status()).toMatchObject({
      phase: 'error',
      errorMessage: 'Provider session expired',
    });
  });

  it('backs off automatic synchronization after a provider rate limit', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const rateLimit = Object.assign(
      new Error('Provider-controlled rate-limit detail'),
      {
        status: 429,
        retryAfterSeconds: 120,
      },
    );
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);

    scheduler.start();
    environment.advance(0);
    await flushPromises();

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(scheduler.status()).toMatchObject({
      phase: 'scheduled',
      scheduledFor: new Date(120_000).toISOString(),
      errorMessage:
        'The synchronization provider is temporarily rate limiting requests. Local changes are safe and automatic synchronization will retry.',
    });
    expect(scheduler.status().errorMessage).not.toContain(
      'Provider-controlled',
    );

    activity.notify({ kind: 'book', entityId: 'sha256:queued-book' });
    environment.advance(119_999);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(1);

    environment.advance(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(scheduler.status().phase).toBe('idle');
  });

  it('persists provider backoff across scheduler restarts', async () => {
    const rateLimitStore = new MemoryRateLimitStore();
    const firstEnvironment = new FakeEnvironment();
    const firstScheduler = createScheduler(
      firstEnvironment,
      new SyncActivityNotifier(),
      vi.fn().mockRejectedValue(
        Object.assign(new Error('Rate limited'), {
          status: 429,
          retryAfterSeconds: 90,
        }),
      ),
      rateLimitStore,
    );
    firstScheduler.start();
    firstEnvironment.advance(0);
    await flushPromises();
    firstScheduler.stop();

    const secondEnvironment = new FakeEnvironment(30_000);
    const secondSync = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const secondScheduler = createScheduler(
      secondEnvironment,
      new SyncActivityNotifier(),
      secondSync,
      rateLimitStore,
    );
    secondScheduler.start();
    secondEnvironment.advance(59_999);
    await flushPromises();
    expect(secondSync).not.toHaveBeenCalled();

    secondEnvironment.advance(1);
    await flushPromises();
    expect(secondSync).toHaveBeenCalledTimes(1);
    expect(secondScheduler.status().phase).toBe('idle');
  });

  it('reports transfer progress and cancels without immediately retrying queued work', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    let receivedOptions: SyncWorkerOptions | undefined;
    const synchronize = vi.fn(
      async (options?: SyncWorkerOptions): Promise<typeof EMPTY_RESULT> => {
        receivedOptions = options;
        options?.onTransferProgress?.({
          direction: 'upload',
          path: '.omnia-reader/v1/books/id/publication.epub',
          transferredBytes: 512,
          totalBytes: 1024,
        });
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
        return EMPTY_RESULT;
      },
    );
    const scheduler = createScheduler(environment, activity, synchronize);

    scheduler.start();
    environment.advance(0);
    await flushPromises();

    expect(scheduler.status()).toMatchObject({
      phase: 'syncing',
      transferProgress: {
        direction: 'upload',
        transferredBytes: 512,
        totalBytes: 1024,
      },
    });

    activity.notify({ kind: 'book', entityId: 'sha256:queued-book' });
    expect(scheduler.cancelActive()).toBe(true);
    expect(scheduler.status().phase).toBe('cancelling');
    expect(receivedOptions?.signal?.aborted).toBe(true);

    await flushPromises();
    environment.advance(0);
    await flushPromises();

    expect(scheduler.status()).toMatchObject({
      phase: 'cancelled',
      reason: 'startup',
    });
    expect(scheduler.status().transferProgress).toBeUndefined();
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(scheduler.cancelActive()).toBe(false);
  });

  it('aborts an active transfer when the scheduler stops', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    let signal: AbortSignal | undefined;
    const synchronize = vi.fn(
      async (options?: SyncWorkerOptions): Promise<typeof EMPTY_RESULT> => {
        signal = options?.signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), {
            once: true,
          });
        });
        return EMPTY_RESULT;
      },
    );
    const scheduler = createScheduler(environment, activity, synchronize);

    scheduler.start();
    environment.advance(0);
    await flushPromises();
    scheduler.stop();

    expect(signal?.aborted).toBe(true);
    expect(scheduler.status().phase).toBe('idle');
    await flushPromises();
    expect(scheduler.status().phase).toBe('idle');
  });
});

describe('NotifyingSyncOperationJournal', () => {
  it('notifies only after a durable append and isolates listener failures', async () => {
    const operation = syncOperation();
    const delegate: SyncOperationJournal = {
      append: vi.fn().mockResolvedValue(operation),
      pending: vi.fn().mockResolvedValue([operation]),
      acknowledge: vi.fn().mockResolvedValue(undefined),
    };
    const activity = new SyncActivityNotifier();
    const listener = vi.fn(() => {
      throw new Error('Scheduling unavailable');
    });
    activity.subscribe(listener);
    const journal = new NotifyingSyncOperationJournal(delegate, activity);

    await expect(journal.append(operation)).resolves.toEqual(operation);
    expect(listener).toHaveBeenCalledWith({
      kind: 'book',
      entityId: operation.entityId,
    });
    await expect(journal.pending()).resolves.toEqual([operation]);
  });

  it('publishes durable annotation activity', async () => {
    const annotationOperation: SyncOperation = {
      ...syncOperation(),
      entity: 'annotation',
      entityId: 'annotation-1',
    };
    const delegate: SyncOperationJournal = {
      append: vi.fn().mockResolvedValue(annotationOperation),
      pending: vi.fn().mockResolvedValue([annotationOperation]),
      acknowledge: vi.fn().mockResolvedValue(undefined),
    };
    const activity = new SyncActivityNotifier();
    const listener = vi.fn();
    activity.subscribe(listener);

    await new NotifyingSyncOperationJournal(delegate, activity).append(
      annotationOperation,
    );

    expect(listener).toHaveBeenCalledWith({
      kind: 'annotation',
      entityId: 'annotation-1',
    });
  });
});

function createScheduler(
  environment: AutoSyncEnvironment,
  activity: SyncActivityNotifier,
  synchronize: SyncWorker['synchronize'],
  rateLimitStore: AutoSyncRateLimitStore = new MemoryRateLimitStore(),
  historyStore: AutoSyncHistoryStore = new MemoryHistoryStore(),
  selection: SyncProviderSelection = new FakeProviderSelection('git'),
): AutoSyncScheduler {
  return new AutoSyncScheduler({ synchronize }, selection, activity, {
    environment,
    quietIntervalMs: 1_000,
    interactiveQuietIntervalMs: 50,
    revisionCheckIntervalMs: 10_000,
    rateLimitStore,
    historyStore,
  });
}

class FakeProviderSelection implements SyncProviderSelection {
  private readonly listeners = new Set<
    (provider: SyncProviderKind | null) => void
  >();

  constructor(private provider: SyncProviderKind | null) {}

  current(): SyncProviderKind | null {
    return this.provider;
  }

  select(provider: SyncProviderKind): void {
    this.provider = provider;
    this.notify();
  }

  clear(): void {
    this.provider = null;
    this.notify();
  }

  subscribe(listener: (provider: SyncProviderKind | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.provider);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener(this.provider));
  }
}

function syncOperation(): SyncOperation & NewSyncOperation {
  return {
    id: 'operation',
    entity: 'book',
    entityId: 'sha256:book',
    operation: 'upsert',
    revision: 1,
    createdAt: '2026-07-25T00:00:00.000Z',
    payload: {},
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeEnvironment implements AutoSyncEnvironment {
  online = true;
  background = false;
  private currentTime: number;
  private sequence = 0;
  private readonly timers = new Map<
    number,
    { dueAt: number; callback: () => void }
  >();
  private readonly onlineListeners = new Set<() => void>();
  private readonly offlineListeners = new Set<() => void>();
  private readonly visibilityListeners = new Set<() => void>();

  constructor(initialTime = 0) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  isOnline(): boolean {
    return this.online;
  }

  isBackground(): boolean {
    return this.background;
  }

  setTimer(callback: () => void, milliseconds: number): unknown {
    const id = ++this.sequence;
    this.timers.set(id, {
      dueAt: this.currentTime + milliseconds,
      callback,
    });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  onOnline(callback: () => void): () => void {
    this.onlineListeners.add(callback);
    return () => this.onlineListeners.delete(callback);
  }

  onOffline(callback: () => void): () => void {
    this.offlineListeners.add(callback);
    return () => this.offlineListeners.delete(callback);
  }

  onVisibilityChange(callback: () => void): () => void {
    this.visibilityListeners.add(callback);
    return () => this.visibilityListeners.delete(callback);
  }

  advance(milliseconds: number): void {
    const target = this.currentTime + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (!next) {
        break;
      }
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentTime = timer.dueAt;
      timer.callback();
    }
    this.currentTime = target;
  }

  goOnline(): void {
    this.online = true;
    this.onlineListeners.forEach((listener) => listener());
  }

  goBackground(): void {
    this.background = true;
    this.visibilityListeners.forEach((listener) => listener());
  }

  goForeground(): void {
    this.background = false;
    this.visibilityListeners.forEach((listener) => listener());
  }
}

class MemoryRateLimitStore implements AutoSyncRateLimitStore {
  private readonly retryAfter = new Map<string, number>();

  readRetryAfter(provider: 'git' | 'mega'): number | null {
    return this.retryAfter.get(provider) ?? null;
  }

  writeRetryAfter(provider: 'git' | 'mega', timestamp: number | null): void {
    if (timestamp === null) {
      this.retryAfter.delete(provider);
    } else {
      this.retryAfter.set(provider, timestamp);
    }
  }
}

class MemoryHistoryStore implements AutoSyncHistoryStore {
  private readonly history = new Map<'git' | 'mega', AutoSyncHistory>();

  read(provider: 'git' | 'mega'): AutoSyncHistory | null {
    return this.history.get(provider) ?? null;
  }

  write(provider: 'git' | 'mega', history: AutoSyncHistory | null): void {
    if (history) {
      this.history.set(provider, structuredClone(history));
    } else {
      this.history.delete(provider);
    }
  }
}
