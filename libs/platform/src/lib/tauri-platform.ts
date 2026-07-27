import {
  BookSource,
  FileSaveRequest,
  PlatformFileSave,
  PlatformPort,
  PlatformStorageStatus,
} from '@omnia-reader/reader/domain';
import { registerPageBackgroundListener } from './page-lifecycle';

interface NativePublicationDescriptor {
  sourceId: string;
  name: string;
  mediaType: string;
  size: number;
}

type NativeBytes = ArrayBuffer | Uint8Array | number[];
interface NativeInvokeOptions {
  headers: Record<string, string>;
}
export type NativeInvoke = <T>(
  command: string,
  body?: Record<string, unknown> | Uint8Array,
  options?: NativeInvokeOptions,
) => Promise<T>;
export type NativeUnlisten = () => void;
export type NativeListen = (
  event: string,
  callback: (event: { payload: unknown }) => void,
) => Promise<NativeUnlisten>;
export type NativeBackListen = (
  callback: () => void | Promise<void>,
) => Promise<NativeUnlisten>;
export type NativeOpenExternal = (url: string) => Promise<void>;
type TauriPlatformKind = 'tauri-desktop' | 'tauri-android';
const BACKUP_EXPORT_ID_HEADER = 'X-Omnia-Export-Id';
const NATIVE_BACKUP_CHUNK_SIZE = 512 * 1024;
const BOOK_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TAURI_SUSPENDED_EVENT = 'tauri://suspended';

export class TauriPlatform implements PlatformPort {
  readonly supportsStreamingFileSave = true;

  constructor(
    private readonly invokeNative: NativeInvoke = invokeTauri,
    private readonly listenNative: NativeListen = listenTauri,
    private readonly listenBackNative: NativeBackListen = listenTauriBack,
    readonly kind: TauriPlatformKind = detectTauriPlatformKind(),
    private readonly openExternalNative: NativeOpenExternal = openTauriExternal,
  ) {}

  async getStorageStatus(): Promise<PlatformStorageStatus> {
    return { persistence: 'persistent' };
  }

  async requestPersistentStorage(): Promise<PlatformStorageStatus> {
    return this.getStorageStatus();
  }

  async pickPublications(): Promise<readonly BookSource[]> {
    const publications =
      await this.invokeNative<NativePublicationDescriptor[]>(
        'pick_publications',
      );
    return this.createSources(publications);
  }

  async createFileSave(
    request: FileSaveRequest,
  ): Promise<PlatformFileSave | null> {
    const exportId = await this.invokeNative<string | null>(
      'begin_backup_export',
      {
        suggestedName: request.suggestedName,
      },
    );
    if (!exportId) {
      return null;
    }

    let settled = false;
    const invokeNative = this.invokeNative;
    return {
      writable: new WritableStream<Uint8Array>({
        async write(chunk) {
          for (
            let offset = 0;
            offset < chunk.byteLength;
            offset += NATIVE_BACKUP_CHUNK_SIZE
          ) {
            await invokeNative<void>(
              'write_backup_chunk',
              chunk.slice(
                offset,
                Math.min(offset + NATIVE_BACKUP_CHUNK_SIZE, chunk.byteLength),
              ),
              {
                headers: {
                  [BACKUP_EXPORT_ID_HEADER]: exportId,
                },
              },
            );
          }
        },
        async close() {
          settled = true;
          await invokeNative<void>('commit_backup_export', { exportId });
        },
        async abort() {
          if (!settled) {
            settled = true;
            await invokeNative<void>('cancel_backup_export', { exportId });
          }
        },
      }),
    };
  }

  async onPublicationsOpened(
    callback: (sources: readonly BookSource[]) => void | Promise<void>,
  ): Promise<() => void> {
    let delivery = Promise.resolve();
    const drain = (): Promise<void> => {
      delivery = delivery
        .catch(() => undefined)
        .then(async () => {
          const publications = await this.invokeNative<
            NativePublicationDescriptor[]
          >('take_opened_publications');
          if (publications.length > 0) {
            await callback(this.createSources(publications));
          }
        });
      return delivery;
    };
    const unlisten = await this.listenNative('publications-opened', () => {
      void drain();
    });
    await drain();
    return unlisten;
  }

