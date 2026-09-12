import {
  BrowserObjectUploadRequester,
  browserObjectDownloadBlob,
  browserObjectUploadRequest,
  DocumentDeleteRequest,
  LibrarySyncTransport,
  ObjectDeleteRequest,
  ObjectDownloadOptions,
  ObjectUploadRequest,
  RemoteObject,
  RemoteSyncEntry,
  RemoteSyncEntryDeleteRequest,
} from '@omnia-reader/sync/core';
import {
  GitConflictError,
  GitFile,
  GitWriteRequest,
} from './git-repository-transport';

export interface GitHubGatewayUser {
  id: number;
  login: string;
  avatarUrl: string;
}

export interface GitHubRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
}

export type GitHubGatewaySession =
  | { configured: false; authenticated: false }
  | {
      configured: true;
      authenticated: false;
      installationUrl: string;
    }
  | {
      configured: true;
      authenticated: true;
      installationUrl: string;
      user: GitHubGatewayUser;
      repository: GitHubRepository | null;
    };

export interface GitHubRepositoryCreationResult {
  repository: GitHubRepository;
  selected: boolean;
  session: GitHubGatewaySession;
  installationSettingsUrl: string | null;
}

export interface GitHubGateway extends LibrarySyncTransport {
  session(): Promise<GitHubGatewaySession>;
  repositories(): Promise<readonly GitHubRepository[]>;
  selectRepository(repositoryId: number): Promise<GitHubGatewaySession>;
  createRepository(name: string): Promise<GitHubRepositoryCreationResult>;
  disconnect(): Promise<void>;
  beginAuthorization(returnTo?: string): Promise<void>;
}

export class GitHubGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GitHubGatewayError';
  }
}

export class GitHubGatewayProtocolError extends Error {
  constructor(
    message = 'The GitHub sync gateway returned an invalid response',
  ) {
    super(message);
    this.name = 'GitHubGatewayProtocolError';
  }
}

export interface GitHubGatewayClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  redirect?: (url: string) => void;
  currentPath?: () => string;
  uploadRequester?: BrowserObjectUploadRequester;
  storage?: Storage;
}

const DEFAULT_BASE_URL = '/api/sync/github';
const DEFAULT_RETURN_PATH = '/settings/sync';
const CSRF_HEADER = 'X-Omnia-CSRF';
const REMEMBERED_REPOSITORY_KEY = 'omnia-reader.sync-github-repository';

export class GitHubGatewayClient implements GitHubGateway {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly redirect: (url: string) => void;
  private readonly currentPath: () => string;
  private readonly uploadRequester: BrowserObjectUploadRequester;
  private readonly storage: Storage | undefined;

  constructor(options: GitHubGatewayClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetcher =
      options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.redirect =
      options.redirect ?? ((url) => globalThis.location.assign(url));
    this.currentPath =
      options.currentPath ??
      (() =>
        `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`);
    this.uploadRequester =
      options.uploadRequester ?? browserObjectUploadRequest;
    this.storage = options.storage ?? browserStorage();
  }

  async session(): Promise<GitHubGatewaySession> {
    const response = await this.request('/session');
    const session = parseSession(await responseJson(response));
    if (!session.authenticated) {
      return session;
    }
    if (session.repository) {
      this.rememberRepository(session.repository);
      return session;
    }
    const remembered = this.readRememberedRepository();
    if (!remembered) {
      return session;
    }
    try {
      return await this.selectRepository(remembered.id);
    } catch (error) {
      if (
        error instanceof GitHubGatewayError &&
        (error.status === 403 || error.status === 404)
      ) {
        this.forgetRepository();
        return session;
      }
      throw error;
    }
  }

  async repositories(): Promise<readonly GitHubRepository[]> {
    const response = await this.request('/repositories');
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      !Array.isArray(value['repositories']) ||
      !value['repositories'].every(isRepository)
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return value['repositories'];
  }

