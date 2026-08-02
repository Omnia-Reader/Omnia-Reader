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
  | 'destination-selected'
  | 'revision-check';

export type AutoSyncStatusReason = AutoSyncReason | 'manual';

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
  reason?: AutoSyncStatusReason;
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
  onVisibilityChange(callback: () => void): () => void;
}

export interface AutoSyncSchedulerOptions {
  quietIntervalMs?: number;
  interactiveQuietIntervalMs?: number;
  revisionCheckIntervalMs?: number;
  environment?: AutoSyncEnvironment;
  rateLimitStore?: AutoSyncRateLimitStore;
  historyStore?: AutoSyncHistoryStore;
}

export interface AutoSyncRateLimitStore {
  readRetryAfter(provider: SyncProviderKind): number | null;
  writeRetryAfter(provider: SyncProviderKind, timestamp: number | null): void;
}

export interface AutoSyncHistory {
  lastSuccessAt: string;
  lastResult: SyncWorkerResult;
}

export interface AutoSyncHistoryStore {
  read(provider: SyncProviderKind): AutoSyncHistory | null;
  write(provider: SyncProviderKind, history: AutoSyncHistory | null): void;
}

const DEFAULT_QUIET_INTERVAL_MS = 750;
const DEFAULT_INTERACTIVE_QUIET_INTERVAL_MS = 50;
const DEFAULT_REVISION_CHECK_INTERVAL_MS = 10_000;
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
  private readonly interactiveQuietIntervalMs: number;
  private readonly revisionCheckIntervalMs: number;
  private readonly environment: AutoSyncEnvironment;
  private readonly rateLimitStore: AutoSyncRateLimitStore;
  private readonly historyStore: AutoSyncHistoryStore;
  private readonly listeners = new Set<(status: AutoSyncStatus) => void>();
  private readonly providerRetryAfterAt: Partial<
    Record<SyncProviderKind, number>
  > = {};
  private readonly loadedProviderRetryAfter = new Set<SyncProviderKind>();
  private historyProvider: SyncProviderKind | null = null;

  private statusValue: AutoSyncStatus = { phase: 'idle' };
  private started = false;
  private timer: unknown;
  private revisionCheckTimer: unknown;
  private scheduledReason: AutoSyncReason | null = null;
  private queuedReason: AutoSyncReason | null = null;
  private activeSync: Promise<SyncWorkerResult> | null = null;
  private activeSyncController: AbortController | null = null;
  private unsubscribeActivity: (() => void) | null = null;
  private unsubscribeOnline: (() => void) | null = null;
  private unsubscribeOffline: (() => void) | null = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private unsubscribeSelection: (() => void) | null = null;

  constructor(
    private readonly worker: SyncWorker,
    private readonly selection: SyncProviderSelection,
    private readonly activity: SyncActivityNotifier,
    options: AutoSyncSchedulerOptions = {},
  ) {
    this.quietIntervalMs = options.quietIntervalMs ?? DEFAULT_QUIET_INTERVAL_MS;
    this.interactiveQuietIntervalMs =
      options.interactiveQuietIntervalMs ??
      DEFAULT_INTERACTIVE_QUIET_INTERVAL_MS;
    this.revisionCheckIntervalMs =
      options.revisionCheckIntervalMs ?? DEFAULT_REVISION_CHECK_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.revisionCheckIntervalMs) ||
      this.revisionCheckIntervalMs < 5_000 ||
      this.revisionCheckIntervalMs > 5 * 60_000
    ) {
      throw new TypeError(
        'The remote synchronization check interval must be between 5 seconds and 5 minutes',
      );
    }
    this.environment = options.environment ?? browserEnvironment();
    this.rateLimitStore =
      options.rateLimitStore ?? browserAutoSyncRateLimitStore();
    this.historyStore = options.historyStore ?? browserAutoSyncHistoryStore();
    const provider = this.selection.current();
    if (provider) {
      this.activateHistory(provider);
    }
  }

  status(): AutoSyncStatus {
    const provider = this.selection.current();
    if (provider) {
      this.activateHistory(provider);
    }
    return this.statusValue;
  }

  subscribe(listener: (status: AutoSyncStatus) => void): () => void {
    const provider = this.selection.current();
    if (provider) {
      this.activateHistory(provider);
    }
    this.listeners.add(listener);
    listener(this.statusValue);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    const provider = this.selection.current();
    if (provider) {
      this.activateHistory(provider);
    }
    this.unsubscribeActivity = this.activity.subscribe((change) => {
      if (change.kind === 'book') {
        this.requestImmediate('book-change');
      } else if (this.environment.isBackground()) {
        this.requestImmediate('background');
      } else if (change.kind === 'annotation' || change.kind === 'bookmark') {
        this.requestQuiet(this.interactiveQuietIntervalMs);
      } else {
        this.requestQuiet(this.quietIntervalMs);
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
      this.scheduleRevisionCheck();
    });
    this.unsubscribeOffline = this.environment.onOffline(() => {
      this.clearRevisionCheckTimer();
      this.handleOffline();
    });
    this.unsubscribeVisibility = this.environment.onVisibilityChange(() => {
      if (this.environment.isBackground()) {
        this.clearRevisionCheckTimer();
        return;
      }
      if (this.selection.current() === 'git') {
        this.requestImmediate('revision-check');
      }
      this.scheduleRevisionCheck();
    });
    this.unsubscribeSelection =
      this.selection.subscribe?.(() => {
        this.scheduleRevisionCheck();
      }) ?? null;

    if (this.selection.current()) {
      this.requestImmediate('startup');
    }
    this.scheduleRevisionCheck();
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.clearScheduledTimer();
    this.clearRevisionCheckTimer();
    this.queuedReason = null;
    this.activeSyncController?.abort(
      new DOMException('Automatic synchronization stopped', 'AbortError'),
    );
    this.unsubscribeActivity?.();
    this.unsubscribeOnline?.();
    this.unsubscribeOffline?.();
    this.unsubscribeVisibility?.();
    this.unsubscribeSelection?.();
    this.unsubscribeActivity = null;
    this.unsubscribeOnline = null;
    this.unsubscribeOffline = null;
    this.unsubscribeVisibility = null;
    this.unsubscribeSelection = null;
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

  recordManualSuccess(
    result: SyncWorkerResult,
    completedAt = this.environment.now(),
  ): void {
    const provider = this.selection.current();
    if (!provider) {
      return;
    }
    this.activateHistory(provider);
    this.clearScheduledTimer();
    this.queuedReason = null;
    this.recordSuccess(provider, result, completedAt, 'manual');
  }

  clearHistory(provider: SyncProviderKind): void {
    try {
      this.historyStore.write(provider, null);
    } catch {
      // Sync history is presentation state and cannot affect local data.
    }
    if (this.historyProvider === provider) {
      this.updateStatus({
        lastAttemptAt: undefined,
        lastSuccessAt: undefined,
        lastResult: undefined,
      });
    }
  }

  requestImmediate(reason: Exclude<AutoSyncReason, 'reading-quiet'>): void {
    const provider = this.selection.current();
    if (!this.started || !provider) {
      return;
    }
    this.activateHistory(provider);
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

  requestQuiet(delay = this.quietIntervalMs): void {
    const provider = this.selection.current();
    if (!this.started || !provider) {
      return;
    }
    this.activateHistory(provider);
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

    const providerRetryDelay = this.readProviderRetryDelay(provider);
    const boundedDelay = Math.max(delay, providerRetryDelay);
    this.schedule(
      'reading-quiet',
      boundedDelay,
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
      this.recordSuccess(provider, result, completedAt, reason);
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

  private scheduleRevisionCheck(): void {
    this.clearRevisionCheckTimer();
    if (!this.revisionPollingEnabled()) {
      return;
    }
    this.revisionCheckTimer = this.environment.setTimer(() => {
      this.revisionCheckTimer = undefined;
      if (
        this.revisionPollingEnabled() &&
        this.timer === undefined &&
        !this.activeSync
      ) {
        this.requestImmediate('revision-check');
      }
      this.scheduleRevisionCheck();
    }, this.revisionCheckIntervalMs);
  }

  private revisionPollingEnabled(): boolean {
    return (
      this.started &&
      this.selection.current() === 'git' &&
      this.environment.isOnline() &&
      !this.environment.isBackground()
    );
  }

  private clearRevisionCheckTimer(): void {
    if (this.revisionCheckTimer !== undefined) {
      this.environment.clearTimer(this.revisionCheckTimer);
      this.revisionCheckTimer = undefined;
    }
  }

  private clearScheduledTimer(): void {
    if (this.timer !== undefined) {
      this.environment.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.scheduledReason = null;
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

  private activateHistory(provider: SyncProviderKind): void {
    if (this.historyProvider === provider) {
      return;
    }
    this.historyProvider = provider;
    let history: AutoSyncHistory | null = null;
    try {
      history = this.historyStore.read(provider);
    } catch {
      // Missing history persistence never affects synchronization.
    }
    this.updateStatus({
      lastAttemptAt: undefined,
      lastSuccessAt: history?.lastSuccessAt,
      lastResult: history?.lastResult,
    });
  }

  private recordSuccess(
    provider: SyncProviderKind,
    result: SyncWorkerResult,
    completedAt: number,
    reason: AutoSyncStatusReason,
  ): void {
    const lastSuccessAt = new Date(completedAt).toISOString();
    const history: AutoSyncHistory = {
      lastSuccessAt,
      lastResult: { ...result },
    };
    try {
      this.historyStore.write(provider, history);
    } catch {
      // Sync history is presentation state and cannot affect success.
    }
    this.updateStatus({
      phase: 'idle',
      reason,
      scheduledFor: undefined,
      lastAttemptAt:
        reason === 'manual' ? lastSuccessAt : this.statusValue.lastAttemptAt,
      lastSuccessAt,
      lastResult: history.lastResult,
      transferProgress: undefined,
      errorMessage: undefined,
    });
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
    onVisibilityChange: (callback) =>
      listen(globalThis.document ?? eventTarget, 'visibilitychange', callback),
  };
}

function browserAutoSyncRateLimitStore(): AutoSyncRateLimitStore {
  const retryAfterKey = (provider: SyncProviderKind) =>
    `omnia-reader.auto-sync.v1.retry-after.${provider}`;
  return {
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

function browserAutoSyncHistoryStore(): AutoSyncHistoryStore {
  const historyKey = (provider: SyncProviderKind) =>
    `omnia-reader.auto-sync.v1.history.${provider}`;
  return {
    read: (provider) => {
      try {
        const value = globalThis.localStorage?.getItem(historyKey(provider));
        if (!value) {
          return null;
        }
        const history: unknown = JSON.parse(value);
        return isAutoSyncHistory(history) ? history : null;
      } catch {
        return null;
      }
    },
    write: (provider, history) => {
      try {
        if (history) {
          globalThis.localStorage?.setItem(
            historyKey(provider),
            JSON.stringify(history),
          );
        } else {
          globalThis.localStorage?.removeItem(historyKey(provider));
        }
      } catch {
        // History remains available in memory when storage is unavailable.
      }
    },
  };
}

function isAutoSyncHistory(value: unknown): value is AutoSyncHistory {
  if (!isRecord(value) || !isRecord(value['lastResult'])) {
    return false;
  }
  const lastSuccessAt = value['lastSuccessAt'];
  const result = value['lastResult'];
  return (
    typeof lastSuccessAt === 'string' &&
    Number.isFinite(Date.parse(lastSuccessAt)) &&
    isSyncCount(result['pulled']) &&
    isSyncCount(result['pushed']) &&
    isSyncCount(result['conflicts']) &&
    isSyncCount(result['rejected']) &&
    (result['unchanged'] === undefined || result['unchanged'] === true)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSyncCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
