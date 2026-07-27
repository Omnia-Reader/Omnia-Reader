import { BrowserPlatform } from './browser-platform';
import { createPlatform } from './platform-provider';
import {
  NativeBackListen,
  NativeInvoke,
  NativeListen,
  NativeOpenExternal,
  TauriPlatform,
} from './tauri-platform';

const invoke = vi.fn();

describe('platform selection', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__');
  });

  it('uses browser APIs outside a Tauri webview', () => {
    Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__');

    expect(createPlatform()).toBeInstanceOf(BrowserPlatform);
  });

  it('uses the native adapter inside a Tauri webview', () => {
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    expect(createPlatform()).toBeInstanceOf(TauriPlatform);
  });
});

describe('BrowserPlatform', () => {
  it('reports best-effort browser storage and upgrades a granted request', async () => {
    let persisted = false;
    const storageManager = {
      estimate: vi.fn().mockResolvedValue({
        usage: 25,
        quota: 100,
      }),
      persisted: vi.fn(() => Promise.resolve(persisted)),
      persist: vi.fn(() => {
        persisted = true;
        return Promise.resolve(true);
      }),
    } as unknown as StorageManager;
    const platform = new BrowserPlatform(storageManager);

    await expect(platform.getStorageStatus()).resolves.toEqual({
      persistence: 'best-effort',
      usageBytes: 25,
      quotaBytes: 100,
    });
    await expect(platform.requestPersistentStorage()).resolves.toEqual({
      persistence: 'persistent',
      usageBytes: 25,
      quotaBytes: 100,
    });
    expect(storageManager.persist).toHaveBeenCalledOnce();
  });

  it('reports unavailable persistence when the browser API is absent', async () => {
    const platform = new BrowserPlatform(undefined);

    await expect(platform.getStorageStatus()).resolves.toEqual({
      persistence: 'unavailable',
    });
    await expect(platform.requestPersistentStorage()).resolves.toEqual({
      persistence: 'unavailable',
    });
  });

  it('keeps best-effort storage usable when a persistence request is denied', async () => {
    const storageManager = {
      estimate: vi.fn().mockRejectedValue(new Error('Quota unavailable')),
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
    } as unknown as StorageManager;
    const platform = new BrowserPlatform(storageManager);

    await expect(platform.requestPersistentStorage()).resolves.toEqual({
      persistence: 'best-effort',
    });
  });

  it('opens a browser streaming save destination when File System Access is available', async () => {
    const writable = new WritableStream<Uint8Array>();
    const createWritable = vi.fn().mockResolvedValue(writable);
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);
    const platform = new BrowserPlatform();

    const destination = await platform.createFileSave({
      suggestedName: 'library.omnia-backup',
      mediaType: 'application/vnd.omnia-reader.backup+zip',
      extensions: ['.omnia-backup'],
    });

    expect(platform.supportsStreamingFileSave).toBe(true);
    expect(destination?.writable).toBe(writable);
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'library.omnia-backup',
      types: [
        {
          description: 'Omnia Reader backup',
          accept: {
            'application/vnd.omnia-reader.backup+zip': ['.omnia-backup'],
          },
        },
      ],
    });
    vi.unstubAllGlobals();
  });

  it('preserves a custom suggested suffix without an invalid picker type filter', async () => {
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi
        .fn()
        .mockResolvedValue(new WritableStream<Uint8Array>()),
    });
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);

    await new BrowserPlatform().createFileSave({
      suggestedName: 'library.omnia-backup',
      mediaType: 'application/vnd.omnia-reader.backup+zip',
      extensions: [],
    });

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'library.omnia-backup',
    });
    vi.unstubAllGlobals();
  });

  it('turns an operating-system file drop into browser book sources', async () => {
    const received: string[][] = [];
    const platform = new BrowserPlatform();
    const stop = await platform.onPublicationsOpened((sources) => {
      received.push(sources.map((source) => source.name));
    });
    const dropped = new File(['%PDF-1.4'], 'dropped.pdf', {
      type: 'application/pdf',
    });
    const event = new Event('drop', { cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [dropped] },
    });

    globalThis.dispatchEvent(event);
    await vi.waitFor(() => expect(received).toEqual([['dropped.pdf']]));
    expect(event.defaultPrevented).toBe(true);

    stop();
  });

  it('leaves browser history and tab lifecycle to the browser', async () => {
    const platform = new BrowserPlatform();
    const stop = await platform.onBackRequested(vi.fn());
    const stopDeepLinks = await platform.onBookDeepLink(vi.fn());

    stop();
    stopDeepLinks();
    await expect(platform.requestApplicationExit()).resolves.toBeUndefined();
  });

  it('opens only HTTP and HTTPS links in a separate browser context', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const platform = new BrowserPlatform();

    await platform.openExternalUrl('https://example.com/reference');

    expect(open).toHaveBeenCalledWith(
      'https://example.com/reference',
      '_blank',
      'noopener,noreferrer',
    );
    await expect(
      platform.openExternalUrl('mailto:reader@example.com'),
    ).rejects.toThrow('Only HTTP and HTTPS links can be opened');
    vi.unstubAllGlobals();
  });

  it('reports page hiding as background activity and removes its listeners', () => {
    const callback = vi.fn();
    const platform = new BrowserPlatform();
    const stop = platform.onBackground(callback);

    globalThis.dispatchEvent(new PageTransitionEvent('pagehide'));

    expect(callback).toHaveBeenCalledOnce();
    stop();
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe('TauriPlatform', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('reports application-managed storage as persistent', async () => {
    const platform = new TauriPlatform(invoke as NativeInvoke);

    await expect(platform.getStorageStatus()).resolves.toEqual({
      persistence: 'persistent',
    });
    await expect(platform.requestPersistentStorage()).resolves.toEqual({
      persistence: 'persistent',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps native paths opaque and reads the selected publication by ID', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'pick_publications') {
        return [
          {
            sourceId: 'opaque-source-id',
            name: 'book.epub',
            mediaType: 'application/epub+zip',
            size: 10,
          },
        ];
      }
      if (command === 'read_publication') {
        return new Uint8Array([80, 75, 3, 4]);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const [source] = await new TauriPlatform(
      invoke as NativeInvoke,
    ).pickPublications();
    const bytes = await source.open();

    expect(source.name).toBe('book.epub');
    expect(source.mediaType).toBe('application/epub+zip');
    expect(source.size).toBe(4);
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    if (!(bytes instanceof ArrayBuffer)) {
      throw new Error('Expected the native source to return an ArrayBuffer');
    }
    expect(Array.from(new Uint8Array(bytes))).toEqual([80, 75, 3, 4]);
    expect(invoke).toHaveBeenNthCalledWith(1, 'pick_publications');
    expect(invoke).toHaveBeenNthCalledWith(2, 'read_publication', {
      sourceId: 'opaque-source-id',
    });
  });

  it('maps a cancelled native picker to an empty selection', async () => {
    invoke.mockResolvedValue([]);

    await expect(
      new TauriPlatform(invoke as NativeInvoke).pickPublications(),
    ).resolves.toEqual([]);
  });

  it('streams bounded raw chunks into an opaque native backup export', async () => {
    const writes: Uint8Array[] = [];
    invoke.mockImplementation(
      async (
        command: string,
        body?: Record<string, unknown> | Uint8Array,
        options?: { headers: Record<string, string> },
      ) => {
        if (command === 'begin_backup_export') {
          expect(body).toEqual({
            suggestedName: 'library.omnia-backup',
          });
          return 'opaque-export-id';
        }
        if (command === 'write_backup_chunk') {
          expect(body).toBeInstanceOf(Uint8Array);
          expect(options?.headers).toEqual({
            'X-Omnia-Export-Id': 'opaque-export-id',
          });
          writes.push(body as Uint8Array);
          return undefined;
        }
        if (command === 'commit_backup_export') {
          expect(body).toEqual({ exportId: 'opaque-export-id' });
          return undefined;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    );
    const platform = new TauriPlatform(invoke as NativeInvoke);
    const destination = await platform.createFileSave({
      suggestedName: 'library.omnia-backup',
      mediaType: 'application/vnd.omnia-reader.backup+zip',
      extensions: ['.omnia-backup'],
    });
    if (!destination) {
      throw new Error('Expected a native backup destination');
    }

    const writer = destination.writable.getWriter();
    await writer.write(new Uint8Array(700 * 1024));
    await writer.close();

    expect(platform.supportsStreamingFileSave).toBe(true);
    expect(writes.map((chunk) => chunk.byteLength)).toEqual([
      512 * 1024,
      188 * 1024,
    ]);
    expect(invoke).toHaveBeenLastCalledWith('commit_backup_export', {
      exportId: 'opaque-export-id',
    });
  });

  it('cancels an unfinished opaque native backup export', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'begin_backup_export') {
        return 'opaque-export-id';
      }
      if (command === 'cancel_backup_export') {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const destination = await new TauriPlatform(
      invoke as NativeInvoke,
    ).createFileSave({
      suggestedName: 'library.omnia-backup',
      mediaType: 'application/vnd.omnia-reader.backup+zip',
      extensions: ['.omnia-backup'],
    });
    if (!destination) {
      throw new Error('Expected a native backup destination');
    }

    await destination.writable.abort('cancelled');

    expect(invoke).toHaveBeenLastCalledWith('cancel_backup_export', {
      exportId: 'opaque-export-id',
    });
  });

  it('drains cold-start and warm open-with publications as opaque sources', async () => {
    let opened = [
      {
        sourceId: 'cold-source',
        name: 'cold.pdf',
        mediaType: 'application/pdf',
        size: 20,
      },
    ];
    let openedListener: ((event: { payload: unknown }) => void) | null = null;
    const unlisten = vi.fn();
    const listen = vi.fn(
      async (
        event: string,
        callback: (event: { payload: unknown }) => void,
      ) => {
        expect(event).toBe('publications-opened');
        openedListener = callback;
        return unlisten;
      },
    );
    invoke.mockImplementation(async (command: string) => {
      if (command === 'take_opened_publications') {
        const result = opened;
        opened = [];
        return result;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const received: string[][] = [];
    const platform = new TauriPlatform(
      invoke as NativeInvoke,
      listen as NativeListen,
    );

    const stop = await platform.onPublicationsOpened((sources) => {
      received.push(sources.map((source) => source.name));
    });
    expect(received).toEqual([['cold.pdf']]);

    opened = [
      {
        sourceId: 'warm-source',
        name: 'warm.epub',
        mediaType: 'application/epub+zip',
        size: 30,
      },
    ];
    if (!openedListener) {
      throw new Error('Expected the native event listener to be registered');
    }
    openedListener({ payload: null });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toEqual(['warm.epub']);

    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('drains only validated cold-start and warm exact-edition deep links', async () => {
    const coldBookId = `sha256:${'a'.repeat(64)}`;
    const warmBookId = `sha256:${'b'.repeat(64)}`;
    let opened: unknown = [coldBookId, '../not-a-book'];
    let openedListener: ((event: { payload: unknown }) => void) | null = null;
    const unlisten = vi.fn();
    const listen = vi.fn(
      async (
        event: string,
        callback: (event: { payload: unknown }) => void,
      ) => {
        expect(event).toBe('book-deep-link-opened');
        openedListener = callback;
        return unlisten;
      },
    );
    invoke.mockImplementation(async (command: string) => {
      if (command === 'take_opened_book_deep_links') {
        const result = opened;
        opened = [];
        return result;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const received: string[] = [];
    const platform = new TauriPlatform(
      invoke as NativeInvoke,
      listen as NativeListen,
    );

    const stop = await platform.onBookDeepLink((bookId) => {
      received.push(bookId);
    });
    expect(received).toEqual([coldBookId]);

    opened = [warmBookId, 'sha256:not-a-digest', null];
    if (!openedListener) {
      throw new Error(
        'Expected the native deep-link listener to be registered',
      );
    }
    openedListener({ payload: null });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([coldBookId, warmBookId]);

    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('forwards Android hardware back and exits only when requested', async () => {
    const backCallback = vi.fn();
    const unlistenBack = vi.fn();
    let nativeBackCallback: (() => void | Promise<void>) | null = null;
    const listenBack = vi.fn(async (callback: () => void | Promise<void>) => {
      nativeBackCallback = callback;
      return unlistenBack;
    });
    invoke.mockResolvedValue(undefined);
    const platform = new TauriPlatform(
      invoke as NativeInvoke,
      vi.fn() as NativeListen,
      listenBack as NativeBackListen,
      'tauri-android',
    );

    const stop = await platform.onBackRequested(backCallback);
    if (!nativeBackCallback) {
      throw new Error('Expected the Android back listener to be registered');
    }
    await nativeBackCallback();

    expect(backCallback).toHaveBeenCalledOnce();
    stop();
    expect(unlistenBack).toHaveBeenCalledOnce();

    await platform.requestApplicationExit();
    expect(invoke).toHaveBeenCalledWith('plugin:app|exit');
  });

  it('does not install mobile back behavior on desktop', async () => {
    const listenBack = vi.fn();
    const platform = new TauriPlatform(
      invoke as NativeInvoke,
      vi.fn() as NativeListen,
      listenBack as NativeBackListen,
      'tauri-desktop',
    );

    const stop = await platform.onBackRequested(vi.fn());
    stop();
    await platform.requestApplicationExit();

    expect(listenBack).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports native suspension and removes page and native listeners', async () => {
    const callback = vi.fn();
    const unlisten = vi.fn();
    let suspendedListener: ((event: { payload: unknown }) => void) | undefined;
    const listen = vi.fn(
      async (
        event: string,
        listener: (event: { payload: unknown }) => void,
      ) => {
        expect(event).toBe('tauri://suspended');
        suspendedListener = listener;
        return unlisten;
      },
    );
    const platform = new TauriPlatform(
      invoke as NativeInvoke,
      listen as NativeListen,
    );

    const stop = platform.onBackground(callback);
    await vi.waitFor(() => expect(suspendedListener).toBeDefined());
    suspendedListener?.({ payload: null });
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide'));

    expect(callback).toHaveBeenCalledTimes(2);
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
    suspendedListener?.({ payload: null });
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('unregisters a native suspension listener that resolves after cleanup', async () => {
    const unlisten = vi.fn();
    let resolveListener: ((value: () => void) => void) | undefined;
    const listen = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListener = resolve;
        }),
    );
    const platform = new TauriPlatform(
      invoke as NativeInvoke,
      listen as NativeListen,
    );

    const stop = platform.onBackground(vi.fn());
    stop();
    resolveListener?.(unlisten);

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  it('delegates validated external links to the native opener', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const platform = new TauriPlatform(
      invoke as NativeInvoke,
      vi.fn() as NativeListen,
      vi.fn() as NativeBackListen,
      'tauri-desktop',
      openExternal as NativeOpenExternal,
    );

    await platform.openExternalUrl('https://example.com/reference');

    expect(openExternal).toHaveBeenCalledWith('https://example.com/reference');
    await expect(
      platform.openExternalUrl('file:///etc/passwd'),
    ).rejects.toThrow('Only HTTP and HTTPS links can be opened');
  });
});
