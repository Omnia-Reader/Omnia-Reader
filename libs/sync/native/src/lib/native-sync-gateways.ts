import {
  GitHubGateway,
  GitHubGatewayError,
  GitHubGatewayProtocolError,
  GitHubGatewaySession,
  GitHubRepository,
  GitHubRepositoryCreationResult,
} from '@omnia-reader/sync/git';
import {
  MegaFolder,
  MegaGateway,
  MegaGatewayError,
  MegaGatewayProtocolError,
  MegaGatewaySession,
} from '@omnia-reader/sync/mega';
import {
  NativeSyncInvoke,
  NativeSyncProvider,
  NativeSyncTransport,
} from './native-sync-transport';

export type NativeSyncListen = (
  event: 'sync-authorization-completed',
  callback: (event: { payload: unknown }) => void,
) => Promise<() => void>;

export type NativeSyncOpenExternal = (url: string) => Promise<void>;

export interface NativeSyncGatewayOptions {
  invoke?: NativeSyncInvoke;
  listen?: NativeSyncListen;
  openExternal?: NativeSyncOpenExternal;
  randomId?: () => string;
  authorizationTimeoutMs?: number;
  gatewayOrigin?: string;
  allowInsecureLoopback?: boolean;
}

interface NativeAuthorizationEvent {
  requestId: string;
  provider: NativeSyncProvider;
  outcome: 'authorized' | 'denied' | 'invalid' | 'failed';
  error?: string;
}

class NativeAuthorizationError extends Error {
  constructor(readonly code: NativeErrorCode) {
    super(nativeErrorMessage(code));
    this.name = 'NativeAuthorizationError';
  }
}

type NativeErrorCode =
  | 'authentication-required'
  | 'cancelled'
  | 'invalid-response'
  | 'permission-denied'
  | 'rate-limited'
  | 'transport-unavailable';

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

class NativeAuthorizationClient {
  private active:
    | { controller: AbortController; completion: Promise<void> }
    | undefined;

  constructor(
    private readonly invoke: NativeSyncInvoke,
    private readonly listen: NativeSyncListen,
    private readonly openExternal: NativeSyncOpenExternal,
    private readonly randomId: () => string,
    private readonly timeoutMs: number,
    private readonly allowInsecureLoopback: boolean,
  ) {}

  authorize(provider: NativeSyncProvider): Promise<void> {
    if (this.active) {
      return Promise.reject(
        new NativeAuthorizationError('transport-unavailable'),
      );
    }
    const controller = new AbortController();
    const completion = this.run(provider, controller.signal).finally(() => {
      if (this.active?.controller === controller) {
        this.active = undefined;
      }
    });
    this.active = { controller, completion };
    return completion;
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.completion.catch(() => undefined);
  }

  private async run(
    provider: NativeSyncProvider,
    signal: AbortSignal,
  ): Promise<void> {
    const requestId = this.randomId();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new NativeAuthorizationError('transport-unavailable');
    }
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveCompleted: () => void = () => undefined;
    let rejectCompleted: (reason: unknown) => void = () => undefined;
    const abort = () =>
      rejectCompleted(
        new DOMException('Authorization cancelled', 'AbortError'),
      );
    try {
      const completed = new Promise<void>((resolve, reject) => {
        resolveCompleted = resolve;
        rejectCompleted = reject;
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(
          () => reject(new NativeAuthorizationError('authentication-required')),
          this.timeoutMs,
        );
      });
      unlisten = await this.listen('sync-authorization-completed', (event) => {
        if (
          !isRecord(event.payload) ||
          event.payload['requestId'] !== requestId
        ) {
          return;
        }
        const value = nativeAuthorizationEvent(event.payload);
        if (!value || value.provider !== provider) {
          rejectCompleted(
            new NativeAuthorizationError('authentication-required'),
          );
        } else if (value.outcome === 'authorized') {
          resolveCompleted();
        } else {
          rejectCompleted(
            new NativeAuthorizationError(
              value.error === 'transport-unavailable'
                ? 'transport-unavailable'
                : 'authentication-required',
            ),
          );
        }
      });
      const gatewayOrigin = nativeBrokerOrigin(
        await this.invoke('sync_broker_status', {}),
        this.allowInsecureLoopback,
      );
      const start = await this.invoke('sync_authorization_begin', {
        requestId,
        provider,
      });
      const authorizationUrl = nativeAuthorizationUrl(
        start,
        provider,
        requestId,
        gatewayOrigin,
      );
      await this.openExternal(authorizationUrl);
      await completed;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw nativeAuthorizationError(error);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      unlisten?.();
      await this.invoke('sync_authorization_cancel', { requestId }).catch(
        () => undefined,
      );
    }
  }
}

