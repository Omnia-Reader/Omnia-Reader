import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { GatewayHttpError } from './gateway-contract.js';

export interface MegaSdkCredentials {
  email: string;
  password: string;
  multiFactorCode?: string;
}

export interface MegaSdkLogin {
  account: string;
  session: string;
}

export interface MegaSdkFolder {
  handle: string;
  name: string;
  path: string;
  canWrite: boolean;
}

export interface MegaSdkFile {
  handle: string;
  path: string;
  revision: string;
  size: number;
  sha256?: string;
}

export interface MegaSdkFileUpload {
  rootHandle: string;
  path: string;
  size: number;
  sha256: string;
  content: Readable;
}

/**
 * Narrow process boundary around MEGA's official C++/Java SDK.
 *
 * The bridge owns MegaApi instances and maps these operations to login /
 * fastLogin, dumpSession, fetchNodes, node enumeration, startUpload,
 * startDownload, moveNode, remove, and the `osh` custom SHA-256 attribute.
 */
export interface MegaSdkBridge {
  login(credentials: MegaSdkCredentials): Promise<MegaSdkLogin>;
  logout(session: string): Promise<void>;
  folders(session: string): Promise<readonly MegaSdkFolder[]>;
  files(
    session: string,
    rootHandle: string,
    prefix: string,
  ): Promise<readonly MegaSdkFile[]>;
  downloadFile(
    session: string,
    rootHandle: string,
    handle: string,
  ): Promise<Readable>;
  uploadFile(session: string, upload: MegaSdkFileUpload): Promise<MegaSdkFile>;
  moveFile(
    session: string,
    handle: string,
    rootHandle: string,
    path: string,
  ): Promise<MegaSdkFile>;
  removeFile(
    session: string,
    rootHandle: string,
    handle: string,
  ): Promise<void>;
}

export interface HttpMegaSdkBridgeOptions {
  baseUrl: string;
  token: string;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
  transferTimeoutMs?: number;
}

const SESSION_HEADER = 'X-Omnia-Mega-Session';
const MAX_FILES = 20_000;

export class HttpMegaSdkBridge implements MegaSdkBridge {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly transferTimeoutMs: number;

