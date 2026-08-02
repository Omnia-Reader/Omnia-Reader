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

interface SimulatedGitRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
}

interface SimulatedSyncGatewayOptions {
  authenticated?: boolean;
  expireGitHubAuthorizationOnRepositories?: boolean;
  forbidRepositoryCreation?: boolean;
  rateLimitGitHubRepositories?: boolean;
  interruptFirstObjectUpload?: boolean;
  conflictFirstBookManifestWrite?: boolean;
  holdFirstObjectUpload?: boolean;
  expectedPublication?: Buffer;
  selectedGitRepository?: boolean;
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
  private holdNextObjectUpload: boolean;
  private authenticated: boolean;
  private expireGitHubAuthorizationOnRepositories: boolean;
  private rateLimitGitHubRepositories: boolean;
  private readonly forbidRepositoryCreation: boolean;
  private readonly expectedPublication?: Buffer;
  private resolveObjectUploadStarted: () => void = () => undefined;
  private readonly objectUploadStarted = new Promise<void>((resolve) => {
    this.resolveObjectUploadStarted = resolve;
  });
  private releaseHeldObjectUpload: () => void = () => undefined;
  private readonly heldObjectUploadReleased = new Promise<void>((resolve) => {
    this.releaseHeldObjectUpload = resolve;
  });
  private readonly gitRepositories: SimulatedGitRepository[] = [
    {
      id: 1,
      fullName: 'omnia-reader/e2e-library',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    },
  ];
  private selectedGitRepository: SimulatedGitRepository | null;
  private readonly requests: string[] = [];

