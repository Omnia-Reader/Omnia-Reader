import { createHash, randomBytes, sign } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  GatewayHttpError,
  type DocumentWriteRequest,
  type RemoteDocument,
  type RemoteObject,
  type RemoteObjectDownload,
  type RemoteObjectUpload,
  type SyncGatewayAdapter,
} from './gateway-contract.js';
import type { GatewaySessionStore } from './session-store.js';

interface GitHubUser {
  id: number;
  login: string;
  avatarUrl: string;
}

interface GitHubRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  installationId: number;
}

interface CreatedGitHubRepository {
  id: number;
  fullName: string;
  private: true;
  defaultBranch: string;
}

export interface GitHubSessionState {
  authorizationState?: string;
  returnTo?: string;
  userAccessToken?: string;
  userTokenExpiresAt?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  user?: GitHubUser;
  repositories?: GitHubRepository[];
  repository?: GitHubRepository;
  installationAccessToken?: string;
  installationTokenExpiresAt?: number;
}

export interface GitHubAdapterOptions {
  clientId: string;
  clientSecret: string;
  appId: string;
  privateKey: string;
  callbackUrl: string;
  sessions: GatewaySessionStore<GitHubSessionState>;
  fetcher?: typeof fetch;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  apiVersion?: string;
  now?: () => number;
  randomState?: () => string;
}

interface GitHubContent {
  path: string;
  sha: string;
  content: string;
  encoding: string;
  type: string;
}

interface LfsAction {
  href: string;
  header?: Record<string, string>;
}

interface LfsObjectResponse {
  oid: string;
  size: number;
  actions?: {
    upload?: LfsAction;
    download?: LfsAction;
    verify?: LfsAction;
  };
  error?: { code: number; message: string };
}

const GIT_ATTRIBUTES = [
  '.omnia-reader/v1/books/**/*.epub filter=lfs diff=lfs merge=lfs -text',
  '.omnia-reader/v1/books/**/*.pdf filter=lfs diff=lfs merge=lfs -text',
];
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MAX_REMOTE_DOCUMENTS = 10_000;

export class GitHubSyncGatewayAdapter implements SyncGatewayAdapter {
  private readonly fetcher: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;
  private readonly apiVersion: string;
  private readonly now: () => number;
  private readonly randomState: () => string;

  constructor(private readonly options: GitHubAdapterOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.apiBaseUrl = stripTrailingSlash(
      options.apiBaseUrl ?? 'https://api.github.com',
    );
    this.webBaseUrl = stripTrailingSlash(
      options.webBaseUrl ?? 'https://github.com',
    );
    this.apiVersion = options.apiVersion ?? '2026-03-10';
    this.now = options.now ?? Date.now;
    this.randomState =
      options.randomState ?? (() => randomBytes(32).toString('base64url'));
  }

  async session(sessionId: string): Promise<unknown> {
    const state = await this.authenticatedState(sessionId, false);
    return state ? this.publicSession(state) : { authenticated: false };
  }

