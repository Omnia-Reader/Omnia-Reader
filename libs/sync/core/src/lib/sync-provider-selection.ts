import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectUploadRequest,
} from './library-sync-transport';

export type SyncProviderKind = 'git' | 'mega';

export interface SyncProviderSelection {
  current(): SyncProviderKind | null;
  select(provider: SyncProviderKind): void;
  clear(): void;
}

export class BrowserSyncProviderSelection implements SyncProviderSelection {
  private readonly storageKey = 'omnia-reader.sync-provider';

  current(): SyncProviderKind | null {
    const value = globalThis.localStorage?.getItem(this.storageKey);
    return value === 'git' || value === 'mega' ? value : null;
  }

  select(provider: SyncProviderKind): void {
    globalThis.localStorage?.setItem(this.storageKey, provider);
  }

  clear(): void {
    globalThis.localStorage?.removeItem(this.storageKey);
  }
}

export class SyncProviderNotSelectedError extends Error {
  constructor() {
    super('Choose a synchronization provider first');
    this.name = 'SyncProviderNotSelectedError';
  }
}

export class SelectedLibrarySyncTransport implements LibrarySyncTransport {
  constructor(
    private readonly selection: SyncProviderSelection,
    private readonly providers: Readonly<
      Record<SyncProviderKind, LibrarySyncTransport>
    >,
  ) {}

  list(prefix: string) {
    return this.active().list(prefix);
  }

  read(path: string) {
    return this.active().read(path);
  }

  write(request: DocumentWriteRequest) {
    return this.active().write(request);
  }

  headObject(path: string) {
    return this.active().headObject(path);
  }

  downloadObject(path: string) {
    return this.active().downloadObject(path);
  }

  uploadObject(request: ObjectUploadRequest) {
    return this.active().uploadObject(request);
  }

  private active(): LibrarySyncTransport {
    const provider = this.selection.current();
    if (!provider) {
      throw new SyncProviderNotSelectedError();
    }
    return this.providers[provider];
  }
}