abstract class NativeProviderGateway extends NativeSyncTransport {
  protected readonly invokeSettings: NativeSyncInvoke;
  private readonly authorization: NativeAuthorizationClient;
  private settingsRequestSequence = 0;

  protected constructor(
    provider: NativeSyncProvider,
    options: NativeSyncGatewayOptions,
  ) {
    const invoke = options.invoke ?? invokeTauri;
    super({
      provider,
      invoke,
      ...(options.gatewayOrigin
        ? { gatewayOrigin: options.gatewayOrigin }
        : {}),
      ...(options.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    });
    this.invokeSettings = invoke;
    this.authorization = new NativeAuthorizationClient(
      invoke,
      options.listen ?? listenTauri,
      options.openExternal ?? openTauriExternal,
      options.randomId ?? randomRequestId,
      boundedTimeout(options.authorizationTimeoutMs),
      options.allowInsecureLoopback ?? false,
    );
  }

  protected beginNativeAuthorization(
    provider: NativeSyncProvider,
  ): Promise<void> {
    return this.authorization.authorize(provider);
  }

  cancelAuthorization(): Promise<void> {
    return this.authorization.cancel();
  }

  protected settingsRequest(
    command: Parameters<NativeSyncInvoke>[0],
    body = {},
  ) {
    return this.invokeSettings(command, {
      requestId: `settings-${++this.settingsRequestSequence}`,
      ...body,
    });
  }

  override async dispose(): Promise<void> {
    await this.authorization.cancel();
    await super.dispose();
  }
}

export class NativeGitHubGateway
  extends NativeProviderGateway
  implements GitHubGateway
{
  constructor(options: NativeSyncGatewayOptions = {}) {
    super('git', options);
  }

  async session(): Promise<GitHubGatewaySession> {
    return parseGitHubSession(await this.request('sync_github_session'));
  }

  async repositories(): Promise<readonly GitHubRepository[]> {
    const value = await this.request('sync_github_repositories');
    if (!Array.isArray(value) || value.length > 50_000) {
      throw new GitHubGatewayProtocolError();
    }
    return value.map(parseGitHubRepository);
  }

  async selectRepository(repositoryId: number): Promise<GitHubGatewaySession> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new TypeError('A valid GitHub repository ID is required');
    }
    return parseGitHubSession(
      await this.request('sync_github_select_repository', { repositoryId }),
    );
  }

  async createRepository(
    nameValue: string,
  ): Promise<GitHubRepositoryCreationResult> {
    const name = nameValue.trim();
    if (!/^[a-z0-9._-]{1,100}$/i.test(name) || name === '.' || name === '..') {
      throw new TypeError(
        'Repository names may contain letters, numbers, dots, hyphens, and underscores',
      );
    }
    return parseGitHubRepositoryCreation(
      await this.request('sync_github_create_repository', { name }),
    );
  }

  async disconnect(): Promise<void> {
    await this.request('sync_github_disconnect');
  }

  async beginAuthorization(): Promise<void> {
    try {
      await this.beginNativeAuthorization('git');
    } catch (error) {
      throw githubError(error);
    }
  }

  private async request(
    command:
      | 'sync_github_session'
      | 'sync_github_repositories'
      | 'sync_github_select_repository'
      | 'sync_github_create_repository'
      | 'sync_github_disconnect',
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    try {
      return await this.settingsRequest(command, body);
    } catch (error) {
      throw githubError(error);
    }
  }
}