  async authorizationUrl(sessionId: string, returnTo: string): Promise<string> {
    const authorizationState = this.randomState();
    await this.options.sessions.set(sessionId, {
      authorizationState,
      returnTo,
    });
    const url = new URL('/login/oauth/authorize', this.webBaseUrl);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.callbackUrl);
    url.searchParams.set('state', authorizationState);
    return url.toString();
  }

  async completeAuthorization(
    sessionId: string,
    replacementSessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<string> {
    const pending = await this.options.sessions.get(sessionId);
    if (
      !pending?.authorizationState ||
      !parameters['state'] ||
      parameters['state'] !== pending.authorizationState
    ) {
      throw new GatewayHttpError(400, 'GitHub authorization state is invalid');
    }
    if (parameters['error']) {
      throw new GatewayHttpError(401, 'GitHub authorization was not granted');
    }
    const code = parameters['code'];
    if (!code || code.length > 1024) {
      throw new GatewayHttpError(400, 'GitHub authorization code is missing');
    }

    const token = await this.exchangeAuthorizationCode(code);
    const user = await this.githubJson<unknown>('/user', {
      token: token.accessToken,
    });
    const authenticated: GitHubSessionState = {
      userAccessToken: token.accessToken,
      ...(token.expiresAt ? { userTokenExpiresAt: token.expiresAt } : {}),
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.refreshExpiresAt
        ? { refreshTokenExpiresAt: token.refreshExpiresAt }
        : {}),
      user: parseUser(user),
    };
    await this.options.sessions.move(
      sessionId,
      replacementSessionId,
      authenticated,
    );
    return pending.returnTo ?? '/settings/sync';
  }

  async disconnect(sessionId: string): Promise<void> {
    await this.options.sessions.delete(sessionId);
  }

  async destinations(sessionId: string): Promise<readonly unknown[]> {
    const state = await this.requireAuthenticatedState(sessionId);
    const repositories = await this.loadRepositories(sessionId, state);
    return repositories.map(publicRepository);
  }

  async selectDestination(
    sessionId: string,
    selection: unknown,
  ): Promise<unknown> {
    if (
      !isRecord(selection) ||
      !Number.isSafeInteger(selection['repositoryId']) ||
      (selection['repositoryId'] as number) <= 0
    ) {
      throw new GatewayHttpError(400, 'A valid repository ID is required');
    }
    const state = await this.requireAuthenticatedState(sessionId);
    const repositories = await this.loadRepositories(sessionId, state);
    const repository = repositories.find(
      (candidate) => candidate.id === selection['repositoryId'],
    );
    if (!repository || !repository.canPush) {
      throw new GatewayHttpError(
        403,
        'The GitHub App cannot write to that repository',
      );
    }
    const updated: GitHubSessionState = {
      ...state,
      repositories,
      repository,
      installationAccessToken: undefined,
      installationTokenExpiresAt: undefined,
    };
    await this.options.sessions.set(sessionId, updated);
    return this.publicSession(updated);
  }

  async createDestination(
    sessionId: string,
    request: unknown,
  ): Promise<unknown> {
    const name = privateRepositoryName(request);
    const state = await this.requireAuthenticatedState(sessionId);
    if (!state.userAccessToken) {
      throw new GatewayHttpError(401, 'GitHub authentication is required');
    }
    const value = await this.githubJson<unknown>('/user/repos', {
      method: 'POST',
      token: state.userAccessToken,
      body: {
        name,
        description:
          'Private Omnia Reader library, publication, and reading progress synchronization',
        private: true,
        auto_init: true,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
        has_discussions: false,
      },
    });
    const created = parseCreatedRepository(value);
    const repositories = await this.loadRepositories(sessionId, state);
    const selected = repositories.find(
      (repository) => repository.id === created.id && repository.canPush,
    );
    const refreshed = await this.requireAuthenticatedState(sessionId);
    const updated: GitHubSessionState = selected
      ? {
          ...refreshed,
          repositories,
          repository: selected,
          installationAccessToken: undefined,
          installationTokenExpiresAt: undefined,
        }
      : refreshed;
    if (selected) {
      await this.options.sessions.set(sessionId, updated);
    }
    return {
      repository: publicCreatedRepository(created),
      selected: !!selected,
      session: this.publicSession(updated),
      installationSettingsUrl: selected
        ? null
        : `${this.webBaseUrl}/settings/installations`,
    };
  }

  async listDocuments(
    sessionId: string,
    prefix: string,
  ): Promise<readonly RemoteDocument[]> {
    const context = await this.repositoryContext(sessionId);
    const branch = encodeURIComponent(context.repository.defaultBranch);
    const tree = await this.githubJson<unknown>(
      `/repos/${encodeFullName(context.repository.fullName)}/git/trees/${branch}?recursive=1`,
      { token: context.token },
      [404],
    );
    if (tree === null) {
      return [];
    }
    if (!isRecord(tree) || !Array.isArray(tree['tree'])) {
      throw providerProtocolError();
    }
    const blobs = tree['tree'].filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        entry['type'] === 'blob' &&
        typeof entry['path'] === 'string' &&
        (entry['path'] === prefix ||
          (entry['path'] as string).startsWith(`${prefix}/`)) &&
        isGitSha(entry['sha']),
    );
    if (blobs.length > MAX_REMOTE_DOCUMENTS) {
      throw new GatewayHttpError(
        413,
        'The synchronization document set is too large',
      );
    }
    const documents: RemoteDocument[] = [];
    for (const blob of blobs) {
      const content = await this.readBlob(
        context.repository,
        context.token,
        blob['sha'] as string,
      );
      documents.push({
        path: blob['path'] as string,
        content,
        revision: blob['sha'] as string,
      });
    }
    return documents;
  }

  async readDocument(
    sessionId: string,
    path: string,
  ): Promise<RemoteDocument | null> {
    const context = await this.repositoryContext(sessionId);
    return this.readFile(context.repository, context.token, path);
  }

  async writeDocument(
    sessionId: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument> {
    const context = await this.repositoryContext(sessionId);
    return this.writeFile(context.repository, context.token, request);
  }

  async headObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObject | null> {
    const context = await this.repositoryContext(sessionId);
    const pointer = await this.readFile(
      context.repository,
      context.token,
      path,
    );
    return pointer ? parseLfsPointer(path, pointer) : null;
  }

  async downloadObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObjectDownload | null> {
    const context = await this.repositoryContext(sessionId);
    const pointer = await this.readFile(
      context.repository,
      context.token,
      path,
    );
    if (!pointer) {
      return null;
    }
    const metadata = parseLfsPointer(path, pointer);
    const object = await this.lfsBatch(
      context.repository,
      context.token,
      'download',
      metadata.sha256,
      metadata.size,
    );
    const action = object.actions?.download;
    if (!action) {
      throw providerProtocolError('Git LFS did not provide a download action');
    }
    const response = await this.fetcher(action.href, {
      method: 'GET',
      headers: actionHeaders(action),
      redirect: 'error',
    });
    if (!response.ok || !response.body) {
      throw await providerHttpError(response);
    }
    const verifier = integrityTransform(metadata.sha256, metadata.size);
    Readable.fromWeb(response.body).pipe(verifier);
    return {
      metadata,
      mediaType: path.endsWith('.pdf')
        ? 'application/pdf'
        : 'application/epub+zip',
      content: verifier,
    };
  }

  async uploadObject(
    sessionId: string,
    upload: RemoteObjectUpload,
  ): Promise<RemoteObject> {
    const context = await this.repositoryContext(sessionId);
    const existing = await this.readFile(
      context.repository,
      context.token,
      upload.path,
    );
    if (existing) {
      const metadata = parseLfsPointer(upload.path, existing);
      if (metadata.sha256 !== upload.sha256 || metadata.size !== upload.size) {
        throw new GatewayHttpError(
          409,
          'A different publication already exists at that path',
        );
      }
      await verifyReadable(upload.content, upload.sha256, upload.size);
      return metadata;
    }

    const object = await this.lfsBatch(
      context.repository,
      context.token,
      'upload',
      upload.sha256,
      upload.size,
    );
    if (object.actions?.upload) {
      await this.uploadLfsContent(object.actions.upload, upload);
    } else {
      await verifyReadable(upload.content, upload.sha256, upload.size);
    }
    if (object.actions?.verify) {
      const verifyResponse = await this.fetcher(object.actions.verify.href, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.git-lfs+json',
          ...actionHeaders(object.actions.verify),
        },
        body: JSON.stringify({ oid: upload.sha256, size: upload.size }),
        redirect: 'error',
      });
      if (!verifyResponse.ok) {
        throw await providerHttpError(verifyResponse);
      }
    }

    await this.ensureGitAttributes(context.repository, context.token);
    const pointer = lfsPointer(upload.sha256, upload.size);
    let document: RemoteDocument;
    try {
      document = await this.writeFile(context.repository, context.token, {
        path: upload.path,
        content: pointer,
        message: `Omnia Reader: add publication ${upload.sha256.slice(0, 12)}`,
      });
    } catch (error) {
      if (!(error instanceof GatewayHttpError) || error.statusCode !== 409) {
        throw error;
      }
      const concurrent = await this.readFile(
        context.repository,
        context.token,
        upload.path,
      );
      if (!concurrent || concurrent.content !== pointer) {
        throw error;
      }
      document = concurrent;
    }
    return {
      path: upload.path,
      revision: document.revision,
      size: upload.size,
      sha256: upload.sha256,
    };
  }

  private async exchangeAuthorizationCode(code: string): Promise<{
    accessToken: string;
    expiresAt?: number;
    refreshToken?: string;
    refreshExpiresAt?: number;
  }> {
    const response = await this.fetcher(
      `${this.webBaseUrl}/login/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          code,
          redirect_uri: this.options.callbackUrl,
        }),
        redirect: 'error',
      },
    );
    const value = await responseJson(response);
    if (!response.ok) {
      throw await providerHttpError(response, value);
    }
    if (!isRecord(value) || !isBoundedString(value['access_token'], 4096)) {
      throw providerProtocolError();
    }
    const expiresIn = positiveNumber(value['expires_in']);
    const refreshExpiresIn = positiveNumber(value['refresh_token_expires_in']);
    return {
      accessToken: value['access_token'],
      ...(expiresIn ? { expiresAt: this.now() + expiresIn * 1000 } : {}),
      ...(isBoundedString(value['refresh_token'], 4096)
        ? { refreshToken: value['refresh_token'] }
        : {}),
      ...(refreshExpiresIn
        ? { refreshExpiresAt: this.now() + refreshExpiresIn * 1000 }
        : {}),
    };
  }

  private async authenticatedState(
    sessionId: string,
    required: boolean,
  ): Promise<GitHubSessionState | null> {
    const state = await this.options.sessions.get(sessionId);
    if (!state?.user || !state.userAccessToken) {
      if (required) {
        throw new GatewayHttpError(401, 'GitHub authentication is required');
      }
      return null;
    }
    if (
      state.userTokenExpiresAt &&
      state.userTokenExpiresAt <= this.now() + TOKEN_REFRESH_MARGIN_MS
    ) {
      if (
        !state.refreshToken ||
        (state.refreshTokenExpiresAt &&
          state.refreshTokenExpiresAt <= this.now())
      ) {
        await this.options.sessions.delete(sessionId);
        if (required) {
          throw new GatewayHttpError(401, 'GitHub session has expired');
        }
        return null;
      }
      const refreshed = await this.refreshUserToken(state.refreshToken);
      const updated: GitHubSessionState = {
        ...state,
        userAccessToken: refreshed.accessToken,
        userTokenExpiresAt: refreshed.expiresAt,
        refreshToken: refreshed.refreshToken ?? state.refreshToken,
        refreshTokenExpiresAt:
          refreshed.refreshExpiresAt ?? state.refreshTokenExpiresAt,
      };
      await this.options.sessions.set(sessionId, updated);
      return updated;
    }
    return state;
  }

  private async requireAuthenticatedState(
    sessionId: string,
  ): Promise<GitHubSessionState> {
    const state = await this.authenticatedState(sessionId, true);
    if (!state) {
      throw new GatewayHttpError(401, 'GitHub authentication is required');
    }
    return state;
  }

  private async refreshUserToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: number;
    refreshToken?: string;
    refreshExpiresAt?: number;
  }> {
    const response = await this.fetcher(
      `${this.webBaseUrl}/login/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        redirect: 'error',
      },
    );
    const value = await responseJson(response);
    if (
      !response.ok ||
      !isRecord(value) ||
      !isBoundedString(value['access_token'], 4096) ||
      !positiveNumber(value['expires_in'])
    ) {
      throw new GatewayHttpError(401, 'GitHub session refresh failed');
    }
    const expiresIn = value['expires_in'] as number;
    const refreshExpiresIn = positiveNumber(value['refresh_token_expires_in']);
    return {
      accessToken: value['access_token'],
      expiresAt: this.now() + expiresIn * 1000,
      ...(isBoundedString(value['refresh_token'], 4096)
        ? { refreshToken: value['refresh_token'] }
        : {}),
      ...(refreshExpiresIn
        ? { refreshExpiresAt: this.now() + refreshExpiresIn * 1000 }
        : {}),
    };
  }

  private async loadRepositories(
    sessionId: string,
    state: GitHubSessionState,
  ): Promise<GitHubRepository[]> {
    if (!state.userAccessToken) {
      throw new GatewayHttpError(401, 'GitHub authentication is required');
    }
    const installations = await this.githubPaginated(
      '/user/installations?per_page=100',
      state.userAccessToken,
      'installations',
    );
    const repositories: GitHubRepository[] = [];
    for (const installation of installations) {
      if (!isRecord(installation) || !positiveInteger(installation['id'])) {
        throw providerProtocolError();
      }
      const installationId = installation['id'];
      const values = await this.githubPaginated(
        `/user/installations/${installationId}/repositories?per_page=100`,
        state.userAccessToken,
        'repositories',
      );
      for (const value of values) {
        repositories.push(parseRepository(value, installationId));
      }
    }
    const unique = [
      ...new Map(
        repositories.map((repository) => [repository.id, repository]),
      ).values(),
    ].sort((left, right) => left.fullName.localeCompare(right.fullName));
    const selected = state.repository
      ? unique.find((repository) => repository.id === state.repository?.id)
      : undefined;
    await this.options.sessions.set(sessionId, {
      ...state,
      repositories: unique,
      repository: selected,
      ...(!selected
        ? {
            installationAccessToken: undefined,
            installationTokenExpiresAt: undefined,
          }
        : {}),
    });
    return unique;
  }

  private async repositoryContext(sessionId: string): Promise<{
    repository: GitHubRepository;
    token: string;
  }> {
    const state = await this.requireAuthenticatedState(sessionId);
    if (!state.repository) {
      throw new GatewayHttpError(404, 'No GitHub repository is selected');
    }
    if (
      state.installationAccessToken &&
      state.installationTokenExpiresAt &&
      state.installationTokenExpiresAt > this.now() + TOKEN_REFRESH_MARGIN_MS
    ) {
      return {
        repository: state.repository,
        token: state.installationAccessToken,
      };
    }
    const jwt = this.appJwt();
    const value = await this.githubJson<unknown>(
      `/app/installations/${state.repository.installationId}/access_tokens`,
      {
        method: 'POST',
        token: jwt,
        body: {
          repository_ids: [state.repository.id],
          permissions: { contents: 'write' },
        },
      },
    );
    if (
      !isRecord(value) ||
      !isBoundedString(value['token'], 4096) ||
      typeof value['expires_at'] !== 'string'
    ) {
      throw providerProtocolError();
    }
    const expiresAt = Date.parse(value['expires_at']);
    if (!Number.isFinite(expiresAt)) {
      throw providerProtocolError();
    }
    const updated: GitHubSessionState = {
      ...state,
      installationAccessToken: value['token'],
      installationTokenExpiresAt: expiresAt,
    };
    await this.options.sessions.set(sessionId, updated);
    return { repository: state.repository, token: value['token'] };
  }

  private appJwt(): string {
    const nowSeconds = Math.floor(this.now() / 1000);
    const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
    const payload = base64UrlJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: this.options.appId,
    });
    const unsigned = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), {
      key: this.options.privateKey,
    }).toString('base64url');
    return `${unsigned}.${signature}`;
  }

  private async githubPaginated(
    path: string,
    token: string,
    collection: string,
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    let next: string | null = `${this.apiBaseUrl}${path}`;
    while (next) {
      if (!next.startsWith(`${this.apiBaseUrl}/`)) {
        throw providerProtocolError();
      }
      const response = await this.githubResponse(next, { token });
      const value = await responseJson(response);
      if (
        !response.ok ||
        !isRecord(value) ||
        !Array.isArray(value[collection])
      ) {
        if (!response.ok) {
          throw await providerHttpError(response, value);
        }
        throw providerProtocolError();
      }
      result.push(...value[collection]);
      next = nextLink(response.headers.get('link'));
    }
    return result;
  }

  private async githubJson<T>(
    path: string,
    request: {
      method?: string;
      token?: string;
      body?: unknown;
    } = {},
    nullStatuses: readonly number[] = [],
  ): Promise<T | null> {
    const response = await this.githubResponse(
      path.startsWith('http') ? path : `${this.apiBaseUrl}${path}`,
      request,
    );
    if (nullStatuses.includes(response.status)) {
      return null;
    }
    const value = await responseJson(response);
    if (!response.ok) {
      throw await providerHttpError(response, value);
    }
    return value as T;
  }

  private async githubResponse(
    url: string,
    request: {
      method?: string;
      token?: string;
      body?: unknown;
    },
  ): Promise<Response> {
    return this.fetcher(url, {
      method: request.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': this.apiVersion,
        'User-Agent': 'Omnia-Reader-Sync-Gateway',
        ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}),
        ...(request.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      redirect: 'error',
    });
  }

  private async readFile(
    repository: GitHubRepository,
    token: string,
    path: string,
  ): Promise<RemoteDocument | null> {
    const value = await this.githubJson<unknown>(
      `/repos/${encodeFullName(repository.fullName)}/contents/${encodePath(path)}?ref=${encodeURIComponent(repository.defaultBranch)}`,
      { token },
      [404],
    );
    if (value === null) {
      return null;
    }
    const content = parseContent(value);
    return {
      path,
      content: decodeBase64(content.content),
      revision: content.sha,
    };
  }

  private async readBlob(
    repository: GitHubRepository,
    token: string,
    sha: string,
  ): Promise<string> {
    const value = await this.githubJson<unknown>(
      `/repos/${encodeFullName(repository.fullName)}/git/blobs/${sha}`,
      { token },
    );
    if (
      !isRecord(value) ||
      value['encoding'] !== 'base64' ||
      typeof value['content'] !== 'string'
    ) {
      throw providerProtocolError();
    }
    return decodeBase64(value['content']);
  }

  private async writeFile(
    repository: GitHubRepository,
    token: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument> {
    const current = await this.readFile(repository, token, request.path);
    if (
      (request.expectedRevision !== undefined &&
        current?.revision !== request.expectedRevision) ||
      (request.expectedRevision === undefined && current !== null)
    ) {
      throw new GatewayHttpError(409, 'The remote Git document changed');
    }
    const value = await this.githubJson<unknown>(
      `/repos/${encodeFullName(repository.fullName)}/contents/${encodePath(request.path)}`,
      {
        method: 'PUT',
        token,
        body: {
          message: request.message,
          content: Buffer.from(request.content).toString('base64'),
          branch: repository.defaultBranch,
          ...(current ? { sha: current.revision } : {}),
        },
      },
    );
    if (
      !isRecord(value) ||
      !isRecord(value['content']) ||
      !isGitSha(value['content']['sha'])
    ) {
      throw providerProtocolError();
    }
    return {
      path: request.path,
      content: request.content,
      revision: value['content']['sha'],
    };
  }

  private async ensureGitAttributes(
    repository: GitHubRepository,
    token: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.readFile(repository, token, '.gitattributes');
      const lines = new Set(
        (current?.content ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      let changed = false;
      for (const line of GIT_ATTRIBUTES) {
        if (!lines.has(line)) {
          lines.add(line);
          changed = true;
        }
      }
      if (!changed) {
        return;
      }
      try {
        await this.writeFile(repository, token, {
          path: '.gitattributes',
          content: `${[...lines].join('\n')}\n`,
          message: 'Omnia Reader: configure Git LFS publications',
          ...(current ? { expectedRevision: current.revision } : {}),
        });
        return;
      } catch (error) {
        if (!(error instanceof GatewayHttpError) || error.statusCode !== 409) {
          throw error;
        }
      }
    }
    throw new GatewayHttpError(409, 'The remote .gitattributes file changed');
  }

  private async lfsBatch(
    repository: GitHubRepository,
    token: string,
    operation: 'upload' | 'download',
    oid: string,
    size: number,
  ): Promise<LfsObjectResponse> {
    const response = await this.fetcher(
      `${this.webBaseUrl}/${repository.fullName}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.git-lfs+json',
          'Content-Type': 'application/vnd.git-lfs+json',
          Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
          'User-Agent': 'Omnia-Reader-Sync-Gateway',
        },
        body: JSON.stringify({
          operation,
          transfers: ['basic'],
          ref: { name: `refs/heads/${repository.defaultBranch}` },
          objects: [{ oid, size }],
        }),
        redirect: 'error',
      },
    );
    const value = await responseJson(response);
    if (!response.ok) {
      throw await providerHttpError(response, value);
    }
    if (
      !isRecord(value) ||
      !Array.isArray(value['objects']) ||
      value['objects'].length !== 1 ||
      !isRecord(value['objects'][0])
    ) {
      throw providerProtocolError();
    }
    if (
      (value['transfer'] !== undefined && value['transfer'] !== 'basic') ||
      !isRecord(value['objects'][0])
    ) {
      throw providerProtocolError();
    }
    const object = parseLfsObjectResponse(value['objects'][0]);
    if (object.oid !== oid || object.size !== size) {
      throw providerProtocolError();
    }
    if (object.error) {
      throw new GatewayHttpError(
        mapProviderStatus(object.error.code),
        boundedProviderMessage(object.error.message),
      );
    }
    return object;
  }

  private async uploadLfsContent(
    action: LfsAction,
    upload: RemoteObjectUpload,
  ): Promise<void> {
    const verifier = integrityTransform(upload.sha256, upload.size);
    upload.content.pipe(verifier);
    const response = await this.fetcher(action.href, {
      method: 'PUT',
      headers: actionHeaders(action),
      body: verifier,
      duplex: 'half',
      redirect: 'error',
    } as RequestInit & { duplex: 'half' });
    await finished(verifier);
    if (!response.ok) {
      throw await providerHttpError(response);
    }
  }

  private publicSession(state: GitHubSessionState): unknown {
    if (!state.user) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      user: state.user,
      repository: state.repository ? publicRepository(state.repository) : null,
    };
  }
}

function parseUser(value: unknown): GitHubUser {
  if (
    !isRecord(value) ||
    !positiveInteger(value['id']) ||
    !isBoundedString(value['login'], 256) ||
    !isBoundedString(value['avatar_url'], 2048)
  ) {
    throw providerProtocolError();
  }
  return {
    id: value['id'],
    login: value['login'],
    avatarUrl: value['avatar_url'],
  };
}

function parseRepository(
  value: unknown,
  installationId: number,
): GitHubRepository {
  if (
    !isRecord(value) ||
    !positiveInteger(value['id']) ||
    !isBoundedString(value['full_name'], 512) ||
    typeof value['private'] !== 'boolean' ||
    !isBoundedString(value['default_branch'], 256) ||
    !isRecord(value['permissions']) ||
    typeof value['permissions']['push'] !== 'boolean'
  ) {
    throw providerProtocolError();
  }
  return {
    id: value['id'],
    fullName: value['full_name'],
    private: value['private'],
    defaultBranch: value['default_branch'],
    canPush: value['permissions']['push'],
    installationId,
  };
}

function parseCreatedRepository(value: unknown): CreatedGitHubRepository {
  if (
    !isRecord(value) ||
    !positiveInteger(value['id']) ||
    !isBoundedString(value['full_name'], 512) ||
    value['private'] !== true ||
    !isBoundedString(value['default_branch'], 256)
  ) {
    throw providerProtocolError();
  }
  return {
    id: value['id'],
    fullName: value['full_name'],
    private: true,
    defaultBranch: value['default_branch'],
  };
}

function publicRepository(repository: GitHubRepository): unknown {
  return {
    id: repository.id,
    fullName: repository.fullName,
    private: repository.private,
    defaultBranch: repository.defaultBranch,
    canPush: repository.canPush,
  };
}

function publicCreatedRepository(repository: CreatedGitHubRepository): unknown {
  return {
    ...repository,
    canPush: true,
  };
}

function parseContent(value: unknown): GitHubContent {
  if (
    !isRecord(value) ||
    value['type'] !== 'file' ||
    value['encoding'] !== 'base64' ||
    typeof value['path'] !== 'string' ||
    !isGitSha(value['sha']) ||
    typeof value['content'] !== 'string'
  ) {
    throw providerProtocolError();
  }
  return value as unknown as GitHubContent;
}

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8');
}

function parseLfsPointer(path: string, document: RemoteDocument): RemoteObject {
  const match =
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([1-9]\d*)\n$/.exec(
      document.content.replace(/\r\n/g, '\n'),
    );
  if (!match) {
    throw providerProtocolError('The Git LFS pointer is invalid');
  }
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size)) {
    throw providerProtocolError('The Git LFS pointer is invalid');
  }
  return {
    path,
    revision: document.revision,
    sha256: match[1],
    size,
  };
}

function lfsPointer(sha256: string, size: number): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${size}\n`;
}

function integrityTransform(
  expectedDigest: string,
  expectedSize: number,
): Transform {
  const hash = createHash('sha256');
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, encoding, callback) {
      void encoding;
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const digest = hash.digest('hex');
      callback(
        size === expectedSize && digest === expectedDigest
          ? null
          : new GatewayHttpError(400, 'Publication integrity check failed'),
      );
    },
  });
}

