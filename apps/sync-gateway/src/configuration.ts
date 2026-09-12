import {
  GitHubSyncGatewayAdapter,
  type GitHubAdapterOptions,
  type GitHubSessionState,
} from './github-adapter.js';
import type { SyncGatewayAdapter } from './gateway-contract.js';
import {
  MemoryGitHubAuthorizationRevocationStore,
  type GitHubAuthorizationRevocationStore,
} from './github-authorization-revocations.js';
import {
  MegaSyncGatewayAdapter,
  type MegaAdapterOptions,
  type MegaSessionState,
} from './mega-adapter.js';
import {
  HttpMegaSdkBridge,
  type HttpMegaSdkBridgeOptions,
} from './mega-sdk-bridge.js';
import {
  EncryptedMemorySessionStore,
  type GatewaySessionStore,
  sessionEncryptionKeys,
} from './session-store.js';
import { UnconfiguredSyncGatewayAdapter } from './unconfigured-adapter.js';
import type { GitHubWebhookOptions } from './github-webhook.js';

const GITHUB_PROVIDER_KEYS = [
  'OMNIA_GITHUB_APP_ID',
  'OMNIA_GITHUB_CLIENT_ID',
  'OMNIA_GITHUB_CLIENT_SECRET',
  'OMNIA_GITHUB_PRIVATE_KEY',
  'OMNIA_GITHUB_CALLBACK_URL',
  'OMNIA_GITHUB_INSTALLATION_URL',
] as const;

const GITHUB_KEYS = [
  ...GITHUB_PROVIDER_KEYS,
  'OMNIA_SYNC_SESSION_KEY',
] as const;

const MEGA_PROVIDER_KEYS = [
  'OMNIA_MEGA_SDK_BRIDGE_URL',
  'OMNIA_MEGA_SDK_BRIDGE_TOKEN',
  'OMNIA_MEGA_LOGIN_URL',
] as const;

const MEGA_KEYS = [...MEGA_PROVIDER_KEYS, 'OMNIA_SYNC_SESSION_KEY'] as const;

export function githubAdapterFromEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides: Pick<
    GitHubAdapterOptions,
    | 'fetcher'
    | 'now'
    | 'randomState'
    | 'requestTimeoutMs'
    | 'transferTimeoutMs'
    | 'onUserTokenRevocationFailure'
  > & {
    sessions?: GatewaySessionStore<GitHubSessionState>;
    revocations?: GitHubAuthorizationRevocationStore;
  } = {},
): SyncGatewayAdapter {
  const configured = GITHUB_PROVIDER_KEYS.filter((key) => environment[key]);
  if (configured.length === 0) {
    return new UnconfiguredSyncGatewayAdapter('GitHub/Git LFS');
  }
  const missing = GITHUB_KEYS.filter((key) => !environment[key]);
  if (missing.length > 0) {
    throw new TypeError(
      `GitHub synchronization configuration is incomplete: ${missing.join(', ')}`,
    );
  }
  const callbackUrl = new URL(
    environment['OMNIA_GITHUB_CALLBACK_URL'] as string,
  );
  if (
    callbackUrl.protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(callbackUrl.hostname)
  ) {
    throw new TypeError('The GitHub callback URL must use HTTPS');
  }
  const installationUrl = githubInstallationUrl(
    environment['OMNIA_GITHUB_INSTALLATION_URL'] as string,
  );
  const requestTimeoutMs = optionalDuration(
    environment['OMNIA_GITHUB_REQUEST_TIMEOUT_MS'],
    1_000,
    5 * 60 * 1000,
    'OMNIA_GITHUB_REQUEST_TIMEOUT_MS',
  );
  const transferTimeoutMs = optionalDuration(
    environment['OMNIA_GITHUB_TRANSFER_TIMEOUT_MS'],
    60_000,
    24 * 60 * 60 * 1000,
    'OMNIA_GITHUB_TRANSFER_TIMEOUT_MS',
  );
  if (environment['NODE_ENV'] === 'production' && !overrides.sessions) {
    throw new TypeError('The GitHub production session store is unavailable');
  }
  return new GitHubSyncGatewayAdapter({
    appId: environment['OMNIA_GITHUB_APP_ID'] as string,
    clientId: environment['OMNIA_GITHUB_CLIENT_ID'] as string,
    clientSecret: environment['OMNIA_GITHUB_CLIENT_SECRET'] as string,
    privateKey: (environment['OMNIA_GITHUB_PRIVATE_KEY'] as string).replace(
      /\\n/g,
      '\n',
    ),
    callbackUrl: callbackUrl.toString(),
    installationUrl,
    sessions:
      overrides.sessions ??
      new EncryptedMemorySessionStore(
        sessionEncryptionKeys(
          environment['OMNIA_SYNC_SESSION_KEY'] as string,
          environment['OMNIA_SYNC_SESSION_PREVIOUS_KEYS'],
        ),
      ),
    revocations:
      overrides.revocations ?? new MemoryGitHubAuthorizationRevocationStore(),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(transferTimeoutMs === undefined ? {} : { transferTimeoutMs }),
    ...overrides,
  });
}

