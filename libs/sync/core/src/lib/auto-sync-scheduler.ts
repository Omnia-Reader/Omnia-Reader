import {
  SyncProviderKind,
  SyncProviderSelection,
} from './sync-provider-selection';
import { SyncActivityNotifier } from './sync-activity';
import { SyncWorker, SyncWorkerResult } from './library-sync-coordinator';

export type AutoSyncReason =
  | 'startup'
  | 'book-change'
  | 'reading-quiet'
  | 'background'
  | 'online'
  | 'destination-selected';

export type AutoSyncPhase =
  | 'idle'
  | 'scheduled'
  | 'syncing'
  | 'offline'
  | 'error';

export interface AutoSyncStatus {
  phase: AutoSyncPhase;
  reason?: AutoSyncReason;
  scheduledFor?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastResult?: SyncWorkerResult;
  errorMessage?: string;
}

export interface AutoSyncEnvironment {
  now(): number;
  isOnline(): boolean;
  isBackground(): boolean;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(handle: unknown): void;
  onOnline(callback: () => void): () => void;
  onOffline(callback: () => void): () => void;
}

export interface AutoSyncSchedulerOptions {
  quietIntervalMs?: number;
  periodicMinimumIntervalMs?: number;
  environment?: AutoSyncEnvironment;
  rateLimitStore?: AutoSyncRateLimitStore;
}

export interface AutoSyncRateLimitStore {
  read(provider: SyncProviderKind): number | null;
  write(provider: SyncProviderKind, timestamp: number): void;
}

const DEFAULT_QUIET_INTERVAL_MS = 30_000;
const DEFAULT_PERIODIC_MINIMUM_INTERVAL_MS = 5 * 60_000;

/**
 * Coalesces automatic synchronization triggers without ever blocking local
 * reading. Book changes, lifecycle events, and connectivity recovery are
 * immediate; small reading-state changes use a quiet interval and are
 * rate-limited.
 */
export class AutoSyncScheduler {
  private readonly quietIntervalMs: number;
  private readonly periodicMinimumIntervalMs: number;
  private readonly environment: AutoSyncEnvironment;
  private readonly rateLimitStore: AutoSyncRateLimitStore;
  private readonly listeners = new Set<(status: AutoSyncStatus) => void>();

  private statusValue: AutoSyncStatus = { phase: 'idle' };
  private started = false;
  private timer: unknown;
  private scheduledReason: AutoSyncReason | null = null;
  private queuedReason: AutoSyncReason | null = null;
  private readonly lastPeriodicSyncAt: Partial<
    Record<SyncProviderKind, number>
  > = {};
  private readonly loadedRateLimits = new Set<SyncProviderKind>();
  private activeSync: Promise<SyncWorkerResult> | null = null;
  private unsubscribeActivity: (() => void) | null = null;
  private unsubscribeOnline: (() => void) | null = null;
  private unsubscribeOffline: (() => void) | null = null;

  constructor(
    private readonly worker: SyncWorker,
    private readonly selection: SyncProviderSelection,
    private readonly activity: SyncActivityNotifier,
    options: AutoSyncSchedulerOptions = {},
  ) {
    this.quietIntervalMs = options.quietIntervalMs ?? DEFAULT_QUIET_INTERVAL_MS;
    this.periodicMinimumIntervalMs =
      options.periodicMinimumIntervalMs ?? DEFAULT_PERIODIC_MINIMUM_INTERVAL_MS;
    this.environment = options.environment ?? browserEnvironment();
    this.rateLimitStore =
      options.rateLimitStore ?? browserAutoSyncRateLimitStore();
  }

  status(): AutoSyncStatus {
    return this.statusValue;
  }