  constructor(private readonly options: HttpMegaSdkBridgeOptions) {
    const url = new URL(options.baseUrl);
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      )
    ) {
      throw new TypeError(
        'The MEGA SDK bridge URL must use HTTPS or loopback HTTP',
      );
    }
    if (!isBoundedString(options.token, 4096)) {
      throw new TypeError('The MEGA SDK bridge token is required');
    }
    this.baseUrl = `${url.toString().replace(/\/+$/, '')}/`;
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.transferTimeoutMs = options.transferTimeoutMs ?? 2 * 60 * 60 * 1000;
  }

  async login(credentials: MegaSdkCredentials): Promise<MegaSdkLogin> {
    const value = await this.json('/v1/sessions', {
      method: 'POST',
      body: {
        email: credentials.email,
        password: credentials.password,
        ...(credentials.multiFactorCode
          ? { multiFactorCode: credentials.multiFactorCode }
          : {}),
      },
    });
    if (
      !isRecord(value) ||
      !isBoundedString(value['account'], 320) ||
      !isBoundedString(value['session'], 16 * 1024)
    ) {
      throw bridgeProtocolError();
    }
    return {
      account: value['account'],
      session: value['session'],
    };
  }

  async logout(session: string): Promise<void> {
    await this.json('/v1/session', { method: 'DELETE', session });
  }

  async folders(session: string): Promise<readonly MegaSdkFolder[]> {
    const value = await this.json('/v1/folders', { session });
    if (
      !isRecord(value) ||
      !Array.isArray(value['folders']) ||
      value['folders'].length > MAX_FILES ||
      !value['folders'].every(isFolder)
    ) {
      throw bridgeProtocolError();
    }
    return value['folders'];
  }

  async files(
    session: string,
    rootHandle: string,
    prefix: string,
  ): Promise<readonly MegaSdkFile[]> {
    const url = this.url('/v1/files');
    url.searchParams.set('rootHandle', rootHandle);
    url.searchParams.set('prefix', prefix);
    const value = await this.json(url, { session });
    if (
      !isRecord(value) ||
      !Array.isArray(value['files']) ||
      value['files'].length > MAX_FILES ||
      !value['files'].every(isFile)
    ) {
      throw bridgeProtocolError();
    }
    return value['files'];
  }

  async downloadFile(
    session: string,
    rootHandle: string,
    handle: string,
  ): Promise<Readable> {
    const url = this.url(`/v1/files/${encodeURIComponent(handle)}`);
    url.searchParams.set('rootHandle', rootHandle);
    const response = await this.request(url, {
      session,
      signal: AbortSignal.timeout(this.transferTimeoutMs),
    });
    if (!response.ok || !response.body) {
      throw await bridgeHttpError(response);
    }
    return Readable.fromWeb(response.body);
  }

  async uploadFile(
    session: string,
    upload: MegaSdkFileUpload,
  ): Promise<MegaSdkFile> {
    const url = this.url('/v1/files');
    url.searchParams.set('rootHandle', upload.rootHandle);
    url.searchParams.set('path', upload.path);
    const response = await this.request(url, {
      method: 'POST',
      session,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(upload.size),
        'X-Omnia-SHA256': upload.sha256,
      },
      body: upload.content,
      duplex: 'half',
      signal: AbortSignal.timeout(this.transferTimeoutMs),
    });
    await finished(upload.content);
    const value = await responseJson(response);
    if (!response.ok) {
      throw await bridgeHttpError(response, value);
    }
    if (!isFile(value)) {
      throw bridgeProtocolError();
    }
    return value;
  }

  async moveFile(
    session: string,
    handle: string,
    rootHandle: string,
    path: string,
  ): Promise<MegaSdkFile> {
    const url = this.url(`/v1/files/${encodeURIComponent(handle)}`);
    url.searchParams.set('rootHandle', rootHandle);
    url.searchParams.set('path', path);
    const value = await this.json(url, { method: 'PUT', session });
    if (!isFile(value)) {
      throw bridgeProtocolError();
    }
    return value;
  }

  async removeFile(
    session: string,
    rootHandle: string,
    handle: string,
  ): Promise<void> {
    const url = this.url(`/v1/files/${encodeURIComponent(handle)}`);
    url.searchParams.set('rootHandle', rootHandle);
    await this.json(url, {
      method: 'DELETE',
      session,
    });
  }

  private async json(
    path: string | URL,
    options: BridgeRequestOptions = {},
  ): Promise<unknown> {
    const body =
      options.body !== undefined && !(options.body instanceof Readable)
        ? JSON.stringify(options.body)
        : options.body;
    const response = await this.request(path, {
      ...options,
      body,
      headers: {
        ...(typeof body === 'string'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...options.headers,
      },
    });
    const value = await responseJson(response);
    if (!response.ok) {
      throw await bridgeHttpError(response, value);
    }
    return value;
  }

  private request(
    path: string | URL,
    options: BridgeRequestOptions = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${this.options.token}`);
    if (options.session) {
      headers.set(
        SESSION_HEADER,
        Buffer.from(options.session, 'utf8').toString('base64url'),
      );
    }
    return this.fetcher(path instanceof URL ? path : this.url(path), {
      method: options.method ?? 'GET',
      headers,
      body: options.body as RequestInit['body'],
      redirect: 'error',
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(this.requestTimeoutMs)
          : options.signal,
      ...(options.duplex ? { duplex: options.duplex } : {}),
    } as RequestInit & { duplex?: 'half' });
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\/+/, ''), this.baseUrl);
  }
}

interface BridgeRequestOptions {
  method?: string;
  session?: string;
  headers?: RequestInit['headers'];
  body?: unknown;
  duplex?: 'half';
  signal?: AbortSignal | null;
}

function isFolder(value: unknown): value is MegaSdkFolder {
  return (
    isRecord(value) &&
    isBoundedString(value['handle']) &&
    isBoundedString(value['name']) &&
    isBoundedString(value['path'], 2048) &&
    typeof value['canWrite'] === 'boolean'
  );
}

function isFile(value: unknown): value is MegaSdkFile {
  return (
    isRecord(value) &&
    isBoundedString(value['handle']) &&
    isBoundedString(value['path'], 2048) &&
    isBoundedString(value['revision']) &&
    Number.isSafeInteger(value['size']) &&
    (value['size'] as number) >= 0 &&
    (value['sha256'] === undefined ||
      (typeof value['sha256'] === 'string' &&
        /^[a-f0-9]{64}$/.test(value['sha256'])))
  );
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function bridgeHttpError(
  response: Response,
  parsed?: unknown,
): Promise<GatewayHttpError> {
  const value = parsed ?? (await responseJson(response));
  const code =
    isRecord(value) && typeof value['code'] === 'string' ? value['code'] : '';
  const mapped = bridgeError(code, response.status);
  return new GatewayHttpError(mapped.status, mapped.message);
}

function bridgeError(
  code: string,
  status: number,
): { status: number; message: string } {
  switch (code) {
    case 'INVALID_CREDENTIALS':
    case 'MFA_REQUIRED':
    case 'INVALID_MFA':
      return { status: 401, message: 'MEGA authentication was not accepted' };
    case 'SESSION_EXPIRED':
      return { status: 401, message: 'The MEGA session has expired' };
    case 'STORAGE_QUOTA':
      return { status: 507, message: 'The MEGA storage quota is exhausted' };
    case 'TRANSFER_QUOTA':
      return {
        status: 429,
        message: 'The MEGA transfer quota is temporarily exhausted',
      };
    case 'DUPLICATE_NODES':
      return {
        status: 409,
        message: 'Conflicting duplicate MEGA nodes were found',
      };
  }
  if ([400, 401, 403, 404, 409, 413, 429, 507].includes(status)) {
    return { status, message: `MEGA SDK bridge request failed (${status})` };
  }
  return {
    status: status >= 500 ? 502 : 400,
    message: 'The MEGA SDK bridge returned an error',
  };
}

function bridgeProtocolError(): GatewayHttpError {
  return new GatewayHttpError(
    502,
    'The MEGA SDK bridge returned an invalid response',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum = 1024): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}
