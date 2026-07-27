import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GatewayHttpError } from './gateway-contract.js';

export interface GatewaySessionStore<T extends object> {
  get(sessionId: string): Promise<T | null>;
  set(sessionId: string, value: T): Promise<void>;
  move(
    sessionId: string,
    replacementSessionId: string,
    value: T,
  ): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface RedisSessionClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  pTTL(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

interface EncryptedRecord {
  ciphertext: string;
  expiresAt: number;
}

interface DecryptedValue<T> {
  value: T;
  needsRotation: boolean;
}

export interface EncryptedSessionStoreOptions {
  ttlMs?: number;
  now?: () => number;
  random?: (size: number) => Buffer;
}

export interface EncryptedRedisSessionStoreOptions
  extends EncryptedSessionStoreOptions {
  prefix: string;
}

export interface EncryptedFileSessionStoreOptions
  extends EncryptedSessionStoreOptions {
  filePath: string;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const MAX_SESSION_KEYS = 4;
const MOVE_SESSION_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
if KEYS[1] ~= KEYS[2] then
  redis.call('DEL', KEYS[1])
end
return 1
`;

export class EncryptedMemorySessionStore<T extends object>
  implements GatewaySessionStore<T>
{
  private readonly records = new Map<string, EncryptedRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cipher: SessionCipher<T>;

  constructor(
    keys: Buffer | readonly Buffer[],
    options: EncryptedSessionStoreOptions = {},
  ) {
    this.ttlMs = sessionTtl(options.ttlMs);
    this.now = options.now ?? Date.now;
    this.cipher = new SessionCipher(keys, options.random ?? randomBytes);
  }

  async get(sessionId: string): Promise<T | null> {
    assertSessionId(sessionId);
    const record = this.records.get(sessionId);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= this.now()) {
      this.records.delete(sessionId);
      return null;
    }
    try {
      const decrypted = this.cipher.decrypt(sessionId, record.ciphertext);
      if (decrypted.needsRotation) {
        record.ciphertext = this.cipher.encrypt(sessionId, decrypted.value);
      }
      return decrypted.value;
    } catch {
      this.records.delete(sessionId);
      throw invalidProviderSession();
    }
  }

  async set(sessionId: string, value: T): Promise<void> {
    assertSessionId(sessionId);
    this.records.set(sessionId, {
      ciphertext: this.cipher.encrypt(sessionId, value),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  async move(
    sessionId: string,
    replacementSessionId: string,
    value: T,
  ): Promise<void> {
    assertSessionId(sessionId);
    assertSessionId(replacementSessionId);
    const record = this.records.get(sessionId);
    if (!record || record.expiresAt <= this.now()) {
      this.records.delete(sessionId);
      throw invalidProviderSession();
    }
    try {
      this.cipher.decrypt(sessionId, record.ciphertext);
    } catch {
      this.records.delete(sessionId);
      throw invalidProviderSession();
    }
    this.records.set(replacementSessionId, {
      ciphertext: this.cipher.encrypt(replacementSessionId, value),
      expiresAt: this.now() + this.ttlMs,
    });
    if (sessionId !== replacementSessionId) {
      this.records.delete(sessionId);
    }
  }

  async delete(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    this.records.delete(sessionId);
  }
}

export class EncryptedRedisSessionStore<T extends object>
  implements GatewaySessionStore<T>
{
  private readonly ttlMs: number;
  private readonly cipher: SessionCipher<T>;
  private readonly prefix: string;

  constructor(
    private readonly client: RedisSessionClient,
    keys: Buffer | readonly Buffer[],
    options: EncryptedRedisSessionStoreOptions,
  ) {
    if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/.test(options.prefix)) {
      throw new TypeError('The Redis session prefix is invalid');
    }
    this.prefix = options.prefix;
    this.ttlMs = sessionTtl(options.ttlMs);
    this.cipher = new SessionCipher(keys, options.random ?? randomBytes);
  }

  async get(sessionId: string): Promise<T | null> {
    const key = this.storageKey(sessionId);
    const ciphertext = await this.client.get(key);
    if (ciphertext === null) {
      return null;
    }
    try {
      const decrypted = this.cipher.decrypt(sessionId, ciphertext);
      if (decrypted.needsRotation) {
        const remainingTtl = await this.client.pTTL(key);
        if (remainingTtl <= 0) {
          await this.client.del(key);
          return null;
        }
        await this.client.set(
          key,
          this.cipher.encrypt(sessionId, decrypted.value),
          { PX: remainingTtl },
        );
      }
      return decrypted.value;
    } catch {
      await this.client.del(key);
      throw invalidProviderSession();
    }
  }

  async set(sessionId: string, value: T): Promise<void> {
    const key = this.storageKey(sessionId);
    await this.client.set(key, this.cipher.encrypt(sessionId, value), {
      PX: this.ttlMs,
    });
  }

  async move(
    sessionId: string,
    replacementSessionId: string,
    value: T,
  ): Promise<void> {
    const sourceKey = this.storageKey(sessionId);
    const replacementKey = this.storageKey(replacementSessionId);
    const moved = await this.client.eval(MOVE_SESSION_SCRIPT, {
      keys: [sourceKey, replacementKey],
      arguments: [
        this.cipher.encrypt(replacementSessionId, value),
        String(this.ttlMs),
      ],
    });
    if (moved !== 1) {
      throw invalidProviderSession();
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.client.del(this.storageKey(sessionId));
  }

  private storageKey(sessionId: string): string {
    assertSessionId(sessionId);
    const digest = createHash('sha256')
      .update(sessionId, 'utf8')
      .digest('base64url');
    return `${this.prefix}:${digest}`;
  }
}

interface EncryptedFile {
  version: 1;
  records: Record<string, EncryptedRecord>;
}

export class EncryptedFileSessionStore<T extends object>
  implements GatewaySessionStore<T>
{
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cipher: SessionCipher<T>;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    keys: Buffer | readonly Buffer[],
    options: EncryptedFileSessionStoreOptions,
  ) {
    if (!options.filePath || options.filePath.includes('\0')) {
      throw new TypeError('The persistent session file path is invalid');
    }
    this.filePath = options.filePath;
    this.ttlMs = sessionTtl(options.ttlMs);
    this.now = options.now ?? Date.now;
    this.cipher = new SessionCipher(keys, options.random ?? randomBytes);
  }

  async get(sessionId: string): Promise<T | null> {
    assertSessionId(sessionId);
    return this.serialized(async () => {
      const file = await this.read();
      const storageKey = this.storageKey(sessionId);
      const record = file.records[storageKey];
      if (!record) {
        return null;
      }
      if (record.expiresAt <= this.now()) {
        delete file.records[storageKey];
        await this.write(file);
        return null;
      }
      try {
        const decrypted = this.cipher.decrypt(sessionId, record.ciphertext);
        if (decrypted.needsRotation) {
          record.ciphertext = this.cipher.encrypt(sessionId, decrypted.value);
          await this.write(file);
        }
        return decrypted.value;
      } catch {
        delete file.records[storageKey];
        await this.write(file);
        throw invalidProviderSession();
      }
    });
  }

  async set(sessionId: string, value: T): Promise<void> {
    assertSessionId(sessionId);
    await this.serialized(async () => {
      const file = await this.read();
      this.removeExpired(file);
      file.records[this.storageKey(sessionId)] = {
        ciphertext: this.cipher.encrypt(sessionId, value),
        expiresAt: this.now() + this.ttlMs,
      };
      await this.write(file);
    });
  }

  async move(
    sessionId: string,
    replacementSessionId: string,
    value: T,
  ): Promise<void> {
    assertSessionId(sessionId);
    assertSessionId(replacementSessionId);
    await this.serialized(async () => {
      const file = await this.read();
      const sourceKey = this.storageKey(sessionId);
      const record = file.records[sourceKey];
      if (!record || record.expiresAt <= this.now()) {
        delete file.records[sourceKey];
        await this.write(file);
        throw invalidProviderSession();
      }
      try {
        this.cipher.decrypt(sessionId, record.ciphertext);
      } catch {
        delete file.records[sourceKey];
        await this.write(file);
        throw invalidProviderSession();
      }
      file.records[this.storageKey(replacementSessionId)] = {
        ciphertext: this.cipher.encrypt(replacementSessionId, value),
        expiresAt: this.now() + this.ttlMs,
      };
      if (sessionId !== replacementSessionId) {
        delete file.records[sourceKey];
      }
      await this.write(file);
    });
  }

  async delete(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await this.serialized(async () => {
      const file = await this.read();
      if (delete file.records[this.storageKey(sessionId)]) {
        await this.write(file);
      }
    });
  }

  private storageKey(sessionId: string): string {
    return createHash('sha256').update(sessionId, 'utf8').digest('base64url');
  }

  private removeExpired(file: EncryptedFile): void {
    const now = this.now();
    for (const [key, record] of Object.entries(file.records)) {
      if (record.expiresAt <= now) {
        delete file.records[key];
      }
    }
  }

  private async read(): Promise<EncryptedFile> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { version: 1, records: {} };
      }
      throw error;
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_FILE_BYTES) {
      throw invalidSessionFile();
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw invalidSessionFile();
    }
    if (!isEncryptedFile(value)) {
      throw invalidSessionFile();
    }
    return value;
  }

  private async write(file: EncryptedFile): Promise<void> {
    const serialized = JSON.stringify(file);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_FILE_BYTES) {
      throw new TypeError(
        'The persistent synchronization session store is full',
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private serialized<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class SessionCipher<T extends object> {
  private readonly keys: readonly Buffer[];
  private readonly keyIds: readonly string[];

  constructor(
    keys: Buffer | readonly Buffer[],
    private readonly random: (size: number) => Buffer,
  ) {
    this.keys = normalizeKeys(keys);
    this.keyIds = this.keys.map(keyId);
  }

  encrypt(sessionId: string, value: T): string {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_BYTES) {
      throw new TypeError('The provider session is too large');
    }
    const iv = this.random(12);
    if (iv.byteLength !== 12) {
      throw new TypeError('The session IV source must return 12 bytes');
    }
    const keyIdValue = this.keyIds[0];
    const cipher = createCipheriv('aes-256-gcm', this.keys[0], iv);
    cipher.setAAD(aad(sessionId, keyIdValue));
    const encrypted = Buffer.concat([
      cipher.update(serialized, 'utf8'),
      cipher.final(),
    ]);
    const payload = Buffer.concat([
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]).toString('base64url');
    return `v1.${keyIdValue}.${payload}`;
  }

  decrypt(sessionId: string, ciphertext: string): DecryptedValue<T> {
    if (ciphertext.length > MAX_SESSION_BYTES * 2) {
      throw new Error('Invalid encrypted session');
    }
    const envelope = ciphertext.split('.');
    if (envelope.length === 3 && envelope[0] === 'v1') {
      const keyIndex = this.keyIds.indexOf(envelope[1]);
      if (keyIndex < 0) {
        throw new Error('Unknown session encryption key');
      }
      return {
        value: this.decryptPayload(
          sessionId,
          envelope[2],
          this.keys[keyIndex],
          aad(sessionId, envelope[1]),
        ),
        needsRotation: keyIndex !== 0,
      };
    }

    for (const [keyIndex, key] of this.keys.entries()) {
      try {
        return {
          value: this.decryptPayload(
            sessionId,
            ciphertext,
            key,
            Buffer.from(sessionId),
          ),
          needsRotation: true,
        };
      } catch {
        if (keyIndex === this.keys.length - 1) {
          throw new Error('Invalid encrypted session');
        }
      }
    }
    throw new Error('Invalid encrypted session');
  }

  private decryptPayload(
    sessionId: string,
    payload: string,
    key: Buffer,
    additionalData: Buffer,
  ): T {
    assertSessionId(sessionId);
    const sealed = Buffer.from(payload, 'base64url');
    if (sealed.byteLength < 29 || sealed.byteLength > MAX_SESSION_BYTES) {
      throw new Error('Invalid encrypted session');
    }
    const iv = sealed.subarray(0, 12);
    const tag = sealed.subarray(12, 28);
    const encrypted = sealed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
    const value: unknown = JSON.parse(plaintext);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid encrypted session');
    }
    return value as T;
  }
}

export function sessionEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== value) {
    throw new TypeError(
      'OMNIA_SYNC_SESSION_KEY must encode exactly 32 random bytes',
    );
  }
  return key;
}

export function sessionEncryptionKeys(
  current: string,
  previous = '',
): readonly Buffer[] {
  const encoded = [
    current,
    ...previous
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  if (encoded.length > MAX_SESSION_KEYS) {
    throw new TypeError(
      'At most four synchronization session keys are allowed',
    );
  }
  return normalizeKeys(encoded.map(sessionEncryptionKey));
}

function normalizeKeys(keys: Buffer | readonly Buffer[]): readonly Buffer[] {
  const normalized = (Buffer.isBuffer(keys) ? [keys] : keys).map((key) =>
    Buffer.from(key),
  );
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SESSION_KEYS ||
    normalized.some((key) => key.byteLength !== 32)
  ) {
    throw new TypeError(
      'Synchronization session keys must contain 32-byte AES keys',
    );
  }
  const identifiers = normalized.map(keyId);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new TypeError('Synchronization session keys must be unique');
  }
  return normalized;
}

function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 16);
}

function aad(sessionId: string, keyIdValue: string): Buffer {
  assertSessionId(sessionId);
  return Buffer.from(`omnia-sync-session:v1:${keyIdValue}:${sessionId}`);
}

function assertSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    Buffer.byteLength(sessionId, 'utf8') > MAX_SESSION_ID_BYTES ||
    sessionId.includes('\0')
  ) {
    throw new TypeError('The gateway session ID is invalid');
  }
}

function sessionTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 7 * 24 * 60 * 60 * 1000) {
    throw new TypeError('The synchronization session TTL is invalid');
  }
  return ttl;
}

function invalidProviderSession(): GatewayHttpError {
  return new GatewayHttpError(401, 'Provider session is invalid');
}

function invalidSessionFile(): TypeError {
  return new TypeError(
    'The persistent synchronization session store is invalid',
  );
}

function isEncryptedFile(value: unknown): value is EncryptedFile {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1
  ) {
    return false;
  }
  const records = (value as { records?: unknown }).records;
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    return false;
  }
  return Object.entries(records).every(
    ([key, record]) =>
      /^[A-Za-z0-9_-]{43}$/.test(key) &&
      !!record &&
      typeof record === 'object' &&
      !Array.isArray(record) &&
      typeof (record as EncryptedRecord).ciphertext === 'string' &&
      (record as EncryptedRecord).ciphertext.length <= MAX_SESSION_BYTES * 2 &&
      Number.isSafeInteger((record as EncryptedRecord).expiresAt) &&
      (record as EncryptedRecord).expiresAt > 0,
  );
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
