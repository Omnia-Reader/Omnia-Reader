import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { buildSyncGateway } from './app.js';
import {
  AuthorizationHttpError,
  GatewayHttpError,
  type CredentialAuthorizationPage,
  type CredentialSyncGatewayAdapter,
  type DestinationCreatingSyncGatewayAdapter,
  type DocumentDeleteRequest,
  type DocumentWriteRequest,
  type RemoteDocument,
  type RemoteObject,
  type RemoteObjectDelete,
  type RemoteObjectDownload,
  type RemoteObjectUpload,
  type SyncGatewayAdapter,
  type SyncProviderKind,
} from './gateway-contract.js';
import { MemoryGitHubAuthorizationRevocationStore } from './github-authorization-revocations.js';
import type { GitHubWebhookOptions } from './github-webhook.js';
import { UnconfiguredSyncGatewayAdapter } from './unconfigured-adapter.js';

const HOST = 'reader.test';
const MUTATION_HEADERS = {
  host: HOST,
  origin: `http://${HOST}`,
  'sec-fetch-site': 'same-origin',
  'x-omnia-csrf': '1',
};

describe('sync gateway', () => {
  it('exposes health without requiring a provider session', async () => {
    const app = gateway();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'omnia-reader-sync-gateway',
    });
    await app.close();
  });

  it('applies a signed GitHub authorization revocation once per delivery', async () => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();
    const webhook = { secret: 'w'.repeat(32), revocations };
    const app = gateway(
      new MemoryGatewayAdapter('github'),
      new MemoryGatewayAdapter('mega'),
      webhook,
    );
    const payload = JSON.stringify({
      action: 'revoked',
      sender: { id: 42, login: 'reader' },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/sync/github/webhook',
      headers: webhookHeaders(webhook.secret, payload, 'delivery-1'),
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/sync/github/webhook',
      headers: webhookHeaders(webhook.secret, payload, 'delivery-1'),
      payload,
    });

    expect(first.statusCode).toBe(204);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(replay.statusCode).toBe(204);
    await expect(revocations.generation(42)).resolves.toBe(1);
    await app.close();
  });

  it('rejects an invalid webhook signature without applying its payload', async () => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();
    const app = gateway(
      new MemoryGatewayAdapter('github'),
      new MemoryGatewayAdapter('mega'),
      { secret: 'w'.repeat(32), revocations },
    );
    const payload = JSON.stringify({
      action: 'revoked',
      sender: { id: 42 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-invalid',
        'x-github-event': 'github_app_authorization',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      message: 'GitHub webhook signature is invalid',
    });
    await expect(revocations.generation(42)).resolves.toBe(0);
    await app.close();
  });

  it('fails gateway readiness when the webhook secret is too weak', async () => {
    const app = gateway(
      new MemoryGatewayAdapter('github'),
      new MemoryGatewayAdapter('mega'),
      {
        secret: 'too-short',
        revocations: new MemoryGitHubAuthorizationRevocationStore(),
      },
    );

    await expect(app.ready()).rejects.toThrow(
      'The GitHub webhook secret is invalid',
    );
    await app.close();
  });

  it.each([
    {
      name: 'unsupported authorization action',
      payload: { action: 'created', sender: { id: 42 } },
      delivery: 'delivery-action',
    },
    {
      name: 'missing sender',
      payload: { action: 'revoked' },
      delivery: 'delivery-sender',
    },
    {
      name: 'invalid delivery ID',
      payload: { action: 'revoked', sender: { id: 42 } },
      delivery: 'invalid delivery',
    },
  ])('rejects a signed webhook with $name', async ({ payload, delivery }) => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();
    const webhook = { secret: 'w'.repeat(32), revocations };
    const app = gateway(
      new MemoryGatewayAdapter('github'),
      new MemoryGatewayAdapter('mega'),
      webhook,
    );
    const body = JSON.stringify(payload);

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/github/webhook',
      headers: webhookHeaders(webhook.secret, body, delivery),
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: delivery.includes(' ')
        ? 'GitHub webhook delivery ID is invalid'
        : 'GitHub webhook payload is invalid',
    });
    await expect(revocations.generation(42)).resolves.toBe(0);
    await app.close();
  });

  it('acknowledges signed unrelated GitHub events without applying them', async () => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();
    const webhook = { secret: 'w'.repeat(32), revocations };
    const app = gateway(
      new MemoryGatewayAdapter('github'),
      new MemoryGatewayAdapter('mega'),
      webhook,
    );
    const payload = JSON.stringify({ zen: 'Keep it logically awesome.' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/github/webhook',
      headers: {
        ...webhookHeaders(webhook.secret, payload, 'delivery-ping'),
        'x-github-event': 'ping',
      },
      payload,
    });

    expect(response.statusCode).toBe(204);
    await expect(revocations.generation(42)).resolves.toBe(0);
    await app.close();
  });

  it('bounds GitHub webhook bodies without caching the error response', async () => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();
    const webhook = { secret: 'w'.repeat(32), revocations };
    const app = gateway(
      new MemoryGatewayAdapter('github'),
      new MemoryGatewayAdapter('mega'),
      webhook,
    );
    const payload = JSON.stringify({ padding: 'x'.repeat(256 * 1024) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/github/webhook',
      headers: webhookHeaders(webhook.secret, payload, 'delivery-large'),
      payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('uses scoped HttpOnly same-site cookies for provider sessions', async () => {
    const app = gateway();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/github/session',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: true });
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(response.headers['set-cookie']).toContain('Path=/api/sync/github');
    await app.close();
  });

  it('exposes a no-store selected-destination revision for capable providers', async () => {
    const app = gateway();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/github/revision',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ revision: 'github:revision:0' });
    await app.close();
  });

  it('reports an unconfigured provider before authorization starts', async () => {
    const app = gateway(new UnconfiguredSyncGatewayAdapter('GitHub/Git LFS'));

    const session = await app.inject({
      method: 'GET',
      url: '/api/sync/github/session',
    });
    const authorization = await app.inject({
      method: 'GET',
      url: '/api/sync/github/auth/start?returnTo=%2Fsettings%2Fsync',
    });

    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({
      configured: false,
      authenticated: false,
    });
    expect(authorization.statusCode).toBe(503);
    expect(authorization.json()).toEqual({
      message: 'GitHub/Git LFS synchronization is not configured',
    });
    await app.close();
  });

  it('returns a bounded Retry-After header for provider rate limits', async () => {
    const github = new MemoryGatewayAdapter('github');
    vi.spyOn(github, 'destinations').mockRejectedValue(
      new GatewayHttpError(
        429,
        'GitHub is temporarily rate limiting synchronization',
        120,
      ),
    );
    const app = gateway(github);

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/github/repositories',
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('120');
    expect(response.json()).toEqual({
      message: 'GitHub is temporarily rate limiting synchronization',
    });
    await app.close();
  });

  it('rotates the provider session after an authorization callback', async () => {
    const app = gateway();
    const start = await app.inject({
      method: 'GET',
      url: '/api/sync/github/auth/start?returnTo=%2Fsettings%2Fsync',
    });
    const originalCookie = start.cookies[0];

    const callback = await app.inject({
      method: 'GET',
      url: '/api/sync/github/auth/callback?code=test&state=test',
      cookies: { [originalCookie.name]: originalCookie.value },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/settings/sync');
    expect(callback.cookies[0].value).not.toBe(originalCookie.value);
    await app.close();
  });

  it('returns a denied GitHub authorization to Settings without exposing provider details', async () => {
    const app = gateway();
    const start = await app.inject({
      method: 'GET',
      url: '/api/sync/github/auth/start?returnTo=%2Fsettings%2Fsync',
    });
    const originalCookie = start.cookies[0];

    const callback = await app.inject({
      method: 'GET',
      url:
        '/api/sync/github/auth/callback?error=access_denied' +
        '&error_description=Sensitive+provider+detail&state=test',
      cookies: { [originalCookie.name]: originalCookie.value },
    });

    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe(
      '/settings/sync?syncAuth=github-denied',
    );
    expect(callback.headers.location).not.toContain('Sensitive');
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(callback.headers['set-cookie']).toContain(
      `${originalCookie.name}=;`,
    );
    await app.close();
  });

  it.each([
    {
      callbackQuery: 'code=test&state=invalid',
      outcome: 'github-invalid',
    },
    {
      callbackQuery: 'error=provider_failure&state=test',
      outcome: 'github-failed',
    },
  ])(
    'returns a $outcome authorization result to Settings',
    async ({ callbackQuery, outcome }) => {
      const app = gateway();
      const start = await app.inject({
        method: 'GET',
        url: '/api/sync/github/auth/start?returnTo=%2Fsettings%2Fsync',
      });
      const originalCookie = start.cookies[0];

      const callback = await app.inject({
        method: 'GET',
        url: `/api/sync/github/auth/callback?${callbackQuery}`,
        cookies: { [originalCookie.name]: originalCookie.value },
      });

      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe(
        `/settings/sync?syncAuth=${outcome}`,
      );
      await app.close();
    },
  );

  it('creates a provider destination through a same-origin mutation', async () => {
    const github = new CreatingMemoryAdapter();
    const app = gateway(github);

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/github/repository',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': 'application/json',
      },
      payload: { name: 'omnia-reader-library' },
    });

    expect(response.statusCode).toBe(200);
    expect(github.createdRequest).toEqual({ name: 'omnia-reader-library' });
    expect(response.json()).toMatchObject({
      repository: { fullName: 'reader/omnia-reader-library' },
      selected: true,
    });
    await app.close();
  });

  it('keeps provider JSON parsing isolated from the raw webhook parser', async () => {
    const github = new CreatingMemoryAdapter();
    const app = gateway(github, new MemoryGatewayAdapter('mega'), {
      secret: 'w'.repeat(32),
      revocations: new MemoryGitHubAuthorizationRevocationStore(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/github/repository',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': 'application/json',
      },
      payload: { name: 'omnia-reader-library' },
    });

    expect(response.statusCode).toBe(200);
    expect(github.createdRequest).toEqual({ name: 'omnia-reader-library' });
    await app.close();
  });

  it('serves a no-store MEGA credential page and rotates the session after login', async () => {
    const mega = new CredentialMemoryAdapter();
    const app = gateway(new MemoryGatewayAdapter('github'), mega);
    const start = await app.inject({
      method: 'GET',
      url: '/api/sync/mega/auth/start?returnTo=%2Fsettings%2Fsync',
    });
    const originalCookie = start.cookies[0];
    expect(start.headers.location).toBe(
      '/api/sync/mega/auth/login?state=mega-state',
    );

    const page = await app.inject({
      method: 'GET',
      url: start.headers.location as string,
      cookies: { [originalCookie.name]: originalCookie.value },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(page.body).toContain('Connect MEGA');
    expect(page.body).not.toContain('sdk-session');

    const login = await app.inject({
      method: 'POST',
      url: '/api/sync/mega/auth/login',
      headers: {
        host: HOST,
        origin: `http://${HOST}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      cookies: { [originalCookie.name]: originalCookie.value },
      payload:
        'state=mega-state&email=reader%40example.com&password=secret&multiFactorCode=123456',
    });
    expect(login.statusCode).toBe(303);
    expect(login.headers.location).toBe('/settings/sync');
    expect(login.cookies[0].value).not.toBe(originalCookie.value);
    expect(mega.completedParameters).toEqual({
      state: 'mega-state',
      email: 'reader@example.com',
      password: 'secret',
      multiFactorCode: '123456',
    });
    await app.close();
  });

  it('rejects mutating requests without same-origin CSRF evidence', async () => {
    const app = gateway();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/sync/mega/document',
      headers: { 'content-type': 'application/json' },
      payload: documentWrite(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      message: 'Missing synchronization CSRF header',
    });
    await app.close();
  });

  it('rejects cross-origin mutations even with the CSRF marker', async () => {
    const app = gateway();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/sync/mega/document',
      headers: {
        ...MUTATION_HEADERS,
        origin: 'https://attacker.invalid',
        'content-type': 'application/json',
      },
      payload: documentWrite(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      message: 'Cross-origin requests are not allowed',
    });
    await app.close();
  });

  it('rejects paths that escape the versioned synchronization root', async () => {
    const app = gateway();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/github/file?path=.omnia-reader/v1/../secret',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Invalid synchronization path',
    });
    await app.close();
  });

  it('accepts encoded IDs while rejecting encoded path separators', async () => {
    const app = gateway();
    const encodedBookPath = `.omnia-reader/v1/books/sha256%3A${'a'.repeat(64)}/book.json`;

    const safeResponse = await app.inject({
      method: 'GET',
      url: `/api/sync/github/file?path=${encodeURIComponent(encodedBookPath)}`,
    });
    expect(safeResponse.statusCode).toBe(404);

    for (const unsafeSegment of ['book%2Fsecret', 'book%252Fsecret']) {
      const unsafePath = `.omnia-reader/v1/books/${unsafeSegment}/book.json`;
      const response = await app.inject({
        method: 'GET',
        url: `/api/sync/github/file?path=${encodeURIComponent(unsafePath)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        message: 'Invalid synchronization path',
      });
    }
    await app.close();
  });

  it('round-trips bookmark tombstones through both provider document routes', async () => {
    const github = new MemoryGatewayAdapter('github');
    const mega = new MemoryGatewayAdapter('mega');
    const app = gateway(github, mega);
    const write = documentWrite();

    for (const provider of ['github', 'mega'] as const) {
      const documentName = provider === 'github' ? 'file' : 'document';
      const writeResponse = await app.inject({
        method: 'PUT',
        url: `/api/sync/${provider}/${documentName}`,
        headers: {
          ...MUTATION_HEADERS,
          'content-type': 'application/json',
        },
        payload: write,
      });
      expect(writeResponse.statusCode).toBe(200);

      const readResponse = await app.inject({
        method: 'GET',
        url: `/api/sync/${provider}/${documentName}?path=${encodeURIComponent(write.path)}`,
      });
      expect(readResponse.statusCode).toBe(200);
      expect(readResponse.json()).toMatchObject({
        path: write.path,
        content: write.content,
      });

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url:
          `/api/sync/${provider}/${documentName}` +
          `?path=${encodeURIComponent(write.path)}` +
          `&expectedRevision=${encodeURIComponent(writeResponse.json().revision)}` +
          '&message=Delete+bookmark',
        headers: MUTATION_HEADERS,
      });
      expect(deleteResponse.statusCode).toBe(204);
      const missingResponse = await app.inject({
        method: 'GET',
        url: `/api/sync/${provider}/${documentName}?path=${encodeURIComponent(write.path)}`,
      });
      expect(missingResponse.statusCode).toBe(404);
      const optionalMissingResponse = await app.inject({
        method: 'GET',
        url:
          `/api/sync/${provider}/${documentName}` +
          `?path=${encodeURIComponent(write.path)}&optional=true`,
      });
      expect(optionalMissingResponse.statusCode).toBe(204);
      expect(optionalMissingResponse.headers['cache-control']).toBe('no-store');
    }
    await app.close();
  });

  it('returns quiet cache-disabled absence for optional object probes', async () => {
    const app = gateway();

    for (const [provider, objectPath] of [
      ['github', 'lfs/object'],
      ['mega', 'object'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url:
          `/api/sync/${provider}/${objectPath}/metadata` +
          '?path=.omnia-reader%2Fv1%2Flibrary%2Fmissing.epub&optional=true',
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    await app.close();
  });

  it('rejects malformed optional lookup markers', async () => {
    const app = gateway();

    const response = await app.inject({
      method: 'GET',
      url:
        '/api/sync/github/file' +
        '?path=.omnia-reader%2Fv1%2Fmanifest.json&optional=maybe',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Invalid optional lookup marker',
    });
    await app.close();
  });

  it('streams and verifies an immutable publication object', async () => {
    const github = new MemoryGatewayAdapter('github');
    const app = gateway(github, new MemoryGatewayAdapter('mega'));
    const content = Buffer.from('%PDF-1.7\nOmnia\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    const upload = await app.inject({
      method: 'PUT',
      url: `/api/sync/github/lfs/object?path=${encodeURIComponent(path)}`,
      headers: {
        ...MUTATION_HEADERS,
        'content-type': 'application/pdf',
        'x-omnia-sha256': sha256,
        'x-omnia-size': String(content.byteLength),
      },
      payload: content,
    });

    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({
      path,
      size: content.byteLength,
      sha256,
    });

    const download = await app.inject({
      method: 'GET',
      url: `/api/sync/github/lfs/object?path=${encodeURIComponent(path)}`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.rawPayload).toEqual(content);
    await app.close();
  });

  it('requires same-origin evidence and revision-deletes publication objects', async () => {
    const github = new MemoryGatewayAdapter('github');
    const app = gateway(github, new MemoryGatewayAdapter('mega'));
    const content = Buffer.from('%PDF-1.7\nDelete route\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;
    const metadata = await github.uploadObject('session', {
      path,
      content: Readable.from(content),
      mediaType: 'application/pdf',
      size: content.byteLength,
      sha256,
    });

    const rejected = await app.inject({
      method: 'DELETE',
      url: `/api/sync/github/lfs/object?path=${encodeURIComponent(path)}`,
    });
    expect(rejected.statusCode).toBe(403);

    const deleted = await app.inject({
      method: 'DELETE',
      url:
        `/api/sync/github/lfs/object?path=${encodeURIComponent(path)}` +
        `&expectedRevision=${metadata.revision}`,
      headers: MUTATION_HEADERS,
    });
    expect(deleted.statusCode).toBe(204);
    await expect(github.headObject('session', path)).resolves.toBeNull();
    await app.close();
  });

  it('rejects publication media types that do not match their object path', async () => {
    const app = gateway();
    const content = Buffer.from('book');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.epub`;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/sync/mega/object?path=${encodeURIComponent(path)}`,
      headers: {
        ...MUTATION_HEADERS,
        'content-type': 'application/pdf',
        'x-omnia-sha256': sha256,
        'x-omnia-size': String(content.byteLength),
      },
      payload: content,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Publication path and media type do not match',
    });
    await app.close();
  });
});

function gateway(
  github = new MemoryGatewayAdapter('github'),
  mega = new MemoryGatewayAdapter('mega'),
  githubWebhook?: GitHubWebhookOptions,
) {
  return buildSyncGateway({
    github,
    mega,
    ...(githubWebhook ? { githubWebhook } : {}),
    secureCookies: false,
    maxPublicationBytes: 1024 * 1024,
  });
}

function webhookHeaders(
  secret: string,
  payload: string,
  deliveryId: string,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-github-delivery': deliveryId,
    'x-github-event': 'github_app_authorization',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex')}`,
  };
}

function documentWrite(): DocumentWriteRequest {
  return {
    path: '.omnia-reader/v1/bookmarks/book/bookmark.json',
    content: JSON.stringify({
      schemaVersion: 1,
      id: 'bookmark',
      deletedAt: '2026-07-25T10:00:00.000Z',
      updatedAt: '2026-07-25T10:00:00.000Z',
    }),
    message: 'Sync bookmark tombstone',
  };
}

class MemoryGatewayAdapter implements SyncGatewayAdapter {
  private readonly documents = new Map<string, RemoteDocument>();
  private readonly objects = new Map<
    string,
    {
      metadata: RemoteObject;
      mediaType: RemoteObjectUpload['mediaType'];
      content: Buffer;
    }
  >();
  private revision = 0;

  constructor(private readonly kind: SyncProviderKind) {}

  async session(): Promise<unknown> {
    return this.kind === 'github'
      ? {
          configured: true,
          authenticated: true,
          installationUrl:
            'https://github.test/apps/omnia-reader/installations/new',
          user: { login: 'reader', name: 'Reader', avatarUrl: null },
          repository: null,
        }
      : { authenticated: true, account: 'reader', folder: null };
  }

  async authorizationUrl(sessionId: string, returnTo: string): Promise<string> {
    void sessionId;
    return `https://provider.invalid/authorize?returnTo=${encodeURIComponent(returnTo)}`;
  }

  async completeAuthorization(
    sessionId: string,
    replacementSessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<string> {
    void sessionId;
    void replacementSessionId;
    if (parameters['error'] === 'access_denied') {
      throw new AuthorizationHttpError(
        401,
        'GitHub authorization was not granted',
        'denied',
      );
    }
    if (parameters['error']) {
      throw new GatewayHttpError(502, 'Provider authorization failed');
    }
    if (parameters['state'] === 'invalid') {
      throw new AuthorizationHttpError(
        400,
        'Authorization state is invalid',
        'invalid',
      );
    }
    return '/settings/sync';
  }

  async disconnect(sessionId: string): Promise<void> {
    void sessionId;
  }

  async destinations(sessionId: string): Promise<readonly unknown[]> {
    void sessionId;
    return [];
  }

  async selectDestination(
    sessionId: string,
    selection: unknown,
  ): Promise<unknown> {
    void sessionId;
    void selection;
    return this.session();
  }

  async destinationRevision(sessionId: string): Promise<string> {
    void sessionId;
    return `${this.kind}:revision:${this.revision}`;
  }

  async listDocuments(
    sessionId: string,
    prefix: string,
  ): Promise<readonly RemoteDocument[]> {
    void sessionId;
    return [...this.documents.values()].filter((document) =>
      document.path.startsWith(prefix),
    );
  }

  async readDocument(
    sessionId: string,
    path: string,
  ): Promise<RemoteDocument | null> {
    void sessionId;
    return this.documents.get(path) ?? null;
  }

  async writeDocument(
    sessionId: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument> {
    void sessionId;
    const current = this.documents.get(request.path);
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current?.revision
    ) {
      throw new GatewayHttpError(409, 'Remote document changed');
    }
    const document = {
      path: request.path,
      content: request.content,
      revision: String(++this.revision),
    };
    this.documents.set(request.path, document);
    return document;
  }

  async deleteDocument(
    sessionId: string,
    request: DocumentDeleteRequest,
  ): Promise<void> {
    void sessionId;
    const current = this.documents.get(request.path);
    if (
      current &&
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    ) {
      throw new GatewayHttpError(409, 'Remote document changed');
    }
    this.documents.delete(request.path);
  }

  async headObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObject | null> {
    void sessionId;
    return this.objects.get(path)?.metadata ?? null;
  }

  async downloadObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObjectDownload | null> {
    void sessionId;
    const object = this.objects.get(path);
    return object
      ? {
          metadata: object.metadata,
          mediaType: object.mediaType,
          content: Readable.from(object.content),
        }
      : null;
  }

  async uploadObject(
    sessionId: string,
    upload: RemoteObjectUpload,
  ): Promise<RemoteObject> {
    void sessionId;
    const chunks: Buffer[] = [];
    for await (const chunk of upload.content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks);
    const digest = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== upload.size || digest !== upload.sha256) {
      throw new GatewayHttpError(400, 'Publication integrity check failed');
    }
    const metadata = {
      path: upload.path,
      revision: String(++this.revision),
      size: upload.size,
      sha256: upload.sha256,
    };
    this.objects.set(upload.path, {
      metadata,
      mediaType: upload.mediaType,
      content,
    });
    return metadata;
  }

  async deleteObject(
    sessionId: string,
    request: RemoteObjectDelete,
  ): Promise<void> {
    void sessionId;
    const current = this.objects.get(request.path);
    if (
      current &&
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.metadata.revision
    ) {
      throw new GatewayHttpError(409, 'Remote object changed');
    }
    this.objects.delete(request.path);
  }
}

class CredentialMemoryAdapter
  extends MemoryGatewayAdapter
  implements CredentialSyncGatewayAdapter
{
  completedParameters: Readonly<Record<string, string>> | null = null;

  constructor() {
    super('mega');
  }

  override async authorizationUrl(): Promise<string> {
    return '/api/sync/mega/auth/login?state=mega-state';
  }

  async credentialAuthorizationPage(
    sessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<CredentialAuthorizationPage> {
    void sessionId;
    if (parameters['state'] !== 'mega-state') {
      throw new GatewayHttpError(400, 'invalid state');
    }
    return {
      provider: 'MEGA',
      state: 'mega-state',
      accountLabel: 'MEGA account email',
      passwordLabel: 'MEGA account password',
      supportsMultiFactorCode: true,
    };
  }

  override async completeAuthorization(
    sessionId: string,
    replacementSessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<string> {
    void sessionId;
    void replacementSessionId;
    this.completedParameters = parameters;
    return '/settings/sync';
  }
}

class CreatingMemoryAdapter
  extends MemoryGatewayAdapter
  implements DestinationCreatingSyncGatewayAdapter
{
  createdRequest: unknown;

  constructor() {
    super('github');
  }

  async createDestination(
    sessionId: string,
    request: unknown,
  ): Promise<unknown> {
    void sessionId;
    this.createdRequest = request;
    return {
      repository: {
        id: 7,
        fullName: 'reader/omnia-reader-library',
        private: true,
        defaultBranch: 'main',
        canPush: true,
      },
      selected: true,
      session: await this.session(),
      installationSettingsUrl: null,
    };
  }
}
