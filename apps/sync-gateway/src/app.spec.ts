import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buildSyncGateway } from './app.js';
import {
  GatewayHttpError,
  type CredentialAuthorizationPage,
  type CredentialSyncGatewayAdapter,
  type DocumentWriteRequest,
  type RemoteDocument,
  type RemoteObject,
  type RemoteObjectDownload,
  type RemoteObjectUpload,
  type SyncGatewayAdapter,
  type SyncProviderKind,
} from './gateway-contract.js';

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
    }
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
) {
  return buildSyncGateway({
    github,
    mega,
    secureCookies: false,
    maxPublicationBytes: 1024 * 1024,
  });
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
          authenticated: true,
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
    void parameters;
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
