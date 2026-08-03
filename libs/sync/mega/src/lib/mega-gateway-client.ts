import {
  BrowserObjectUploadRequester,
  browserObjectDownloadBlob,
  browserObjectUploadRequest,
  DocumentDeleteRequest,
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectDeleteRequest,
  ObjectDownloadOptions,
  ObjectUploadRequest,
  RemoteDocument,
  RemoteObject,
  RemoteSyncEntry,
  RemoteSyncEntryDeleteRequest,
  SyncConflictError,
} from '@omnia-reader/sync/core';

export interface MegaFolder {
  handle: string;
  name: string;
  path: string;
  canWrite: boolean;
}

export type MegaGatewaySession =
  | { authenticated: false }
  | {
      authenticated: true;
      account: string;
      folder: MegaFolder | null;
    };

export interface MegaGateway extends LibrarySyncTransport {
  session(): Promise<MegaGatewaySession>;
  folders(): Promise<readonly MegaFolder[]>;
  selectFolder(handle: string): Promise<MegaGatewaySession>;
  disconnect(): Promise<void>;
  beginAuthorization(returnTo?: string): void;
}

export class MegaGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MegaGatewayError';
  }
}

export class MegaGatewayProtocolError extends Error {
  constructor(message = 'The MEGA sync gateway returned an invalid response') {
    super(message);
    this.name = 'MegaGatewayProtocolError';
  }
}

export interface MegaGatewayClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  redirect?: (url: string) => void;
  currentPath?: () => string;
  uploadRequester?: BrowserObjectUploadRequester;
}

const DEFAULT_BASE_URL = '/api/sync/mega';
const DEFAULT_RETURN_PATH = '/settings/sync';
const CSRF_HEADER = 'X-Omnia-CSRF';

export class MegaGatewayClient implements MegaGateway {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly redirect: (url: string) => void;
  private readonly currentPath: () => string;
  private readonly uploadRequester: BrowserObjectUploadRequester;

  constructor(options: MegaGatewayClientOptions = {}) {
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
  }

  async session(): Promise<MegaGatewaySession> {
    const response = await this.request('/session');
    return parseSession(await responseJson(response));
  }