  async onBookDeepLink(
    callback: (bookId: string) => void | Promise<void>,
  ): Promise<() => void> {
    let delivery = Promise.resolve();
    const drain = (): Promise<void> => {
      delivery = delivery
        .catch(() => undefined)
        .then(async () => {
          const value = await this.invokeNative<unknown>(
            'take_opened_book_deep_links',
          );
          for (const bookId of normalizeBookIds(value)) {
            await callback(bookId);
          }
        });
      return delivery;
    };
    const unlisten = await this.listenNative('book-deep-link-opened', () => {
      void drain();
    });
    await drain();
    return unlisten;
  }

  async onBackRequested(
    callback: () => void | Promise<void>,
  ): Promise<() => void> {
    if (this.kind !== 'tauri-android') {
      return () => undefined;
    }
    return this.listenBackNative(callback);
  }

  async requestApplicationExit(): Promise<void> {
    if (this.kind === 'tauri-android') {
      await this.invokeNative<void>('plugin:app|exit');
    }
  }

  async openExternalUrl(url: string): Promise<void> {
    const safeUrl = requireExternalHttpUrl(url);
    await this.openExternalNative(safeUrl);
  }

  onBackground(callback: () => void): () => void {
    const removePageListener = registerPageBackgroundListener(callback);
    let active = true;
    let removeNativeListener: NativeUnlisten | null = null;

    void this.listenNative(TAURI_SUSPENDED_EVENT, () => {
      if (active) {
        callback();
      }
    })
      .then((unlisten) => {
        if (active) {
          removeNativeListener = unlisten;
        } else {
          unlisten();
        }
      })
      .catch(() => {
        // Page lifecycle events remain available if native registration fails.
      });

    return () => {
      active = false;
      removePageListener();
      removeNativeListener?.();
      removeNativeListener = null;
    };
  }

  private createSources(
    publications: readonly NativePublicationDescriptor[],
  ): readonly BookSource[] {
    return publications.map(
      (publication) => new TauriBookSource(publication, this.invokeNative),
    );
  }
}

class TauriBookSource implements BookSource {
  private byteLength: number;

  constructor(
    private readonly descriptor: NativePublicationDescriptor,
    private readonly invokeNative: NativeInvoke,
  ) {
    this.byteLength = descriptor.size;
  }

  get name(): string {
    return this.descriptor.name;
  }

  get mediaType(): string {
    return this.descriptor.mediaType;
  }

  get size(): number {
    return this.byteLength;
  }

  async open(): Promise<ArrayBuffer> {
    const nativeBytes = await this.invokeNative<NativeBytes>(
      'read_publication',
      {
        sourceId: this.descriptor.sourceId,
      },
    );
    const bytes = normalizeNativeBytes(nativeBytes);
    this.byteLength = bytes.byteLength;
    return bytes;
  }
}

async function invokeTauri<T>(
  command: string,
  body?: Record<string, unknown> | Uint8Array,
  options?: NativeInvokeOptions,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, body, options);
}

async function listenTauri(
  event: string,
  callback: (event: { payload: unknown }) => void,
): Promise<NativeUnlisten> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen(event, callback);
}

async function listenTauriBack(
  callback: () => void | Promise<void>,
): Promise<NativeUnlisten> {
  const { onBackButtonPress } = await import('@tauri-apps/api/app');
  const listener = await onBackButtonPress(() => {
    void callback();
  });
  return () => {
    void listener.unregister();
  };
}

async function openTauriExternal(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

function detectTauriPlatformKind(): TauriPlatformKind {
  return /Android/i.test(globalThis.navigator?.userAgent ?? '')
    ? 'tauri-android'
    : 'tauri-desktop';
}

function requireExternalHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS links can be opened');
  }
  return url.href;
}

function normalizeNativeBytes(nativeBytes: NativeBytes): ArrayBuffer {
  if (nativeBytes instanceof ArrayBuffer) {
    return nativeBytes;
  }

  const bytes =
    nativeBytes instanceof Uint8Array
      ? nativeBytes
      : Uint8Array.from(nativeBytes);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function normalizeBookIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (bookId): bookId is string =>
      typeof bookId === 'string' && BOOK_ID_PATTERN.test(bookId),
  );
}