  subscribe(listener: (status: AutoSyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.statusValue);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.unsubscribeActivity = this.activity.subscribe((change) => {
      if (change.kind === 'book') {
        this.requestImmediate('book-change');
      } else if (this.environment.isBackground()) {
        this.requestImmediate('background');
      } else {
        this.requestQuiet();
      }
    });
    this.unsubscribeOnline = this.environment.onOnline(() => {
      const queuedReason = this.queuedReason;
      this.queuedReason = null;
      this.requestImmediate(
        queuedReason && queuedReason !== 'reading-quiet'
          ? queuedReason
          : 'online',
      );
    });
    this.unsubscribeOffline = this.environment.onOffline(() =>
      this.handleOffline(),
    );

    if (this.selection.current()) {
      this.requestImmediate('startup');
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.clearScheduledTimer();
    this.queuedReason = null;
    this.unsubscribeActivity?.();
    this.unsubscribeOnline?.();
    this.unsubscribeOffline?.();
    this.unsubscribeActivity = null;
    this.unsubscribeOnline = null;
    this.unsubscribeOffline = null;
    this.updateStatus({
      phase: 'idle',
      reason: undefined,
      scheduledFor: undefined,
      errorMessage: undefined,
    });
  }

  requestImmediate(reason: Exclude<AutoSyncReason, 'reading-quiet'>): void {
    if (!this.started || !this.selection.current()) {
      return;
    }
    if (!this.environment.isOnline()) {
      this.queuedReason = mergeReasons(this.queuedReason, reason);
      this.clearScheduledTimer();
      this.updateStatus({ phase: 'offline', reason });
      return;
    }
    if (this.activeSync) {
      this.queuedReason = mergeReasons(this.queuedReason, reason);
      return;
    }

    this.schedule(reason, 0);
  }

  requestQuiet(): void {
    const provider = this.selection.current();
    if (!this.started || !provider) {
      return;
    }
    if (!this.environment.isOnline()) {
      this.queuedReason = mergeReasons(this.queuedReason, 'reading-quiet');
      this.clearScheduledTimer();
      this.updateStatus({ phase: 'offline', reason: 'reading-quiet' });
      return;
    }
    if (this.activeSync) {
      this.queuedReason = mergeReasons(this.queuedReason, 'reading-quiet');
      return;
    }

    const now = this.environment.now();
    const lastPeriodicSyncAt =
      provider === 'git' ? this.readLastPeriodicSyncAt(provider) : null;
    const nextPeriodicAt =
      lastPeriodicSyncAt === null
        ? now
        : lastPeriodicSyncAt + this.periodicMinimumIntervalMs;
    const delay = Math.max(this.quietIntervalMs, nextPeriodicAt - now);
    this.schedule('reading-quiet', delay);
  }

  private schedule(reason: AutoSyncReason, delay: number): void {
    this.clearScheduledTimer();
    this.scheduledReason = reason;
    const scheduledAt = this.environment.now() + delay;
    this.timer = this.environment.setTimer(() => {
      this.timer = undefined;
      this.scheduledReason = null;
      void this.runAutomatic(reason);
    }, delay);
    this.updateStatus({
      phase: 'scheduled',
      reason,
      scheduledFor: new Date(scheduledAt).toISOString(),
      errorMessage: undefined,
    });
  }

  private async runAutomatic(reason: AutoSyncReason): Promise<void> {
    const provider = this.selection.current();
    if (!this.started || !provider) {
      this.updateStatus({ phase: 'idle', reason: undefined });
      return;
    }
    if (!this.environment.isOnline()) {
      this.queuedReason = mergeReasons(this.queuedReason, reason);
      this.updateStatus({ phase: 'offline', reason });
      return;
    }
    if (this.activeSync) {
      this.queuedReason = mergeReasons(this.queuedReason, reason);
      return;
    }

    const attemptAt = this.environment.now();
    this.updateStatus({
      phase: 'syncing',
      reason,
      scheduledFor: undefined,
      lastAttemptAt: new Date(attemptAt).toISOString(),
      errorMessage: undefined,
    });

    const activeSync = Promise.resolve().then(() => this.worker.synchronize());
    this.activeSync = activeSync;
    try {
      const result = await activeSync;
      if (!this.started) {
        return;
      }
      const completedAt = this.environment.now();
      if (reason === 'reading-quiet' && provider === 'git') {
        this.lastPeriodicSyncAt[provider] = completedAt;
        try {
          this.rateLimitStore.write(provider, completedAt);
        } catch {
          // Persistence cannot turn a successful provider sync into a failure.
        }
      }
      this.updateStatus({
        phase: 'idle',
        reason,
        lastSuccessAt: new Date(completedAt).toISOString(),
        lastResult: result,
        errorMessage: undefined,
      });
    } catch (error) {
      if (!this.started) {
        return;
      }
      this.updateStatus({
        phase: 'error',
        reason,
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Automatic library synchronization failed.',
      });
    } finally {
      this.activeSync = null;
      if (!this.started) {
        this.queuedReason = null;
      } else {
        const queuedReason = this.queuedReason;
        this.queuedReason = null;
        if (queuedReason) {
          if (queuedReason === 'reading-quiet') {
            this.requestQuiet();
          } else {
            this.requestImmediate(queuedReason);
          }
        }
      }
    }
  }

  private handleOffline(): void {
    if (!this.started || !this.selection.current()) {
      return;
    }
    if (this.scheduledReason) {
      this.queuedReason = mergeReasons(this.queuedReason, this.scheduledReason);
    }
    this.clearScheduledTimer();
    this.updateStatus({
      phase: 'offline',
      reason: this.queuedReason ?? undefined,
      scheduledFor: undefined,
    });
  }

  private clearScheduledTimer(): void {
    if (this.timer !== undefined) {
      this.environment.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.scheduledReason = null;
  }

  private readLastPeriodicSyncAt(provider: SyncProviderKind): number | null {
    if (!this.loadedRateLimits.has(provider)) {
      this.loadedRateLimits.add(provider);
      let stored: number | null = null;
      try {
        stored = this.rateLimitStore.read(provider);
      } catch {
        // Missing storage support simply falls back to the in-memory limit.
      }
      if (stored !== null) {
        this.lastPeriodicSyncAt[provider] = stored;
      }
    }
    return this.lastPeriodicSyncAt[provider] ?? null;
  }

  private updateStatus(status: Partial<AutoSyncStatus>): void {
    this.statusValue = { ...this.statusValue, ...status };
    for (const listener of this.listeners) {
      try {
        listener(this.statusValue);
      } catch {
        // Status presentation must not affect synchronization.
      }
    }
  }
}

function mergeReasons(
  current: AutoSyncReason | null,
  incoming: AutoSyncReason,
): AutoSyncReason {
  if (!current || current === 'reading-quiet') {
    return incoming;
  }
  return current;
}

function browserEnvironment(): AutoSyncEnvironment {
  const eventTarget = globalThis as unknown as EventTarget;
  return {
    now: () => Date.now(),
    isOnline: () => globalThis.navigator?.onLine ?? true,
    isBackground: () => globalThis.document?.visibilityState === 'hidden',
    setTimer: (callback, milliseconds) =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimer: (handle) => globalThis.clearTimeout(handle as number),
    onOnline: (callback) => listen(eventTarget, 'online', callback),
    onOffline: (callback) => listen(eventTarget, 'offline', callback),
  };
}

function browserAutoSyncRateLimitStore(): AutoSyncRateLimitStore {
  const key = (provider: SyncProviderKind) =>
    `omnia-reader.auto-sync.v1.last-periodic.${provider}`;
  return {
    read: (provider) => {
      try {
        const value = globalThis.localStorage?.getItem(key(provider));
        if (!value) {
          return null;
        }
        const timestamp = Number(value);
        return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
      } catch {
        return null;
      }
    },
    write: (provider, timestamp) => {
      try {
        globalThis.localStorage?.setItem(key(provider), String(timestamp));
      } catch {
        // Rate-limit persistence is an optimization, never a sync prerequisite.
      }
    },
  };
}

function listen(
  target: EventTarget,
  eventName: string,
  callback: () => void,
): () => void {
  target.addEventListener(eventName, callback);
  return () => target.removeEventListener(eventName, callback);
}