  async folders(): Promise<readonly MegaFolder[]> {
    const response = await this.request('/folders');
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      !Array.isArray(value['folders']) ||
      !value['folders'].every(isFolder)
    ) {
      throw new MegaGatewayProtocolError();
    }
    return value['folders'];
  }

  async selectFolder(handle: string): Promise<MegaGatewaySession> {
    if (!isBoundedString(handle)) {
      throw new TypeError('A valid MEGA folder handle is required');
    }
    const response = await this.request('/folder', {
      method: 'PUT',
      body: JSON.stringify({ handle }),
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

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    const response = await this.request(
      `/documents?prefix=${encodeURIComponent(prefix)}`,
    );
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      !Array.isArray(value['documents']) ||
      !value['documents'].every(isRemoteDocument)
    ) {
      throw new MegaGatewayProtocolError();
    }
    return value['documents'];
  }

  async listEntries(prefix: string): Promise<readonly RemoteSyncEntry[]> {
    const response = await this.request(
      `/entries?prefix=${encodeURIComponent(prefix)}`,
    );
    const value = await responseJson(response);
    if (
      !isRecord(value) ||
      !Array.isArray(value['entries']) ||
      !value['entries'].every(isRemoteSyncEntry)
    ) {
      throw new MegaGatewayProtocolError();
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
    if (response.status === 409) {
      throw new SyncConflictError('The remote MEGA sync entry changed');
    }
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
    if (response.status === 409) {
      throw new SyncConflictError('A remote MEGA sync entry changed');
    }
  }

  async read(path: string): Promise<RemoteDocument | null> {
    const response = await this.request(
      `/document?path=${encodeURIComponent(path)}&optional=true`,
      {},
      [404],
    );
    if (response.status === 204 || response.status === 404) {
      return null;
    }
    const value = await responseJson(response);
    if (!isRemoteDocument(value)) {
      throw new MegaGatewayProtocolError();
    }
    return value;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    const response = await this.request(
      '/document',
      { method: 'PUT', body: JSON.stringify(request) },
      [409],
    );
    if (response.status === 409) {
      throw new SyncConflictError('The remote MEGA document changed');
    }
    const value = await responseJson(response);
    if (!isRemoteDocument(value)) {
      throw new MegaGatewayProtocolError();
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
      `/document?${parameters.toString()}`,
      { method: 'DELETE' },
      [404, 409],
    );
    if (response.status === 409) {
      throw new SyncConflictError('The remote MEGA document changed');
    }
  }

  async headObject(path: string): Promise<RemoteObject | null> {
    const response = await this.request(
      `/object/metadata?path=${encodeURIComponent(path)}&optional=true`,
      {},
      [404],
    );
    if (response.status === 204 || response.status === 404) {
      return null;
    }
    const value = await responseJson(response);
    if (!isRemoteObject(value)) {
      throw new MegaGatewayProtocolError();
    }
    return value;
  }

  async downloadObject(
    path: string,
    options: ObjectDownloadOptions = {},
  ): Promise<Blob> {
    const response = await this.request(
      `/object?path=${encodeURIComponent(path)}`,
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
    const path = `/object?path=${encodeURIComponent(request.path)}`;
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
      throw new SyncConflictError('The remote MEGA object changed');
    }
    const value = await responseJson(response);
    if (!isRemoteObject(value)) {
      throw new MegaGatewayProtocolError();
    }
    return value;
  }

  async deleteObject(request: ObjectDeleteRequest): Promise<void> {
    const parameters = new URLSearchParams({ path: request.path });
    if (request.expectedRevision) {
      parameters.set('expectedRevision', request.expectedRevision);
    }
    const response = await this.request(
      `/object?${parameters.toString()}`,
      { method: 'DELETE' },
      [404, 409],
    );
    if (response.status === 409) {
      throw new SyncConflictError('The remote MEGA object changed');
    }
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
    if (method !== 'GET' && method !== 'HEAD') {
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
    throw new MegaGatewayProtocolError();
  }
}

async function gatewayError(response: Response): Promise<MegaGatewayError> {
  let message = `MEGA sync gateway request failed (${response.status})`;
  try {
    const value: unknown = await response.json();
    if (isRecord(value) && isBoundedString(value['message'])) {
      message = value['message'];
    }
  } catch {
    // Preserve the HTTP status if an upstream proxy returns non-JSON.
  }
  return new MegaGatewayError(response.status, message);
}

function parseSession(value: unknown): MegaGatewaySession {
  if (!isRecord(value) || typeof value['authenticated'] !== 'boolean') {
    throw new MegaGatewayProtocolError();
  }
  if (!value['authenticated']) {
    return { authenticated: false };
  }
  const account = value['account'];
  const folder = value['folder'];
  if (!isBoundedString(account)) {
    throw new MegaGatewayProtocolError();
  }
  const selectedFolder =
    folder === null ? null : isFolder(folder) ? folder : undefined;
  if (selectedFolder === undefined) {
    throw new MegaGatewayProtocolError();
  }
  return { authenticated: true, account, folder: selectedFolder };
}

function isFolder(value: unknown): value is MegaFolder {
  return (
    isRecord(value) &&
    isBoundedString(value['handle']) &&
    isBoundedString(value['name']) &&
    isBoundedString(value['path']) &&
    typeof value['canWrite'] === 'boolean'
  );
}

function isRemoteDocument(value: unknown): value is RemoteDocument {
  return (
    isRecord(value) &&
    isBoundedString(value['path']) &&
    typeof value['content'] === 'string' &&
    isBoundedString(value['revision'])
  );
}

function isRemoteObject(value: unknown): value is RemoteObject {
  return (
    isRecord(value) &&
    isBoundedString(value['path']) &&
    isBoundedString(value['revision']) &&
    Number.isSafeInteger(value['size']) &&
    (value['size'] as number) >= 0 &&
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['sha256'])
  );
}

function isRemoteSyncEntry(value: unknown): value is RemoteSyncEntry {
  return (
    isRecord(value) &&
    isBoundedString(value['path']) &&
    isBoundedString(value['revision']) &&
    (value['kind'] === 'document' || value['kind'] === 'object')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function sanitizeReturnPath(value: string): string {
  return value.startsWith('/') && !value.startsWith('//')
    ? value
    : DEFAULT_RETURN_PATH;
}