  async selectRepository(repositoryId: number): Promise<GitHubGatewaySession> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new TypeError('A valid GitHub repository ID is required');
    }
    const response = await this.request('/repository', {
      method: 'PUT',
      body: JSON.stringify({ repositoryId }),
    });
    const session = parseSession(await responseJson(response));
    if (session.authenticated && session.repository) {
      this.rememberRepository(session.repository);
    }
    return session;
  }

  async createRepository(
    repositoryName: string,
  ): Promise<GitHubRepositoryCreationResult> {
    const name = repositoryName.trim();
    if (!/^[a-z0-9._-]{1,100}$/i.test(name) || name === '.' || name === '..') {
      throw new TypeError(
        'Repository names may contain letters, numbers, dots, hyphens, and underscores',
      );
    }
    const response = await this.request('/repository', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const result = parseRepositoryCreationResult(await responseJson(response));
    if (result.session.authenticated && result.session.repository) {
      this.rememberRepository(result.session.repository);
    }
    return result;
  }

  async disconnect(): Promise<void> {
    await this.request('/session', { method: 'DELETE' });
    this.forgetRepository();
  }

  async beginAuthorization(returnTo = this.currentPath()): Promise<void> {
    const session = await this.session();
    if (!session.configured) {
      throw new GitHubGatewayError(
        503,
        'GitHub App authentication is not configured on this sync gateway',
      );
    }
    const safeReturnTo = sanitizeReturnPath(returnTo);
    this.redirect(
      `${this.baseUrl}/auth/start?returnTo=${encodeURIComponent(safeReturnTo)}`,
    );
  }

  async destinationRevision(
    options: Pick<ObjectDownloadOptions, 'signal'> = {},
  ): Promise<string> {
    const response = await this.request('/revision', {
      signal: options.signal,
    });
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      typeof value['revision'] !== 'string' ||
      value['revision'].length === 0 ||
      value['revision'].length > 1024 ||
      value['revision'].includes('\0')
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return value['revision'];
  }

  async list(prefix: string): Promise<readonly GitFile[]> {
    const response = await this.request(
      `/files?prefix=${encodeURIComponent(prefix)}`,
    );
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      !Array.isArray(value['files']) ||
      !value['files'].every(
        (file) => isGitFile(file) && isPathWithinPrefix(file.path, prefix),
      ) ||
      !hasUniquePaths(value['files'])
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return value['files'];
  }

  async listEntries(prefix: string): Promise<readonly RemoteSyncEntry[]> {
    const response = await this.request(
      `/entries?prefix=${encodeURIComponent(prefix)}`,
    );
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      !Array.isArray(value['entries']) ||
      !value['entries'].every(
        (entry) =>
          isRemoteSyncEntry(entry) && isPathWithinPrefix(entry.path, prefix),
      ) ||
      !hasUniquePaths(value['entries'])
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return value['entries'];
  }

  async deleteEntry(request: RemoteSyncEntryDeleteRequest): Promise<void> {
    const parameters = new URLSearchParams({
      path: request.path,
      expectedRevision: request.expectedRevision,
    });
    const response = await this.request(
      `/entry?${parameters.toString()}`,
      { method: 'DELETE' },
      [404, 409],
    );
    if (response.status === 409) throw new GitConflictError();
  }

  async deleteEntries(
    requests: readonly RemoteSyncEntryDeleteRequest[],
  ): Promise<void> {
    if (requests.length === 0) return;
    const response = await this.request(
      '/entries',
      { method: 'DELETE', body: JSON.stringify(requests) },
      [409],
    );
    if (response.status === 409) throw new GitConflictError();
  }

  async read(path: string): Promise<GitFile | null> {
    const response = await this.request(
      `/file?path=${encodeURIComponent(path)}&optional=true`,
      {},
      [404],
    );
    if (response.status === 204 || response.status === 404) {
      return null;
    }
    const value = await responseJson(response);
    if (!isGitFile(value) || value.path !== path) {
      throw new GitHubGatewayProtocolError();
    }
    return value;
  }

  async write(request: GitWriteRequest): Promise<GitFile> {
    const response = await this.request(
      '/file',
      {
        method: 'PUT',
        body: JSON.stringify(request),
      },
      [409],
    );
    if (response.status === 409) {
      throw new GitConflictError();
    }
    const value = await responseJson(response);
    if (
      !isGitFile(value) ||
      value.path !== request.path ||
      value.content !== request.content
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return value;
  }

  async deleteDocument(request: DocumentDeleteRequest): Promise<void> {
    const parameters = new URLSearchParams({ path: request.path });
    if (request.expectedRevision) {
      parameters.set('expectedRevision', request.expectedRevision);
    }
    parameters.set('message', request.message);
    const response = await this.request(
      `/file?${parameters.toString()}`,
      { method: 'DELETE' },
      [404, 409],
    );
    if (response.status === 409) {
      throw new GitConflictError();
    }
  }

  async headObject(path: string): Promise<RemoteObject | null> {
    const response = await this.request(
      `/lfs/object/metadata?path=${encodeURIComponent(path)}&optional=true`,
      {},
      [404],
    );
    if (response.status === 204 || response.status === 404) {
      return null;
    }
    const value = await responseJson(response);
    if (!isRemoteObject(value) || value.path !== path) {
      throw new GitHubGatewayProtocolError();
    }
    return value;
  }

  async downloadObject(
    path: string,
    options: ObjectDownloadOptions = {},
  ): Promise<Blob> {
    const response = await this.request(
      `/lfs/object?path=${encodeURIComponent(path)}`,
      { signal: options.signal },
    );
    return browserObjectDownloadBlob(response, path, options);
  }

  async uploadObject(request: ObjectUploadRequest): Promise<RemoteObject> {
    const headers = new Headers({
      Accept: 'application/json',
      'Content-Type': request.mediaType,
      [CSRF_HEADER]: '1',
      'X-Omnia-SHA256': request.sha256,
      'X-Omnia-Size': String(request.size),
    });
    const path = `/lfs/object?path=${encodeURIComponent(request.path)}`;
    const response = request.onProgress
      ? await this.uploadRequester(`${this.baseUrl}${path}`, headers, request)
      : await this.request(
          path,
          {
            method: 'PUT',
            headers,
            body: request.content,
            signal: request.signal,
          },
          [409],
        );
    if (!response.ok && response.status !== 409) {
      throw await gatewayError(response);
    }
    if (response.status === 409) {
      throw new GitConflictError('The remote Git LFS object changed');
    }
    const value = await responseJson(response);
    if (
      !isRemoteObject(value) ||
      value.path !== request.path ||
      value.size !== request.size ||
      value.sha256 !== request.sha256
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return value;
  }

  async deleteObject(request: ObjectDeleteRequest): Promise<void> {
    const parameters = new URLSearchParams({ path: request.path });
    if (request.expectedRevision) {
      parameters.set('expectedRevision', request.expectedRevision);
    }
    const response = await this.request(
      `/lfs/object?${parameters.toString()}`,
      { method: 'DELETE' },
      [404, 409],
    );
    if (response.status === 409) {
      throw new GitConflictError('The remote Git LFS object changed');
    }
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const mutating = method !== 'GET' && method !== 'HEAD';
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
    if (mutating) {
      headers.set(CSRF_HEADER, '1');
    }

    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      credentials: 'include',
    });
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw await gatewayError(response);
    }
    return response;
  }

  private readRememberedRepository(): Pick<
    GitHubRepository,
    'id' | 'fullName'
  > | null {
    try {
      const stored = this.storage?.getItem(REMEMBERED_REPOSITORY_KEY);
      if (!stored) {
        return null;
      }
      if (stored.length > 1024) {
        this.forgetRepository();
        return null;
      }
      const value: unknown = JSON.parse(stored);
      if (
        !isRecord(value) ||
        value['schemaVersion'] !== 1 ||
        !isRememberedRepository(value['repository'])
      ) {
        this.forgetRepository();
        return null;
      }
      return value['repository'];
    } catch {
      this.forgetRepository();
      return null;
    }
  }

  private rememberRepository(
    repository: Pick<GitHubRepository, 'id' | 'fullName'>,
  ): void {
    try {
      this.storage?.setItem(
        REMEMBERED_REPOSITORY_KEY,
        JSON.stringify({
          schemaVersion: 1,
          repository: {
            id: repository.id,
            fullName: repository.fullName,
          },
        }),
      );
    } catch {
      // Destination memory is a convenience; the gateway session remains
      // authoritative when browser storage is restricted.
    }
  }

  private forgetRepository(): void {
    try {
      this.storage?.removeItem(REMEMBERED_REPOSITORY_KEY);
    } catch {
      // A restricted storage implementation must not block disconnect.
    }
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GitHubGatewayProtocolError();
  }
}

