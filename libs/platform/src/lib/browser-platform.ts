import {
  BookSource,
  FileSaveRequest,
  PlatformFileSave,
  PlatformPort,
  PlatformStorageStatus,
} from '@omnia-reader/reader/domain';
import { BrowserBookSource } from './browser-book-source';
import { registerPageBackgroundListener } from './page-lifecycle';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: readonly {
    description?: string;
    accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

type ShowSaveFilePicker = (
  options?: SaveFilePickerOptions,
) => Promise<FileSystemFileHandle>;

export class BrowserPlatform implements PlatformPort {
  readonly kind = 'web' as const;

  constructor(
    private readonly storageManager: StorageManager | undefined = globalThis
      .navigator?.storage,
  ) {}

  get supportsStreamingFileSave(): boolean {
    return typeof showSaveFilePicker() === 'function';
  }

  async getStorageStatus(): Promise<PlatformStorageStatus> {
    const estimate = await readStorageEstimate(this.storageManager);
    if (
      !this.storageManager ||
      typeof this.storageManager.persisted !== 'function'
    ) {
      return { persistence: 'unavailable', ...estimate };
    }

    const persisted = await this.storageManager.persisted();
    return {
      persistence: persisted
        ? 'persistent'
        : typeof this.storageManager.persist === 'function'
          ? 'best-effort'
          : 'unavailable',
      ...estimate,
    };
  }

  async requestPersistentStorage(): Promise<PlatformStorageStatus> {
    if (
      !this.storageManager ||
      typeof this.storageManager.persist !== 'function'
    ) {
      return this.getStorageStatus();
    }

    const granted = await this.storageManager.persist();
    const status = await this.getStorageStatus();
    return granted ? { ...status, persistence: 'persistent' } : status;
  }

  pickPublications(): Promise<readonly BookSource[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      let resolved = false;
      const finish = (sources: readonly BookSource[]) => {
        if (!resolved) {
          resolved = true;
          resolve(sources);
        }
      };
      input.type = 'file';
      input.accept = '.epub,.pdf,application/epub+zip,application/pdf';
      input.multiple = true;
      input.addEventListener(
        'change',
        () => {
          finish(
            Array.from(input.files ?? []).map(
              (file) => new BrowserBookSource(file),
            ),
          );
        },
        { once: true },
      );
      input.addEventListener('cancel', () => finish([]), { once: true });
      input.click();
    });
  }

  async createFileSave(
    request: FileSaveRequest,
  ): Promise<PlatformFileSave | null> {
    const picker = showSaveFilePicker();
    if (!picker) {
      return null;
    }

    try {
      const extensions = request.extensions.map((extension) =>
        extension.startsWith('.') ? extension : `.${extension}`,
      );
      const handle = await picker(
        extensions.length === 0
          ? {
              suggestedName: request.suggestedName,
            }
          : {
              suggestedName: request.suggestedName,
              types: [
                {
                  description: 'Omnia Reader backup',
                  accept: {
                    [request.mediaType]: extensions,
                  },
                },
              ],
            },
      );
      return {
        writable: await handle.createWritable(),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null;
      }
      throw error;
    }
  }

  async onPublicationsOpened(
    callback: (sources: readonly BookSource[]) => void | Promise<void>,
  ): Promise<() => void> {
    const containsFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (event: DragEvent) => {
      if (containsFiles(event)) {
        event.preventDefault();
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!containsFiles(event)) {
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []).filter(
        isSupportedPublication,
      );
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      void callback(files.map((file) => new BrowserBookSource(file)));
    };
    globalThis.addEventListener('dragover', onDragOver);
    globalThis.addEventListener('drop', onDrop);
    return () => {
      globalThis.removeEventListener('dragover', onDragOver);
      globalThis.removeEventListener('drop', onDrop);
    };
  }

  async onBookDeepLink(
    callback: (bookId: string) => void | Promise<void>,
  ): Promise<() => void> {
    void callback;
    return () => undefined;
  }

  async onBackRequested(
    callback: () => void | Promise<void>,
  ): Promise<() => void> {
    void callback;
    return () => undefined;
  }

  async openExternalUrl(url: string): Promise<void> {
    const safeUrl = requireExternalHttpUrl(url);
    globalThis.open(safeUrl, '_blank', 'noopener,noreferrer');
  }

  async requestApplicationExit(): Promise<void> {
    // Browsers own tab and window lifecycle.
  }

  onBackground(callback: () => void): () => void {
    return registerPageBackgroundListener(callback);
  }
}

function showSaveFilePicker(): ShowSaveFilePicker | undefined {
  return (
    globalThis as typeof globalThis & {
      showSaveFilePicker?: ShowSaveFilePicker;
    }
  ).showSaveFilePicker;
}

function requireExternalHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS links can be opened');
  }
  return url.href;
}

function isSupportedPublication(file: File): boolean {
  const name = file.name.toLocaleLowerCase();
  return (
    name.endsWith('.epub') ||
    name.endsWith('.pdf') ||
    file.type === 'application/epub+zip' ||
    file.type === 'application/pdf'
  );
}

async function readStorageEstimate(
  storageManager: StorageManager | undefined,
): Promise<Pick<PlatformStorageStatus, 'usageBytes' | 'quotaBytes'>> {
  if (!storageManager || typeof storageManager.estimate !== 'function') {
    return {};
  }

  try {
    const estimate = await storageManager.estimate();
    return {
      ...(isValidByteCount(estimate.usage)
        ? { usageBytes: estimate.usage }
        : {}),
      ...(isValidByteCount(estimate.quota)
        ? { quotaBytes: estimate.quota }
        : {}),
    };
  } catch {
    return {};
  }
}

function isValidByteCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
