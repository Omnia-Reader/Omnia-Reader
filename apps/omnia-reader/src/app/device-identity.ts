import { InjectionToken } from '@angular/core';

const DEVICE_ID_STORAGE_KEY = 'omnia-reader-device-id';
const LEGACY_LOGICAL_BOOK_DEVICE_ID_STORAGE_KEY = 'omnia-reader.device-id';
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export const DEVICE_ID = new InjectionToken<string>('Omnia Reader device ID', {
  providedIn: 'root',
  factory: () => resolveBrowserDeviceId(),
});

export function createOpaqueId(
  randomUuid: (() => string) | null = browserRandomUuid(),
): string {
  try {
    const id = randomUuid?.();
    if (validDeviceId(id)) return id;
  } catch {
    // Fall through to a bounded locally generated identifier.
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function resolveBrowserDeviceId(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = browserStorage(),
  createId: () => string = createDeviceId,
): string {
  let deviceId: string | null = null;
  try {
    const current = storage?.getItem(DEVICE_ID_STORAGE_KEY);
    const legacy = storage?.getItem(LEGACY_LOGICAL_BOOK_DEVICE_ID_STORAGE_KEY);
    deviceId = validDeviceId(current)
      ? current
      : validDeviceId(legacy)
        ? legacy
        : null;
  } catch {
    // A session identity remains sufficient when browser storage is restricted.
  }

  if (!deviceId) {
    const created = createId();
    deviceId = validDeviceId(created) ? created : createDeviceId();
  }

  persistDeviceId(storage, DEVICE_ID_STORAGE_KEY, deviceId);
  persistDeviceId(storage, LEGACY_LOGICAL_BOOK_DEVICE_ID_STORAGE_KEY, deviceId);
  return deviceId;
}

function persistDeviceId(
  storage: Pick<Storage, 'setItem'> | undefined,
  key: string,
  deviceId: string,
): void {
  try {
    storage?.setItem(key, deviceId);
  } catch {
    // Device attribution remains stable through the root-scoped token.
  }
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function createDeviceId(): string {
  return createOpaqueId();
}

function browserRandomUuid(): (() => string) | null {
  try {
    return globalThis.crypto?.randomUUID?.bind(globalThis.crypto) ?? null;
  } catch {
    return null;
  }
}

function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}