async function gatewayError(response: Response): Promise<GitHubGatewayError> {
  let message = `GitHub sync gateway request failed (${response.status})`;
  try {
    const value: unknown = await response.json();
    if (isRecord(value) && isNonEmptyString(value['message'])) {
      message = value['message'];
    }
  } catch {
    // The status remains useful even when an upstream proxy returns non-JSON.
  }
  return new GitHubGatewayError(
    response.status,
    message,
    parseRetryAfterSeconds(response.headers.get('retry-after')),
  );
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value || !/^[0-9]{1,5}$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400
    ? seconds
    : undefined;
}

function parseSession(value: unknown): GitHubGatewaySession {
  if (
    !isRecord(value) ||
    typeof value['configured'] !== 'boolean' ||
    typeof value['authenticated'] !== 'boolean'
  ) {
    throw new GitHubGatewayProtocolError();
  }
  if (!value['configured']) {
    if (value['authenticated']) {
      throw new GitHubGatewayProtocolError();
    }
    return { configured: false, authenticated: false };
  }
  const installationUrl = value['installationUrl'];
  if (!isSafeExternalUrl(installationUrl)) {
    throw new GitHubGatewayProtocolError();
  }
  if (!value['authenticated']) {
    return { configured: true, authenticated: false, installationUrl };
  }
  const user = value['user'];
  const repository = value['repository'];
  if (!isUser(user)) {
    throw new GitHubGatewayProtocolError();
  }
  const selectedRepository =
    repository === null
      ? null
      : isRepository(repository)
        ? repository
        : undefined;
  if (selectedRepository === undefined) {
    throw new GitHubGatewayProtocolError();
  }
  return {
    configured: true,
    authenticated: true,
    installationUrl,
    user,
    repository: selectedRepository,
  };
}

