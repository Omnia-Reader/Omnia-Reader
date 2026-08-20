import { TestBed } from '@angular/core/testing';
import {
  createOpaqueId,
  DEVICE_ID,
  resolveBrowserDeviceId,
} from './device-identity';

describe('resolveBrowserDeviceId', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('keeps the established reader identity and aligns the logical-book key', () => {
    const storage = new MemoryStorage({
      'omnia-reader-device-id': 'reader-device',
      'omnia-reader.device-id': 'logical-device',
    });

    expect(resolveBrowserDeviceId(storage, () => 'new-device')).toBe(
      'reader-device',
    );
    expect(storage.getItem('omnia-reader-device-id')).toBe('reader-device');
    expect(storage.getItem('omnia-reader.device-id')).toBe('reader-device');
  });

  it('migrates the existing logical-book identity when no reader ID exists', () => {
    const storage = new MemoryStorage({
      'omnia-reader.device-id': 'logical-device',
    });

    expect(resolveBrowserDeviceId(storage, () => 'new-device')).toBe(
      'logical-device',
    );
    expect(storage.getItem('omnia-reader-device-id')).toBe('logical-device');
  });

  it('replaces malformed persisted identity with one bounded generated ID', () => {
    const storage = new MemoryStorage({
      'omnia-reader-device-id': 'x'.repeat(129),
      'omnia-reader.device-id': 'invalid\nidentity',
    });

    expect(resolveBrowserDeviceId(storage, () => 'generated-device')).toBe(
      'generated-device',
    );
    expect(storage.getItem('omnia-reader-device-id')).toBe('generated-device');
    expect(storage.getItem('omnia-reader.device-id')).toBe('generated-device');
  });

  it('returns a session identity when browser storage rejects access', () => {
    const storage = new MemoryStorage();
    storage.rejectAccess = true;

    expect(resolveBrowserDeviceId(storage, () => 'session-device')).toBe(
      'session-device',
    );
  });

  it('keeps the generated fallback stable through the root injection token', () => {
    const storage = new MemoryStorage();
    storage.rejectAccess = true;
    vi.stubGlobal('localStorage', storage);

    const first = TestBed.inject(DEVICE_ID);

    expect(first).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
    expect(TestBed.inject(DEVICE_ID)).toBe(first);
  });

  it('generates a bounded opaque ID without Web Crypto support', () => {
    expect(createOpaqueId(null)).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
  });
});

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private readonly values = new Map<string, string>();
  rejectAccess = false;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    Object.entries(initial).forEach(([key, value]) =>
      this.values.set(key, value),
    );
  }

  getItem(key: string): string | null {
    this.assertAccessible();
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.assertAccessible();
    this.values.set(key, value);
  }

  private assertAccessible(): void {
    if (this.rejectAccess) {
      throw new DOMException('Storage denied', 'SecurityError');
    }
  }
}
