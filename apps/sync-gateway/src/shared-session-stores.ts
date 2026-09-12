import { resolve } from 'node:path';
import { createClient } from 'redis';
import {
  MemoryGitHubAuthorizationRevocationStore,
  RedisGitHubAuthorizationRevocationStore,
  type GitHubAuthorizationRevocationStore,
} from './github-authorization-revocations.js';
import type { GitHubSessionState } from './github-adapter.js';
import type { MegaSessionState } from './mega-adapter.js';
import {
  NativeAuthorizationHandoffs,
  type NativeHandoffRecord,
} from './native-handoff.js';
import {
  EncryptedFileSessionStore,
  EncryptedMemorySessionStore,
  EncryptedRedisSessionStore,
  type GatewaySessionStore,
  type RedisSessionClient,
  sessionEncryptionKeys,
} from './session-store.js';

export interface GatewaySessionStores {
  github?: GatewaySessionStore<GitHubSessionState>;
  githubRevocations?: GitHubAuthorizationRevocationStore;
  mega?: GatewaySessionStore<MegaSessionState>;
  nativeHandoffs?: NativeAuthorizationHandoffs;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface SharedRedisClient extends RedisSessionClient {
  on(event: 'error', listener: (error: unknown) => void): this;
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  destroy(): void;
}

export interface GatewaySessionStoreOptions {
  createRedisClient?: (url: string) => SharedRedisClient;
  onRedisError?: (error: unknown) => void;
}

const PROVIDER_KEYS = [
  'OMNIA_GITHUB_APP_ID',
  'OMNIA_GITHUB_CLIENT_ID',
  'OMNIA_GITHUB_CLIENT_SECRET',
  'OMNIA_GITHUB_PRIVATE_KEY',
  'OMNIA_GITHUB_CALLBACK_URL',
  'OMNIA_GITHUB_INSTALLATION_URL',
  'OMNIA_MEGA_SDK_BRIDGE_URL',
  'OMNIA_MEGA_SDK_BRIDGE_TOKEN',
  'OMNIA_MEGA_LOGIN_URL',
] as const;

export async function gatewaySessionStoresFromEnvironment(
  environment: NodeJS.ProcessEnv,
  options: GatewaySessionStoreOptions = {},
): Promise<GatewaySessionStores> {
  if (!PROVIDER_KEYS.some((key) => environment[key])) {
    return {
      ready: async () => undefined,
      close: async () => undefined,
    };
  }

  const currentKey = environment['OMNIA_SYNC_SESSION_KEY'];
  if (!currentKey) {
    return {
      ready: async () => undefined,
      close: async () => undefined,
    };
  }
  const keys = sessionEncryptionKeys(
    currentKey,
    environment['OMNIA_SYNC_SESSION_PREVIOUS_KEYS'],
  );
  const ttlMs = sessionTtlFromEnvironment(
    environment['OMNIA_SYNC_SESSION_TTL_MS'],
  );
  const redisUrl = environment['OMNIA_SYNC_REDIS_URL'];
  const sessionDirectory = environment['OMNIA_SYNC_SESSION_DIRECTORY'];
  const nativeRedirectScheme = environment['OMNIA_SYNC_NATIVE_REDIRECT_SCHEME'];
  if (environment['NODE_ENV'] === 'production' && !redisUrl) {
    throw new TypeError(
      'Production synchronization requires Redis session storage',
    );
  }
  if (redisUrl && sessionDirectory) {
    throw new TypeError(
      'Configure either OMNIA_SYNC_REDIS_URL or OMNIA_SYNC_SESSION_DIRECTORY, not both',
    );
  }
  if (sessionDirectory) {
    if (sessionDirectory.includes('\0')) {
      throw new TypeError('OMNIA_SYNC_SESSION_DIRECTORY is invalid');
    }
    if (environment['OMNIA_GITHUB_WEBHOOK_SECRET']) {
      throw new TypeError(
        'GitHub webhooks require the Redis synchronization session store',
      );
    }
    const directory = resolve(sessionDirectory);
    const nativeHandoffs = nativeRedirectScheme
      ? new NativeAuthorizationHandoffs({
          store: new EncryptedFileSessionStore<NativeHandoffRecord>(keys, {
            filePath: resolve(directory, 'native-handoffs.json'),
            ttlMs: 10 * 60 * 1000,
          }),
          redirectScheme: nativeRedirectScheme,
        })
      : undefined;
    return {
      github: new EncryptedFileSessionStore(keys, {
        filePath: resolve(directory, 'github-sessions.json'),
        ttlMs,
      }),
      githubRevocations: new MemoryGitHubAuthorizationRevocationStore(),
      mega: new EncryptedFileSessionStore(keys, {
        filePath: resolve(directory, 'mega-sessions.json'),
        ttlMs,
      }),
      ...(nativeHandoffs ? { nativeHandoffs } : {}),
      ready: async () => undefined,
      close: async () => undefined,
    };
  }
  if (!redisUrl) {
    const nativeHandoffs = nativeRedirectScheme
      ? new NativeAuthorizationHandoffs({
          store: new EncryptedMemorySessionStore<NativeHandoffRecord>(keys, {
            ttlMs: 10 * 60 * 1000,
          }),
          redirectScheme: nativeRedirectScheme,
        })
      : undefined;
    return {
      github: new EncryptedMemorySessionStore(keys, { ttlMs }),
      githubRevocations: new MemoryGitHubAuthorizationRevocationStore(),
      mega: new EncryptedMemorySessionStore(keys, { ttlMs }),
      ...(nativeHandoffs ? { nativeHandoffs } : {}),
      ready: async () => undefined,
      close: async () => undefined,
    };
  }

  const parsedRedisUrl = new URL(redisUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(
    parsedRedisUrl.hostname,
  );
  if (
    parsedRedisUrl.protocol !== 'rediss:' &&
    !(parsedRedisUrl.protocol === 'redis:' && loopback)
  ) {
    throw new TypeError(
      'OMNIA_SYNC_REDIS_URL must use rediss or loopback redis',
    );
  }
  if (parsedRedisUrl.hash) {
    throw new TypeError('OMNIA_SYNC_REDIS_URL must not contain a fragment');
  }

  const clientFactory =
    options.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as SharedRedisClient);
  const client = clientFactory(parsedRedisUrl.toString());
  client.on('error', options.onRedisError ?? (() => undefined));
  try {
    await client.connect();
  } catch (error) {
    client.destroy();
    throw error;
  }

  const prefix = environment['OMNIA_SYNC_REDIS_PREFIX'] ?? 'omnia:sync:v1';
  let closed = false;
  const nativeHandoffs = nativeRedirectScheme
    ? new NativeAuthorizationHandoffs({
        store: new EncryptedRedisSessionStore<NativeHandoffRecord>(
          client,
          keys,
          {
            prefix: `${prefix}:native-handoffs`,
            ttlMs: 10 * 60 * 1000,
          },
        ),
        redirectScheme: nativeRedirectScheme,
      })
    : undefined;
  return {
    github: new EncryptedRedisSessionStore(client, keys, {
      prefix: `${prefix}:github`,
      ttlMs,
    }),
    githubRevocations: new RedisGitHubAuthorizationRevocationStore(client, {
      prefix: `${prefix}:github-revocations`,
    }),
    mega: new EncryptedRedisSessionStore(client, keys, {
      prefix: `${prefix}:mega`,
      ttlMs,
    }),
    ...(nativeHandoffs ? { nativeHandoffs } : {}),
    ready: async () => {
      await client.ping();
    },
    close: async () => {
      if (!closed) {
        closed = true;
        client.destroy();
      }
    },
  };
}

function sessionTtlFromEnvironment(value: string | undefined): number {
  if (value === undefined) {
    return 12 * 60 * 60 * 1000;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new TypeError('OMNIA_SYNC_SESSION_TTL_MS is invalid');
  }
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 7 * 24 * 60 * 60 * 1000) {
    throw new TypeError('OMNIA_SYNC_SESSION_TTL_MS is invalid');
  }
  return ttl;
}