function parseRepositoryCreationResult(
  value: unknown,
): GitHubRepositoryCreationResult {
  if (
    !isRecord(value) ||
    !isRepository(value['repository']) ||
    typeof value['selected'] !== 'boolean'
  ) {
    throw new GitHubGatewayProtocolError();
  }
  const session = parseSession(value['session']);
  const rawInstallationSettingsUrl = value['installationSettingsUrl'];
  let installationSettingsUrl: string | null;
  if (rawInstallationSettingsUrl === null) {
    installationSettingsUrl = null;
  } else if (isSafeExternalUrl(rawInstallationSettingsUrl)) {
    installationSettingsUrl = rawInstallationSettingsUrl;
  } else {
    throw new GitHubGatewayProtocolError();
  }
  if (
    value['selected'] &&
    (!session.authenticated ||
      session.repository?.id !== value['repository'].id)
  ) {
    throw new GitHubGatewayProtocolError();
  }
  return {
    repository: value['repository'],
    selected: value['selected'],
    session,
    installationSettingsUrl,
  };
}

function isUser(value: unknown): value is GitHubGatewayUser {
  return (
    isRecord(value) &&
    isPositiveInteger(value['id']) &&
    isNonEmptyString(value['login']) &&
    typeof value['avatarUrl'] === 'string'
  );
}

function isRepository(value: unknown): value is GitHubRepository {
  return (
    isRecord(value) &&
    isPositiveInteger(value['id']) &&
    isNonEmptyString(value['fullName']) &&
    typeof value['private'] === 'boolean' &&
    isNonEmptyString(value['defaultBranch']) &&
    typeof value['canPush'] === 'boolean'
  );
}

function isRememberedRepository(
  value: unknown,
): value is Pick<GitHubRepository, 'id' | 'fullName'> {
  const fullName = isRecord(value) ? value['fullName'] : undefined;
  const segments = typeof fullName === 'string' ? fullName.split('/') : [];
  return (
    isRecord(value) &&
    isPositiveInteger(value['id']) &&
    typeof fullName === 'string' &&
    fullName.length <= 512 &&
    segments.length === 2 &&
    segments.every(isSafeRepositoryNameSegment)
  );
}

function isSafeRepositoryNameSegment(value: string): boolean {
  return (
    value.length > 0 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
  );
}

function isGitFile(value: unknown): value is GitFile {
  return (
    isRecord(value) &&
    isNonEmptyString(value['path']) &&
    typeof value['content'] === 'string' &&
    isNonEmptyString(value['revision'])
  );
}

function isRemoteObject(value: unknown): value is RemoteObject {
  return (
    isRecord(value) &&
    isNonEmptyString(value['path']) &&
    isNonEmptyString(value['revision']) &&
    Number.isSafeInteger(value['size']) &&
    (value['size'] as number) >= 0 &&
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['sha256'])
  );
}

function isRemoteSyncEntry(value: unknown): value is RemoteSyncEntry {
  return (
    isRecord(value) &&
    isNonEmptyString(value['path']) &&
    isNonEmptyString(value['revision']) &&
    (value['kind'] === 'document' || value['kind'] === 'object')
  );
}

function isPathWithinPrefix(path: string, prefix: string): boolean {
  return (
    isCanonicalProviderPath(path) &&
    (path === prefix || path.startsWith(`${prefix}/`))
  );
}

function isCanonicalProviderPath(path: string): boolean {
  return (
    !path.includes('\\') &&
    path
      .split('/')
      .every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function hasUniquePaths(
  entries: readonly { readonly path: string }[],
): boolean {
  return new Set(entries.map((entry) => entry.path)).size === entries.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function sanitizeReturnPath(value: string): string {
  return value.startsWith('/') && !value.startsWith('//')
    ? value
    : DEFAULT_RETURN_PATH;
}
