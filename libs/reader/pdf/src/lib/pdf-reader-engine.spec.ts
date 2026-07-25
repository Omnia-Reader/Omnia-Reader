import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  BookSource,
  PublicationAnnotation,
  PublicationPasswordRequiredError,
  PublicationSelection,
} from '@omnia-reader/reader/domain';
import { PdfReaderEngine, PdfRuntime } from './pdf-reader-engine';

describe('PdfReaderEngine', () => {
  it('opens metadata, navigates pages, searches text, and renders thumbnails', async () => {
    const render = vi.fn(() => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }));
    const document = createDocument(render);
    const loadingTask = {
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
      onPassword: null,
    };
    const engine = new PdfReaderEngine(
      async () => createRuntime(() => loadingTask),
      async () => undefined,
    );

    await expect(engine.open(source())).resolves.toEqual({
      title: 'Fixture title',
      authors: ['Fixture author'],
      identifier: 'fixture-fingerprint',
    });
    expect(engine.pageNavigation()?.pageCount).toBe(2);

    await engine.goTo({
      href: '',
      type: 'application/pdf',
      locations: { position: 2 },
    });
    expect(engine.currentLocator()).toMatchObject({
      title: 'Page 2',
      locations: {
        fragments: ['page=2'],
        position: 2,
        totalProgression: 1,
      },
    });

    const results = [];
    for await (const result of engine.search('needle')) {
      results.push(result);
    }
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.locator.locations?.position)).toEqual(
      [1, 2],
    );

    const canvas = documentElement('canvas');
    await engine.pageNavigation()?.renderThumbnail(2, canvas, 100);
    expect(canvas.getAttribute('aria-label')).toBe('Thumbnail for PDF page 2');
    expect(render).toHaveBeenCalledOnce();

    await engine.close();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(engine.currentLocator()).toBeNull();
  });

  it('surfaces required and incorrect password challenges without owning UI', async () => {
    const document = createDocument();
    const loadingTask: {
      promise: Promise<PDFDocumentProxy>;
      destroy: ReturnType<typeof vi.fn>;
      onPassword?: (
        updatePassword: (password: string | Error) => void,
        reason: number,
      ) => void;
    } = {
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    let requestPassword!: (reason: number) => void;
    loadingTask.promise = new Promise((resolve, reject) => {
      requestPassword = (reason: number) => {
        loadingTask.onPassword?.((password) => {
          if (password instanceof Error) {
            reject(password);
          } else if (password === 'correct horse') {
            resolve(document);
          } else {
            queueMicrotask(() => requestPassword(2));
          }
        }, reason);
      };
    });

    const engine = new PdfReaderEngine(
      async () =>
        createRuntime(() => {
          queueMicrotask(() => requestPassword(1));
          return loadingTask;
        }),
      async () => undefined,
    );
    const challenges: Array<{
      reason: string;
      submit(password: string): void;
    }> = [];
    engine.onPasswordRequested((challenge) => challenges.push(challenge));

    const opened = engine.open(source());
    await vi.waitFor(() => expect(challenges).toHaveLength(1));
    expect(challenges[0].reason).toBe('required');
    challenges[0].submit('wrong');

    await vi.waitFor(() => expect(challenges).toHaveLength(2));
    expect(challenges[1].reason).toBe('incorrect');
    challenges[1].submit('correct horse');

    await expect(opened).resolves.toMatchObject({ title: 'Fixture title' });
  });

  it('normalizes a locked document when no password UI is attached', async () => {
    const loadingTask: {
      promise: Promise<PDFDocumentProxy>;
      destroy: ReturnType<typeof vi.fn>;
      onPassword?: (
        updatePassword: (password: string | Error) => void,
        reason: number,
      ) => void;
    } = {
      promise: Promise.resolve(createDocument()),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    let requestPassword!: () => void;
    loadingTask.promise = new Promise((_, reject) => {
      requestPassword = () => {
        loadingTask.onPassword?.(() => {
          reject(new Error('No password given'));
        }, 1);
      };
    });
    const engine = new PdfReaderEngine(
      async () =>
        createRuntime(() => {
          queueMicrotask(requestPassword);
          return loadingTask;
        }),
      async () => undefined,
    );

    await expect(engine.open(source())).rejects.toBeInstanceOf(
      PublicationPasswordRequiredError,
    );
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it('captures page-anchored selections and renders persisted geometry', async () => {
    const pdfDocument = createDocument();
    const loadingTask = {
      promise: Promise.resolve(pdfDocument),
      destroy: vi.fn().mockResolvedValue(undefined),
      onPassword: null,
    };
    const engine = new PdfReaderEngine(
      async () => createViewerRuntime(() => loadingTask),
      async () => undefined,
    );
    await engine.open(source());
    const viewport = globalThis.document.createElement('div');
    globalThis.document.body.append(viewport);
    await engine.mount(viewport);

    const selections: Array<PublicationSelection | null> = [];
    engine.onSelection((selection) => selections.push(selection));
    const text = viewport.querySelector('.textLayer span')?.firstChild;
    expect(text).toBeInstanceOf(Text);
    const range = globalThis.document.createRange();
    range.setStart(text as Text, 0);
    range.setEnd(text as Text, 10);
    Object.defineProperty(range, 'getClientRects', {
      value: () => [
        {
          left: 10,
          top: 20,
          right: 90,
          bottom: 34,
          width: 80,
          height: 14,
        },
      ],
    });
    const browserSelection = globalThis.document.getSelection();
    browserSelection?.removeAllRanges();
    browserSelection?.addRange(range);
    globalThis.document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();

    const captured = selections[selections.length - 1];
    expect(captured?.locator).toMatchObject({
      title: 'Page 1',
      locations: {
        position: 1,
        fragments: ['pdf-text=1:0:10', 'pdf-rect=10,20,90,34'],
      },
      text: { highlight: 'Selectable' },
    });

    const annotation: PublicationAnnotation = {
      schemaVersion: 1,
      id: 'c68dbc96-d5fc-4a1c-875c-174fda819ab5',
      bookId: `sha256:${'a'.repeat(64)}`,
      format: 'pdf',
      deviceId: 'pdf-engine-test',
      locator: structuredClone(captured?.locator ?? pageOneLocator()),
      color: 'yellow',
      createdAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:00.000Z',
    };
    await engine.setAnnotations([annotation]);

    expect(
      viewport.querySelectorAll('[data-omnia-annotation-layer] > div'),
    ).toHaveLength(1);
    await engine.close();
    viewport.remove();
  });

  it('renders interactive forms and mediates only HTTP external links', async () => {
    const pdfDocument = createDocument();
    const loadingTask = {
      promise: Promise.resolve(pdfDocument),
      destroy: vi.fn().mockResolvedValue(undefined),
      onPassword: null,
    };
    let viewerOptions: Record<string, unknown> | null = null;
    const engine = new PdfReaderEngine(
      async () =>
        createViewerRuntime(
          () => loadingTask,
          (options) => (viewerOptions = options),
        ),
      async () => undefined,
    );
    const externalLinks: string[] = [];
    engine.onExternalLinkRequested((url) => externalLinks.push(url));

    await engine.open(source());
    const viewport = globalThis.document.createElement('div');
    globalThis.document.body.append(viewport);
    await engine.mount(viewport);

    expect(viewerOptions?.['annotationMode']).toBe(2);
    expect(
      viewport
        .querySelector('.annotationLayer input')
        ?.getAttribute('aria-label'),
    ).toBe('reader name');
    const linkService = viewerOptions?.['linkService'] as {
      addLinkAttributes(
        link: HTMLAnchorElement,
        url: string,
        newWindow?: boolean,
      ): void;
    };
    const external = globalThis.document.createElement('a');
    linkService.addLinkAttributes(
      external,
      'https://example.com/reader guide',
      true,
    );
    expect(external.getAttribute('target')).toBeNull();
    expect(external.rel).toContain('noopener');
    external.click();
    expect(externalLinks).toEqual(['https://example.com/reader%20guide']);

    const blocked = globalThis.document.createElement('a');
    linkService.addLinkAttributes(blocked, 'mailto:reader@example.com');
    expect(blocked.getAttribute('href')).toBeNull();
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    blocked.click();
    expect(externalLinks).toHaveLength(1);

    await engine.close();
    external.click();
    expect(externalLinks).toHaveLength(1);
    viewport.remove();
  });

  it('releases the loading task after a malformed PDF fails to open', async () => {
    const parsingError = new Error('Invalid PDF structure');
    const loadingTask = {
      promise: Promise.reject(parsingError),
      destroy: vi.fn().mockResolvedValue(undefined),
      onPassword: null,
    };
    const engine = new PdfReaderEngine(
      async () => createRuntime(() => loadingTask),
      async () => undefined,
    );

    await expect(engine.open(source())).rejects.toBe(parsingError);
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(engine.currentLocator()).toBeNull();
  });
});

function source(): BookSource {
  return {
    name: 'fixture.pdf',
    mediaType: 'application/pdf',
    size: 4,
    open: async () => new Uint8Array([37, 80, 68, 70]).buffer,
  };
}

function createDocument(
  render = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  })),
): PDFDocumentProxy {
  const pageText = [
    'A needle appears on the first page.',
    'Another needle appears on the second page.',
  ];
  return {
    numPages: 2,
    fingerprints: ['fixture-fingerprint', null],
    getMetadata: vi.fn().mockResolvedValue({
      info: { Title: 'Fixture title', Author: 'Fixture author' },
    }),
    getOutline: vi.fn().mockResolvedValue([]),
    getPage: vi.fn(async (pageNumber: number) => ({
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: pageText[pageNumber - 1] }],
      }),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 300 * scale,
      })),
      render,
    })),
  } as unknown as PDFDocumentProxy;
}