export class NativeMegaGateway
  extends NativeProviderGateway
  implements MegaGateway
{
  constructor(options: NativeSyncGatewayOptions = {}) {
    super('mega', options);
  }

  async session(): Promise<MegaGatewaySession> {
    return parseMegaSession(await this.request('sync_mega_session'));
  }

  async folders(): Promise<readonly MegaFolder[]> {
    const value = await this.request('sync_mega_folders');
    if (!Array.isArray(value) || value.length > 50_000) {
      throw new MegaGatewayProtocolError();
    }
    return value.map(parseMegaFolder);
  }

  async selectFolder(handle: string): Promise<MegaGatewaySession> {
    if (!boundedString(handle, 1024)) {
      throw new TypeError('A valid MEGA folder handle is required');
    }
    return parseMegaSession(
      await this.request('sync_mega_select_folder', { handle }),
    );
  }

  async disconnect(): Promise<void> {
    await this.request('sync_mega_disconnect');
  }

  async beginAuthorization(): Promise<void> {
    try {
      await this.beginNativeAuthorization('mega');
    } catch (error) {
      throw megaError(error);
    }
  }

  private async request(
    command:
      | 'sync_mega_session'
      | 'sync_mega_folders'
      | 'sync_mega_select_folder'
      | 'sync_mega_disconnect',
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    try {
      return await this.settingsRequest(command, body);
    } catch (error) {
      throw megaError(error);
    }
  }
}

function parseGitHubSession(value: unknown): GitHubGatewaySession {
  if (!exactRecord(value, ['configured', 'authenticated'])) {
    if (!isRecord(value)) throw new GitHubGatewayProtocolError();
  }
  if (
    !isRecord(value) ||
    typeof value['configured'] !== 'boolean' ||
    typeof value['authenticated'] !== 'boolean'
  ) {
    throw new GitHubGatewayProtocolError();
  }
  if (!value['configured']) {
    if (value['authenticated'] || Object.keys(value).length !== 2) {
      throw new GitHubGatewayProtocolError();
    }
    return { configured: false, authenticated: false };
  }
  if (!boundedHttpsUrl(value['installationUrl'])) {
    throw new GitHubGatewayProtocolError();
  }
  if (!value['authenticated']) {
    if (
      !exactRecord(value, ['configured', 'authenticated', 'installationUrl'])
    ) {
      throw new GitHubGatewayProtocolError();
    }
    return {
      configured: true,
      authenticated: false,
      installationUrl: value['installationUrl'],
    };
  }
  if (
    !exactRecord(value, [
      'configured',
      'authenticated',
      'installationUrl',
      'user',
      'repository',
    ]) ||
    !isRecord(value['user'])
  ) {
    throw new GitHubGatewayProtocolError();
  }
  const user = value['user'];
  if (
    !exactRecord(user, ['id', 'login', 'avatarUrl']) ||
    !positiveInteger(user['id']) ||
    !boundedString(user['login'], 256) ||
    !boundedHttpsUrl(user['avatarUrl'])
  ) {
    throw new GitHubGatewayProtocolError();
  }
  const repository =
    value['repository'] === null
      ? null
      : parseGitHubRepository(value['repository']);
  return {
    configured: true,
    authenticated: true,
    installationUrl: value['installationUrl'],
    user: {
      id: user['id'],
      login: user['login'],
      avatarUrl: user['avatarUrl'],
    },
    repository,
  };
}

function parseGitHubRepository(value: unknown): GitHubRepository {
  if (
    !exactRecord(value, [
      'id',
      'fullName',
      'private',
      'defaultBranch',
      'canPush',
    ]) ||
    !positiveInteger(value['id']) ||
    !boundedString(value['fullName'], 512) ||
    !/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(value['fullName']) ||
    typeof value['private'] !== 'boolean' ||
    !boundedString(value['defaultBranch'], 256) ||
    typeof value['canPush'] !== 'boolean'
  ) {
    throw new GitHubGatewayProtocolError();
  }
  return {
    id: value['id'],
    fullName: value['fullName'],
    private: value['private'],
    defaultBranch: value['defaultBranch'],
    canPush: value['canPush'],
  };
}

