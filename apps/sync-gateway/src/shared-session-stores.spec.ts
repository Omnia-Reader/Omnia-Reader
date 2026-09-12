import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from 'redis';
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
    await expect(
      stores.githubRevocations?.revoke(42, 'delivery-memory'),
    ).resolves.toBe(true);
    await expect(stores.githubRevocations?.generation(42)).resolves.toBe(1);
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
    await expect(
      stores.githubRevocations?.revoke(42, 'delivery-redis'),
    ).resolves.toBe(true);
    await expect(stores.githubRevocations?.generation(42)).resolves.toBe(1);
    expect(client.keys().some((key) => key.includes('session-a'))).toBe(false);
    expect(client.keys().some((key) => key.includes('delivery-redis'))).toBe(
      false,
    );
    expect(client.keys().some((key) => key.endsWith(':42'))).toBe(false);

    await stores.close();
    await stores.close();
    expect(client.destroyCount).toBe(1);
  });

  it('persists encrypted sessions for a restarted single-node gateway', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-stores-'));
    const configured = environment({
      OMNIA_SYNC_SESSION_DIRECTORY: directory,
    });

    try {
      const first = await gatewaySessionStoresFromEnvironment(configured);
      await first.github?.set('session-a', {
        authorizationState: 'github-state',
      });
      await first.close();

      const restarted = await gatewaySessionStoresFromEnvironment(configured);
      await expect(restarted.github?.get('session-a')).resolves.toEqual({
        authorizationState: 'github-state',
      });
      await expect(restarted.mega?.get('session-a')).resolves.toBeNull();
      await restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not mix file persistence with Redis or production webhooks', async () => {
    await expect(
      gatewaySessionStoresFromEnvironment(
        environment({
          OMNIA_SYNC_REDIS_URL: 'redis://127.0.0.1:6379',
          OMNIA_SYNC_SESSION_DIRECTORY: '.session-data',
        }),
      ),
    ).rejects.toThrow('either OMNIA_SYNC_REDIS_URL');
    await expect(
      gatewaySessionStoresFromEnvironment(
        environment({
          OMNIA_SYNC_SESSION_DIRECTORY: '.session-data',
          OMNIA_GITHUB_WEBHOOK_SECRET: 'x'.repeat(32),
        }),
      ),
    ).rejects.toThrow('webhooks require the Redis');
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
    it('survives replicas, restart, key rotation, backup, restore, and outage without extending TTL', async () => {
      const prefix = `omnia:test:${randomBytes(8).toString('hex')}`;
      const redisUrl = process.env['OMNIA_SYNC_REDIS_TEST_URL'] as string;
      const oldKey = Buffer.alloc(32, 7).toString('base64');
      const currentKey = Buffer.alloc(32, 8).toString('base64');
      const configured = environment({
        OMNIA_SYNC_REDIS_URL: redisUrl,
        OMNIA_SYNC_REDIS_PREFIX: prefix,
        OMNIA_SYNC_SESSION_KEY: oldKey,
        OMNIA_SYNC_SESSION_TTL_MS: '120000',
      });
      const first = await gatewaySessionStoresFromEnvironment(configured);
      const second = await gatewaySessionStoresFromEnvironment(configured);
      const observer = createClient({ url: redisUrl });
      await observer.connect();
      let rotated: Awaited<
        ReturnType<typeof gatewaySessionStoresFromEnvironment>
      > | null = null;
      let currentOnly: Awaited<
        ReturnType<typeof gatewaySessionStoresFromEnvironment>
      > | null = null;

      try {
        await expect(first.ready()).resolves.toBeUndefined();
        await expect(second.ready()).resolves.toBeUndefined();
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
        await expect(
          first.githubRevocations?.revoke(42, 'delivery-shared'),
        ).resolves.toBe(true);
        await expect(second.githubRevocations?.generation(42)).resolves.toBe(1);
        await expect(
          second.githubRevocations?.revoke(42, 'delivery-shared'),
        ).resolves.toBe(false);
        await expect(first.githubRevocations?.generation(42)).resolves.toBe(1);

        const redisKey = sessionRedisKey(prefix, 'github', 'session-b');
        const ciphertextBefore = await observer.get(redisKey);
        const ttlBefore = await observer.pTTL(redisKey);
        expect(ciphertextBefore).toBeTruthy();
        expect(ttlBefore).toBeGreaterThan(0);

        await first.close();
        await second.close();
        rotated = await gatewaySessionStoresFromEnvironment(
          environment({
            OMNIA_SYNC_REDIS_URL: redisUrl,
            OMNIA_SYNC_REDIS_PREFIX: prefix,
            OMNIA_SYNC_SESSION_KEY: currentKey,
            OMNIA_SYNC_SESSION_PREVIOUS_KEYS: oldKey,
            OMNIA_SYNC_SESSION_TTL_MS: '120000',
          }),
        );
        await expect(rotated.github?.get('session-b')).resolves.toEqual({
          authorizationState: 'rotated-state',
        });
        await expect(rotated.githubRevocations?.generation(42)).resolves.toBe(
          1,
        );
        await expect(
          rotated.githubRevocations?.revoke(42, 'delivery-shared'),
        ).resolves.toBe(false);

        const ciphertextAfter = await observer.get(redisKey);
        const ttlAfter = await observer.pTTL(redisKey);
        expect(ciphertextAfter).not.toBe(ciphertextBefore);
        expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
        expect(ttlAfter).toBeGreaterThanOrEqual(ttlBefore - 5_000);

        await rotated.close();
        currentOnly = await gatewaySessionStoresFromEnvironment(
          environment({
            OMNIA_SYNC_REDIS_URL: redisUrl,
            OMNIA_SYNC_REDIS_PREFIX: prefix,
            OMNIA_SYNC_SESSION_KEY: currentKey,
            OMNIA_SYNC_SESSION_TTL_MS: '120000',
          }),
        );
        await expect(currentOnly.github?.get('session-b')).resolves.toEqual({
          authorizationState: 'rotated-state',
        });

        const backupValue = await observer.get(redisKey);
        const backupTtl = await observer.pTTL(redisKey);
        expect(backupValue).toBeTruthy();
        await observer.del(redisKey);
        await expect(currentOnly.github?.get('session-b')).resolves.toBeNull();
        await observer.set(redisKey, backupValue as string, { PX: backupTtl });
        await expect(currentOnly.github?.get('session-b')).resolves.toEqual({
          authorizationState: 'rotated-state',
        });

        await currentOnly.close();
        await expect(currentOnly.ready()).rejects.toThrow();
        await expect(currentOnly.github?.get('session-b')).rejects.toThrow();
      } finally {
        await first.close();
        await second.close();
        await rotated?.close();
        await currentOnly?.close();
        for (const key of await observer.keys(`${prefix}:*`)) {
          await observer.del(key);
        }
        observer.destroy();
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

function sessionRedisKey(
  prefix: string,
  provider: 'github' | 'mega',
  sessionId: string,
): string {
  const digest = createHash('sha256')
    .update(sessionId, 'utf8')
    .digest('base64url');
  return `${prefix}:${provider}:${digest}`;
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

  async ping(): Promise<string> {
    return 'PONG';
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
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    if (script.includes("redis.call('SET', KEYS[2], '1'")) {
      const [generationKey, deliveryKey] = options.keys;
      const [deliveryTtl] = options.arguments;
      if (this.records.has(deliveryKey)) {
        return [0, Number((await this.get(generationKey)) ?? '0')];
      }
      await this.set(deliveryKey, '1', { PX: Number(deliveryTtl) });
      const generation = Number((await this.get(generationKey)) ?? '0') + 1;
      this.records.set(generationKey, {
        value: String(generation),
        expiresAt: Number.POSITIVE_INFINITY,
      });
      return [1, generation];
    }

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
