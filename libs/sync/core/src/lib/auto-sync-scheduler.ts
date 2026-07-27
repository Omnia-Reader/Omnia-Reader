import {
  SyncProviderKind,
  SyncProviderSelection,
} from './sync-provider-selection';
import { SyncActivityNotifier } from './sync-activity';
import { SyncWorker, SyncWorkerResult } from './library-sync-coordinator';
import { ObjectTransferProgress } from './library-sync-transport';

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
  | 'cancelling'
  | 'cancelled'
  | 'offline'
  | 'error';

export interface AutoSyncStatus {
  phase: AutoSyncPhase;
  reason?: AutoSyncReason;
  scheduledFor?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastResult?: SyncWorkerResult;
  transferProgress?: ObjectTransferProgress;
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
  readRetryAfter(provider: SyncProviderKind): number | null;
  writeRetryAfter(provider: SyncProviderKind, timestamp: number | null): void;
}

const DEFAULT_QUIET_INTERVAL_MS = 30_000;
const DEFAULT_PERIODIC_MINIMUM_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PROVIDER_RETRY_AFTER_MS = 60_000;
const PROVIDER_RATE_LIMIT_MESSAGE =
  'The synchronization provider is temporarily rate limiting requests. Local changes are safe and automatic synchronization will retry.';

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
  private readonly providerRetryAfterAt: Partial<
    Record<SyncProviderKind, number>
  > = {};
  private readonly loadedProviderRetryAfter = new Set<SyncProviderKind>();

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
  private activeSyncController: AbortController | null = null;
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
    this.activeSyncController?.abort(
      new DOMException('Automatic synchronization stopped', 'AbortError'),
    );
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
      transferProgress: undefined,
      errorMessage: undefined,
    });
  }

  cancelActive(): boolean {
    const controller = this.activeSyncController;
    if (!controller || controller.signal.aborted) {
      return false;
    }

    this.queuedReason = null;
    controller.abort(
      new DOMException('Automatic synchronization was cancelled', 'AbortError'),
    );
    this.updateStatus({
      phase: 'cancelling',
      scheduledFor: undefined,
      transferProgress: undefined,
      errorMessage: undefined,
    });
    return true;
  }

  requestImmediate(reason: Exclude<AutoSyncReason, 'reading-quiet'>): void {
    const provider = this.selection.current();
    if (!this.started || !provider) {
      return;
    }
    if (!this.environment.isOnline()) {
      this.queuedReason = mergeReasons(this.queuedReason, reason);
      this.clearScheduledTimer();
      this.updateStatus({
        phase: 'offline',
        reason,
        transferProgress: undefined,
      });
      return;
    }
    if (this.activeSync) {
      this.queuedReason = mergeReasons(this.queuedReason, reason);
      return;
    }

    const retryDelay = this.readProviderRetryDelay(provider);
    this.schedule(
      reason,
      retryDelay,
      retryDelay > 0 ? PROVIDER_RATE_LIMIT_MESSAGE : undefined,
    );
  }

  requestQuiet(): void {
    const provider = this.selection.current();
    if (!this.started || !provider) {
      return;
    }
    if (!this.environment.isOnline()) {
      this.queuedReason = mergeReasons(this.queuedReason, 'reading-quiet');
      this.clearScheduledTimer();
      this.updateStatus({
        phase: 'offline',
        reason: 'reading-quiet',
        transferProgress: undefined,
      });
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
    const providerRetryDelay = this.readProviderRetryDelay(provider);
    const delay = Math.max(
      this.quietIntervalMs,
      nextPeriodicAt - now,
      providerRetryDelay,
    );
    this.schedule(
      'reading-quiet',
      delay,
      providerRetryDelay > 0 ? PROVIDER_RATE_LIMIT_MESSAGE : undefined,
    );
  }

  private schedule(
    reason: AutoSyncReason,
    delay: number,
    errorMessage?: string,
  ): void {
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
      transferProgress: undefined,
      errorMessage,
    });
  }

  private async runAutomatic(reason: AutoSyncReason): Promise<void> {
    const provider = this.selection.current();
    if (!this.started || !provider) {
      this.updateStatus({
        phase: 'idle',
        reason: undefined,
        transferProgress: undefined,
      });
      return;
    }
    if (!this.environment.isOnline()) {
      this.queuedReason = mergeReasons(this.queuedReason, reason);
      this.updateStatus({
        phase: 'offline',
        reason,
        transferProgress: undefined,
      });
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
      transferProgress: undefined,
      errorMessage: undefined,
    });

    const controller = new AbortController();
    this.activeSyncController = controller;
    const activeSync = Promise.resolve().then(() =>
      this.worker.synchronize({
        signal: controller.signal,
        onTransferProgress: (progress) => {
          if (
            this.started &&
            this.activeSyncController === controller &&
            !controller.signal.aborted
          ) {
            this.updateStatus({ transferProgress: progress });
          }
        },
      }),
    );
    this.activeSync = activeSync;
    let providerRetryDelayMs: number | null = null;
    try {
      const result = await activeSync;
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      if (!this.started) {
        return;
      }
      const completedAt = this.environment.now();
      this.clearProviderRetryAfter(provider);
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
        transferProgress: undefined,
        errorMessage: undefined,
      });
    } catch (error) {
      if (!this.started) {
        return;
      }
      if (controller.signal.aborted) {
        this.queuedReason = null;
        this.updateStatus({
          phase: 'cancelled',
          reason,
          transferProgress: undefined,
          errorMessage: undefined,
        });
      } else {
        const retryAfterSeconds = providerRetryAfterSeconds(error);
        if (retryAfterSeconds !== null) {
          providerRetryDelayMs = retryAfterSeconds * 1000;
          this.persistProviderRetryAfter(
            provider,
            this.environment.now() + providerRetryDelayMs,
          );
        } else {
          this.updateStatus({
            phase: 'error',
            reason,
            transferProgress: undefined,
            errorMessage:
              error instanceof Error
                ? error.message
                : 'Automatic library synchronization failed.',
          });
        }
      }
    } finally {
      if (this.activeSync === activeSync) {
        this.activeSync = null;
      }
      if (this.activeSyncController === controller) {
        this.activeSyncController = null;
      }
      if (!this.started) {
        this.queuedReason = null;
      } else if (controller.signal.aborted) {
        this.queuedReason = null;
      } else if (providerRetryDelayMs !== null) {
        const retryReason = this.queuedReason
          ? mergeReasons(this.queuedReason, reason)
          : reason;
        this.queuedReason = null;
        this.schedule(
          retryReason,
          providerRetryDelayMs,
          PROVIDER_RATE_LIMIT_MESSAGE,
        );
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
      transferProgress: undefined,
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

  private readProviderRetryDelay(provider: SyncProviderKind): number {
    if (!this.loadedProviderRetryAfter.has(provider)) {
      this.loadedProviderRetryAfter.add(provider);
      let stored: number | null = null;
      try {
        stored = this.rateLimitStore.readRetryAfter(provider);
      } catch {
        // Missing storage support falls back to the in-memory deadline.
      }
      if (stored !== null) {
        this.providerRetryAfterAt[provider] = stored;
      }
    }

    const retryAfterAt = this.providerRetryAfterAt[provider];
    if (retryAfterAt === undefined) {
      return 0;
    }
    const delay = retryAfterAt - this.environment.now();
    if (delay > 0) {
      return delay;
    }
    this.clearProviderRetryAfter(provider);
    return 0;
  }

  private persistProviderRetryAfter(
    provider: SyncProviderKind,
    retryAfterAt: number,
  ): void {
    this.loadedProviderRetryAfter.add(provider);
    this.providerRetryAfterAt[provider] = retryAfterAt;
    try {
      this.rateLimitStore.writeRetryAfter(provider, retryAfterAt);
    } catch {
      // Persistence cannot turn provider backoff into a sync failure.
    }
  }

  private clearProviderRetryAfter(provider: SyncProviderKind): void {
    this.loadedProviderRetryAfter.add(provider);
    delete this.providerRetryAfterAt[provider];
    try {
      this.rateLimitStore.writeRetryAfter(provider, null);
    } catch {
      // Persistence is an optimization, never a sync prerequisite.
    }
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
  const periodicKey = (provider: SyncProviderKind) =>
    `omnia-reader.auto-sync.v1.last-periodic.${provider}`;
  const retryAfterKey = (provider: SyncProviderKind) =>
    `omnia-reader.auto-sync.v1.retry-after.${provider}`;
  return {
    read: (provider) => {
      try {
        const value = globalThis.localStorage?.getItem(periodicKey(provider));
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
        globalThis.localStorage?.setItem(
          periodicKey(provider),
          String(timestamp),
        );
      } catch {
        // Rate-limit persistence is an optimization, never a sync prerequisite.
      }
    },
    readRetryAfter: (provider) => {
      try {
        const value = globalThis.localStorage?.getItem(retryAfterKey(provider));
        if (!value) {
          return null;
        }
        const timestamp = Number(value);
        return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
      } catch {
        return null;
      }
    },
    writeRetryAfter: (provider, timestamp) => {
      try {
        if (timestamp === null) {
          globalThis.localStorage?.removeItem(retryAfterKey(provider));
        } else {
          globalThis.localStorage?.setItem(
            retryAfterKey(provider),
            String(timestamp),
          );
        }
      } catch {
        // Provider backoff remains active in memory when storage is unavailable.
      }
    },
  };
}

function providerRetryAfterSeconds(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null;
  }
  if ((error as { status?: unknown }).status !== 429) {
    return null;
  }
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 86_400
  ) {
    return value;
  }
  return DEFAULT_PROVIDER_RETRY_AFTER_MS / 1000;
}

function listen(
  target: EventTarget,
  eventName: string,
  callback: () => void,
): () => void {
  target.addEventListener(eventName, callback);
  return () => target.removeEventListener(eventName, callback);
}
