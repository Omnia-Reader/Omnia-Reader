import { createHash } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';

export type SimulatedSyncProvider = 'git' | 'mega';

interface SimulatedDocument {
  path: string;
  content: string;
  revision: string;
}

interface SimulatedObject {
  path: string;
  revision: string;
  size: number;
  sha256: string;
  mediaType: string;
  content: Buffer;
}

interface SimulatedSyncGatewayOptions {
  interruptFirstObjectUpload?: boolean;
  conflictFirstBookManifestWrite?: boolean;
  expectedPublication?: Buffer;
}

/**
 * An in-memory implementation of the browser gateway contract. It deliberately
 * lives at the HTTP boundary so Playwright exercises the production clients,
 * coordinator, journal, IndexedDB/OPFS repositories, and reader restoration.
 */
export class SimulatedSyncGateway {
  private readonly documents = new Map<string, SimulatedDocument>();
  private readonly objects = new Map<string, SimulatedObject>();
  private revisionSequence = 0;
  private interruptNextObjectUpload: boolean;
  private conflictNextBookManifestWrite: boolean;
  private readonly expectedPublication?: Buffer;

  constructor(
    readonly provider: SimulatedSyncProvider,
    options: SimulatedSyncGatewayOptions = {},
  ) {
    this.interruptNextObjectUpload =
      options.interruptFirstObjectUpload ?? false;
    this.conflictNextBookManifestWrite =
      options.conflictFirstBookManifestWrite ?? false;
    this.expectedPublication = options.expectedPublication
      ? Buffer.from(options.expectedPublication)
      : undefined;
  }

  async install(context: BrowserContext): Promise<void> {
    const providerPath = this.provider === 'git' ? 'github' : 'mega';
    await context.route(`**/api/sync/${providerPath}/**`, (route) =>
      this.handle(route),
    );
  }

  documentPaths(): readonly string[] {
    return [...this.documents.keys()].sort();
  }

  objectPaths(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const basePath =
      this.provider === 'git' ? '/api/sync/github' : '/api/sync/mega';
    const path = url.pathname.slice(basePath.length);
    const method = request.method();

    if (path === '/session' && method === 'GET') {
      await this.fulfillJson(route, this.session());
      return;
    }
    if (path === '/session' && method === 'DELETE') {
      await route.fulfill({ status: 204 });
      return;
    }
    if (this.provider === 'git' && path === '/repositories') {
      await this.fulfillJson(route, {
        repositories: [
          {
            id: 1,
            fullName: 'omnia-reader/e2e-library',
            private: true,
            defaultBranch: 'main',
            canPush: true,
          },
        ],
      });
      return;
    }
    if (this.provider === 'mega' && path === '/folders') {
      await this.fulfillJson(route, {
        folders: [
          {
            handle: 'e2e-folder',
            name: 'Omnia Reader',
            path: '/Omnia Reader',
            canWrite: true,
          },
        ],
      });
      return;
    }
    if (
      (this.provider === 'git' && path === '/repository') ||
      (this.provider === 'mega' && path === '/folder')
    ) {
      await this.fulfillJson(route, this.session());
      return;
    }

    const listPath = this.provider === 'git' ? '/files' : '/documents';
    if (path === listPath && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const documents = [...this.documents.values()]
        .filter(
          (document) =>
            document.path === prefix || document.path.startsWith(`${prefix}/`),
        )
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((document) => ({ ...document }));
      await this.fulfillJson(
        route,
        this.provider === 'git' ? { files: documents } : { documents },
      );
      return;
    }

    const documentPath = this.provider === 'git' ? '/file' : '/document';
    if (path === documentPath && method === 'GET') {
      const remotePath = url.searchParams.get('path') ?? '';
      const document = this.documents.get(remotePath);
      if (!document) {
        await this.fulfillJson(route, { message: 'Not found' }, 404);
        return;
      }
      await this.fulfillJson(route, document);
      return;
    }
    if (path === documentPath && method === 'PUT') {
      await this.writeDocument(route);
      return;
    }

    const metadataPath =
      this.provider === 'git' ? '/lfs/object/metadata' : '/object/metadata';
    if (path === metadataPath && method === 'GET') {
      const remotePath = url.searchParams.get('path') ?? '';
      const object = this.objects.get(remotePath);
      if (!object) {
        await this.fulfillJson(route, { message: 'Not found' }, 404);
        return;
      }
      await this.fulfillJson(route, objectMetadata(object));
      return;
    }

    const objectPath = this.provider === 'git' ? '/lfs/object' : '/object';
    if (path === objectPath && method === 'PUT') {
      await this.uploadObject(route, url.searchParams.get('path') ?? '');
      return;
    }
    if (path === objectPath && method === 'GET') {
      const remotePath = url.searchParams.get('path') ?? '';
      const object = this.objects.get(remotePath);
      if (!object) {
        await this.fulfillJson(route, { message: 'Not found' }, 404);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: object.mediaType,
        body: object.content,
      });
      return;
    }

