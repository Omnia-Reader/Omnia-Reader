import { randomBytes } from 'node:crypto';
import { GatewayHttpError, type SyncProviderKind } from './gateway-contract.js';
import type { GatewaySessionStore } from './session-store.js';

export interface NativeHandoffRecord {
  provider: SyncProviderKind;
  nativeRequestId: string;
  outcome: NativeHandoffOutcome;
  sessionId?: string;
  expiresAt: number;
}

export type NativeHandoffOutcome =
  | 'authorized'
  | 'denied'
  | 'invalid'
  | 'failed';

export interface NativeAuthorizationHandoffOptions {
  store: GatewaySessionStore<NativeHandoffRecord>;
  redirectScheme: string;
  ttlMs?: number;
  now?: () => number;
  randomId?: () => string;
}

export interface NativeHandoffIssue {
  provider: SyncProviderKind;
  nativeRequestId: string;
  sessionId: string;
}

export interface NativeHandoffRedemption {
  provider: SyncProviderKind;
  nativeRequestId: string;
  handoffId: string;
}

export interface NativeHandoffResult {
  outcome: NativeHandoffOutcome;
  sessionId?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const NATIVE_REQUEST_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
const HANDOFF_ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{16,512}$/;
const RETURN_PATH_PREFIX = '/api/sync/native/authorization/';

export class NativeAuthorizationHandoffs {
  private readonly store: GatewaySessionStore<NativeHandoffRecord>;
  private readonly redirectScheme: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(options: NativeAuthorizationHandoffOptions) {
    if (
      !/^[a-z][a-z0-9+.-]{1,31}$/.test(options.redirectScheme) ||
      ['http', 'https', 'file', 'javascript', 'data'].includes(
        options.redirectScheme,
      )
    ) {
      throw new TypeError(
        'The native authorization redirect scheme is invalid',
      );
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw new TypeError('The native authorization handoff TTL is invalid');
    }
    this.store = options.store;
    this.redirectScheme = options.redirectScheme;
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
    this.randomId =
      options.randomId ?? (() => randomBytes(32).toString('base64url'));
  }

  authorizationReturnTo(
    provider: SyncProviderKind,
    nativeRequestId: string,
  ): string {
    assertNativeRequestId(nativeRequestId);
    return `${RETURN_PATH_PREFIX}${provider}/${nativeRequestId}`;
  }

  requestFromReturnTo(
    provider: SyncProviderKind,
    returnTo: string,
  ): string | null {
    const prefix = `${RETURN_PATH_PREFIX}${provider}/`;
    if (!returnTo.startsWith(prefix)) {
      return null;
    }
    const nativeRequestId = returnTo.slice(prefix.length);
    try {
      assertNativeRequestId(nativeRequestId);
    } catch {
      return null;
    }
    return nativeRequestId;
  }

  async issue(input: NativeHandoffIssue): Promise<{ deepLink: string }> {
    assertNativeRequestId(input.nativeRequestId);
    assertSessionId(input.sessionId);
    const handoffId = this.handoffId();
    await this.store.set(handoffId, {
      provider: input.provider,
      nativeRequestId: input.nativeRequestId,
      outcome: 'authorized',
      sessionId: input.sessionId,
      expiresAt: this.now() + this.ttlMs,
    });
    return {
      deepLink: this.deepLink(input.provider, input.nativeRequestId, handoffId),
    };
  }

  async issueFailure(input: {
    provider: SyncProviderKind;
    nativeRequestId: string;
    outcome: Exclude<NativeHandoffOutcome, 'authorized'>;
  }): Promise<{ deepLink: string }> {
    assertNativeRequestId(input.nativeRequestId);
    const handoffId = this.handoffId();
    await this.store.set(handoffId, {
      provider: input.provider,
      nativeRequestId: input.nativeRequestId,
      outcome: input.outcome,
      expiresAt: this.now() + this.ttlMs,
    });
    return {
      deepLink: this.deepLink(input.provider, input.nativeRequestId, handoffId),
    };
  }

  private handoffId(): string {
    const handoffId = this.randomId();
    if (!HANDOFF_ID_PATTERN.test(handoffId)) {
      throw new TypeError('The native authorization handoff source is invalid');
    }
    return handoffId;
  }

  private deepLink(
    provider: SyncProviderKind,
    nativeRequestId: string,
    handoffId: string,
  ): string {
    const deepLink = new URL(`${this.redirectScheme}://sync-auth/${provider}`);
    deepLink.searchParams.set('handoffId', handoffId);
    deepLink.searchParams.set('requestId', nativeRequestId);
    return deepLink.toString();
  }

  async consume(
    input: NativeHandoffRedemption,
    disposeSession: (sessionId: string) => Promise<void> = async () =>
      undefined,
  ): Promise<NativeHandoffResult> {
    assertNativeRequestId(input.nativeRequestId);
    if (!HANDOFF_ID_PATTERN.test(input.handoffId)) {
      throw unavailableHandoff();
    }
    const record = await this.store.take(input.handoffId);
    if (!record || !isNativeHandoffRecord(record)) {
      throw unavailableHandoff();
    }
    if (
      record.provider !== input.provider ||
      record.nativeRequestId !== input.nativeRequestId
    ) {
      if (record.sessionId) {
        await disposeSession(record.sessionId);
      }
      throw new GatewayHttpError(
        400,
        'Native authorization handoff does not match this request',
      );
    }
    if (record.expiresAt <= this.now()) {
      if (record.sessionId) {
        await disposeSession(record.sessionId);
      }
      throw unavailableHandoff();
    }
    if (record.outcome === 'authorized') {
      if (!record.sessionId) {
        throw unavailableHandoff();
      }
      assertSessionId(record.sessionId);
      return { outcome: record.outcome, sessionId: record.sessionId };
    }
    if (record.sessionId) {
      await disposeSession(record.sessionId);
      throw unavailableHandoff();
    }
    return { outcome: record.outcome };
  }
}

function assertNativeRequestId(value: string): void {
  if (!NATIVE_REQUEST_PATTERN.test(value)) {
    throw new GatewayHttpError(400, 'Native authorization request is invalid');
  }
}

function assertSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new TypeError('The native authorization session is invalid');
  }
}

function unavailableHandoff(): GatewayHttpError {
  return new GatewayHttpError(
    401,
    'Native authorization handoff is unavailable',
  );
}

function isNativeHandoffRecord(value: unknown): value is NativeHandoffRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const outcome = record['outcome'];
  const sessionId = record['sessionId'];
  return (
    keys.every((key) =>
      [
        'provider',
        'nativeRequestId',
        'outcome',
        'sessionId',
        'expiresAt',
      ].includes(key),
    ) &&
    (record['provider'] === 'github' || record['provider'] === 'mega') &&
    typeof record['nativeRequestId'] === 'string' &&
    NATIVE_REQUEST_PATTERN.test(record['nativeRequestId']) &&
    ['authorized', 'denied', 'invalid', 'failed'].includes(
      typeof outcome === 'string' ? outcome : '',
    ) &&
    Number.isSafeInteger(record['expiresAt']) &&
    (outcome === 'authorized'
      ? typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)
      : sessionId === undefined) &&
    keys.length === (outcome === 'authorized' ? 5 : 4)
  );
}
