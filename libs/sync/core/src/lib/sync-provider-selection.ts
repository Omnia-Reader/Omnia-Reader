import {
  DocumentWriteRequest,
  DocumentDeleteRequest,
  LibrarySyncTransport,
  ObjectDeleteRequest,
  ObjectDownloadOptions,
  ObjectUploadRequest,
  ObjectTransferOptions,
  RemoteSyncEntryDeleteRequest,
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
  private selectedProvider: SyncProviderKind | null = null;
  private loaded = false;

  constructor(
    private readonly storage: Storage | undefined = browserStorage(),
  ) {}

  current(): SyncProviderKind | null {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const value = this.storage?.getItem(this.storageKey);
        this.selectedProvider =
          value === 'git' || value === 'mega' ? value : null;
      } catch {
        // Optional synchronization cannot make local reading depend on access
        // to browser storage. Keep provider selection session-local instead.
      }
    }
    return this.selectedProvider;
  }

  select(provider: SyncProviderKind): void {
    this.loaded = true;
    this.selectedProvider = provider;
    try {
      this.storage?.setItem(this.storageKey, provider);
    } catch {
      // The in-memory selection remains authoritative for this session.
    }
    this.notify(provider);
  }

  clear(): void {
    this.loaded = true;
    this.selectedProvider = null;
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      // Clearing the in-memory selection is sufficient for this session.
    }
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

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
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

  destinationRevision(options?: Pick<ObjectTransferOptions, 'signal'>) {
    const active = this.active();
    if (!active.destinationRevision) {
      return Promise.resolve(null);
    }
    return active.destinationRevision(options);
  }

  list(prefix: string) {
    return this.active().list(prefix);
  }

  listEntries(prefix: string) {
    const active = this.active();
    if (!active.listEntries) {
      throw new Error(
        'The selected synchronization provider cannot inventory remote entries',
      );
    }
    return active.listEntries(prefix);
  }

  async deleteEntries(
    requests: readonly RemoteSyncEntryDeleteRequest[],
  ): Promise<void> {
    const active = this.active();
    if (active.deleteEntries) {
      await active.deleteEntries(requests);
      return;
    }
    if (!active.deleteEntry) {
      throw new Error(
        'The selected synchronization provider cannot delete remote entries',
      );
    }
    for (const request of requests) {
      await active.deleteEntry(request);
    }
  }

  deleteEntry(request: RemoteSyncEntryDeleteRequest) {
    const active = this.active();
    if (!active.deleteEntry) {
      throw new Error(
        'The selected synchronization provider cannot delete remote entries',
      );
    }
    return active.deleteEntry(request);
  }

  read(path: string) {
    return this.active().read(path);
  }

  write(request: DocumentWriteRequest) {
    return this.active().write(request);
  }

  deleteDocument(request: DocumentDeleteRequest) {
    const active = this.active();
    if (!active.deleteDocument) {
      throw new Error(
        'The selected synchronization provider cannot delete remote documents',
      );
    }
    return active.deleteDocument(request);
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
