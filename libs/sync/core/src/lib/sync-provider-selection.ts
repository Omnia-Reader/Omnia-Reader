import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectDeleteRequest,
  ObjectDownloadOptions,
  ObjectUploadRequest,
} from './library-sync-transport';

export type SyncProviderKind = 'git' | 'mega';

export interface SyncProviderSelection {
  current(): SyncProviderKind | null;
  select(provider: SyncProviderKind): void;
  clear(): void;
  subscribe?(listener: (provider: SyncProviderKind | null) => void): () => void;
}

export class BrowserSyncProviderSelection implements SyncProviderSelection {
  private readonly storageKey = 'omnia-reader.sync-provider';
  private readonly listeners = new Set<
    (provider: SyncProviderKind | null) => void
  >();

  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  current(): SyncProviderKind | null {
    const value = this.storage.getItem(this.storageKey);
    return value === 'git' || value === 'mega' ? value : null;
  }

  select(provider: SyncProviderKind): void {
    this.storage.setItem(this.storageKey, provider);
    this.notify(provider);
  }

  clear(): void {
    this.storage.removeItem(this.storageKey);
    this.notify(null);
  }

  subscribe(listener: (provider: SyncProviderKind | null) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.current());
    } catch {
      // Provider state presentation cannot prevent a valid subscription.
    }
    return () => this.listeners.delete(listener);
  }

  private notify(provider: SyncProviderKind | null): void {
    for (const listener of this.listeners) {
      try {
        listener(provider);
      } catch {
        // Provider state presentation cannot prevent a valid selection.
      }
    }
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

  downloadObject(path: string, options?: ObjectDownloadOptions) {
    return this.active().downloadObject(path, options);
  }

  uploadObject(request: ObjectUploadRequest) {
    return this.active().uploadObject(request);
  }

  deleteObject(request: ObjectDeleteRequest) {
    const active = this.active();
    if (!active.deleteObject) {
      throw new Error(
        'The selected synchronization provider cannot delete remote publications',
      );
    }
    return active.deleteObject(request);
  }

  private active(): LibrarySyncTransport {
    const provider = this.selection.current();
    if (!provider) {
      throw new SyncProviderNotSelectedError();
    }
    return this.providers[provider];
  }
}
