import { buildSyncGateway } from './app.js';
import {
  AuthorizationHttpError,
  type DocumentWriteRequest,
  type RemoteDocument,
  type RemoteObject,
  type RemoteObjectUpload,
  type RemoteSyncEntry,
  type SyncGatewayAdapter,
} from './gateway-contract.js';
import {
  NativeAuthorizationHandoffs,
  type NativeHandoffRecord,
} from './native-handoff.js';
import { EncryptedMemorySessionStore } from './session-store.js';

const REQUEST_ID = 'native-request-12345678';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const HANDOFF_ID = 'A'.repeat(43);

describe('NativeAuthorizationHandoffs', () => {
  it('issues only opaque bound deep links and consumes them exactly once', async () => {
    const handoffs = fixture();
    const issued = await handoffs.issue({
      provider: 'github',
      nativeRequestId: REQUEST_ID,
      sessionId: SESSION_ID,
    });
    const deepLink = new URL(issued.deepLink);

    expect(deepLink.protocol).toBe('omnia-reader:');
    expect(deepLink.host).toBe('sync-auth');
    expect(deepLink.pathname).toBe('/github');
    expect(deepLink.searchParams.get('handoffId')).toBe(HANDOFF_ID);
    expect(deepLink.searchParams.get('requestId')).toBe(REQUEST_ID);
    expect(issued.deepLink).not.toContain(SESSION_ID);

    await expect(
      handoffs.consume({
        provider: 'github',
        nativeRequestId: REQUEST_ID,
        handoffId: HANDOFF_ID,
      }),
    ).resolves.toEqual({ outcome: 'authorized', sessionId: SESSION_ID });
    await expect(
      handoffs.consume({
        provider: 'github',
        nativeRequestId: REQUEST_ID,
        handoffId: HANDOFF_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('atomically rejects provider mismatch, request forgery, and expiry', async () => {
    let now = 1_000;
    let sequence = 0;
    const disposed = vi.fn<(sessionId: string) => Promise<void>>(
      async () => undefined,
    );
    const handoffs = fixture({
      now: () => now,
      randomId: () => `${String.fromCharCode(65 + sequence++).repeat(43)}`,
    });

    await handoffs.issue({
      provider: 'github',
      nativeRequestId: REQUEST_ID,
      sessionId: `${SESSION_ID}-mismatch`,
    });
    await expect(
      handoffs.consume(
        {
          provider: 'mega',
          nativeRequestId: REQUEST_ID,
          handoffId: 'A'.repeat(43),
        },
        disposed,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      handoffs.consume({
        provider: 'github',
        nativeRequestId: REQUEST_ID,
        handoffId: 'A'.repeat(43),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    await handoffs.issue({
      provider: 'github',
      nativeRequestId: REQUEST_ID,
      sessionId: `${SESSION_ID}-expired`,
    });
    now += 301_000;
    await expect(
      handoffs.consume(
        {
          provider: 'github',
          nativeRequestId: REQUEST_ID,
          handoffId: 'B'.repeat(43),
        },
        disposed,
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(disposed).toHaveBeenCalledTimes(2);

    const error = await handoffs
      .consume({
        provider: 'github',
        nativeRequestId: 'forged/request',
        handoffId: 'not-a-handoff',
      })
      .catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain(SESSION_ID);

    await handoffs.issueFailure({
      provider: 'github',
      nativeRequestId: REQUEST_ID,
      outcome: 'denied',
    });
    await expect(
      handoffs.consume({
        provider: 'github',
        nativeRequestId: REQUEST_ID,
        handoffId: 'C'.repeat(43),
      }),
    ).resolves.toEqual({ outcome: 'denied' });
  });

  it('rejects malformed stored handoffs without reflecting their fields', async () => {
    const store = new EncryptedMemorySessionStore<NativeHandoffRecord>(
      Buffer.alloc(32, 7),
    );
    await store.set(HANDOFF_ID, {
      provider: 'github',
      nativeRequestId: REQUEST_ID,
      outcome: 'provider-secret',
      expiresAt: Date.now() + 60_000,
    } as NativeHandoffRecord);
    const handoffs = new NativeAuthorizationHandoffs({
      store,
      redirectScheme: 'omnia-reader',
    });
    const error = await handoffs
      .consume({
        provider: 'github',
        nativeRequestId: REQUEST_ID,
        handoffId: HANDOFF_ID,
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ statusCode: 401 });
    expect(JSON.stringify(error)).not.toContain('provider-secret');
  });

  it('binds OAuth callback completion to native redemption without browser authority', async () => {
    const adapter = new NativeTestAdapter();
    const handoffs = fixture();
    const app = buildSyncGateway({
      github: adapter,
      mega: adapter,
      nativeHandoffs: handoffs,
      secureCookies: false,
    });

    const start = await app.inject({
      method: 'GET',
      url: `/api/sync/github/native/auth/start?requestId=${REQUEST_ID}`,
      cookies: { omnia_sync_github: SESSION_ID },
    });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toBe('https://provider.invalid/authorize');
    const pendingCookie = start.cookies[0];
    expect(pendingCookie.name).toBe('omnia_sync_github_native');
    expect(pendingCookie.value).not.toBe(SESSION_ID);

    const callback = await app.inject({
      method: 'GET',
      url: '/api/sync/github/auth/callback?code=test&state=test',
      cookies: { [pendingCookie.name]: pendingCookie.value },
    });
    expect(callback.statusCode).toBe(303);
    const deepLink = new URL(callback.headers.location as string);
    expect(deepLink.protocol).toBe('omnia-reader:');
    expect(callback.headers['set-cookie']).toContain(`${pendingCookie.name}=;`);
    expect(callback.headers['set-cookie']).not.toContain(SESSION_ID);

    const redemption = await app.inject({
      method: 'POST',
      url: '/api/sync/github/native/auth/redeem',
      headers: {
        host: 'reader.test',
        origin: 'http://reader.test',
        'x-omnia-csrf': '1',
        'content-type': 'application/json',
      },
      payload: {
        handoffId: deepLink.searchParams.get('handoffId'),
        nativeRequestId: deepLink.searchParams.get('requestId'),
      },
    });
    expect(redemption.statusCode).toBe(200);
    expect(redemption.json()).toEqual({ authenticated: true });
    expect(redemption.body).not.toContain(SESSION_ID);
    expect(redemption.cookies[0].value).toBe(adapter.completedSessionId);
    expect(redemption.cookies[0].value).not.toBe(pendingCookie.value);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/sync/github/native/auth/redeem',
      headers: {
        host: 'reader.test',
        origin: 'http://reader.test',
        'x-omnia-csrf': '1',
        'content-type': 'application/json',
      },
      payload: {
        handoffId: deepLink.searchParams.get('handoffId'),
        nativeRequestId: REQUEST_ID,
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.body).not.toContain(SESSION_ID);
    await app.close();
  });

  it('expires a pending native cookie when browser authorization starts', async () => {
    const adapter = new NativeTestAdapter();
    const app = buildSyncGateway({
      github: adapter,
      mega: adapter,
      nativeHandoffs: fixture(),
      secureCookies: false,
    });
    const nativeStart = await app.inject({
      method: 'GET',
      url: `/api/sync/github/native/auth/start?requestId=${REQUEST_ID}`,
      cookies: { omnia_sync_github: SESSION_ID },
    });
    const pendingCookie = nativeStart.cookies[0];

    const browserStart = await app.inject({
      method: 'GET',
      url: '/api/sync/github/auth/start?returnTo=%2Fsettings%2Fsync',
      cookies: {
        omnia_sync_github: SESSION_ID,
        [pendingCookie.name]: pendingCookie.value,
      },
    });

    expect(browserStart.statusCode).toBe(302);
    expect(browserStart.headers['set-cookie']).toContain(
      `${pendingCookie.name}=;`,
    );
    await app.close();
  });

  it('returns denied native authorization through a sanitized one-use handoff', async () => {
    const adapter = new NativeTestAdapter();
    const app = buildSyncGateway({
      github: adapter,
      mega: adapter,
      nativeHandoffs: fixture(),
      secureCookies: false,
    });
    const start = await app.inject({
      method: 'GET',
      url: `/api/sync/github/native/auth/start?requestId=${REQUEST_ID}`,
    });
    const pendingCookie = start.cookies[0];
    const callback = await app.inject({
      method: 'GET',
      url: '/api/sync/github/auth/callback?error=access_denied&error_description=provider-secret',
      cookies: { [pendingCookie.name]: pendingCookie.value },
    });

    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).not.toContain('provider-secret');
    const deepLink = new URL(callback.headers.location as string);
    const redemption = await app.inject({
      method: 'POST',
      url: '/api/sync/github/native/auth/redeem',
      headers: {
        host: 'reader.test',
        origin: 'http://reader.test',
        'x-omnia-csrf': '1',
        'content-type': 'application/json',
      },
      payload: {
        handoffId: deepLink.searchParams.get('handoffId'),
        nativeRequestId: REQUEST_ID,
      },
    });
    expect(redemption.statusCode).toBe(200);
    expect(redemption.json()).toEqual({
      authenticated: false,
      outcome: 'denied',
    });
    expect(redemption.headers['set-cookie']).toBeUndefined();
    expect(redemption.body).not.toContain('provider-secret');
    await app.close();
  });
});

function fixture(
  options: {
    now?: () => number;
    randomId?: () => string;
  } = {},
): NativeAuthorizationHandoffs {
  return new NativeAuthorizationHandoffs({
    store: new EncryptedMemorySessionStore(Buffer.alloc(32, 7), {
      ttlMs: 10 * 60 * 1000,
      now: options.now,
      random: () => Buffer.alloc(12, 9),
    }),
    redirectScheme: 'omnia-reader',
    now: options.now,
    randomId: options.randomId ?? (() => HANDOFF_ID),
  });
}

class NativeTestAdapter implements SyncGatewayAdapter {
  private returnTo = '/settings/sync';
  completedSessionId = '';

  async session(): Promise<unknown> {
    return { authenticated: true };
  }

  async authorizationUrl(
    _sessionId: string,
    returnTo: string,
  ): Promise<string> {
    this.returnTo = returnTo;
    return 'https://provider.invalid/authorize';
  }

  async pendingAuthorizationReturnTo(): Promise<string> {
    return this.returnTo;
  }

  async completeAuthorization(
    _sessionId: string,
    replacementSessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<string> {
    if (parameters['error'] === 'access_denied') {
      throw new AuthorizationHttpError(
        401,
        'Provider-controlled detail is not exposed',
        'denied',
      );
    }
    this.completedSessionId = replacementSessionId;
    return this.returnTo;
  }

  async disconnect(): Promise<void> {
    return;
  }
  async destinations(): Promise<readonly unknown[]> {
    return [];
  }
  async selectDestination(): Promise<unknown> {
    return {};
  }
  async listDocuments(): Promise<readonly RemoteDocument[]> {
    return [];
  }
  async listEntries(): Promise<readonly RemoteSyncEntry[]> {
    return [];
  }
  async deleteEntries(): Promise<void> {
    return;
  }
  async deleteEntry(): Promise<void> {
    return;
  }
  async readDocument(): Promise<RemoteDocument | null> {
    return null;
  }
  async writeDocument(
    _sessionId: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument> {
    return { path: request.path, content: request.content, revision: '1' };
  }
  async deleteDocument(): Promise<void> {
    return;
  }
  async headObject(): Promise<RemoteObject | null> {
    return null;
  }
  async downloadObject(): Promise<null> {
    return null;
  }
  async uploadObject(
    _sessionId: string,
    upload: RemoteObjectUpload,
  ): Promise<RemoteObject> {
    return {
      path: upload.path,
      revision: '1',
      size: upload.size,
      sha256: upload.sha256,
    };
  }
  async deleteObject(): Promise<void> {
    return;
  }
}
