import {
  NewSyncOperation,
  SyncOperation,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { vi } from 'vitest';
import {
  AutoSyncEnvironment,
  AutoSyncRateLimitStore,
  AutoSyncScheduler,
} from './auto-sync-scheduler';
import {
  NotifyingSyncOperationJournal,
  SyncActivityNotifier,
} from './sync-activity';

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

  it('debounces progress and limits periodic synchronization to once per five minutes', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);
    scheduler.start();
    environment.advance(0);
    await flushPromises();

    activity.notify({ kind: 'progress', entityId: 'sha256:book' });
    environment.advance(29_000);
    activity.notify({ kind: 'progress', entityId: 'sha256:book' });
    environment.advance(29_999);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(1);

    environment.advance(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);

    activity.notify({ kind: 'progress', entityId: 'sha256:book' });
    environment.advance(299_999);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);

    environment.advance(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(3);
  });

  it('schedules annotations through the same quiet, rate-limited path', async () => {
    const environment = new FakeEnvironment();
    const activity = new SyncActivityNotifier();
    const synchronize = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const scheduler = createScheduler(environment, activity, synchronize);
    scheduler.start();
    environment.advance(0);
    await flushPromises();

    activity.notify({ kind: 'annotation', entityId: 'annotation-1' });
    environment.advance(29_999);
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

  it('persists the Git quiet-sync rate limit across scheduler restarts', async () => {
    const rateLimitStore = new MemoryRateLimitStore();
    const firstEnvironment = new FakeEnvironment();
    const firstActivity = new SyncActivityNotifier();
    const firstSync = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const firstScheduler = createScheduler(
      firstEnvironment,
      firstActivity,
      firstSync,
      rateLimitStore,
    );
    firstScheduler.start();
    firstEnvironment.advance(0);
    await flushPromises();
    firstActivity.notify({ kind: 'progress', entityId: 'sha256:book' });
    firstEnvironment.advance(30_000);
    await flushPromises();
    firstScheduler.stop();

    const secondEnvironment = new FakeEnvironment(30_000);
    const secondActivity = new SyncActivityNotifier();
    const secondSync = vi.fn().mockResolvedValue(EMPTY_RESULT);
    const secondScheduler = createScheduler(
      secondEnvironment,
      secondActivity,
      secondSync,
      rateLimitStore,
    );
    secondScheduler.start();
    secondEnvironment.advance(0);
    await flushPromises();
    secondActivity.notify({ kind: 'progress', entityId: 'sha256:book' });

    secondEnvironment.advance(299_999);
    await flushPromises();
    expect(secondSync).toHaveBeenCalledTimes(1);

    secondEnvironment.advance(1);
    await flushPromises();
    expect(secondSync).toHaveBeenCalledTimes(2);
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
  synchronize: () => Promise<typeof EMPTY_RESULT>,
  rateLimitStore: AutoSyncRateLimitStore = new MemoryRateLimitStore(),
): AutoSyncScheduler {
  return new AutoSyncScheduler(
    { synchronize },
    {
      current: () => 'git',
      select: vi.fn(),
      clear: vi.fn(),
    },
    activity,
    {
      environment,
      quietIntervalMs: 30_000,
      periodicMinimumIntervalMs: 300_000,
      rateLimitStore,
    },
  );
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
}

class MemoryRateLimitStore implements AutoSyncRateLimitStore {
  private readonly timestamps = new Map<string, number>();

  read(provider: 'git' | 'mega'): number | null {
    return this.timestamps.get(provider) ?? null;
  }

  write(provider: 'git' | 'mega', timestamp: number): void {
    this.timestamps.set(provider, timestamp);
  }
}
