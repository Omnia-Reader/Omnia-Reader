import {
  LibrarySyncTransport,
  ObjectUploadRequest,
  RemoteObject,
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
  | { authenticated: false }
  | {
      authenticated: true;
      user: GitHubGatewayUser;
      repository: GitHubRepository | null;
    };

export interface GitHubGateway extends LibrarySyncTransport {
  session(): Promise<GitHubGatewaySession>;
  repositories(): Promise<readonly GitHubRepository[]>;
  selectRepository(repositoryId: number): Promise<GitHubGatewaySession>;
  disconnect(): Promise<void>;
  beginAuthorization(returnTo?: string): void;
}

export class GitHubGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
}

const DEFAULT_BASE_URL = '/api/sync/github';
const DEFAULT_RETURN_PATH = '/settings/sync';
const CSRF_HEADER = 'X-Omnia-CSRF';

export class GitHubGatewayClient implements GitHubGateway {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly redirect: (url: string) => void;
  private readonly currentPath: () => string;

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
  }

  async session(): Promise<GitHubGatewaySession> {
    const response = await this.request('/session');
    return parseSession(await responseJson(response));
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
    return parseSession(await responseJson(response));
  }

  async disconnect(): Promise<void> {
    await this.request('/session', { method: 'DELETE' });
  }

  beginAuthorization(returnTo = this.currentPath()): void {
    const safeReturnTo = sanitizeReturnPath(returnTo);
    this.redirect(
      `${this.baseUrl}/auth/start?returnTo=${encodeURIComponent(safeReturnTo)}`,
    );
  }

  async list(prefix: string): Promise<readonly GitFile[]> {
    const response = await this.request(
      `/files?prefix=${encodeURIComponent(prefix)}`,
    );
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      !Array.isArray(value['files']) ||
      !value['files'].every(isGitFile)
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return value['files'];
  }

  async read(path: string): Promise<GitFile | null> {
    const response = await this.request(
      `/file?path=${encodeURIComponent(path)}`,
      {},
      [404],
    );
    if (response.status === 404) {
      return null;
    }
    const value = await responseJson(response);
    if (!isGitFile(value)) {
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
    if (!isGitFile(value)) {
      throw new GitHubGatewayProtocolError();
    }
    return value;
  }

  async headObject(path: string): Promise<RemoteObject | null> {
    const response = await this.request(
      `/lfs/object/metadata?path=${encodeURIComponent(path)}`,
      {},
      [404],
    );
    if (response.status === 404) {
      return null;
    }
    const value = await responseJson(response);
    if (!isRemoteObject(value)) {
      throw new GitHubGatewayProtocolError();
    }
    return value;
  }

  async downloadObject(path: string): Promise<Blob> {
    const response = await this.request(
      `/lfs/object?path=${encodeURIComponent(path)}`,
    );
    return response.blob();
  }

  async uploadObject(request: ObjectUploadRequest): Promise<RemoteObject> {
    const headers = new Headers({
      'Content-Type': request.mediaType,
      'X-Omnia-SHA256': request.sha256,
      'X-Omnia-Size': String(request.size),
    });
    const response = await this.request(
      `/lfs/object?path=${encodeURIComponent(request.path)}`,
      {
        method: 'PUT',
        headers,
        body: request.content,
      },
      [409],
    );
    if (response.status === 409) {
      throw new GitConflictError('The remote Git LFS object changed');
    }
    const value = await responseJson(response);
    if (!isRemoteObject(value)) {
      throw new GitHubGatewayProtocolError();
    }
    return value;
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
  return new GitHubGatewayError(response.status, message);
}

function parseSession(value: unknown): GitHubGatewaySession {
  if (!isRecord(value) || typeof value['authenticated'] !== 'boolean') {
    throw new GitHubGatewayProtocolError();
  }
  if (!value['authenticated']) {
    return { authenticated: false };
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
    authenticated: true,
    user,
    repository: selectedRepository,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sanitizeReturnPath(value: string): string {
  return value.startsWith('/') && !value.startsWith('//')
    ? value
    : DEFAULT_RETURN_PATH;
}
