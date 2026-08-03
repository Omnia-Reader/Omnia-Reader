import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GatewayHttpError } from './gateway-contract.js';
import {
  MegaSyncGatewayAdapter,
  type MegaSessionState,
} from './mega-adapter.js';
import type {
  MegaSdkBridge,
  MegaSdkCredentials,
  MegaSdkFile,
  MegaSdkFileUpload,
  MegaSdkFolder,
  MegaSdkLogin,
} from './mega-sdk-bridge.js';
import type { GatewaySessionStore } from './session-store.js';

const folder: MegaSdkFolder = {
  handle: 'root-folder',
  name: 'Omnia Reader',
  path: '/Omnia Reader',
  canWrite: true,
};

describe('MegaSyncGatewayAdapter', () => {
  it('uses a state-bound gateway login and never exposes the SDK session', async () => {
    const fixture = createFixture();
    const authorizationUrl = await fixture.adapter.authorizationUrl(
      'browser-session',
      '/settings/sync?provider=mega',
    );
    const state = new URL(authorizationUrl).searchParams.get('state') as string;

    await expect(
      fixture.adapter.credentialAuthorizationPage('browser-session', {
        state: 'wrong-state',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      fixture.adapter.credentialAuthorizationPage('browser-session', {
        state,
      }),
    ).resolves.toMatchObject({
      provider: 'MEGA',
      state,
      supportsMultiFactorCode: true,
    });

    await expect(
      fixture.adapter.completeAuthorization(
        'browser-session',
        'authenticated-session',
        {
          state,
          email: 'reader@example.com',
          password: 'correct horse battery staple',
          multiFactorCode: '123456',
        },
      ),
    ).resolves.toBe('/settings/sync?provider=mega');
    expect(fixture.bridge.loginCredentials).toEqual({
      email: 'reader@example.com',
      password: 'correct horse battery staple',
      multiFactorCode: '123456',
    });
    expect(await fixture.adapter.session('authenticated-session')).toEqual({
      authenticated: true,
      account: 'reader@example.com',
      folder: null,
    });
    expect(
      JSON.stringify(await fixture.adapter.session('authenticated-session')),
    ).not.toContain('sdk-session-secret');
    expect(await fixture.sessions.get('browser-session')).toBeNull();
  });

  it('authorizes and persists only a writable selected folder', async () => {
    const fixture = createFixture();
    const sessionId = await authenticate(fixture);

    await expect(fixture.adapter.destinations(sessionId)).resolves.toEqual([
      folder,
    ]);
    await expect(
      fixture.adapter.selectDestination(sessionId, { handle: folder.handle }),
    ).resolves.toEqual({
      authenticated: true,
      account: 'reader@example.com',
      folder,
    });

    fixture.bridge.availableFolders = [{ ...folder, canWrite: false }];
    await expect(fixture.adapter.session(sessionId)).resolves.toEqual({
      authenticated: true,
      account: 'reader@example.com',
      folder: null,
    });
  });

  it('creates and optimistically replaces small documents', async () => {
    const fixture = createFixture();
    const sessionId = await authenticatedFolder(fixture);
    const path = '.omnia-reader/v1/progress/device-1/book-1.json';

    const created = await fixture.adapter.writeDocument(sessionId, {
      path,
      content: '{"progress":0.25}',
      message: 'create progress',
    });
    expect(created.path).toBe(path);
    await expect(
      fixture.adapter.readDocument(sessionId, path),
    ).resolves.toEqual(created);
    await expect(
      fixture.adapter.listEntries(sessionId, '.omnia-reader/v1'),
    ).resolves.toEqual([
      { path, revision: created.revision, kind: 'document' },
    ]);

    await expect(
      fixture.adapter.writeDocument(sessionId, {
        path,
        content: '{"progress":0.5}',
        expectedRevision: 'stale-revision',
        message: 'stale update',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const updated = await fixture.adapter.writeDocument(sessionId, {
      path,
      content: '{"progress":0.5}',
      expectedRevision: created.revision,
      message: 'update progress',
    });
    expect(updated.content).toBe('{"progress":0.5}');
    expect(updated.revision).not.toBe(created.revision);
    expect(fixture.bridge.visibleFiles(path)).toHaveLength(1);

    await fixture.adapter.deleteDocument(sessionId, {
      path,
      expectedRevision: updated.revision,
      message: 'delete progress',
    });
    await expect(
      fixture.adapter.readDocument(sessionId, path),
    ).resolves.toBeNull();
  });

  it('validates duplicate-node revisions before removing a batch from one inventory', async () => {
    const fixture = createFixture();
    const sessionId = await authenticatedFolder(fixture);
    const path = '.omnia-reader/v1/obsolete.json';
    fixture.bridge.seed(path, '{}', 'obsolete-a');
    fixture.bridge.seed(path, '{}', 'obsolete-b');
    const entries = await fixture.adapter.listEntries(
      sessionId,
      '.omnia-reader/v1',
    );
    const inventoryRequests = fixture.bridge.fileRequests;
    fixture.bridge.seed(path, '{}', 'obsolete-concurrent');

    await expect(
      fixture.adapter.deleteEntries(
        sessionId,
        entries.map((entry) => ({
          path: entry.path,
          expectedRevision: entry.revision,
        })),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.bridge.fileRequests).toBe(inventoryRequests + 1);
    expect(fixture.bridge.visibleFiles(path)).toHaveLength(3);

    const refreshed = await fixture.adapter.listEntries(
      sessionId,
      '.omnia-reader/v1',
    );
    const requestsBeforeRemoval = fixture.bridge.fileRequests;
    await fixture.adapter.deleteEntries(
      sessionId,
      refreshed.map((entry) => ({
        path: entry.path,
        expectedRevision: entry.revision,
      })),
    );

    expect(fixture.bridge.fileRequests).toBe(requestsBeforeRemoval + 1);
    expect(fixture.bridge.visibleFiles(path)).toEqual([]);
  });

  it('chooses identical duplicates deterministically and rejects divergent ones', async () => {
    const fixture = createFixture();
    const sessionId = await authenticatedFolder(fixture);
    const path = '.omnia-reader/v1/bookmarks/book-1/a.json';
    fixture.bridge.seed(path, '{"bookmark":1}', 'z-handle');
    fixture.bridge.seed(path, '{"bookmark":1}', 'a-handle');

    const resolved = await fixture.adapter.readDocument(sessionId, path);
    expect(resolved).toEqual({
      path,
      content: '{"bookmark":1}',
      revision: 'revision-a-handle',
    });

    await fixture.adapter.writeDocument(sessionId, {
      path,
      content: '{"bookmark":1,"updated":true}',
      expectedRevision: resolved?.revision,
      message: 'reconcile duplicates',
    });
    expect(fixture.bridge.visibleFiles(path)).toHaveLength(1);

    fixture.bridge.seed(path, '{"bookmark":2}', 'm-handle');
    await expect(
      fixture.adapter.readDocument(sessionId, path),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('duplicate MEGA nodes'),
    });
  });

  it('uploads, verifies, and restores immutable publication bytes', async () => {
    const fixture = createFixture();
    const sessionId = await authenticatedFolder(fixture);
    const path = '.omnia-reader/v1/books/ab/book-id/edition.pdf';
    const bytes = Buffer.from('%PDF-1.7 exact publication');
    const sha256 = digest(bytes);

    const uploaded = await fixture.adapter.uploadObject(sessionId, {
      path,
      mediaType: 'application/pdf',
      size: bytes.byteLength,
      sha256,
      content: Readable.from(bytes),
    });
    expect(uploaded).toMatchObject({ path, size: bytes.byteLength, sha256 });
    await expect(fixture.adapter.headObject(sessionId, path)).resolves.toEqual(
      uploaded,
    );

    const download = await fixture.adapter.downloadObject(sessionId, path);
    expect(download?.mediaType).toBe('application/pdf');
    await expect(readAll(download?.content as Readable)).resolves.toEqual(
      bytes,
    );

    await expect(
      fixture.adapter.uploadObject(sessionId, {
        path,
        mediaType: 'application/pdf',
        size: bytes.byteLength,
        sha256,
        content: Readable.from(bytes),
      }),
    ).resolves.toEqual(uploaded);

    const different = Buffer.from('different');
    await expect(
      fixture.adapter.uploadObject(sessionId, {
        path,
        mediaType: 'application/pdf',
        size: different.byteLength,
        sha256: digest(different),
        content: Readable.from(different),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('removes a staged publication after an interrupted publish and retries safely', async () => {
    const fixture = createFixture();
    const sessionId = await authenticatedFolder(fixture);
    const path = '.omnia-reader/v1/books/ab/retry/edition.pdf';
    const bytes = Buffer.from('%PDF-1.7 retry-safe publication');
    const sha256 = digest(bytes);
    fixture.bridge.failMove = true;

    await expect(
      fixture.adapter.uploadObject(sessionId, {
        path,
        mediaType: 'application/pdf',
        size: bytes.byteLength,
        sha256,
        content: Readable.from(bytes),
      }),
    ).rejects.toThrow('Move interrupted');
    expect(fixture.bridge.fileCount()).toBe(0);
    await expect(
      fixture.adapter.headObject(sessionId, path),
    ).resolves.toBeNull();

    fixture.bridge.failMove = false;
    await expect(
      fixture.adapter.uploadObject(sessionId, {
        path,
        mediaType: 'application/pdf',
        size: bytes.byteLength,
        sha256,
        content: Readable.from(bytes),
      }),
    ).resolves.toMatchObject({ path, size: bytes.byteLength, sha256 });
    expect(fixture.bridge.fileCount()).toBe(1);
  });

  it('revision-deletes every matching publication node idempotently', async () => {
    const fixture = createFixture();
    const sessionId = await authenticatedFolder(fixture);
    const path = '.omnia-reader/v1/books/ab/delete/edition.epub';
    const bytes = Buffer.from('EPUB remote deletion');
    const sha256 = digest(bytes);
    const uploaded = await fixture.adapter.uploadObject(sessionId, {
      path,
      mediaType: 'application/epub+zip',
      size: bytes.byteLength,
      sha256,
      content: Readable.from(bytes),
    });
    fixture.bridge.seed(path, bytes.toString(), 'duplicate-handle');
    const current = await fixture.adapter.headObject(sessionId, path);

    await expect(
      fixture.adapter.deleteObject(sessionId, {
        path,
        expectedRevision: 'stale-revision',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await fixture.adapter.deleteObject(sessionId, {
      path,
      expectedRevision: current?.revision ?? uploaded.revision,
    });

    expect(fixture.bridge.visibleFiles(path)).toEqual([]);
    await expect(
      fixture.adapter.deleteObject(sessionId, { path }),
    ).resolves.toBeUndefined();
  });

  it('invalidates the encrypted gateway session when the SDK session expires', async () => {
    const fixture = createFixture();
    const sessionId = await authenticatedFolder(fixture);
    fixture.bridge.sessionExpired = true;

    await expect(fixture.adapter.destinations(sessionId)).rejects.toMatchObject(
      {
        statusCode: 401,
      },
    );
    expect(await fixture.sessions.get(sessionId)).toBeNull();
  });
});

interface Fixture {
  adapter: MegaSyncGatewayAdapter;
  bridge: MemoryMegaSdkBridge;
  sessions: MemorySessionStore<MegaSessionState>;
}

function createFixture(): Fixture {
  const bridge = new MemoryMegaSdkBridge();
  const sessions = new MemorySessionStore<MegaSessionState>();
  const ids = ['first', 'second', 'third', 'fourth', 'fifth'];
  return {
    bridge,
    sessions,
    adapter: new MegaSyncGatewayAdapter({
      loginUrl: 'https://reader.example/api/sync/mega/auth/login',
      bridge,
      sessions,
      randomState: () => 'authorization-state',
      randomId: () => ids.shift() ?? 'later',
    }),
  };
}

async function authenticate(fixture: Fixture): Promise<string> {
  const authorizationUrl = await fixture.adapter.authorizationUrl(
    'pending',
    '/settings/sync',
  );
  const state = new URL(authorizationUrl).searchParams.get('state') as string;
  await fixture.adapter.completeAuthorization('pending', 'authenticated', {
    state,
    email: 'reader@example.com',
    password: 'secret',
  });
  return 'authenticated';
}

async function authenticatedFolder(fixture: Fixture): Promise<string> {
  const sessionId = await authenticate(fixture);
  await fixture.adapter.selectDestination(sessionId, { handle: folder.handle });
  return sessionId;
}

class MemorySessionStore<T extends object> implements GatewaySessionStore<T> {
  private readonly values = new Map<string, T>();

  async get(sessionId: string): Promise<T | null> {
    return this.values.get(sessionId) ?? null;
  }

  async set(sessionId: string, value: T): Promise<void> {
    this.values.set(sessionId, structuredClone(value));
  }

  async move(
    sessionId: string,
    replacementSessionId: string,
    value: T,
  ): Promise<void> {
    await this.set(replacementSessionId, value);
    this.values.delete(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    this.values.delete(sessionId);
  }
}

interface StoredFile extends MegaSdkFile {
  content: Buffer;
}

class MemoryMegaSdkBridge implements MegaSdkBridge {
  availableFolders: MegaSdkFolder[] = [folder];
  loginCredentials: MegaSdkCredentials | null = null;
  sessionExpired = false;
  failMove = false;
  fileRequests = 0;
  private sequence = 0;
  private readonly stored = new Map<string, StoredFile>();

  async login(credentials: MegaSdkCredentials): Promise<MegaSdkLogin> {
    this.loginCredentials = credentials;
    return {
      account: credentials.email,
      session: 'sdk-session-secret',
    };
  }

  async logout(): Promise<void> {
    return;
  }

  async folders(): Promise<readonly MegaSdkFolder[]> {
    this.requireSession();
    return this.availableFolders;
  }

  async files(
    session: string,
    rootHandle: string,
    prefix: string,
  ): Promise<readonly MegaSdkFile[]> {
    this.requireSession(session);
    this.fileRequests += 1;
    expect(rootHandle).toBe(folder.handle);
    return [...this.stored.values()]
      .filter(
        (file) => file.path === prefix || file.path.startsWith(`${prefix}/`),
      )
      .map(withoutContent);
  }

  async downloadFile(
    session: string,
    rootHandle: string,
    handle: string,
  ): Promise<Readable> {
    this.requireSession(session);
    expect(rootHandle).toBe(folder.handle);
    const file = this.stored.get(handle);
    if (!file) {
      throw new GatewayHttpError(404, 'missing');
    }
    return Readable.from(file.content);
  }

  async uploadFile(
    session: string,
    upload: MegaSdkFileUpload,
  ): Promise<MegaSdkFile> {
    this.requireSession(session);
    expect(upload.rootHandle).toBe(folder.handle);
    const content = await readAll(upload.content);
    if (
      content.byteLength !== upload.size ||
      digest(content) !== upload.sha256
    ) {
      throw new GatewayHttpError(400, 'integrity');
    }
    const handle = `handle-${++this.sequence}`;
    const file: StoredFile = {
      handle,
      path: upload.path,
      revision: `revision-${handle}`,
      size: content.byteLength,
      sha256: upload.sha256,
      content,
    };
    this.stored.set(handle, file);
    return withoutContent(file);
  }

  async moveFile(
    session: string,
    handle: string,
    rootHandle: string,
    path: string,
  ): Promise<MegaSdkFile> {
    this.requireSession(session);
    expect(rootHandle).toBe(folder.handle);
    if (this.failMove) {
      throw new GatewayHttpError(503, 'Move interrupted');
    }
    const file = this.stored.get(handle);
    if (!file) {
      throw new GatewayHttpError(404, 'missing');
    }
    file.path = path;
    return withoutContent(file);
  }

  async removeFile(
    session: string,
    rootHandle: string,
    handle: string,
  ): Promise<void> {
    this.requireSession(session);
    expect(rootHandle).toBe(folder.handle);
    this.stored.delete(handle);
  }

  seed(path: string, content: string, handle: string): void {
    const bytes = Buffer.from(content);
    this.stored.set(handle, {
      handle,
      path,
      revision: `revision-${handle}`,
      size: bytes.byteLength,
      sha256: digest(bytes),
      content: bytes,
    });
  }

  visibleFiles(path: string): readonly MegaSdkFile[] {
    return [...this.stored.values()]
      .filter((file) => file.path === path)
      .map(withoutContent);
  }

  fileCount(): number {
    return this.stored.size;
  }

  private requireSession(session = 'sdk-session-secret'): void {
    if (this.sessionExpired || session !== 'sdk-session-secret') {
      throw new GatewayHttpError(401, 'expired');
    }
  }
}

function withoutContent(file: StoredFile): MegaSdkFile {
  const { content, ...metadata } = file;
  void content;
  return { ...metadata };
}

async function readAll(content: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