function parseGitHubRepositoryCreation(
  value: unknown,
): GitHubRepositoryCreationResult {
  const installationSettingsUrl = isRecord(value)
    ? value['installationSettingsUrl']
    : undefined;
  if (
    !exactRecord(value, [
      'repository',
      'selected',
      'session',
      'installationSettingsUrl',
    ]) ||
    typeof value['selected'] !== 'boolean'
  ) {
    throw new GitHubGatewayProtocolError();
  }
  const safeInstallationSettingsUrl =
    installationSettingsUrl === null
      ? null
      : boundedHttpsUrl(installationSettingsUrl)
        ? installationSettingsUrl
        : null;
  if (
    installationSettingsUrl !== null &&
    safeInstallationSettingsUrl === null
  ) {
    throw new GitHubGatewayProtocolError();
  }
  return {
    repository: parseGitHubRepository(value['repository']),
    selected: value['selected'],
    session: parseGitHubSession(value['session']),
    installationSettingsUrl: safeInstallationSettingsUrl,
  };
}

function parseMegaSession(value: unknown): MegaGatewaySession {
  if (!isRecord(value) || typeof value['authenticated'] !== 'boolean') {
    throw new MegaGatewayProtocolError();
  }
  if (!value['authenticated']) {
    if (!exactRecord(value, ['authenticated']))
      throw new MegaGatewayProtocolError();
    return { authenticated: false };
  }
  if (
    !exactRecord(value, ['authenticated', 'account', 'folder']) ||
    !boundedString(value['account'], 320)
  ) {
    throw new MegaGatewayProtocolError();
  }
  return {
    authenticated: true,
    account: value['account'],
    folder: value['folder'] === null ? null : parseMegaFolder(value['folder']),
  };
}

function parseMegaFolder(value: unknown): MegaFolder {
  if (
    !exactRecord(value, ['handle', 'name', 'path', 'canWrite']) ||
    !boundedString(value['handle'], 1024) ||
    !boundedString(value['name'], 1024) ||
    !boundedString(value['path'], 4096) ||
    typeof value['canWrite'] !== 'boolean'
  ) {
    throw new MegaGatewayProtocolError();
  }
  return {
    handle: value['handle'],
    name: value['name'],
    path: value['path'],
    canWrite: value['canWrite'],
  };
}

function nativeAuthorizationEvent(
  value: unknown,
): NativeAuthorizationEvent | null {
  if (
    !isRecord(value) ||
    !REQUEST_ID_PATTERN.test(String(value['requestId'] ?? '')) ||
    (value['provider'] !== 'git' && value['provider'] !== 'mega') ||
    !['authorized', 'denied', 'invalid', 'failed'].includes(
      String(value['outcome']),
    ) ||
    Object.keys(value).some(
      (key) => !['requestId', 'provider', 'outcome', 'error'].includes(key),
    ) ||
    (value['error'] !== undefined &&
      !['authentication-required', 'transport-unavailable'].includes(
        String(value['error']),
      ))
  ) {
    return null;
  }
  return value as unknown as NativeAuthorizationEvent;
}

