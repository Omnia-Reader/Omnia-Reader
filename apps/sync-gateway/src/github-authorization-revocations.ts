import { createHash } from 'node:crypto';
import type { RedisSessionClient } from './session-store.js';

export interface GitHubAuthorizationRevocationStore {
  generation(userId: number): Promise<number>;
  revoke(userId: number, deliveryId: string): Promise<boolean>;
}

export interface GitHubAuthorizationRevocationStoreOptions {
  deliveryTtlMs?: number;
  now?: () => number;
}

export interface RedisGitHubAuthorizationRevocationStoreOptions
  extends GitHubAuthorizationRevocationStoreOptions {
  prefix: string;
}

const DEFAULT_DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DELIVERY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const APPLY_REVOCATION_SCRIPT = `
if redis.call('SET', KEYS[2], '1', 'PX', ARGV[1], 'NX') == false then
  return {0, tonumber(redis.call('GET', KEYS[1]) or '0')}
end
local generation = tonumber(redis.call('GET', KEYS[1]) or '0') + 1
redis.call('SET', KEYS[1], tostring(generation))
return {1, generation}
`;

export class MemoryGitHubAuthorizationRevocationStore
  implements GitHubAuthorizationRevocationStore
{
  private readonly generations = new Map<number, number>();
  private readonly deliveries = new Map<string, number>();
  private readonly deliveryTtlMs: number;
  private readonly now: () => number;

  constructor(options: GitHubAuthorizationRevocationStoreOptions = {}) {
    this.deliveryTtlMs = boundedTtl(
      options.deliveryTtlMs,
      DEFAULT_DELIVERY_TTL_MS,
      MAX_DELIVERY_TTL_MS,
      'GitHub webhook delivery',
    );
    this.now = options.now ?? Date.now;
  }

  async generation(userId: number): Promise<number> {
    assertUserId(userId);
    return this.generations.get(userId) ?? 0;
  }

  async revoke(userId: number, deliveryId: string): Promise<boolean> {
    assertUserId(userId);
    assertDeliveryId(deliveryId);
    const now = this.now();
    for (const [candidate, expiresAt] of this.deliveries) {
      if (expiresAt <= now) {
        this.deliveries.delete(candidate);
      }
    }
    const deliveryExpiry = this.deliveries.get(deliveryId);
    if (deliveryExpiry !== undefined && deliveryExpiry > now) {
      return false;
    }

    const generation = this.generations.get(userId) ?? 0;
    if (generation >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError('The GitHub authorization generation is invalid');
    }
    this.deliveries.set(deliveryId, now + this.deliveryTtlMs);
    this.generations.set(userId, generation + 1);
    return true;
  }
}

export class RedisGitHubAuthorizationRevocationStore
  implements GitHubAuthorizationRevocationStore
{
  private readonly prefix: string;
  private readonly deliveryTtlMs: number;

  constructor(
    private readonly client: RedisSessionClient,
    options: RedisGitHubAuthorizationRevocationStoreOptions,
  ) {
    if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/.test(options.prefix)) {
      throw new TypeError(
        'The GitHub authorization revocation prefix is invalid',
      );
    }
    this.prefix = options.prefix;
    this.deliveryTtlMs = boundedTtl(
      options.deliveryTtlMs,
      DEFAULT_DELIVERY_TTL_MS,
      MAX_DELIVERY_TTL_MS,
      'GitHub webhook delivery',
    );
  }

  async generation(userId: number): Promise<number> {
    assertUserId(userId);
    const value = await this.client.get(this.generationKey(userId));
    return value === null ? 0 : parseGeneration(value);
  }

  async revoke(userId: number, deliveryId: string): Promise<boolean> {
    assertUserId(userId);
    assertDeliveryId(deliveryId);
    const result = await this.client.eval(APPLY_REVOCATION_SCRIPT, {
      keys: [
        this.generationKey(userId),
        `${this.prefix}:delivery:${digest(deliveryId)}`,
      ],
      arguments: [String(this.deliveryTtlMs)],
    });
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      (result[0] !== 0 && result[0] !== 1) ||
      !Number.isSafeInteger(result[1]) ||
      (result[1] as number) < 0
    ) {
      throw new TypeError(
        'The GitHub authorization revocation result is invalid',
      );
    }
    return result[0] === 1;
  }

  private generationKey(userId: number): string {
    return `${this.prefix}:generation:${digest(String(userId))}`;
  }
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError('The GitHub user ID is invalid');
  }
}

function assertDeliveryId(deliveryId: string): void {
  if (
    deliveryId.length === 0 ||
    deliveryId.length > 128 ||
    !/^[a-z0-9._:-]+$/i.test(deliveryId)
  ) {
    throw new TypeError('The GitHub webhook delivery ID is invalid');
  }
}

function parseGeneration(value: string): number {
  if (!/^[0-9]{1,16}$/.test(value)) {
    throw new TypeError('The GitHub authorization generation is invalid');
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError('The GitHub authorization generation is invalid');
  }
  return generation;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function boundedTtl(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const ttl = value ?? fallback;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maximum) {
    throw new TypeError(`The ${label} TTL is invalid`);
  }
  return ttl;
}