async function verifyReadable(
  content: Readable,
  digest: string,
  size: number,
): Promise<void> {
  const verifier = integrityTransform(digest, size);
  content.pipe(verifier);
  verifier.resume();
  await finished(verifier);
}

function actionHeaders(action: LfsAction): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(action.header ?? {})) {
    if (
      /^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(name) &&
      typeof value === 'string' &&
      !/[\r\n]/.test(value)
    ) {
      headers.set(name, value);
    }
  }
  return headers;
}

function parseLfsObjectResponse(
  value: Record<string, unknown>,
): LfsObjectResponse {
  if (
    typeof value['oid'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['oid']) ||
    !positiveInteger(value['size'])
  ) {
    throw providerProtocolError();
  }
  const error = value['error'];
  if (
    error !== undefined &&
    (!isRecord(error) ||
      !positiveInteger(error['code']) ||
      typeof error['message'] !== 'string')
  ) {
    throw providerProtocolError();
  }
  const rawActions = value['actions'];
  let actions: LfsObjectResponse['actions'];
  if (rawActions !== undefined) {
    if (!isRecord(rawActions)) {
      throw providerProtocolError();
    }
    actions = {};
    for (const name of ['upload', 'download', 'verify'] as const) {
      const action = rawActions[name];
      if (action !== undefined) {
        actions[name] = parseLfsAction(action);
      }
    }
  }
  return {
    oid: value['oid'],
    size: value['size'],
    ...(actions ? { actions } : {}),
    ...(isRecord(error)
      ? {
          error: {
            code: error['code'] as number,
            message: error['message'] as string,
          },
        }
      : {}),
  };
}