    await this.fulfillJson(route, { message: 'Unsupported test route' }, 404);
  }

  private session(): object {
    if (this.provider === 'git') {
      return {
        authenticated: true,
        user: { id: 1, login: 'omnia-e2e', avatarUrl: '' },
        repository: {
          id: 1,
          fullName: 'omnia-reader/e2e-library',
          private: true,
          defaultBranch: 'main',
          canPush: true,
        },
      };
    }
    return {
      authenticated: true,
      account: 'omnia-e2e@example.test',
      folder: {
        handle: 'e2e-folder',
        name: 'Omnia Reader',
        path: '/Omnia Reader',
        canWrite: true,
      },
    };
  }

  private async writeDocument(route: Route): Promise<void> {
    const value: unknown = route.request().postDataJSON();
    if (
      !isRecord(value) ||
      typeof value['path'] !== 'string' ||
      typeof value['content'] !== 'string'
    ) {
      await this.fulfillJson(route, { message: 'Invalid document' }, 400);
      return;
    }

    const path = value['path'];
    if (this.conflictNextBookManifestWrite && path.endsWith('/book.json')) {
      this.conflictNextBookManifestWrite = false;
      await this.fulfillJson(route, { message: 'Simulated conflict' }, 409);
      return;
    }

    const current = this.documents.get(path);
    const expectedRevision = value['expectedRevision'];
    if (
      (current && expectedRevision !== current.revision) ||
      (!current && expectedRevision !== undefined)
    ) {
      await this.fulfillJson(route, { message: 'Revision changed' }, 409);
      return;
    }

    const document: SimulatedDocument = {
      path,
      content: value['content'],
      revision: this.nextRevision(),
    };
    this.documents.set(path, document);
    await this.fulfillJson(route, document);
  }

  private async uploadObject(route: Route, path: string): Promise<void> {
    const request = route.request();
    const headers = request.headers();
    const declaredSize = Number(headers['x-omnia-size']);
    const declaredSha256 = headers['x-omnia-sha256'];
    const content = this.interceptedPublicationBody(
      request.postDataBuffer(),
      declaredSize,
      declaredSha256,
    );
    const actualSha256 = createHash('sha256').update(content).digest('hex');

    if (
      !path ||
      !Number.isSafeInteger(declaredSize) ||
      declaredSize !== content.byteLength ||
      declaredSha256 !== actualSha256
    ) {
      await this.fulfillJson(
        route,
        {
          message:
            'Publication integrity check failed ' +
            `(declared size ${headers['x-omnia-size'] ?? 'missing'}, ` +
            `received ${content.byteLength}; declared SHA-256 ` +
            `${declaredSha256 ?? 'missing'}, received ${actualSha256})`,
        },
        400,
      );
      return;
    }

    if (this.interruptNextObjectUpload) {
      this.interruptNextObjectUpload = false;
      await this.fulfillJson(
        route,
        { message: 'Simulated interrupted publication upload' },
        503,
      );
      return;
    }

    const existing = this.objects.get(path);
    if (
      existing &&
      (existing.sha256 !== declaredSha256 || existing.size !== declaredSize)
    ) {
      await this.fulfillJson(
        route,
        { message: 'A different publication already exists' },
        409,
      );
      return;
    }
    if (existing) {
      await this.fulfillJson(route, objectMetadata(existing));
      return;
    }

    const object: SimulatedObject = {
      path,
      revision: this.nextRevision(),
      size: declaredSize,
      sha256: declaredSha256,
      mediaType: headers['content-type'] ?? 'application/octet-stream',
      content,
    };
    this.objects.set(path, object);
    await this.fulfillJson(route, objectMetadata(object));
  }

  private interceptedPublicationBody(
    intercepted: Buffer | null,
    declaredSize: number,
    declaredSha256: string | undefined,
  ): Buffer {
    if (intercepted?.byteLength || declaredSize === 0) {
      return intercepted ?? Buffer.alloc(0);
    }

    // Playwright WebKit does not expose a fetch(Blob) body to route handlers.
    // Reuse only the exact pre-registered fixture whose length and digest match
    // the browser's integrity headers; Chromium and Firefox validate the
    // intercepted request bytes directly.
    const expected = this.expectedPublication;
    if (
      expected?.byteLength === declaredSize &&
      createHash('sha256').update(expected).digest('hex') === declaredSha256
    ) {
      return Buffer.from(expected);
    }
    return Buffer.alloc(0);
  }

  private nextRevision(): string {
    this.revisionSequence += 1;
    return `e2e-r${this.revisionSequence}`;
  }

  private async fulfillJson(
    route: Route,
    value: unknown,
    status = 200,
  ): Promise<void> {
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(value),
    });
  }
}

function objectMetadata(object: SimulatedObject): object {
  return {
    path: object.path,
    revision: object.revision,
    size: object.size,
    sha256: object.sha256,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
