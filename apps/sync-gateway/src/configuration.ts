import {
  GitHubSyncGatewayAdapter,
  type GitHubAdapterOptions,
  type GitHubSessionState,
} from './github-adapter.js';
import type { SyncGatewayAdapter } from './gateway-contract.js';
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

const GITHUB_PROVIDER_KEYS = [
  'OMNIA_GITHUB_APP_ID',
  'OMNIA_GITHUB_CLIENT_ID',
  'OMNIA_GITHUB_CLIENT_SECRET',
  'OMNIA_GITHUB_PRIVATE_KEY',
  'OMNIA_GITHUB_CALLBACK_URL',
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
  overrides: Pick<GitHubAdapterOptions, 'fetcher' | 'now' | 'randomState'> & {
    sessions?: GatewaySessionStore<GitHubSessionState>;
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
  return new GitHubSyncGatewayAdapter({
    appId: environment['OMNIA_GITHUB_APP_ID'] as string,
    clientId: environment['OMNIA_GITHUB_CLIENT_ID'] as string,
    clientSecret: environment['OMNIA_GITHUB_CLIENT_SECRET'] as string,
    privateKey: (environment['OMNIA_GITHUB_PRIVATE_KEY'] as string).replace(
      /\\n/g,
      '\n',
    ),
    callbackUrl: callbackUrl.toString(),
    sessions:
      overrides.sessions ??
      new EncryptedMemorySessionStore(
        sessionEncryptionKeys(
          environment['OMNIA_SYNC_SESSION_KEY'] as string,
          environment['OMNIA_SYNC_SESSION_PREVIOUS_KEYS'],
        ),
      ),
    ...overrides,
  });
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
