import { InjectionToken, Provider } from '@angular/core';
import { PlatformPort } from '@omnia-reader/reader/domain';
import { BrowserPlatform } from './browser-platform';
import { TauriPlatform } from './tauri-platform';

export const PLATFORM_PORT = new InjectionToken<PlatformPort>('PLATFORM_PORT');

export function providePlatform(): Provider {
  return {
    provide: PLATFORM_PORT,
    useFactory: createPlatform,
  };
}

export function createPlatform(): PlatformPort {
  return isTauriRuntime() ? new TauriPlatform() : new BrowserPlatform();
}

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in globalThis;
}