export function githubWebhookFromEnvironment(
  environment: NodeJS.ProcessEnv,
  revocations: GitHubAuthorizationRevocationStore | undefined,
): GitHubWebhookOptions | undefined {
  const secret = environment['OMNIA_GITHUB_WEBHOOK_SECRET'];
  if (secret === undefined) {
    return undefined;
  }
  const missing = GITHUB_KEYS.filter((key) => !environment[key]);
  if (missing.length > 0 || !revocations) {
    throw new TypeError(
      `GitHub webhook configuration requires complete synchronization configuration${
        missing.length > 0 ? `: ${missing.join(', ')}` : ''
      }`,
    );
  }
  const secretBytes = Buffer.byteLength(secret, 'utf8');
  if (secretBytes < 32 || secretBytes > 1024 || secret.includes('\0')) {
    throw new TypeError('The GitHub webhook secret is invalid');
  }
  return { secret, revocations };
}

function githubInstallationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('The GitHub installation URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError(
      'The GitHub installation URL must use HTTPS and omit credentials or fragments',
    );
  }
  return url.toString();
}

function optionalDuration(
  value: string | undefined,
  minimum: number,
  maximum: number,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  const duration = Number(value);
  if (
    !Number.isSafeInteger(duration) ||
    duration < minimum ||
    duration > maximum
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return duration;
}

export function megaAdapterFromEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides: Pick<MegaAdapterOptions, 'randomState' | 'randomId'> &
    Pick<
      HttpMegaSdkBridgeOptions,
      'fetcher' | 'requestTimeoutMs' | 'transferTimeoutMs'
    > & {
      sessions?: GatewaySessionStore<MegaSessionState>;
    } = {},
): SyncGatewayAdapter {
  const configured = MEGA_PROVIDER_KEYS.filter((key) => environment[key]);
  if (configured.length === 0) {
    return new UnconfiguredSyncGatewayAdapter('MEGA');
  }
  const missing = MEGA_KEYS.filter((key) => !environment[key]);
  if (missing.length > 0) {
    throw new TypeError(
      `MEGA synchronization configuration is incomplete: ${missing.join(', ')}`,
    );
  }
  if (environment['NODE_ENV'] === 'production' && !overrides.sessions) {
    throw new TypeError('The MEGA production session store is unavailable');
  }
  const bridge = new HttpMegaSdkBridge({
    baseUrl: environment['OMNIA_MEGA_SDK_BRIDGE_URL'] as string,
    token: environment['OMNIA_MEGA_SDK_BRIDGE_TOKEN'] as string,
    ...(overrides.fetcher ? { fetcher: overrides.fetcher } : {}),
    ...(overrides.requestTimeoutMs
      ? { requestTimeoutMs: overrides.requestTimeoutMs }
      : {}),
    ...(overrides.transferTimeoutMs
      ? { transferTimeoutMs: overrides.transferTimeoutMs }
      : {}),
  });
  return new MegaSyncGatewayAdapter({
    loginUrl: environment['OMNIA_MEGA_LOGIN_URL'] as string,
    bridge,
    sessions:
      overrides.sessions ??
      new EncryptedMemorySessionStore(
        sessionEncryptionKeys(
          environment['OMNIA_SYNC_SESSION_KEY'] as string,
          environment['OMNIA_SYNC_SESSION_PREVIOUS_KEYS'],
        ),
      ),
    ...(overrides.randomState ? { randomState: overrides.randomState } : {}),
    ...(overrides.randomId ? { randomId: overrides.randomId } : {}),
  });
}
