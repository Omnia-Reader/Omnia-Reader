import { createHash, generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GitHubSyncGatewayAdapter,
  type GitHubSessionState,
} from './github-adapter.js';
import {
  AuthorizationHttpError,
  GatewayHttpError,
} from './gateway-contract.js';
import {
  MemoryGitHubAuthorizationRevocationStore,
  type GitHubAuthorizationRevocationStore,
} from './github-authorization-revocations.js';
import { EncryptedMemorySessionStore } from './session-store.js';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
let testAdapterSequence = 0;
const PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
}).privateKey;

describe('GitHubSyncGatewayAdapter', () => {
  it('authenticates, rotates the session, and scopes repository selection', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);

    await expect(adapter.session('missing-session')).resolves.toEqual({
      configured: true,
      authenticated: false,
      installationUrl:
        'https://github.test/apps/omnia-reader/installations/new',
    });

    const authorizationUrl = await adapter.authorizationUrl(
      'old-session',
      '/settings/sync',
    );
    expect(authorizationUrl).toContain(
      'https://github.test/login/oauth/authorize',
    );
    const authorization = new URL(authorizationUrl);
    expect(authorization.searchParams.get('state')).toBe('fixed-state');
    expect(authorization.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update('v'.repeat(43), 'ascii').digest('base64url'),
    );

    await expect(
      adapter.completeAuthorization('old-session', 'new-session', {
        code: 'oauth-code',
        state: 'fixed-state',
      }),
    ).resolves.toBe('/settings/sync');
    await expect(sessions.get('old-session')).resolves.toBeNull();
    await expect(adapter.session('new-session')).resolves.toEqual({
      configured: true,
      authenticated: true,
      installationUrl:
        'https://github.test/apps/omnia-reader/installations/new',
      user: {
        id: 42,
        login: 'reader',
        avatarUrl: 'https://avatars.test/reader',
      },
      repository: null,
    });

    await expect(adapter.destinations('new-session')).resolves.toEqual([
      {
        id: 99,
        fullName: 'reader/library',
        private: true,
        defaultBranch: 'main',
        canPush: true,
      },
    ]);
    await expect(
      adapter.selectDestination('new-session', { repositoryId: 99 }),
    ).resolves.toMatchObject({
      configured: true,
      authenticated: true,
      repository: { id: 99, fullName: 'reader/library' },
    });
  });

  it('rotates an expiring user token once across concurrent requests', async () => {
    let now = NOW;
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider, { now: () => now });
    await authorize(adapter);
    now += (28_800 - 60) * 1000;

    await Promise.all([
      adapter.session('session'),
      adapter.destinations('session'),
    ]);

    expect(provider.refreshRequests).toEqual(['refresh-token']);
    expect(provider.userAccessTokens).toContain('Bearer refreshed-user-token');
    await expect(sessions.get('session')).resolves.toMatchObject({
      userAccessToken: 'refreshed-user-token',
      userTokenExpiresAt: now + 28_800 * 1000,
      refreshToken: 'rotated-refresh-token',
      refreshTokenExpiresAt: now + 15_897_600 * 1000,
    });
  });

  it('does not restore a session disconnected during token refresh', async () => {
    let now = NOW;
    let releaseRefresh = (): void => undefined;
    const refreshWait = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const provider = new FakeGitHub();
    provider.refreshWait = refreshWait;
    const { adapter, sessions } = testAdapter(provider, { now: () => now });
    await authorize(adapter);
    now += (28_800 - 60) * 1000;

    const sessionRequest = adapter.session('session');
    await provider.refreshStarted;
    await adapter.disconnect('session');
    releaseRefresh();

    await expect(sessionRequest).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(sessions.get('session')).resolves.toBeNull();
    expect(provider.revokedUserAccessTokens).toEqual([
      'user-token',
      'refreshed-user-token',
    ]);
  });

  it('does not restore a session revoked by a webhook during token refresh', async () => {
    let now = NOW;
    let releaseRefresh = (): void => undefined;
    const refreshWait = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const provider = new FakeGitHub();
    provider.refreshWait = refreshWait;
    const { adapter, revocations, sessions } = testAdapter(provider, {
      now: () => now,
    });
    await authorize(adapter);
    now += (28_800 - 60) * 1000;

    const sessionRequest = adapter.session('session');
    await provider.refreshStarted;
    await revocations.revoke(42, 'delivery-refresh');
    releaseRefresh();

    await expect(sessionRequest).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(sessions.get('session')).resolves.toBeNull();
    expect(provider.revokedUserAccessTokens).toEqual(['refreshed-user-token']);
  });

  it('revokes only the current GitHub user token when disconnecting', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);
    await authorize(adapter);

    await expect(adapter.disconnect('session')).resolves.toBeUndefined();

    await expect(sessions.get('session')).resolves.toBeNull();
    expect(provider.revokedUserAccessTokens).toEqual(['user-token']);
    expect(provider.revocationAuthorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
  });

  it('keeps disconnect locally authoritative when GitHub token revocation fails', async () => {
    const provider = new FakeGitHub();
    provider.revocationOutcome = 'unavailable';
    const onUserTokenRevocationFailure = vi.fn();
    const { adapter, sessions } = testAdapter(provider, {
      onUserTokenRevocationFailure,
    });
    await authorize(adapter);

    await expect(adapter.disconnect('session')).resolves.toBeUndefined();

    await expect(sessions.get('session')).resolves.toBeNull();
    expect(provider.revokedUserAccessTokens).toEqual(['user-token']);
    expect(onUserTokenRevocationFailure).toHaveBeenCalledOnce();
  });

  it('treats an already-revoked GitHub user token as disconnected', async () => {
    const provider = new FakeGitHub();
    provider.revocationOutcome = 'missing';
    const onUserTokenRevocationFailure = vi.fn();
    const { adapter, sessions } = testAdapter(provider, {
      onUserTokenRevocationFailure,
    });
    await authorize(adapter);

    await expect(adapter.disconnect('session')).resolves.toBeUndefined();

    await expect(sessions.get('session')).resolves.toBeNull();
    expect(provider.revokedUserAccessTokens).toEqual(['user-token']);
    expect(onUserTokenRevocationFailure).not.toHaveBeenCalled();
  });

  it('consumes a rejected refresh token and does not retry it', async () => {
    let now = NOW;
    const provider = new FakeGitHub();
    provider.refreshOutcome = 'bad-token';
    const { adapter, sessions } = testAdapter(provider, { now: () => now });
    await authorize(adapter);
    now += (28_800 - 60) * 1000;

    await expect(adapter.session('session')).resolves.toEqual({
      configured: true,
      authenticated: false,
      installationUrl:
        'https://github.test/apps/omnia-reader/installations/new',
    });
    await expect(sessions.get('session')).resolves.toBeNull();
    await expect(adapter.session('session')).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(adapter.destinations('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 401,
      message: 'GitHub authentication is required',
    });
    expect(provider.refreshRequests).toEqual(['refresh-token']);
  });

  it('expires a session locally when its refresh token lifetime has elapsed', async () => {
    let now = NOW;
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider, { now: () => now });
    await authorize(adapter);
    now += 15_897_600 * 1000 + 1;

    await expect(adapter.session('session')).resolves.toMatchObject({
      configured: true,
      authenticated: false,
    });
    await expect(sessions.get('session')).resolves.toBeNull();
    expect(provider.refreshRequests).toEqual([]);
  });

  it('retains the session after a malformed refresh response', async () => {
    let now = NOW;
    const provider = new FakeGitHub();
    provider.refreshOutcome = 'malformed';
    const { adapter, sessions } = testAdapter(provider, { now: () => now });
    await authorize(adapter);
    now += (28_800 - 60) * 1000;

    await expect(adapter.session('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 502,
      message: 'GitHub returned an invalid token refresh',
    });
    await expect(sessions.get('session')).resolves.toMatchObject({
      userAccessToken: 'user-token',
      refreshToken: 'refresh-token',
    });
    expect(provider.refreshRequests).toEqual(['refresh-token']);
  });

  it('retains the session when token refresh is temporarily unavailable', async () => {
    let now = NOW;
    const provider = new FakeGitHub();
    provider.refreshOutcome = 'unavailable';
    const { adapter, sessions } = testAdapter(provider, { now: () => now });
    await authorize(adapter);
    now += (28_800 - 60) * 1000;

    await expect(adapter.session('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 502,
    });
    await expect(sessions.get('session')).resolves.toMatchObject({
      userAccessToken: 'user-token',
      refreshToken: 'refresh-token',
    });
    expect(provider.refreshRequests).toEqual(['refresh-token']);
  });

  it('consumes a user session after GitHub revokes its authorization', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);
    await authorize(adapter);
    provider.userAuthorizationRevoked = true;

    await expect(adapter.destinations('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 401,
      message: 'GitHub authorization has expired',
    });
    await expect(sessions.get('session')).resolves.toBeNull();
    await expect(adapter.destinations('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 401,
      message: 'GitHub authentication is required',
    });
    expect(provider.userInstallationRequests).toBe(1);
  });

  it('consumes every session for a webhook-revoked GitHub user', async () => {
    const provider = new FakeGitHub();
    const { adapter, revocations, sessions } = testAdapter(provider);
    await authorizeSession(adapter, 'pending-a', 'session-a');
    await authorizeSession(adapter, 'pending-b', 'session-b');

    await revocations.revoke(42, 'delivery-revoked');

    await expect(adapter.session('session-a')).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(adapter.destinations('session-b')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 401,
      message: 'GitHub authorization has been revoked',
    });
    await expect(sessions.get('session-a')).resolves.toBeNull();
    await expect(sessions.get('session-b')).resolves.toBeNull();
    expect(provider.userInstallationRequests).toBe(0);
  });

  it('accepts a new authorization after an earlier grant was revoked', async () => {
    const provider = new FakeGitHub();
    const { adapter, revocations } = testAdapter(provider);
    await authorizeSession(adapter, 'pending-old', 'session-old');
    await revocations.revoke(42, 'delivery-old');

    await authorizeSession(adapter, 'pending-new', 'session-new');

    await expect(adapter.destinations('session-new')).resolves.toHaveLength(1);
    await expect(adapter.session('session-new')).resolves.toMatchObject({
      authenticated: true,
      user: { id: 42 },
    });
  });

  it('consumes a denied authorization without trusting provider error text', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);
    await adapter.authorizationUrl('pending', '/settings/sync');

    await expect(
      adapter.completeAuthorization('pending', 'replacement', {
        error: 'access_denied',
        error_description: 'Provider-controlled detail',
        state: 'fixed-state',
      }),
    ).rejects.toMatchObject<Partial<AuthorizationHttpError>>({
      statusCode: 401,
      outcome: 'denied',
      message: 'GitHub authorization was not granted',
    });
    await expect(sessions.get('pending')).resolves.toBeNull();
    await expect(sessions.get('replacement')).resolves.toBeNull();
    expect(provider.events).toEqual([]);
  });

  it('rejects an untrusted authorization state without contacting GitHub', async () => {
    const provider = new FakeGitHub();
    const { adapter } = testAdapter(provider);
    await adapter.authorizationUrl('pending', '/settings/sync');

    await expect(
      adapter.completeAuthorization('pending', 'replacement', {
        code: 'oauth-code',
        state: 'untrusted-state',
      }),
    ).rejects.toMatchObject<Partial<AuthorizationHttpError>>({
      statusCode: 400,
      outcome: 'invalid',
    });
    expect(provider.events).toEqual([]);
  });

  it('rejects a callback when its encrypted PKCE verifier is unavailable', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);
    await adapter.authorizationUrl('pending', '/settings/sync');
    await sessions.set('pending', {
      authorizationState: 'fixed-state',
      returnTo: '/settings/sync',
    });

    await expect(
      adapter.completeAuthorization('pending', 'replacement', {
        code: 'oauth-code',
        state: 'fixed-state',
      }),
    ).rejects.toMatchObject<Partial<AuthorizationHttpError>>({
      statusCode: 400,
      outcome: 'invalid',
      message: 'GitHub authorization verifier is missing',
    });
    await expect(sessions.get('pending')).resolves.toBeNull();
    expect(provider.events).toEqual([]);
  });

  it('creates, discovers, and selects a private repository', async () => {
    const provider = new FakeGitHub();
    const { adapter } = testAdapter(provider);
    await authorize(adapter);

    await expect(
      adapter.createDestination('session', {
        name: 'omnia-reader-library',
      }),
    ).resolves.toMatchObject({
      repository: {
        id: 100,
        fullName: 'reader/omnia-reader-library',
        private: true,
      },
      selected: true,
      session: {
        configured: true,
        authenticated: true,
        repository: { id: 100 },
      },
      installationSettingsUrl: null,
    });
    expect(provider.createdRepositories).toEqual(['omnia-reader-library']);
  });

  it('preserves a repository-creation permission denial as a 403', async () => {
    const provider = new FakeGitHub();
    provider.forbidRepositoryCreation = true;
    const { adapter } = testAdapter(provider);
    await authorize(adapter);

    await expect(
      adapter.createDestination('session', {
        name: 'omnia-reader-library',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 403,
    });
    expect(provider.createdRepositories).toEqual([]);
  });

  it('maps GitHub rate limits to a safe retryable gateway error', async () => {
    const provider = new FakeGitHub();
    provider.userInstallationRateLimit = {
      status: 403,
      resetAt: Math.floor(NOW / 1000) + 300,
    };
    const { adapter, sessions } = testAdapter(provider);
    await authorize(adapter);

    await expect(adapter.destinations('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 429,
      retryAfterSeconds: 300,
      message: 'GitHub is temporarily rate limiting synchronization',
    });
    await expect(sessions.get('session')).resolves.toMatchObject({
      userAccessToken: 'user-token',
    });
  });

  it('retries a transient safe repository-discovery request', async () => {
    const provider = new FakeGitHub();
    provider.userInstallationTransientFailures = 1;
    const { adapter } = testAdapter(provider);
    await authorize(adapter);

    await expect(adapter.destinations('session')).resolves.toEqual([
      expect.objectContaining({ id: 99, fullName: 'reader/library' }),
    ]);
    expect(provider.userInstallationRequests).toBe(2);
  });

  it('bounds and retries a stalled safe GitHub REST response body', async () => {
    const provider = new FakeGitHub();
    let installationRequests = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (new URL(String(input)).pathname === '/user/installations') {
        installationRequests += 1;
        return stalledJsonResponse(init.signal);
      }
      return provider.fetch(input, init);
    };
    const { adapter } = testAdapter(provider, {
      fetcher,
      requestTimeoutMs: 10,
    });
    await authorize(adapter);

    await expect(adapter.destinations('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 504,
      message: 'GitHub provider request timed out',
    });
    expect(installationRequests).toBe(2);
  });

  it('uses provider throttling once before returning repository destinations', async () => {
    const provider = new FakeGitHub();
    provider.userInstallationRateLimit = {
      status: 429,
      retryAfterSeconds: 1,
      primary: false,
    };
    provider.userInstallationRateLimitFailures = 1;
    const { adapter } = testAdapter(provider);
    await authorize(adapter);

    await expect(adapter.destinations('session')).resolves.toEqual([
      expect.objectContaining({ id: 99, fullName: 'reader/library' }),
    ]);
    expect(provider.userInstallationRequests).toBe(2);
  });

  it('rejects an off-origin pagination link before forwarding user authorization', async () => {
    const provider = new FakeGitHub();
    provider.userInstallationNextLink =
      'https://untrusted.test/user/installations?page=2';
    const { adapter } = testAdapter(provider);
    await authorize(adapter);

    await expect(adapter.destinations('session')).rejects.toMatchObject<
      Partial<GatewayHttpError>
    >({
      statusCode: 502,
      message: 'GitHub returned an invalid synchronization response',
    });
    expect(provider.untrustedRequests).toBe(0);
  });

  it('does not replay repository creation after an ambiguous provider failure', async () => {
    const provider = new FakeGitHub();
    provider.repositoryCreationOutcome = 'applied-unavailable';
    const { adapter } = testAdapter(provider);
    await authorize(adapter);

    await expect(
      adapter.createDestination('session', {
        name: 'omnia-reader-library',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({ statusCode: 502 });
    expect(provider.repositoryCreationRequests).toBe(1);
    expect(provider.createdRepositories).toEqual(['omnia-reader-library']);
  });

  it('does not replay a document write after an ambiguous provider failure', async () => {
    const provider = new FakeGitHub();
    const { adapter } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    provider.contentMutationOutcome = 'applied-unavailable';
    const path = '.omnia-reader/v1/progress/book/device.json';

    await expect(
      adapter.writeDocument('session', {
        path,
        content: '{"progress":0.5}',
        message: 'Sync progress',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({ statusCode: 502 });
    expect(provider.contentMutationRequests).toBe(1);
    expect(provider.files.get(path)?.content).toBe('{"progress":0.5}');
  });

  it('directs the user to grant installation access when a new repository is not visible', async () => {
    const provider = new FakeGitHub();
    provider.exposeCreatedRepositoryToInstallation = false;
    const { adapter } = testAdapter(provider);
    await authorize(adapter);

    await expect(
      adapter.createDestination('session', {
        name: 'omnia-reader-library',
      }),
    ).resolves.toMatchObject({
      repository: { fullName: 'reader/omnia-reader-library' },
      selected: false,
      session: { configured: true, authenticated: true, repository: null },
      installationSettingsUrl:
        'https://github.test/apps/omnia-reader/installations/new',
    });
  });

  it('clears a selected repository after installation access is removed', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    provider.installationTokenOutcome = 'missing';

    await expect(
      adapter.readDocument('session', '.omnia-reader/v1/manifest.json'),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 403,
      message: 'The GitHub App no longer has access to the selected repository',
    });
    const state = await sessions.get('session');
    expect(state).toMatchObject({
      userAccessToken: 'user-token',
    });
    expect(state?.repository).toBeUndefined();
    expect(state?.installationAccessToken).toBeUndefined();
    expect(state?.installationTokenExpiresAt).toBeUndefined();
  });

  it('retains repository selection when App authentication fails', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    provider.installationTokenOutcome = 'unauthorized';

    await expect(
      adapter.readDocument('session', '.omnia-reader/v1/manifest.json'),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 502,
      message: 'GitHub App installation authentication failed',
    });
    await expect(sessions.get('session')).resolves.toMatchObject({
      repository: { id: 99 },
    });
  });

  it('commits and lists JSON documents using optimistic blob revisions', async () => {
    const provider = new FakeGitHub();
    const { adapter } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    const path = '.omnia-reader/v1/progress/book/device.json';

    const created = await adapter.writeDocument('session', {
      path,
      content: '{"progress":0.5}',
      message: 'Sync progress',
    });
    expect(created.revision).toMatch(/^[a-f0-9]{40}$/);
    await expect(adapter.readDocument('session', path)).resolves.toEqual(
      created,
    );
    await expect(
      adapter.listDocuments('session', '.omnia-reader/v1/progress'),
    ).resolves.toEqual([created]);

    await expect(
      adapter.writeDocument('session', {
        path,
        content: '{"progress":0.8}',
        expectedRevision: '0'.repeat(40),
        message: 'Stale progress',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({ statusCode: 409 });

    await expect(
      adapter.deleteDocument('session', {
        path,
        expectedRevision: created.revision,
        message: 'Delete progress',
      }),
    ).resolves.toBeUndefined();
    await expect(adapter.readDocument('session', path)).resolves.toBeNull();
  });

  it.each([404, 409])(
    'treats GitHub tree status %s as an empty document set',
    async (status) => {
      const provider = new FakeGitHub();
      provider.treeStatus = status as 404 | 409;
      const { adapter } = testAdapter(provider);
      await authorizeAndSelect(adapter);

      await expect(
        adapter.listDocuments('session', '.omnia-reader/v1/books'),
      ).resolves.toEqual([]);
    },
  );

  it('uploads verified LFS bytes before publishing the pointer and downloads them', async () => {
    const provider = new FakeGitHub();
    const { adapter } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7\nGit LFS fixture\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    const uploaded = await adapter.uploadObject('session', {
      path,
      content: Readable.from(content),
      size: content.byteLength,
      sha256,
      mediaType: 'application/pdf',
    });

    expect(uploaded).toMatchObject({
      path,
      size: content.byteLength,
      sha256,
    });
    expect(provider.events).toEqual([
      'lfs:batch:upload',
      'lfs:upload',
      'lfs:verify',
      'git:.gitattributes',
      `git:${path}`,
    ]);
    expect(provider.lfsVerifyAuthorization).toBe('signed-verify');
    expect(provider.lfsUploadContentType).toBe('application/octet-stream');
    expect(provider.lfsUploadContentLength).toBe(String(content.byteLength));
    expect(provider.lfsVerifyAccept).toBe('application/vnd.git-lfs+json');
    expect(provider.files.get('.gitattributes')?.content).toContain(
      '.omnia-reader/v1/library/**/*.pdf filter=lfs',
    );
    expect(provider.files.get(path)?.content).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${content.byteLength}\n`,
    );

    const download = await adapter.downloadObject('session', path);
    expect(download?.metadata).toEqual(uploaded);
    expect(download?.mediaType).toBe('application/pdf');
    await expect(readableBuffer(download?.content)).resolves.toEqual(content);
  });

  it('does not publish an LFS pointer after an interrupted object upload', async () => {
    const provider = new FakeGitHub();
    provider.failLfsUpload = true;
    const { adapter } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 interrupted publication\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    await expect(
      adapter.uploadObject('session', {
        path,
        content: Readable.from(content),
        size: content.byteLength,
        sha256,
        mediaType: 'application/pdf',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({ statusCode: 502 });

    expect(provider.events).toEqual(['lfs:batch:upload', 'lfs:upload']);
    expect(provider.files.has(path)).toBe(false);
    expect(provider.files.has('.gitattributes')).toBe(false);
  });

  it('maps an upstream LFS stream rejection without leaking a gateway 500', async () => {
    const provider = new FakeGitHub();
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (String(input).startsWith('https://objects.test/upload/')) {
        (init.body as Readable).destroy(
          new Error('provider-controlled stream failure'),
        );
        return new Response(null, { status: 503 });
      }
      return provider.fetch(input, init);
    };
    const { adapter } = testAdapter(provider, { fetcher });
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 rejected LFS stream\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    await expect(
      adapter.uploadObject('session', {
        path,
        content: Readable.from(content),
        size: content.byteLength,
        sha256,
        mediaType: 'application/pdf',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 502,
      message: 'GitHub provider request failed',
    });

    expect(provider.files.has(path)).toBe(false);
  });

  it('bounds a stalled Git LFS batch request without publishing a pointer', async () => {
    const provider = new FakeGitHub();
    const fetcher: typeof fetch = async (input, init = {}) =>
      String(input).includes('/info/lfs/objects/batch')
        ? stalledResponse(init.signal)
        : provider.fetch(input, init);
    const { adapter } = testAdapter(provider, {
      fetcher,
      requestTimeoutMs: 10,
    });
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 stalled LFS batch\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    await expect(
      adapter.uploadObject('session', {
        path,
        content: Readable.from(content),
        size: content.byteLength,
        sha256,
        mediaType: 'application/pdf',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 504,
      message: 'GitHub provider request timed out',
    });

    expect(provider.files.has(path)).toBe(false);
    expect(provider.files.has('.gitattributes')).toBe(false);
  });

  it('bounds a stalled Git LFS batch response body', async () => {
    const provider = new FakeGitHub();
    const fetcher: typeof fetch = async (input, init = {}) =>
      String(input).includes('/info/lfs/objects/batch')
        ? stalledJsonResponse(init.signal)
        : provider.fetch(input, init);
    const { adapter } = testAdapter(provider, {
      fetcher,
      requestTimeoutMs: 10,
    });
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 stalled LFS response\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    await expect(
      adapter.uploadObject('session', {
        path,
        content: Readable.from(content),
        size: content.byteLength,
        sha256,
        mediaType: 'application/pdf',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 504,
      message: 'GitHub provider request timed out',
    });

    expect(provider.files.has(path)).toBe(false);
  });

  it('maps a Git LFS transport failure to an application-owned error', async () => {
    const provider = new FakeGitHub();
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (String(input).includes('/info/lfs/objects/batch')) {
        throw new TypeError('provider-controlled network detail');
      }
      return provider.fetch(input, init);
    };
    const { adapter } = testAdapter(provider, { fetcher });
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 failed LFS transport\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    await expect(
      adapter.uploadObject('session', {
        path,
        content: Readable.from(content),
        size: content.byteLength,
        sha256,
        mediaType: 'application/pdf',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 502,
      message: 'GitHub provider request failed',
    });

    expect(provider.files.has(path)).toBe(false);
  });

  it('bounds a stalled Git LFS transfer without publishing a pointer', async () => {
    const provider = new FakeGitHub();
    const fetcher: typeof fetch = async (input, init = {}) =>
      String(input).startsWith('https://objects.test/upload/')
        ? stalledResponse(init.signal)
        : provider.fetch(input, init);
    const { adapter } = testAdapter(provider, {
      fetcher,
      transferTimeoutMs: 10,
    });
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 stalled LFS transfer\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    await expect(
      adapter.uploadObject('session', {
        path,
        content: Readable.from(content),
        size: content.byteLength,
        sha256,
        mediaType: 'application/pdf',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 504,
      message: 'GitHub provider request timed out',
    });

    expect(provider.files.has(path)).toBe(false);
    expect(provider.files.has('.gitattributes')).toBe(false);
  });

  it.each([
    {
      name: 'unencrypted URL',
      action: { href: 'http://objects.test/upload/object' },
      message: 'Git LFS returned an unsafe transfer URL',
    },
    {
      name: 'credential-bearing URL',
      action: { href: 'https://user:secret@objects.test/upload/object' },
      message: 'Git LFS returned an unsafe transfer URL',
    },
    {
      name: 'fragment-bearing URL',
      action: { href: 'https://objects.test/upload/object#secret' },
      message: 'Git LFS returned an unsafe transfer URL',
    },
    {
      name: 'loopback URL',
      action: { href: 'https://127.0.0.1/upload/object' },
      message: 'Git LFS returned an unsafe transfer URL',
    },
    {
      name: 'host override header',
      action: {
        href: 'https://objects.test/upload/object',
        header: { Host: 'internal.example' },
      },
      message: 'Git LFS returned unsafe transfer headers',
    },
  ])('rejects a Git LFS action with a $name', async ({ action, message }) => {
    const provider = new FakeGitHub();
    provider.lfsUploadAction = action;
    const { adapter } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 unsafe LFS action\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;

    await expect(
      adapter.uploadObject('session', {
        path,
        content: Readable.from(content),
        size: content.byteLength,
        sha256,
        mediaType: 'application/pdf',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({
      statusCode: 502,
      message,
    });

    expect(provider.events).toEqual(['lfs:batch:upload']);
    expect(provider.files.has(path)).toBe(false);
  });

  it('revision-deletes the Git LFS pointer while retaining object history', async () => {
    const provider = new FakeGitHub();
    const { adapter } = testAdapter(provider);
    await authorizeAndSelect(adapter);
    const content = Buffer.from('%PDF-1.7 remote deletion\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = `.omnia-reader/v1/books/sha256:${sha256}/publication.pdf`;
    const uploaded = await adapter.uploadObject('session', {
      path,
      content: Readable.from(content),
      size: content.byteLength,
      sha256,
      mediaType: 'application/pdf',
    });

    await expect(
      adapter.deleteObject('session', {
        path,
        expectedRevision: 'stale-revision',
      }),
    ).rejects.toMatchObject<Partial<GatewayHttpError>>({ statusCode: 409 });

    await adapter.deleteObject('session', {
      path,
      expectedRevision: uploaded.revision,
    });

    expect(provider.files.has(path)).toBe(false);
    expect(provider.lfs.has(sha256)).toBe(true);
    expect(provider.deletedFile).toEqual({
      path,
      sha: uploaded.revision,
      branch: 'main',
      message: `Omnia Reader: delete publication ${path}`,
    });
    await expect(
      adapter.deleteObject('session', { path }),
    ).resolves.toBeUndefined();
  });
});

function testAdapter(
  provider: FakeGitHub,
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    onUserTokenRevocationFailure?: () => void;
    requestTimeoutMs?: number;
    revocations?: GitHubAuthorizationRevocationStore;
    transferTimeoutMs?: number;
  } = {},
): {
  adapter: GitHubSyncGatewayAdapter;
  revocations: GitHubAuthorizationRevocationStore;
  sessions: EncryptedMemorySessionStore<GitHubSessionState>;
} {
  const sessions = new EncryptedMemorySessionStore<GitHubSessionState>(
    Buffer.alloc(32, 7),
    { now: () => NOW },
  );
  const revocations =
    options.revocations ??
    new MemoryGitHubAuthorizationRevocationStore({
      now: options.now ?? (() => NOW),
    });
  return {
    sessions,
    revocations,
    adapter: new GitHubSyncGatewayAdapter({
      appId: '1234',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      callbackUrl: 'https://reader.test/api/sync/github/auth/callback',
      installationUrl:
        'https://github.test/apps/omnia-reader/installations/new',
      privateKey: PRIVATE_KEY.export({
        type: 'pkcs8',
        format: 'pem',
      }).toString(),
      sessions,
      revocations,
      fetcher: options.fetcher ?? provider.fetch,
      apiBaseUrl: 'https://api.github.test',
      webBaseUrl: 'https://github.test',
      now: options.now ?? (() => NOW),
      randomState: () => 'fixed-state',
      randomCodeVerifier: () => 'v'.repeat(43),
      providerRetryBaseValueMs: 1,
      throttleId: `github-adapter-test:${++testAdapterSequence}`,
      ...(options.requestTimeoutMs
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.transferTimeoutMs
        ? { transferTimeoutMs: options.transferTimeoutMs }
        : {}),
      ...(options.onUserTokenRevocationFailure
        ? {
            onUserTokenRevocationFailure: options.onUserTokenRevocationFailure,
          }
        : {}),
    }),
  };
}

async function authorizeAndSelect(
  adapter: GitHubSyncGatewayAdapter,
): Promise<void> {
  await authorize(adapter);
  await adapter.destinations('session');
  await adapter.selectDestination('session', { repositoryId: 99 });
}

async function authorize(adapter: GitHubSyncGatewayAdapter): Promise<void> {
  await authorizeSession(adapter, 'pending', 'session');
}

async function authorizeSession(
  adapter: GitHubSyncGatewayAdapter,
  pendingSessionId: string,
  sessionId: string,
): Promise<void> {
  await adapter.authorizationUrl(pendingSessionId, '/settings/sync');
  await adapter.completeAuthorization(pendingSessionId, sessionId, {
    code: 'oauth-code',
    state: 'fixed-state',
  });
}

class FakeGitHub {
  readonly files = new Map<string, { content: string; sha: string }>();
  readonly events: string[] = [];
  readonly lfs = new Map<string, Buffer>();
  readonly createdRepositories: string[] = [];
  readonly refreshRequests: string[] = [];
  readonly revokedUserAccessTokens: string[] = [];
  readonly userAccessTokens: string[] = [];
  revocationAuthorization = '';
  lfsVerifyAuthorization = '';
  lfsUploadContentType = '';
  lfsUploadContentLength = '';
  lfsVerifyAccept = '';
  userInstallationRequests = 0;
  userInstallationTransientFailures = 0;
  userInstallationRateLimitFailures = Number.POSITIVE_INFINITY;
  repositoryCreationRequests = 0;
  contentMutationRequests = 0;
  untrustedRequests = 0;
  private markRefreshStarted: () => void = () => undefined;
  readonly refreshStarted = new Promise<void>((resolve) => {
    this.markRefreshStarted = resolve;
  });
  failLfsUpload = false;
  lfsUploadAction: {
    href: string;
    header?: Record<string, string>;
  } | null = null;
  forbidRepositoryCreation = false;
  repositoryCreationOutcome: 'success' | 'applied-unavailable' = 'success';
  contentMutationOutcome: 'success' | 'applied-unavailable' = 'success';
  exposeCreatedRepositoryToInstallation = true;
  refreshOutcome: 'success' | 'bad-token' | 'malformed' | 'unavailable' =
    'success';
  revocationOutcome: 'success' | 'missing' | 'unavailable' = 'success';
  refreshWait: Promise<void> | null = null;
  userAuthorizationRevoked = false;
  userInstallationRateLimit: {
    status: 403 | 429;
    retryAfterSeconds?: number;
    resetAt?: number;
    primary?: boolean;
  } | null = null;
  userInstallationNextLink: string | null = null;
  installationTokenOutcome: 'success' | 'missing' | 'unauthorized' = 'success';
  treeStatus: 200 | 404 | 409 = 200;
  deletedFile: {
    path: string;
    sha: string;
    branch: string;
    message: string;
  } | null = null;
  private revision = 0;
  private pendingLfs: { oid: string; size: number } | null = null;
  private readonly repositories: Array<Record<string, unknown>> = [
    {
      id: 99,
      full_name: 'reader/library',
      private: true,
      default_branch: 'main',
      permissions: { push: true },
    },
  ];

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();

    if (url.origin === 'https://untrusted.test') {
      this.untrustedRequests += 1;
      return json({ installations: [] });
    }

    if (
      url.origin === 'https://github.test' &&
      url.pathname === '/login/oauth/access_token'
    ) {
      const request = JSON.parse(String(init.body)) as {
        code_verifier?: string;
        grant_type?: string;
        refresh_token?: string;
      };
      if (request.grant_type === 'refresh_token') {
        this.refreshRequests.push(request.refresh_token ?? '');
        this.markRefreshStarted();
        await this.refreshWait;
        if (this.refreshOutcome === 'bad-token') {
          return json({ error: 'bad_refresh_token' });
        }
        if (this.refreshOutcome === 'malformed') {
          return json({
            access_token: 'refreshed-user-token',
            expires_in: 28_800,
          });
        }
        if (this.refreshOutcome === 'unavailable') {
          return json({ message: 'Provider maintenance' }, 503);
        }
        return json({
          access_token: 'refreshed-user-token',
          expires_in: 28_800,
          refresh_token: 'rotated-refresh-token',
          refresh_token_expires_in: 15_897_600,
        });
      }
      expect(request.code_verifier).toBe('v'.repeat(43));
      return json({
        access_token: 'user-token',
        expires_in: 28_800,
        refresh_token: 'refresh-token',
        refresh_token_expires_in: 15_897_600,
      });
    }
    if (
      url.origin === 'https://api.github.test' &&
      url.pathname === '/applications/client-id/token' &&
      method === 'DELETE'
    ) {
      const request = JSON.parse(String(init.body)) as {
        access_token?: string;
      };
      this.revokedUserAccessTokens.push(request.access_token ?? '');
      this.revocationAuthorization =
        new Headers(init.headers).get('authorization') ?? '';
      if (this.revocationOutcome === 'missing') {
        return json({ message: 'Not Found' }, 404);
      }
      if (this.revocationOutcome === 'unavailable') {
        return json({ message: 'Provider maintenance' }, 503);
      }
      return new Response(null, { status: 204 });
    }
    if (
      url.origin === 'https://api.github.test' &&
      url.pathname === '/user/repos' &&
      method === 'POST'
    ) {
      this.repositoryCreationRequests += 1;
      if (this.forbidRepositoryCreation) {
        return json({ message: 'Resource not accessible by integration' }, 403);
      }
      const body = JSON.parse(String(init.body)) as {
        name: string;
        private: boolean;
        auto_init: boolean;
      };
      expect(body.private).toBe(true);
      expect(body.auto_init).toBe(true);
      this.createdRepositories.push(body.name);
      const repository = {
        id: 100,
        full_name: `reader/${body.name}`,
        private: true,
        default_branch: 'main',
        permissions: { push: true },
      };
      if (this.exposeCreatedRepositoryToInstallation) {
        this.repositories.push(repository);
      }
      if (this.repositoryCreationOutcome === 'applied-unavailable') {
        return json({ message: 'Provider maintenance' }, 503);
      }
      return json(repository, 201);
    }
    if (url.origin === 'https://api.github.test' && url.pathname === '/user') {
      return json({
        id: 42,
        login: 'reader',
        avatar_url: 'https://avatars.test/reader',
      });
    }
    if (url.pathname === '/user/installations') {
      this.userInstallationRequests += 1;
      if (this.userInstallationTransientFailures > 0) {
        this.userInstallationTransientFailures -= 1;
        return json({ message: 'Provider maintenance' }, 503);
      }
      if (
        this.userInstallationRateLimit &&
        this.userInstallationRateLimitFailures > 0
      ) {
        this.userInstallationRateLimitFailures -= 1;
        const rateLimit = this.userInstallationRateLimit;
        return json(
          {
            message:
              rateLimit.primary === false
                ? 'You have exceeded a secondary rate limit'
                : 'Provider-controlled rate-limit detail',
          },
          rateLimit.status,
          {
            ...(rateLimit.retryAfterSeconds === undefined
              ? {}
              : { 'Retry-After': String(rateLimit.retryAfterSeconds) }),
            ...(rateLimit.resetAt === undefined
              ? {}
              : { 'X-RateLimit-Reset': String(rateLimit.resetAt) }),
            ...(rateLimit.primary === false
              ? {}
              : { 'X-RateLimit-Remaining': '0' }),
          },
        );
      }
      if (this.userAuthorizationRevoked) {
        return json({ message: 'Bad credentials' }, 401);
      }
      this.userAccessTokens.push(
        new Headers(init.headers).get('authorization') ?? '',
      );
      return jsonAt(
        url,
        { total_count: 1, installations: [{ id: 7 }] },
        200,
        this.userInstallationNextLink
          ? { Link: `<${this.userInstallationNextLink}>; rel="next"` }
          : {},
      );
    }
    if (url.pathname === '/user/installations/7/repositories') {
      return jsonAt(url, {
        total_count: this.repositories.length,
        repositories: this.repositories,
      });
    }
    if (
      url.pathname === '/app/installations/7/access_tokens' &&
      method === 'POST'
    ) {
      if (this.installationTokenOutcome === 'missing') {
        return json({ message: 'Not Found' }, 404);
      }
      if (this.installationTokenOutcome === 'unauthorized') {
        return json({ message: 'Bad credentials' }, 401);
      }
      expect(new Headers(init.headers).get('authorization')).toMatch(
        /^Bearer [^.]+\.[^.]+\.[^.]+$/,
      );
      return json({
        token: 'installation-token',
        expires_at: '2026-07-25T13:00:00.000Z',
      });
    }
    if (url.pathname.includes('/contents/')) {
      return this.contents(url, method, init);
    }
    if (url.pathname.includes('/git/trees/')) {
      if (this.treeStatus !== 200) {
        return json({ message: 'Git Repository is empty.' }, this.treeStatus);
      }
      return json({
        tree: [...this.files.entries()].map(([path, file]) => ({
          path,
          type: 'blob',
          sha: file.sha,
          size: Buffer.byteLength(file.content),
        })),
      });
    }
    if (url.pathname.includes('/git/blobs/')) {
      const sha = url.pathname.split('/').at(-1);
      const file = [...this.files.values()].find(
        (candidate) => candidate.sha === sha,
      );
      return file
        ? json({
            encoding: 'base64',
            content: Buffer.from(file.content).toString('base64'),
          })
        : json({ message: 'Not Found' }, 404);
    }
    if (url.pathname.endsWith('/info/lfs/objects/batch')) {
      const request = JSON.parse(String(init.body)) as {
        operation: 'upload' | 'download';
        objects: [{ oid: string; size: number }];
      };
      const object = request.objects[0];
      this.events.push(`lfs:batch:${request.operation}`);
      this.pendingLfs = object;
      if (request.operation === 'upload') {
        return json({
          transfer: 'basic',
          objects: [
            {
              ...object,
              actions: {
                upload: {
                  ...(this.lfsUploadAction ?? {
                    href: `https://objects.test/upload/${object.oid}`,
                    header: { Authorization: 'signed-upload' },
                  }),
                },
                verify: {
                  href: `https://objects.test/verify/${object.oid}`,
                  header: { Authorization: 'signed-verify' },
                },
              },
            },
          ],
        });
      }
      return json({
        transfer: 'basic',
        objects: [
          {
            ...object,
            actions: {
              download: {
                href: `https://objects.test/download/${object.oid}`,
              },
            },
          },
        ],
      });
    }
    if (url.origin === 'https://objects.test') {
      const oid = url.pathname.split('/').at(-1) as string;
      if (url.pathname.startsWith('/upload/')) {
        this.events.push('lfs:upload');
        const headers = new Headers(init.headers);
        this.lfsUploadContentType = headers.get('content-type') ?? '';
        this.lfsUploadContentLength = headers.get('content-length') ?? '';
        const content = await requestBody(init.body);
        if (this.failLfsUpload) {
          return json({ message: 'Upload interrupted' }, 503);
        }
        this.lfs.set(oid, content);
        return new Response(null, { status: 200 });
      }
      if (url.pathname.startsWith('/verify/')) {
        this.events.push('lfs:verify');
        const headers = new Headers(init.headers);
        this.lfsVerifyAuthorization = headers.get('authorization') ?? '';
        this.lfsVerifyAccept = headers.get('accept') ?? '';
        const value = JSON.parse(String(init.body)) as {
          oid: string;
          size: number;
        };
        const content = this.lfs.get(value.oid);
        return content?.byteLength === value.size
          ? new Response(null, { status: 200 })
          : json({ message: 'Invalid object' }, 422);
      }
      if (url.pathname.startsWith('/download/')) {
        const content = this.lfs.get(oid);
        return content
          ? new Response(content, { status: 200 })
          : json({ message: 'Not Found' }, 404);
      }
    }
    return json({ message: `Unhandled ${method} ${url}` }, 500);
  };

  private async contents(
    url: URL,
    method: string,
    init: RequestInit,
  ): Promise<Response> {
    const marker = '/contents/';
    const path = url.pathname
      .slice(url.pathname.indexOf(marker) + marker.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    const current = this.files.get(path);
    if (method === 'GET') {
      return current
        ? json({
            path,
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(current.content).toString('base64'),
            sha: current.sha,
          })
        : json({ message: 'Not Found' }, 404);
    }
    if (method === 'DELETE') {
      const body = JSON.parse(String(init.body)) as {
        message: string;
        sha: string;
        branch: string;
      };
      if (!current) {
        return json({ message: 'Not Found' }, 404);
      }
      if (body.sha !== current.sha) {
        return json({ message: 'Conflict' }, 409);
      }
      this.files.delete(path);
      this.deletedFile = { path, ...body };
      return json({ commit: { sha: (++this.revision).toString(16) } });
    }
    this.contentMutationRequests += 1;
    const body = JSON.parse(String(init.body)) as {
      content: string;
      sha?: string;
    };
    if (
      (current && body.sha !== current.sha) ||
      (!current && body.sha !== undefined)
    ) {
      return json({ message: 'Conflict' }, 409);
    }
    const sha = (++this.revision).toString(16).padStart(40, '0');
    const content = Buffer.from(body.content, 'base64').toString('utf8');
    this.files.set(path, { content, sha });
    if (path === '.gitattributes' || path.startsWith('.omnia-reader/')) {
      this.events.push(`git:${path}`);
    }
    if (this.contentMutationOutcome === 'applied-unavailable') {
      return json({ message: 'Provider maintenance' }, 503);
    }
    return json({ content: { sha } }, current ? 200 : 201);
  }
}

function json(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function jsonAt(
  url: URL,
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const response = json(value, status, headers);
  Object.defineProperty(response, 'url', { value: url.toString() });
  return response;
}

async function requestBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (
    body &&
    typeof body === 'object' &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === 'function'
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

function stalledResponse(
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => {
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function stalledJsonResponse(signal: AbortSignal | null | undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          controller.error(
            signal?.reason ?? new DOMException('Aborted', 'AbortError'),
          );
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

async function readableBuffer(stream: Readable | undefined): Promise<Buffer> {
  if (!stream) {
    throw new Error('Missing download stream');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