  constructor(
    readonly provider: SimulatedSyncProvider,
    options: SimulatedSyncGatewayOptions = {},
  ) {
    this.authenticated = options.authenticated ?? true;
    this.expireGitHubAuthorizationOnRepositories =
      options.expireGitHubAuthorizationOnRepositories ?? false;
    this.rateLimitGitHubRepositories =
      options.rateLimitGitHubRepositories ?? false;
    this.forbidRepositoryCreation = options.forbidRepositoryCreation ?? false;
    this.interruptNextObjectUpload =
      options.interruptFirstObjectUpload ?? false;
    this.conflictNextBookManifestWrite =
      options.conflictFirstBookManifestWrite ?? false;
    this.holdNextObjectUpload = options.holdFirstObjectUpload ?? false;
    this.expectedPublication = options.expectedPublication
      ? Buffer.from(options.expectedPublication)
      : undefined;
    this.selectedGitRepository =
      options.selectedGitRepository === false
        ? null
        : (this.gitRepositories[0] ?? null);
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

  documentContent(path: string): string | null {
    return this.documents.get(path)?.content ?? null;
  }

  objectPaths(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  waitForObjectUploadStart(): Promise<void> {
    return this.objectUploadStarted;
  }

  releaseObjectUpload(): void {
    this.releaseHeldObjectUpload();
  }

  clearRequestHistory(): void {
    this.requests.length = 0;
  }

  requestHistory(): readonly string[] {
    return [...this.requests];
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const basePath =
      this.provider === 'git' ? '/api/sync/github' : '/api/sync/mega';
    const path = url.pathname.slice(basePath.length);
    const method = request.method();
    this.requests.push(`${method} ${path}`);

    if (path === '/session' && method === 'GET') {
      await this.fulfillJson(route, this.session());
      return;
    }
    if (path === '/session' && method === 'DELETE') {
      await route.fulfill({ status: 204 });
      return;
    }
    if (this.provider === 'git' && path === '/repositories') {
      if (this.rateLimitGitHubRepositories) {
        this.rateLimitGitHubRepositories = false;
        await this.fulfillJson(
          route,
          { message: 'Provider-controlled rate-limit detail' },
          429,
          { 'Retry-After': '120' },
        );
        return;
      }
      if (this.expireGitHubAuthorizationOnRepositories) {
        this.expireGitHubAuthorizationOnRepositories = false;
        this.authenticated = false;
        await this.fulfillJson(
          route,
          { message: 'Provider-controlled revocation detail' },
          401,
        );
        return;
      }
      await this.fulfillJson(route, {
        repositories: this.gitRepositories,
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
      this.provider === 'git' &&
      path === '/repository' &&
      method === 'POST'
    ) {
      if (this.forbidRepositoryCreation) {
        await this.fulfillJson(
          route,
          { message: 'Provider-controlled permission detail' },
          403,
        );
        return;
      }
      const value: unknown = request.postDataJSON();
      const name =
        isRecord(value) && typeof value['name'] === 'string'
          ? value['name']
          : '';
      if (!/^[a-z0-9._-]{1,100}$/i.test(name)) {
        await this.fulfillJson(route, { message: 'Invalid repository' }, 400);
        return;
      }
      const repository: SimulatedGitRepository = {
        id: 2,
        fullName: `omnia-e2e/${name}`,
        private: true,
        defaultBranch: 'main',
        canPush: true,
      };
      this.gitRepositories.push(repository);
      this.selectedGitRepository = repository;
      await this.fulfillJson(route, {
        repository,
        selected: true,
        session: this.session(),
        installationSettingsUrl: null,
      });
      return;
    }
    if (
      (this.provider === 'git' && path === '/repository' && method === 'PUT') ||
      (this.provider === 'mega' && path === '/folder')
    ) {
      if (this.provider === 'git') {
        const value: unknown = request.postDataJSON();
        const repositoryId =
          isRecord(value) && typeof value['repositoryId'] === 'number'
            ? value['repositoryId']
            : 0;
        this.selectedGitRepository =
          this.gitRepositories.find(
            (repository) => repository.id === repositoryId,
          ) ?? this.selectedGitRepository;
      }
      await this.fulfillJson(route, this.session());
      return;
    }

    if (this.provider === 'git' && path === '/revision' && method === 'GET') {
      const repository = this.selectedGitRepository;
      if (!repository) {
        await this.fulfillJson(
          route,
          { message: 'No repository selected' },
          404,
        );
        return;
      }
      await this.fulfillJson(route, {
        revision: `${repository.id}:${repository.defaultBranch}:e2e-r${this.revisionSequence}`,
      });
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
        if (url.searchParams.get('optional') === 'true') {
          await route.fulfill({
            status: 204,
            headers: { 'Cache-Control': 'no-store' },
          });
        } else {
          await this.fulfillJson(route, { message: 'Not found' }, 404);
        }
        return;
      }
      await this.fulfillJson(route, document);
      return;
    }
    if (path === documentPath && method === 'PUT') {
      await this.writeDocument(route);
      return;
    }
    if (path === documentPath && method === 'DELETE') {
      const remotePath = url.searchParams.get('path') ?? '';
      const expectedRevision = url.searchParams.get('expectedRevision');
      const document = this.documents.get(remotePath);
      if (!document) {
        await this.fulfillJson(route, { message: 'Not found' }, 404);
        return;
      }
      if (expectedRevision !== null && expectedRevision !== document.revision) {
        await this.fulfillJson(route, { message: 'Revision changed' }, 409);
        return;
      }
      this.documents.delete(remotePath);
      this.nextRevision();
      await route.fulfill({ status: 204 });
      return;
    }

    const metadataPath =
      this.provider === 'git' ? '/lfs/object/metadata' : '/object/metadata';
    if (path === metadataPath && method === 'GET') {
      const remotePath = url.searchParams.get('path') ?? '';
      const object = this.objects.get(remotePath);
      if (!object) {
        if (url.searchParams.get('optional') === 'true') {
          await route.fulfill({
            status: 204,
            headers: { 'Cache-Control': 'no-store' },
          });
        } else {
          await this.fulfillJson(route, { message: 'Not found' }, 404);
        }
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
    if (path === objectPath && method === 'DELETE') {
      const remotePath = url.searchParams.get('path') ?? '';
      const expectedRevision = url.searchParams.get('expectedRevision');
      const object = this.objects.get(remotePath);
      if (!object) {
        await this.fulfillJson(route, { message: 'Not found' }, 404);
        return;
      }
      if (expectedRevision !== null && expectedRevision !== object.revision) {
        await this.fulfillJson(route, { message: 'Revision changed' }, 409);
        return;
      }
      this.objects.delete(remotePath);
      this.nextRevision();
      await route.fulfill({ status: 204 });
      return;
    }

    await this.fulfillJson(route, { message: 'Unsupported test route' }, 404);
  }

  private session(): object {
    if (this.provider === 'git') {
      if (!this.authenticated) {
        return {
          configured: true,
          authenticated: false,
          installationUrl:
            'https://github.test/apps/omnia-reader/installations/new',
        };
      }
      return {
        configured: true,
        authenticated: true,
        installationUrl:
          'https://github.test/apps/omnia-reader/installations/new',
        user: { id: 1, login: 'omnia-e2e', avatarUrl: '' },
        repository: this.selectedGitRepository,
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

    if (this.holdNextObjectUpload) {
      this.holdNextObjectUpload = false;
      this.resolveObjectUploadStarted();
      await this.heldObjectUploadReleased;
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
    headers: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store', ...headers },
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
