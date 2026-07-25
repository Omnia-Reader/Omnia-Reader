import { createClient } from 'redis';
import type { GitHubSessionState } from './github-adapter.js';
import type { MegaSessionState } from './mega-adapter.js';
import {
  EncryptedMemorySessionStore,
  EncryptedRedisSessionStore,
  type GatewaySessionStore,
  type RedisSessionClient,
  sessionEncryptionKeys,
} from './session-store.js';

export interface GatewaySessionStores {
  github?: GatewaySessionStore<GitHubSessionState>;
  mega?: GatewaySessionStore<MegaSessionState>;
  close(): Promise<void>;
}

export interface SharedRedisClient extends RedisSessionClient {
  on(event: 'error', listener: (error: unknown) => void): this;
  connect(): Promise<unknown>;
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
  'OMNIA_MEGA_SDK_BRIDGE_URL',
  'OMNIA_MEGA_SDK_BRIDGE_TOKEN',
  'OMNIA_MEGA_LOGIN_URL',
] as const;

export async function gatewaySessionStoresFromEnvironment(
  environment: NodeJS.ProcessEnv,
  options: GatewaySessionStoreOptions = {},
): Promise<GatewaySessionStores> {
  if (!PROVIDER_KEYS.some((key) => environment[key])) {
    return { close: async () => undefined };
  }

  const currentKey = environment['OMNIA_SYNC_SESSION_KEY'];
  if (!currentKey) {
    return { close: async () => undefined };
  }
  const keys = sessionEncryptionKeys(
    currentKey,
    environment['OMNIA_SYNC_SESSION_PREVIOUS_KEYS'],
  );
  const ttlMs = sessionTtlFromEnvironment(
    environment['OMNIA_SYNC_SESSION_TTL_MS'],
  );
  const redisUrl = environment['OMNIA_SYNC_REDIS_URL'];
  if (!redisUrl) {
    return {
      github: new EncryptedMemorySessionStore(keys, { ttlMs }),
      mega: new EncryptedMemorySessionStore(keys, { ttlMs }),
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
  return {
    github: new EncryptedRedisSessionStore(client, keys, {
      prefix: `${prefix}:github`,
      ttlMs,
    }),
    mega: new EncryptedRedisSessionStore(client, keys, {
      prefix: `${prefix}:mega`,
      ttlMs,
    }),
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