function createRuntime(getDocument: () => unknown): PdfRuntime {
  return {
    core: {
      GlobalWorkerOptions: { workerSrc: '' },
      AnnotationMode: { ENABLE: 1, ENABLE_FORMS: 2 },
      AnnotationEditorType: { NONE: -1 },
      PasswordResponses: {
        NEED_PASSWORD: 1,
        INCORRECT_PASSWORD: 2,
      },
      getDocument,
    },
    viewer: {},
  } as unknown as PdfRuntime;
}

function createViewerRuntime(
  getDocument: () => unknown,
  captureOptions?: (options: Record<string, unknown>) => void,
): PdfRuntime {
  class TestEventBus {
    private readonly listeners = new Map<
      string,
      Set<(event: unknown) => void>
    >();

    on(name: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
    }

    off(name: string, listener: (event: unknown) => void): void {
      this.listeners.get(name)?.delete(listener);
    }

    dispatch(name: string, event: unknown = {}): void {
      this.listeners.get(name)?.forEach((listener) => listener(event));
    }
  }

  class TestLinkService {
    addLinkAttributes(
      link: HTMLAnchorElement,
      url: string,
      newWindow?: boolean,
    ): void {
      link.href = url;
      link.rel = 'noopener noreferrer nofollow';
      if (newWindow) {
        link.target = '_blank';
      }
    }

    setViewer(): void {
      return undefined;
    }

    setDocument(): void {
      return undefined;
    }
  }

  class TestPdfViewer {
    currentPageNumber = 1;
    firstPagePromise = Promise.resolve();
    pagesRotation = 0;
    currentScale = 1;
    currentScaleValue = 'page-width';
    private page: HTMLDivElement | null = null;

    constructor(
      private readonly options: {
        viewer: HTMLDivElement;
        eventBus: TestEventBus;
      },
    ) {
      captureOptions?.(options as unknown as Record<string, unknown>);
    }

    setDocument(document: PDFDocumentProxy | null): void {
      if (!document) {
        this.page?.remove();
        return;
      }
      const page = globalThis.document.createElement('div');
      page.className = 'page';
      page.dataset['pageNumber'] = '1';
      page.style.position = 'relative';
      const textLayer = globalThis.document.createElement('div');
      textLayer.className = 'textLayer';
      const span = globalThis.document.createElement('span');
      span.textContent = 'Selectable text in a PDF page.';
      textLayer.append(span);
      const annotationLayer = globalThis.document.createElement('div');
      annotationLayer.className = 'annotationLayer';
      const formInput = globalThis.document.createElement('input');
      formInput.name = 'reader-name';
      annotationLayer.append(formInput);
      page.append(textLayer, annotationLayer);
      this.options.viewer.append(page);
      this.page = page;
      queueMicrotask(() => {
        this.options.eventBus.dispatch('pagesinit');
        this.options.eventBus.dispatch('textlayerrendered', { pageNumber: 1 });
        this.options.eventBus.dispatch('annotationlayerrendered', {
          pageNumber: 1,
        });
      });
    }

    getPageView(): unknown {
      return {
        div: this.page,
        getPagePoint: (x: number, y: number) => [x, y],
        viewport: {
          convertToViewportPoint: (x: number, y: number) => [x, y],
        },
      };
    }

    cleanup(): void {
      return undefined;
    }

    nextPage(): void {
      return undefined;
    }

    previousPage(): void {
      return undefined;
    }

    scrollPageIntoView(): void {
      return undefined;
    }
  }

  return {
    core: {
      GlobalWorkerOptions: { workerSrc: '' },
      AnnotationMode: { ENABLE: 1, ENABLE_FORMS: 2 },
      AnnotationEditorType: { NONE: -1 },
      PasswordResponses: {
        NEED_PASSWORD: 1,
        INCORRECT_PASSWORD: 2,
      },
      getDocument,
    },
    viewer: {
      EventBus: TestEventBus,
      PDFLinkService: TestLinkService,
      PDFFindController: class {},
      PDFViewer: TestPdfViewer,
      LinkTarget: { BLANK: 2 },
    },
  } as unknown as PdfRuntime;
}

function pageOneLocator() {
  return {
    href: '',
    type: 'application/pdf',
    title: 'Page 1',
    locations: {
      position: 1,
      fragments: ['pdf-text=1:0:10', 'pdf-rect=10,20,90,34'],
    },
    text: { highlight: 'Selectable' },
  };
}

function documentElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
): HTMLElementTagNameMap[K] {
  return globalThis.document.createElement(tagName);
}
