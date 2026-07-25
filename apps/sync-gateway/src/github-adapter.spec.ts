import { createHash, generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GitHubSyncGatewayAdapter,
  type GitHubSessionState,
} from './github-adapter.js';
import { GatewayHttpError } from './gateway-contract.js';
import { EncryptedMemorySessionStore } from './session-store.js';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
}).privateKey;

describe('GitHubSyncGatewayAdapter', () => {
  it('authenticates, rotates the session, and scopes repository selection', async () => {
    const provider = new FakeGitHub();
    const { adapter, sessions } = testAdapter(provider);

    const authorizationUrl = await adapter.authorizationUrl(
      'old-session',
      '/settings/sync',
    );
    expect(authorizationUrl).toContain(
      'https://github.test/login/oauth/authorize',
    );
    expect(authorizationUrl).toContain('state=fixed-state');

    await expect(
      adapter.completeAuthorization('old-session', 'new-session', {
        code: 'oauth-code',
        state: 'fixed-state',
      }),
    ).resolves.toBe('/settings/sync');
    await expect(sessions.get('old-session')).resolves.toBeNull();
    await expect(adapter.session('new-session')).resolves.toEqual({
      authenticated: true,
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
      authenticated: true,
      repository: { id: 99, fullName: 'reader/library' },
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
  });

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
    expect(provider.files.get('.gitattributes')?.content).toContain(
      '.omnia-reader/v1/books/**/*.pdf filter=lfs',
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
});

function testAdapter(provider: FakeGitHub): {
  adapter: GitHubSyncGatewayAdapter;
  sessions: EncryptedMemorySessionStore<GitHubSessionState>;
} {
  const sessions = new EncryptedMemorySessionStore<GitHubSessionState>(
    Buffer.alloc(32, 7),
    { now: () => NOW },
  );
  return {
    sessions,
    adapter: new GitHubSyncGatewayAdapter({
      appId: '1234',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      callbackUrl: 'https://reader.test/api/sync/github/auth/callback',
      privateKey: PRIVATE_KEY.export({
        type: 'pkcs8',
        format: 'pem',
      }).toString(),
      sessions,
      fetcher: provider.fetch,
      apiBaseUrl: 'https://api.github.test',
      webBaseUrl: 'https://github.test',
      now: () => NOW,
      randomState: () => 'fixed-state',
    }),
  };
}

async function authorizeAndSelect(
  adapter: GitHubSyncGatewayAdapter,
): Promise<void> {
  await adapter.authorizationUrl('pending', '/settings/sync');
  await adapter.completeAuthorization('pending', 'session', {
    code: 'oauth-code',
    state: 'fixed-state',
  });
  await adapter.destinations('session');
  await adapter.selectDestination('session', { repositoryId: 99 });
}

class FakeGitHub {
  readonly files = new Map<string, { content: string; sha: string }>();
  readonly events: string[] = [];
  readonly lfs = new Map<string, Buffer>();
  failLfsUpload = false;
  private revision = 0;
  private pendingLfs: { oid: string; size: number } | null = null;

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();

    if (
      url.origin === 'https://github.test' &&
      url.pathname === '/login/oauth/access_token'
    ) {
      return json({
        access_token: 'user-token',
        expires_in: 28_800,
        refresh_token: 'refresh-token',
        refresh_token_expires_in: 15_552_000,
      });
    }
    if (url.origin === 'https://api.github.test' && url.pathname === '/user') {
      return json({
        id: 42,
        login: 'reader',
        avatar_url: 'https://avatars.test/reader',
      });
    }
    if (url.pathname === '/user/installations') {
      return json({ installations: [{ id: 7 }] });
    }
    if (url.pathname === '/user/installations/7/repositories') {
      return json({
        repositories: [
          {
            id: 99,
            full_name: 'reader/library',
            private: true,
            default_branch: 'main',
            permissions: { push: true },
          },
        ],
      });
    }
    if (
      url.pathname === '/app/installations/7/access_tokens' &&
      method === 'POST'
    ) {
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
                  href: `https://objects.test/upload/${object.oid}`,
                  header: { Authorization: 'signed-upload' },
                },
                verify: {
                  href: `https://objects.test/verify/${object.oid}`,
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
        const content = await requestBody(init.body);
        if (this.failLfsUpload) {
          return json({ message: 'Upload interrupted' }, 503);
        }
        this.lfs.set(oid, content);
        return new Response(null, { status: 200 });
      }
      if (url.pathname.startsWith('/verify/')) {
        this.events.push('lfs:verify');
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
    return json({ content: { sha } }, current ? 200 : 201);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
