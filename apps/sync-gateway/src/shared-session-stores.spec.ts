import { randomBytes } from 'node:crypto';
import {
  gatewaySessionStoresFromEnvironment,
  type SharedRedisClient,
} from './shared-session-stores.js';

describe('gatewaySessionStoresFromEnvironment', () => {
  it('uses isolated encrypted memory stores for a single replica', async () => {
    const stores = await gatewaySessionStoresFromEnvironment(environment());

    await stores.github?.set('session-a', {
      authorizationState: 'github-state',
    });
    await expect(stores.github?.get('session-a')).resolves.toEqual({
      authorizationState: 'github-state',
    });
    await expect(stores.mega?.get('session-a')).resolves.toBeNull();
    await stores.close();
  });

  it('connects one Redis client, namespaces providers, and closes once', async () => {
    const client = new FakeSharedRedisClient();
    let configuredUrl = '';
    const stores = await gatewaySessionStoresFromEnvironment(
      environment({
        OMNIA_SYNC_REDIS_URL: 'redis://127.0.0.1:6379/2',
        OMNIA_SYNC_REDIS_PREFIX: 'reader:test',
      }),
      {
        createRedisClient: (url) => {
          configuredUrl = url;
          return client;
        },
      },
    );

    expect(configuredUrl).toBe('redis://127.0.0.1:6379/2');
    expect(client.connectCount).toBe(1);
    await stores.github?.set('session-a', {
      authorizationState: 'github-state',
    });
    await stores.mega?.set('session-a', {
      authorizationState: 'mega-state',
    });
    await expect(stores.github?.get('session-a')).resolves.toEqual({
      authorizationState: 'github-state',
    });
    await expect(stores.mega?.get('session-a')).resolves.toEqual({
      authorizationState: 'mega-state',
    });
    expect(client.keys().some((key) => key.includes('session-a'))).toBe(false);

    await stores.close();
    await stores.close();
    expect(client.destroyCount).toBe(1);
  });

  it('requires TLS for a non-loopback Redis service', async () => {
    await expect(
      gatewaySessionStoresFromEnvironment(
        environment({
          OMNIA_SYNC_REDIS_URL: 'redis://redis.internal:6379',
        }),
      ),
    ).rejects.toThrow('must use rediss or loopback redis');
  });
});

describe.skipIf(!process.env['OMNIA_SYNC_REDIS_TEST_URL'])(
  'Redis session store integration',
  () => {
    it('shares and atomically rotates a session between real clients', async () => {
      const prefix = `omnia:test:${randomBytes(8).toString('hex')}`;
      const redisUrl = process.env['OMNIA_SYNC_REDIS_TEST_URL'] as string;
      const configured = environment({
        OMNIA_SYNC_REDIS_URL: redisUrl,
        OMNIA_SYNC_REDIS_PREFIX: prefix,
      });
      const first = await gatewaySessionStoresFromEnvironment(configured);
      const second = await gatewaySessionStoresFromEnvironment(configured);

      try {
        await first.github?.set('session-a', {
          authorizationState: 'shared-state',
        });
        await expect(second.github?.get('session-a')).resolves.toEqual({
          authorizationState: 'shared-state',
        });
        await second.github?.move('session-a', 'session-b', {
          authorizationState: 'rotated-state',
        });
        await expect(first.github?.get('session-a')).resolves.toBeNull();
        await expect(first.github?.get('session-b')).resolves.toEqual({
          authorizationState: 'rotated-state',
        });
        await expect(
          first.github?.move('session-a', 'session-c', {
            authorizationState: 'replayed-state',
          }),
        ).rejects.toThrow('Provider session is invalid');
        await first.github?.delete('session-b');
      } finally {
        await first.close();
        await second.close();
      }
    });
  },
);

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OMNIA_GITHUB_CLIENT_ID: 'configured',
    OMNIA_SYNC_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  };
}

interface FakeRecord {
  value: string;
  expiresAt: number;
}

class FakeSharedRedisClient implements SharedRedisClient {
  readonly records = new Map<string, FakeRecord>();
  connectCount = 0;
  destroyCount = 0;

  on(): this {
    return this;
  }

  async connect(): Promise<unknown> {
    this.connectCount += 1;
    return this;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  async get(key: string): Promise<string | null> {
    return this.records.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    options: { PX: number },
  ): Promise<unknown> {
    this.records.set(key, {
      value,
      expiresAt: Date.now() + options.PX,
    });
    return 'OK';
  }

  async pTTL(key: string): Promise<number> {
    const record = this.records.get(key);
    return record ? record.expiresAt - Date.now() : -2;
  }

  async del(key: string): Promise<unknown> {
    return this.records.delete(key) ? 1 : 0;
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    const [sourceKey, replacementKey] = options.keys;
    const [value, ttl] = options.arguments;
    if (!this.records.has(sourceKey)) {
      return 0;
    }
    await this.set(replacementKey, value, { PX: Number(ttl) });
    if (sourceKey !== replacementKey) {
      await this.del(sourceKey);
    }
    return 1;
  }

  keys(): readonly string[] {
    return [...this.records.keys()];
  }
}