function nativeAuthorizationUrl(
  value: unknown,
  provider: NativeSyncProvider,
  requestId: string,
  gatewayOrigin: string,
): string {
  if (
    !exactRecord(value, ['authorizationUrl']) ||
    typeof value['authorizationUrl'] !== 'string'
  ) {
    throw new NativeAuthorizationError('invalid-response');
  }
  let url: URL;
  try {
    url = new URL(value['authorizationUrl']);
  } catch {
    throw new NativeAuthorizationError('invalid-response');
  }
  const providerPath = provider === 'git' ? 'github' : 'mega';
  if (
    url.origin !== gatewayOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/api/sync/${providerPath}/native/auth/start` ||
    [...url.searchParams.keys()].some((key) => key !== 'requestId') ||
    url.searchParams.getAll('requestId').length !== 1 ||
    url.searchParams.get('requestId') !== requestId
  ) {
    throw new NativeAuthorizationError('invalid-response');
  }
  return url.toString();
}

function nativeBrokerOrigin(
  value: unknown,
  allowInsecureLoopback: boolean,
): string {
  if (!isRecord(value) || typeof value['gatewayOrigin'] !== 'string') {
    throw new NativeAuthorizationError('invalid-response');
  }
  let url: URL;
  try {
    url = new URL(value['gatewayOrigin']);
  } catch {
    throw new NativeAuthorizationError('invalid-response');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' &&
      !(allowInsecureLoopback && url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value['gatewayOrigin'] !== url.origin
  ) {
    throw new NativeAuthorizationError('invalid-response');
  }
  return url.origin;
}

function githubError(error: unknown): Error {
  if (error instanceof TypeError || error instanceof GitHubGatewayProtocolError)
    return error;
  const native = nativeError(error);
  return new GitHubGatewayError(
    native.status,
    native.message,
    native.retryAfterSeconds,
  );
}

function megaError(error: unknown): Error {
  if (error instanceof TypeError || error instanceof MegaGatewayProtocolError)
    return error;
  const native = nativeError(error);
  return new MegaGatewayError(native.status, native.message);
}

function nativeAuthorizationError(error: unknown): Error {
  if (error instanceof NativeAuthorizationError) return error;
  if (error instanceof DOMException && error.name === 'AbortError')
    return error;
  return new NativeAuthorizationError(nativeErrorCode(error));
}

function nativeError(error: unknown): {
  status: number;
  message: string;
  retryAfterSeconds?: number;
} {
  const code = nativeErrorCode(error);
  const status =
    code === 'authentication-required'
      ? 401
      : code === 'cancelled'
        ? 499
        : code === 'permission-denied'
          ? 403
          : code === 'rate-limited'
            ? 429
            : code === 'invalid-response'
              ? 502
              : 503;
  const retryAfterSeconds =
    isRecord(error) &&
    Number.isSafeInteger(error['retryAfterSeconds']) &&
    Number(error['retryAfterSeconds']) > 0 &&
    Number(error['retryAfterSeconds']) <= 86_400
      ? Number(error['retryAfterSeconds'])
      : undefined;
  return {
    status,
    message: nativeErrorMessage(code),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function nativeErrorCode(error: unknown): NativeErrorCode {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'cancelled';
  }
  const code = isRecord(error)
    ? error['code']
    : error instanceof NativeAuthorizationError
      ? error.code
      : undefined;
  return code === 'authentication-required' ||
    code === 'cancelled' ||
    code === 'invalid-response' ||
    code === 'permission-denied' ||
    code === 'rate-limited' ||
    code === 'transport-unavailable'
    ? code
    : 'transport-unavailable';
}

function nativeErrorMessage(code: NativeErrorCode): string {
  switch (code) {
    case 'authentication-required':
      return 'The synchronization account must be connected again.';
    case 'cancelled':
      return 'Synchronization authorization was cancelled.';
    case 'invalid-response':
      return 'The synchronization service returned an invalid response.';
    case 'permission-denied':
      return 'The synchronization provider no longer grants the required permission.';
    case 'rate-limited':
      return 'The synchronization provider is temporarily rate limiting requests.';
    default:
      return 'The native synchronization service is unavailable.';
  }
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > DEFAULT_AUTHORIZATION_TIMEOUT_MS
  ) {
    throw new TypeError('The native authorization timeout is invalid');
  }
  return timeout;
}

function randomRequestId(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes('\0')
  );
}

function boundedHttpsUrl(value: unknown): value is string {
  if (!boundedString(value, 2048)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

async function invokeTauri(
  command: Parameters<NativeSyncInvoke>[0],
  body: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, body, options);
}

async function listenTauri(
  event: 'sync-authorization-completed',
  callback: (event: { payload: unknown }) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen(event, callback);
}

async function openTauriExternal(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
