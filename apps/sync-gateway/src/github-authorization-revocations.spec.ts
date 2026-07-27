import {
  MemoryGitHubAuthorizationRevocationStore,
  RedisGitHubAuthorizationRevocationStore,
} from './github-authorization-revocations.js';
import type { RedisSessionClient } from './session-store.js';

describe('GitHub authorization revocation stores', () => {
  it('keeps memory generations monotonic while delivery IDs expire', async () => {
    let now = 1_000;
    const store = new MemoryGitHubAuthorizationRevocationStore({
      now: () => now,
      deliveryTtlMs: 2_000,
    });

    await expect(store.generation(42)).resolves.toBe(0);
    await expect(store.revoke(42, 'delivery-1')).resolves.toBe(true);
    await expect(store.revoke(42, 'delivery-1')).resolves.toBe(false);
    await expect(store.generation(42)).resolves.toBe(1);
    await expect(store.revoke(42, 'delivery-2')).resolves.toBe(true);
    await expect(store.generation(42)).resolves.toBe(2);

    now += 1_001;
    await expect(store.generation(42)).resolves.toBe(2);
    await expect(store.revoke(42, 'delivery-1')).resolves.toBe(false);

    now += 1_000;
    await expect(store.revoke(42, 'delivery-1')).resolves.toBe(true);
    await expect(store.generation(42)).resolves.toBe(3);
  });

  it('rejects invalid identities and unsafe retention settings', async () => {
    const store = new MemoryGitHubAuthorizationRevocationStore();

    await expect(store.generation(0)).rejects.toThrow(
      'GitHub user ID is invalid',
    );
    await expect(store.revoke(42, 'invalid delivery')).rejects.toThrow(
      'GitHub webhook delivery ID is invalid',
    );
    expect(
      () =>
        new MemoryGitHubAuthorizationRevocationStore({
          deliveryTtlMs: 0,
        }),
    ).toThrow('GitHub webhook delivery TTL is invalid');
  });

  it('shares atomic, replay-safe generations between Redis replicas', async () => {
    const client = new FakeRedisClient();
    const first = new RedisGitHubAuthorizationRevocationStore(client, {
      prefix: 'omnia:test:github-revocations',
    });
    const second = new RedisGitHubAuthorizationRevocationStore(client, {
      prefix: 'omnia:test:github-revocations',
    });

    const concurrent = await Promise.all([
      first.revoke(42, 'delivery-1'),
      second.revoke(42, 'delivery-1'),
    ]);
    expect(concurrent.sort()).toEqual([false, true]);
    await expect(second.generation(42)).resolves.toBe(1);
    await expect(second.revoke(42, 'delivery-1')).resolves.toBe(false);
    await expect(second.revoke(42, 'delivery-2')).resolves.toBe(true);
    await expect(first.generation(42)).resolves.toBe(2);
    expect(client.keys().join(' ')).not.toContain('delivery-1');
    expect(client.keys().join(' ')).not.toContain(':42');
  });
});

interface FakeRecord {
  value: string;
  expiresAt: number;
}

class FakeRedisClient implements RedisSessionClient {
  private readonly records = new Map<string, FakeRecord>();

  async get(key: string): Promise<string | null> {
    const record = this.liveRecord(key);
    return record?.value ?? null;
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
    const record = this.liveRecord(key);
    return record ? record.expiresAt - Date.now() : -2;
  }

  async del(key: string): Promise<unknown> {
    return this.records.delete(key) ? 1 : 0;
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    expect(script).toContain("redis.call('SET', KEYS[2]");
    const [generationKey, deliveryKey] = options.keys;
    const [deliveryTtl] = options.arguments;
    const current = Number(this.liveRecord(generationKey)?.value ?? '0');
    if (this.liveRecord(deliveryKey)) {
      return [0, current];
    }
    this.records.set(deliveryKey, {
      value: '1',
      expiresAt: Date.now() + Number(deliveryTtl),
    });
    this.records.set(generationKey, {
      value: String(current + 1),
      expiresAt: Number.POSITIVE_INFINITY,
    });
    return [1, current + 1];
  }

  keys(): readonly string[] {
    return [...this.records.keys()];
  }

  private liveRecord(key: string): FakeRecord | undefined {
    const record = this.records.get(key);
    if (record && record.expiresAt <= Date.now()) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }
}
