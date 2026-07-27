import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EncryptedFileSessionStore,
  EncryptedMemorySessionStore,
  EncryptedRedisSessionStore,
  type RedisSessionClient,
  sessionEncryptionKey,
  sessionEncryptionKeys,
} from './session-store.js';

describe('EncryptedMemorySessionStore', () => {
  it('round-trips, rotates, and expires encrypted provider state', async () => {
    let now = 1_000;
    const store = new EncryptedMemorySessionStore<{ token: string }>(
      Buffer.alloc(32, 7),
      {
        ttlMs: 100,
        now: () => now,
        random: () => Buffer.alloc(12, 9),
      },
    );

    await store.set('session-a', { token: 'secret' });
    await expect(store.get('session-a')).resolves.toEqual({ token: 'secret' });

    await store.move('session-a', 'session-b', { token: 'rotated' });
    await expect(store.get('session-a')).resolves.toBeNull();
    await expect(store.get('session-b')).resolves.toEqual({
      token: 'rotated',
    });

    now = 1_101;
    await expect(store.get('session-b')).resolves.toBeNull();
  });

  it('requires canonical 256-bit base64 encryption keys', () => {
    const current = Buffer.alloc(32, 3).toString('base64');
    const previous = Buffer.alloc(32, 4).toString('base64');

    expect(sessionEncryptionKey(current)).toEqual(Buffer.alloc(32, 3));
    expect(sessionEncryptionKeys(current, previous)).toEqual([
      Buffer.alloc(32, 3),
      Buffer.alloc(32, 4),
    ]);
    expect(() => sessionEncryptionKey('not-a-key')).toThrow(
      'must encode exactly 32 random bytes',
    );
    expect(() => sessionEncryptionKeys(current, current)).toThrow(
      'must be unique',
    );
  });
});

describe('EncryptedRedisSessionStore', () => {
  it('shares sealed sessions and rotates IDs atomically across replicas', async () => {
    const redis = new FakeRedisClient();
    const key = Buffer.alloc(32, 7);
    const first = redisStore(redis, [key]);
    const second = redisStore(redis, [key]);

    await first.set('session-a', { token: 'secret' });
    await expect(second.get('session-a')).resolves.toEqual({
      token: 'secret',
    });
    expect(redis.keys().join(' ')).not.toContain('session-a');

    await second.move('session-a', 'session-b', { token: 'rotated' });
    await expect(first.get('session-a')).resolves.toBeNull();
    await expect(first.get('session-b')).resolves.toEqual({
      token: 'rotated',
    });
    await expect(
      first.move('session-a', 'session-c', { token: 'replayed' }),
    ).rejects.toThrow('Provider session is invalid');
  });

  it('re-encrypts previous-key sessions without extending their TTL', async () => {
    const redis = new FakeRedisClient();
    const previousKey = Buffer.alloc(32, 5);
    const currentKey = Buffer.alloc(32, 6);
    const previous = redisStore(redis, [previousKey]);

    await previous.set('session-a', { token: 'secret' });
    const storageKey = redis.keys()[0];
    const previousCiphertext = redis.value(storageKey);
    redis.advance(40);

    const current = redisStore(redis, [currentKey, previousKey]);
    await expect(current.get('session-a')).resolves.toEqual({
      token: 'secret',
    });
    expect(redis.value(storageKey)).not.toBe(previousCiphertext);
    expect(await redis.pTTL(storageKey)).toBe(60);

    redis.advance(61);
    await expect(current.get('session-a')).resolves.toBeNull();
  });
});

describe('EncryptedFileSessionStore', () => {
  it('restores encrypted sessions after the gateway store is recreated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-session-'));
    const filePath = join(directory, 'github-sessions.json');
    const key = Buffer.alloc(32, 7);

    try {
      const first = fileStore(filePath, [key]);
      await first.set('session-a', { token: 'secret' });

      const serialized = await readFile(filePath, 'utf8');
      expect(serialized).not.toContain('session-a');
      expect(serialized).not.toContain('secret');

      const restarted = fileStore(filePath, [key]);
      await expect(restarted.get('session-a')).resolves.toEqual({
        token: 'secret',
      });
      await restarted.move('session-a', 'session-b', { token: 'rotated' });
      await expect(first.get('session-a')).resolves.toBeNull();
      await expect(first.get('session-b')).resolves.toEqual({
        token: 'rotated',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when the persisted envelope is malformed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omnia-sync-session-'));
    const filePath = join(directory, 'github-sessions.json');

    try {
      await writeFile(filePath, '{"version":1,"records":{"unsafe":{}}}');
      const store = fileStore(filePath, [Buffer.alloc(32, 7)]);
      await expect(store.get('session-a')).rejects.toThrow(
        'persistent synchronization session store is invalid',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function redisStore(
  client: RedisSessionClient,
  keys: readonly Buffer[],
): EncryptedRedisSessionStore<{ token: string }> {
  return new EncryptedRedisSessionStore(client, keys, {
    prefix: 'omnia:sync:test',
    ttlMs: 100,
    random: () => Buffer.alloc(12, 9),
  });
}

function fileStore(
  filePath: string,
  keys: readonly Buffer[],
): EncryptedFileSessionStore<{ token: string }> {
  return new EncryptedFileSessionStore(keys, {
    filePath,
    ttlMs: 100,
    random: () => Buffer.alloc(12, 9),
  });
}

interface FakeRedisRecord {
  value: string;
  expiresAt: number;
}

class FakeRedisClient implements RedisSessionClient {
  private readonly records = new Map<string, FakeRedisRecord>();
  private now = 1_000;

  async get(key: string): Promise<string | null> {
    return this.active(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    options: { PX: number },
  ): Promise<unknown> {
    this.records.set(key, {
      value,
      expiresAt: this.now + options.PX,
    });
    return 'OK';
  }

  async pTTL(key: string): Promise<number> {
    const record = this.active(key);
    return record ? record.expiresAt - this.now : -2;
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
    if (!this.active(sourceKey)) {
      return 0;
    }
    await this.set(replacementKey, value, { PX: Number(ttl) });
    if (sourceKey !== replacementKey) {
      await this.del(sourceKey);
    }
    return 1;
  }

  keys(): string[] {
    return [...this.records.keys()];
  }

  value(key: string): string | undefined {
    return this.active(key)?.value;
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }

  private active(key: string): FakeRedisRecord | null {
    const record = this.records.get(key);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= this.now) {
      this.records.delete(key);
      return null;
    }
    return record;
  }
}