function parseLfsAction(value: unknown): LfsAction {
  if (!isRecord(value) || !isBoundedString(value['href'], 4096)) {
    throw providerProtocolError();
  }
  let url: URL;
  try {
    url = new URL(value['href']);
  } catch {
    throw providerProtocolError();
  }
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname)
    )
  ) {
    throw providerProtocolError('Git LFS returned an unsafe transfer URL');
  }
  const rawHeaders = value['header'];
  if (
    rawHeaders !== undefined &&
    (!isRecord(rawHeaders) ||
      !Object.values(rawHeaders).every(
        (header) => typeof header === 'string' && !/[\r\n]/.test(header),
      ))
  ) {
    throw providerProtocolError();
  }
  return {
    href: url.toString(),
    ...(isRecord(rawHeaders)
      ? { header: rawHeaders as Record<string, string> }
      : {}),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function providerHttpError(
  response: Response,
  parsed?: unknown,
): Promise<GatewayHttpError> {
  const value = parsed ?? (await responseJson(response));
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get('x-ratelimit-remaining') === '0');
  return new GatewayHttpError(
    rateLimited ? 429 : mapProviderStatus(response.status),
    isRecord(value) && typeof value['message'] === 'string'
      ? boundedProviderMessage(value['message'])
      : `GitHub provider request failed (${response.status})`,
  );
}

function mapProviderStatus(status: number): number {
  if ([400, 401, 403, 404, 409, 413, 422, 429, 507].includes(status)) {
    return status === 422 ? 409 : status;
  }
  return status >= 500 ? 502 : 400;
}

function boundedProviderMessage(value: string): string {
  return value.length > 0 && value.length <= 512
    ? value
    : 'GitHub provider request failed';
}

function providerProtocolError(
  message = 'GitHub returned an invalid synchronization response',
): GatewayHttpError {
  return new GatewayHttpError(502, message);
}

function nextLink(value: string | null): string | null {
  if (!value) {
    return null;
  }
  for (const segment of value.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(segment);
    if (match?.[2] === 'next') {
      return match[1];
    }
  }
  return null;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function encodeFullName(value: string): string {
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw providerProtocolError();
  }
  return parts.map(encodeURIComponent).join('/');
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function privateRepositoryName(value: unknown): string {
  if (!isRecord(value) || typeof value['name'] !== 'string') {
    throw new GatewayHttpError(400, 'A repository name is required');
  }
  const name = value['name'].trim();
  if (!/^[a-z0-9._-]{1,100}$/i.test(name) || name === '.' || name === '..') {
    throw new GatewayHttpError(
      400,
      'Repository names may contain letters, numbers, dots, hyphens, and underscores',
    );
  }
  return name;
}
