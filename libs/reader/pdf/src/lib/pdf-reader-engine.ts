import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type {
  EventBus,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import {
  BookSource,
  DEFAULT_PDF_READER_PREFERENCES,
  PageNavigation,
  PdfReaderPreferences,
  PublicationAnnotation,
  PublicationLocator,
  PublicationMetadata,
  PublicationPasswordChallenge,
  PublicationPasswordRequiredError,
  PublicationSelection,
  ReaderEngine,
  ReaderPreferences,
  SearchResult,
  TocEntry,
} from '@omnia-reader/reader/domain';

type PdfCoreModule = typeof import('pdfjs-dist');
type PdfViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs');

export interface PdfRuntime {
  core: PdfCoreModule;
  viewer: PdfViewerModule;
}

export type PdfRuntimeLoader = () => Promise<PdfRuntime>;
export type PdfStylesheetLoader = () => Promise<void>;

interface PdfInfo {
  Title?: string;
  Author?: string;
}

interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
}

interface PdfReference {
  num: number;
  gen: number;
}

interface PageChangingEvent {
  pageNumber: number;
}

interface TextLayerRenderedEvent {
  pageNumber: number;
}

interface AnnotationLayerRenderedEvent {
  pageNumber: number;
}

interface PdfPageViewLike {
  div: HTMLDivElement;
  getPagePoint(x: number, y: number): [number, number];
  viewport: {
    convertToViewportPoint(x: number, y: number): [number, number];
  };
}

export class PdfReaderEngine implements ReaderEngine {
  private runtime: PdfRuntime | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private document: PDFDocumentProxy | null = null;
  private pdfViewer: PDFViewer | null = null;
  private linkService: PDFLinkService | null = null;
  private eventBus: EventBus | null = null;
  private viewerElement: HTMLDivElement | null = null;
  private viewport: HTMLElement | null = null;
  private previousViewportPosition: string | null = null;
  private pageNumber = 1;
  private toc: readonly TocEntry[] = [];
  private preferences: PdfReaderPreferences = {
    ...DEFAULT_PDF_READER_PREFERENCES,
  };
  private annotations: readonly PublicationAnnotation[] = [];
  private selectionCaptureQueued = false;
  private passwordRequiredWithoutListener = false;
  private readonly relocationListeners = new Set<
    (locator: PublicationLocator) => void
  >();
  private readonly passwordListeners = new Set<
    (challenge: PublicationPasswordChallenge) => void
  >();
  private readonly selectionListeners = new Set<
    (selection: PublicationSelection | null) => void
  >();
  private readonly externalLinkRequestListeners = new Set<
    (url: string) => void
  >();
  private readonly handlePageChanging = (event: PageChangingEvent): void => {
    const document = this.document;
    if (
      !document ||
      !Number.isInteger(event.pageNumber) ||
      event.pageNumber < 1 ||
      event.pageNumber > document.numPages
    ) {
      return;
    }
    this.pageNumber = event.pageNumber;
    this.notifyRelocated();
  };
  private readonly handleTextLayerRendered = (
    event: TextLayerRenderedEvent,
  ): void => {
    if (Number.isInteger(event.pageNumber) && event.pageNumber > 0) {
      this.renderPageAnnotations(event.pageNumber);
    }
  };
  private readonly handleAnnotationLayerRendered = (
    event: AnnotationLayerRenderedEvent,
  ): void => {
    if (Number.isInteger(event.pageNumber) && event.pageNumber > 0) {
      this.ensureFormAccessibility(event.pageNumber);
    }
  };
  private readonly handleSelectionChange = (): void => {
    if (this.selectionCaptureQueued) {
      return;
    }
    this.selectionCaptureQueued = true;
    queueMicrotask(() => {
      this.selectionCaptureQueued = false;
      this.captureSelection();
    });
  };

  constructor(
    private readonly runtimeLoader: PdfRuntimeLoader = loadPdfRuntime,
    private readonly stylesheetLoader: PdfStylesheetLoader = ensurePdfViewerStyles,
  ) {}

  async open(source: BookSource): Promise<PublicationMetadata> {
    await this.resetDocument();
    const opened = await source.open();
    const bytes =
      opened instanceof Blob
        ? new Uint8Array(await opened.arrayBuffer())
        : new Uint8Array(opened.slice(0));
    this.runtime = await this.runtimeLoader();
    this.runtime.core.GlobalWorkerOptions.workerSrc = new URL(
      'assets/pdfjs/pdf.worker.min.mjs',
      globalThis.document.baseURI,
    ).toString();

    const loadingTask = this.runtime.core.getDocument({ data: bytes });
    this.loadingTask = loadingTask;
    this.passwordRequiredWithoutListener = false;
    loadingTask.onPassword = (
      updatePassword: (password: string | Error) => void,
      response: number,
    ) => {
      this.requestPassword(updatePassword, response);
    };

    try {
      this.document = await loadingTask.promise;
    } catch (error) {
      const passwordRequired = this.passwordRequiredWithoutListener;
      try {
        await this.resetDocument();
      } catch {
        // Preserve the PDF.js parsing/password error while still attempting
        // to release the worker and loading task.
      }
      throw passwordRequired ? new PublicationPasswordRequiredError() : error;
    }
    const [{ info }, outline] = await Promise.all([
      this.document.getMetadata(),
      this.document.getOutline(),
    ]);
    this.toc = await this.mapOutline(
      (outline ?? []) as unknown as PdfOutlineNode[],
    );
    const pdfInfo = info as PdfInfo;

    return {
      title: pdfInfo.Title || source.name,
      authors: pdfInfo.Author ? [pdfInfo.Author] : [],
      identifier: this.document.fingerprints[0] ?? undefined,
    };
  }

  async mount(viewport: HTMLElement): Promise<void> {
    const document = this.requireDocument();
    const runtime = this.requireRuntime();
    await this.stylesheetLoader();

    this.viewport = viewport;
    this.previousViewportPosition = viewport.style.position;
    viewport.replaceChildren();
    viewport.classList.add('omnia-pdf-viewer-container');
    // PDF.js requires its scroll container to be absolutely positioned and
    // validates that invariant synchronously. Set it inline so native webviews
    // cannot race the asynchronously loaded application stylesheet.
    viewport.style.position = 'absolute';
    viewport.setAttribute('role', 'document');
    viewport.setAttribute('aria-label', 'PDF document');
    if (!viewport.hasAttribute('tabindex')) {
      viewport.tabIndex = 0;
    }

    const viewerElement = globalThis.document.createElement('div');
    viewerElement.className = 'pdfViewer';
    viewport.append(viewerElement);
    this.viewerElement = viewerElement;

    const eventBus = new runtime.viewer.EventBus();
    const linkService = new runtime.viewer.PDFLinkService({
      eventBus,
      externalLinkRel: 'noopener noreferrer nofollow',
      ignoreDestinationZoom: true,
    });
    this.installExternalLinkPolicy(linkService);
    const findController = new runtime.viewer.PDFFindController({
      eventBus,
      linkService,
    });
    const pdfViewer = new runtime.viewer.PDFViewer({
      container: viewport as HTMLDivElement,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
      annotationMode: runtime.core.AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: runtime.core.AnnotationEditorType.NONE,
      imageResourcesPath: new URL(
        'assets/pdfjs/images/',
        globalThis.document.baseURI,
      ).toString(),
      enablePermissions: true,
      enableAutoLinking: true,
      enableDetailCanvas: true,
      enableOptimizedPartialRendering: true,
      enableSelectionRendering: true,
      supportsPinchToZoom: true,
    });

    this.eventBus = eventBus;
    this.linkService = linkService;
    this.pdfViewer = pdfViewer;
    eventBus.on('pagechanging', this.handlePageChanging);
    eventBus.on('textlayerrendered', this.handleTextLayerRendered);
    eventBus.on('annotationlayerrendered', this.handleAnnotationLayerRendered);
    viewport.ownerDocument.addEventListener(
      'selectionchange',
      this.handleSelectionChange,
    );
    linkService.setViewer(pdfViewer);
    linkService.setDocument(document);

    const pagesInitialized = waitForEvent(eventBus, 'pagesinit');
    pdfViewer.setDocument(document);
    await pagesInitialized;
    this.applyPdfPreferences();
    await pdfViewer.firstPagePromise;
    this.renderVisibleAnnotations();
  }

  async close(): Promise<void> {
    await this.resetDocument();
    this.relocationListeners.clear();
    this.passwordListeners.clear();
    this.selectionListeners.clear();
    this.externalLinkRequestListeners.clear();
  }

  tableOfContents(): readonly TocEntry[] {
    return this.toc;
  }

  currentLocator(): PublicationLocator | null {
    const document = this.document;
    if (!document) {
      return null;
    }
    const currentPage = this.pdfViewer?.currentPageNumber ?? this.pageNumber;
    return pageLocator(currentPage, document.numPages);
  }

  onRelocated(listener: (locator: PublicationLocator) => void): () => void {
    this.relocationListeners.add(listener);
    return () => this.relocationListeners.delete(listener);
  }

  onSelection(
    listener: (selection: PublicationSelection | null) => void,
  ): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  onExternalLinkRequested(listener: (url: string) => void): () => void {
    this.externalLinkRequestListeners.add(listener);
    return () => this.externalLinkRequestListeners.delete(listener);
  }

  clearSelection(): void {
    this.viewport?.ownerDocument.getSelection()?.removeAllRanges();
    this.notifySelection(null);
  }

  async setAnnotations(
    annotations: readonly PublicationAnnotation[],
  ): Promise<void> {
    this.annotations = annotations.filter(
      (annotation) =>
        annotation.format === 'pdf' && annotation.deletedAt === undefined,
    );
    try {
      this.renderVisibleAnnotations();
    } catch {
      // Stored annotations remain authoritative if a stale anchor cannot render.
    }
  }

  onPasswordRequested(
    listener: (challenge: PublicationPasswordChallenge) => void,
  ): () => void {
    this.passwordListeners.add(listener);
    return () => this.passwordListeners.delete(listener);
  }

  pageNavigation(): PageNavigation | null {
    const document = this.document;
    if (!document) {
      return null;
    }
    return {
      pageCount: document.numPages,
      renderThumbnail: (pageNumber, canvas, maxWidth, signal) =>
        this.renderThumbnail(pageNumber, canvas, maxWidth, signal),
    };
  }

  async applyPreferences(preferences: ReaderPreferences): Promise<void> {
    if (preferences.format !== 'pdf') {
      throw new Error('PDF preferences are required by the PDF reader');
    }

    this.preferences = { ...preferences };
    this.applyPdfPreferences();
  }

  async goTo(locator: PublicationLocator): Promise<void> {
    const document = this.requireDocument();
    const requested = locatorPageNumber(
      locator,
      this.pdfViewer?.currentPageNumber ?? this.pageNumber,
    );
    const pageNumber = Math.min(
      document.numPages,
      Math.max(1, Math.trunc(requested)),
    );
    this.pageNumber = pageNumber;
    if (this.pdfViewer) {
      this.pdfViewer.currentPageNumber = pageNumber;
      this.pdfViewer.scrollPageIntoView({ pageNumber });
    }
  }

  async next(): Promise<void> {
    if (this.pdfViewer) {
      this.pdfViewer.nextPage();
      return;
    }
    const document = this.requireDocument();
    this.pageNumber = Math.min(document.numPages, this.pageNumber + 1);
  }

  async previous(): Promise<void> {
    if (this.pdfViewer) {
      this.pdfViewer.previousPage();
      return;
    }
    this.pageNumber = Math.max(1, this.pageNumber - 1);
  }

  async *search(query: string): AsyncIterable<SearchResult> {
    const document = this.requireDocument();
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return;
    }

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      const normalizedText = text.toLocaleLowerCase();
      let matchIndex = normalizedText.indexOf(normalizedQuery);
      let matches = 0;
      while (matchIndex >= 0 && matches < 20) {
        const start = Math.max(0, matchIndex - 50);
        const end = Math.min(text.length, matchIndex + query.length + 50);
        yield {
          locator: {
            ...pageLocator(pageNumber, document.numPages),
            text: {
              before: text.slice(start, matchIndex),
              highlight: text.slice(matchIndex, matchIndex + query.length),
              after: text.slice(matchIndex + query.length, end),
            },
          },
          excerpt: text.slice(start, end),
        };
        matches += 1;
        matchIndex = normalizedText.indexOf(
          normalizedQuery,
          matchIndex + Math.max(1, normalizedQuery.length),
        );
      }
    }
  }

  private applyPdfPreferences(): void {
    if (!this.pdfViewer) {
      return;
    }
    this.pdfViewer.pagesRotation = this.preferences.rotation;
    if (this.preferences.zoomMode === 'custom') {
      this.pdfViewer.currentScale = this.preferences.zoomPercent / 100;
    } else {
      this.pdfViewer.currentScaleValue =
        this.preferences.zoomMode === 'fit-page' ? 'page-fit' : 'page-width';
    }
  }

  private async renderThumbnail(
    requestedPage: number,
    canvas: HTMLCanvasElement,
    maxWidth: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const document = this.requireDocument();
    const pageNumber = Math.min(
      document.numPages,
      Math.max(1, Math.trunc(requestedPage)),
    );
    if (signal?.aborted) {
      return;
    }

    const page = await document.getPage(pageNumber);
    const unscaled = page.getViewport({
      scale: 1,
      rotation: this.preferences.rotation,
    });
    const scale = Math.max(0.05, maxWidth / unscaled.width);
    const viewport = page.getViewport({
      scale,
      rotation: this.preferences.rotation,
    });
    const outputScale = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.setAttribute('aria-label', `Thumbnail for PDF page ${pageNumber}`);

    const renderTask = page.render({
      canvas,
      viewport,
      transform:
        outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    const cancel = () => renderTask.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await renderTask.promise;
    } catch (error) {
      if (!isRenderingCancelled(error) && !signal?.aborted) {
        throw error;
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  private requestPassword(
    updatePassword: (password: string | Error) => void,
    response: number,
  ): void {
    const runtime = this.requireRuntime();
    if (this.passwordListeners.size === 0) {
      this.passwordRequiredWithoutListener = true;
      updatePassword(new PublicationPasswordRequiredError());
      return;
    }

    let answered = false;
    const challenge: PublicationPasswordChallenge = {
      reason:
        response === runtime.core.PasswordResponses.INCORRECT_PASSWORD
          ? 'incorrect'
          : 'required',
      submit: (password) => {
        if (!answered) {
          answered = true;
          updatePassword(password);
        }
      },
      cancel: () => {
        if (!answered) {
          answered = true;
          updatePassword(new Error('PDF password entry was cancelled'));
        }
      },
    };
    for (const listener of this.passwordListeners) {
      listener(challenge);
    }
  }

  private notifyRelocated(): void {
    const locator = this.currentLocator();
    if (!locator) {
      return;
    }
    for (const listener of this.relocationListeners) {
      listener(locator);
    }
  }

  private notifySelection(selection: PublicationSelection | null): void {
    for (const listener of this.selectionListeners) {
      listener(selection);
    }
  }

  private installExternalLinkPolicy(linkService: PDFLinkService): void {
    const addLinkAttributes = linkService.addLinkAttributes.bind(linkService);
    linkService.addLinkAttributes = (
      link: HTMLAnchorElement,
      url: string,
      newWindow?: boolean,
    ): void => {
      const safeUrl = normalizeExternalHttpUrl(url);
      if (!safeUrl) {
        link.removeAttribute('href');
        link.removeAttribute('target');
        link.setAttribute('aria-disabled', 'true');
        return;
      }

      addLinkAttributes(link, safeUrl, newWindow);
      // PDF.js may honor a publication-provided `newWindow` flag. Omnia owns
      // that decision, so the anchor remains inert until the shell confirms it.
      link.removeAttribute('target');
      link.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        for (const listener of this.externalLinkRequestListeners) {
          listener(safeUrl);
        }
      });
    };
  }

  private ensureFormAccessibility(pageNumber: number): void {
    const pageView = this.pdfViewer?.getPageView(pageNumber - 1) as
      | PdfPageViewLike
      | undefined;
    const controls = pageView?.div.querySelectorAll<
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | HTMLButtonElement
    >(
      '.annotationLayer input:not([type="hidden"]), .annotationLayer textarea, .annotationLayer select, .annotationLayer button',
    );
    controls?.forEach((control, index) => {
      if (
        control.hasAttribute('aria-label') ||
        control.hasAttribute('aria-labelledby') ||
        control.hasAttribute('title') ||
        control.labels?.length
      ) {
        return;
      }
      const fieldName = control
        .getAttribute('name')
        ?.replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const annotationDescription = control
        .closest<HTMLElement>('[data-annotation-id]')
        ?.getAttribute('title')
        ?.trim();
      control.setAttribute(
        'aria-label',
        annotationDescription ||
          fieldName ||
          `PDF form field ${index + 1} on page ${pageNumber}`,
      );
    });
  }

  private captureSelection(): void {
    const viewer = this.pdfViewer;
    const viewport = this.viewport;
    const document = this.document;
    const selection = viewport?.ownerDocument.getSelection();
    if (
      !viewer ||
      !viewport ||
      !document ||
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      this.notifySelection(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const startPage = closestPage(range.startContainer, this.viewerElement);
    const endPage = closestPage(range.endContainer, this.viewerElement);
    if (!startPage || startPage !== endPage) {
      this.notifySelection(null);
      return;
    }
    const pageNumber = Number(startPage.dataset['pageNumber']);
    const textLayer = startPage.querySelector<HTMLElement>('.textLayer');
    const pageView = viewer.getPageView(pageNumber - 1) as PdfPageViewLike;
    if (
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > document.numPages ||
      !textLayer ||
      !pageView
    ) {
      this.notifySelection(null);
      return;
    }

    const start = textOffsetWithin(
      textLayer,
      range.startContainer,
      range.startOffset,
    );
    const end = textOffsetWithin(
      textLayer,
      range.endContainer,
      range.endOffset,
    );
    const highlight = range.toString();
    if (
      start === null ||
      end === null ||
      end <= start ||
      !highlight.trim() ||
      highlight.length > 4096
    ) {
      this.notifySelection(null);
      return;
    }

    const pageRect = pageView.div.getBoundingClientRect();
    const geometry = [...range.getClientRects()]
      .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
      .slice(0, 15)
      .map((rectangle) => {
        const first = pageView.getPagePoint(
          rectangle.left - pageRect.left,
          rectangle.top - pageRect.top,
        );
        const second = pageView.getPagePoint(
          rectangle.right - pageRect.left,
          rectangle.bottom - pageRect.top,
        );
        return `pdf-rect=${round(first[0])},${round(first[1])},${round(second[0])},${round(second[1])}`;
      });
    const pageText = textLayer.textContent ?? '';
    this.notifySelection({
      locator: {
        ...pageLocator(pageNumber, document.numPages),
        locations: {
          ...pageLocator(pageNumber, document.numPages).locations,
          fragments: [`pdf-text=${pageNumber}:${start}:${end}`, ...geometry],
        },
        text: {
          before: pageText.slice(Math.max(0, start - 256), start),
          highlight,
          after: pageText.slice(end, end + 256),
        },
      },
    });
  }

  private renderVisibleAnnotations(): void {
    const viewer = this.pdfViewer;
    if (!viewer) {
      return;
    }
    const pages = new Set(
      this.annotations
        .map((annotation) => annotation.locator.locations?.position)
        .filter(
          (pageNumber): pageNumber is number =>
            Number.isSafeInteger(pageNumber) && Number(pageNumber) > 0,
        ),
    );
    for (const pageNumber of pages) {
      this.renderPageAnnotations(pageNumber);
    }
    this.viewerElement
      ?.querySelectorAll<HTMLElement>('[data-omnia-annotation-layer]')
      .forEach((layer) => {
        const pageNumber = Number(
          layer.closest<HTMLElement>('.page')?.dataset['pageNumber'],
        );
        if (!pages.has(pageNumber)) {
          layer.remove();
        }
      });
  }

  private renderPageAnnotations(pageNumber: number): void {
    const viewer = this.pdfViewer;
    if (!viewer) {
      return;
    }
    const pageView = viewer.getPageView(pageNumber - 1) as
      | PdfPageViewLike
      | undefined;
    const page = pageView?.div;
    if (!page) {
      return;
    }
    page.querySelector<HTMLElement>('[data-omnia-annotation-layer]')?.remove();
    const annotations = this.annotations.filter(
      (annotation) => annotation.locator.locations?.position === pageNumber,
    );
    if (annotations.length === 0) {
      return;
    }

    const layer = page.ownerDocument.createElement('div');
    layer.dataset['omniaAnnotationLayer'] = '';
    Object.assign(layer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '3',
    });

    for (const annotation of annotations) {
      const rectangles = annotation.locator.locations?.fragments
        ?.map(parsePdfRectangle)
        .filter(
          (rectangle): rectangle is [number, number, number, number] =>
            rectangle !== null,
        );
      if (rectangles?.length) {
        for (const rectangle of rectangles) {
          const first = pageView.viewport.convertToViewportPoint(
            rectangle[0],
            rectangle[1],
          );
          const second = pageView.viewport.convertToViewportPoint(
            rectangle[2],
            rectangle[3],
          );
          appendHighlightRectangle(
            layer,
            normalizeRectangle([...first, ...second]),
            annotation.color,
          );
        }
        continue;
      }

      const selector = annotation.locator.locations?.fragments
        ?.map(parsePdfTextSelector)
        .find((value) => value?.pageNumber === pageNumber);
      const textLayer = page.querySelector<HTMLElement>('.textLayer');
      const range =
        selector && textLayer
          ? rangeForTextOffsets(textLayer, selector.start, selector.end)
          : null;
      const pageRect = page.getBoundingClientRect();
      if (range) {
        [...range.getClientRects()].forEach((rectangle) =>
          appendHighlightRectangle(
            layer,
            [
              rectangle.left - pageRect.left,
              rectangle.top - pageRect.top,
              rectangle.right - pageRect.left,
              rectangle.bottom - pageRect.top,
            ],
            annotation.color,
          ),
        );
      }
    }
    if (layer.childElementCount > 0) {
      page.append(layer);
    }
  }

  private requireDocument(): PDFDocumentProxy {
    if (!this.document) {
      throw new Error('Open a PDF before using its reader');
    }
    return this.document;
  }

  private requireRuntime(): PdfRuntime {
    if (!this.runtime) {
      throw new Error('Open a PDF before initializing its viewer');
    }
    return this.runtime;
  }

  private async mapOutline(
    nodes: readonly PdfOutlineNode[],
  ): Promise<readonly TocEntry[]> {
    const document = this.requireDocument();
    return Promise.all(
      nodes.map(async (node) => {
        const destination =
          typeof node.dest === 'string'
            ? await document.getDestination(node.dest)
            : node.dest;
        const reference = destination?.[0];
        let pageNumber = 1;

        if (typeof reference === 'number') {
          pageNumber = reference + 1;
        } else if (isPdfReference(reference)) {
          pageNumber = (await document.getPageIndex(reference)) + 1;
        }

        return {
          title: node.title,
          locator: {
            ...pageLocator(pageNumber, document.numPages),
            title: node.title,
          },
          children: await this.mapOutline(node.items ?? []),
        };
      }),
    );
  }

  private async resetDocument(): Promise<void> {
    if (this.eventBus) {
      this.eventBus.off('pagechanging', this.handlePageChanging);
      this.eventBus.off('textlayerrendered', this.handleTextLayerRendered);
      this.eventBus.off(
        'annotationlayerrendered',
        this.handleAnnotationLayerRendered,
      );
    }
    this.viewport?.ownerDocument.removeEventListener(
      'selectionchange',
      this.handleSelectionChange,
    );
    this.pdfViewer?.cleanup();
    if (this.pdfViewer) {
      this.pdfViewer.setDocument(null as unknown as PDFDocumentProxy);
    }
    this.linkService?.setDocument(null);
    this.viewport?.classList.remove('omnia-pdf-viewer-container');
    if (this.viewport && this.previousViewportPosition !== null) {
      this.viewport.style.position = this.previousViewportPosition;
    }
    this.viewport?.removeAttribute('role');
    this.viewport?.removeAttribute('aria-label');
    this.viewport?.replaceChildren();
    this.viewerElement = null;
    this.pdfViewer = null;
    this.linkService = null;
    this.eventBus = null;
    this.viewport = null;
    this.previousViewportPosition = null;
    await this.loadingTask?.destroy();
    this.loadingTask = null;
    this.document = null;
    this.runtime = null;
    this.pageNumber = 1;
    this.toc = [];
    this.annotations = [];
    this.selectionCaptureQueued = false;
    this.passwordRequiredWithoutListener = false;
  }
}

function pageLocator(
  pageNumber: number,
  pageCount: number,
): PublicationLocator {
  return {
    href: '',
    type: 'application/pdf',
    title: `Page ${pageNumber}`,
    locations: {
      fragments: [`page=${pageNumber}`],
      position: pageNumber,
      progression: (pageNumber - 1) / pageCount,
      totalProgression: pageNumber / pageCount,
    },
  };
}

function normalizeExternalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function closestPage(
  node: Node,
  viewer: HTMLElement | null,
): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const page = element?.closest<HTMLElement>('.page[data-page-number]') ?? null;
  return page && viewer?.contains(page) ? page : null;
}

function textOffsetWithin(
  root: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  if (!root.contains(node)) {
    return null;
  }
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function rangeForTextOffsets(
  root: HTMLElement,
  start: number,
  end: number,
): Range | null {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    return null;
  }
  const startBoundary = textBoundary(root, start);
  const endBoundary = textBoundary(root, end);
  if (!startBoundary || !endBoundary) {
    return null;
  }
  const range = root.ownerDocument.createRange();
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  return range;
}

function textBoundary(
  root: HTMLElement,
  requestedOffset: number,
): { node: Text; offset: number } | null {
  const showText = root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = root.ownerDocument.createTreeWalker(root, showText);
  let consumed = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const next = consumed + text.data.length;
    if (requestedOffset <= next) {
      return {
        node: text,
        offset: Math.max(0, requestedOffset - consumed),
      };
    }
    consumed = next;
    node = walker.nextNode();
  }
  return null;
}

function parsePdfTextSelector(
  fragment: string,
): { pageNumber: number; start: number; end: number } | null {
  const match = /^pdf-text=(\d+):(\d+):(\d+)$/.exec(fragment);
  if (!match) {
    return null;
  }
  return {
    pageNumber: Number(match[1]),
    start: Number(match[2]),
    end: Number(match[3]),
  };
}

function parsePdfRectangle(
  fragment: string,
): [number, number, number, number] | null {
  const match =
    /^pdf-rect=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(
      fragment,
    );
  if (!match) {
    return null;
  }
  const values = match.slice(1).map(Number);
  return values.every(Number.isFinite)
    ? (values as [number, number, number, number])
    : null;
}

function normalizeRectangle(
  rectangle: number[],
): [number, number, number, number] {
  return [
    Math.min(rectangle[0], rectangle[2]),
    Math.min(rectangle[1], rectangle[3]),
    Math.max(rectangle[0], rectangle[2]),
    Math.max(rectangle[1], rectangle[3]),
  ];
}

function appendHighlightRectangle(
  layer: HTMLElement,
  rectangle: [number, number, number, number],
  color: PublicationAnnotation['color'],
): void {
  const [left, top, right, bottom] = rectangle;
  if (
    ![left, top, right, bottom].every(Number.isFinite) ||
    right <= left ||
    bottom <= top
  ) {
    return;
  }
  const highlight = layer.ownerDocument.createElement('div');
  Object.assign(highlight.style, {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
    background: PDF_ANNOTATION_COLORS[color],
    mixBlendMode: 'multiply',
    borderRadius: '2px',
  });
  layer.append(highlight);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const PDF_ANNOTATION_COLORS = {
  yellow: 'rgb(250 204 21 / 42%)',
  green: 'rgb(74 222 128 / 38%)',
  blue: 'rgb(96 165 250 / 38%)',
  pink: 'rgb(244 114 182 / 38%)',
} as const;

function locatorPageNumber(
  locator: PublicationLocator,
  fallback: number,
): number {
  const fragmentPage = locator.locations?.fragments
    ?.map((fragment) => /^page=(\d+)$/.exec(fragment)?.[1])
    .find(Boolean);
  const requested = Number(
    fragmentPage ?? locator.locations?.position ?? fallback,
  );
  return Number.isFinite(requested) ? requested : fallback;
}

function isPdfReference(value: unknown): value is PdfReference {
  return (
    !!value &&
    typeof value === 'object' &&
    'num' in value &&
    typeof value.num === 'number' &&
    'gen' in value &&
    typeof value.gen === 'number'
  );
}

function isRenderingCancelled(value: unknown): boolean {
  return value instanceof Error && value.name === 'RenderingCancelledException';
}

function waitForEvent(eventBus: EventBus, eventName: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = () => {
      eventBus.off(eventName, listener);
      resolve();
    };
    eventBus.on(eventName, listener);
  });
}

async function loadPdfRuntime(): Promise<PdfRuntime> {
  const core = await import('pdfjs-dist');
  (globalThis as typeof globalThis & { pdfjsLib?: PdfCoreModule }).pdfjsLib =
    core;
  const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
  return { core, viewer };
}

let stylesheetPromise: Promise<void> | null = null;

function ensurePdfViewerStyles(): Promise<void> {
  if (stylesheetPromise) {
    return stylesheetPromise;
  }
  stylesheetPromise = new Promise((resolve, reject) => {
    const selector = 'link[data-omnia-pdf-viewer-styles]';
    const existing =
      globalThis.document.querySelector<HTMLLinkElement>(selector);
    if (existing?.dataset['loaded'] === 'true') {
      resolve();
      return;
    }

    const stylesheet = existing ?? globalThis.document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL(
      'assets/pdfjs/pdf_viewer.css',
      globalThis.document.baseURI,
    ).toString();
    stylesheet.dataset['omniaPdfViewerStyles'] = '';
    stylesheet.addEventListener(
      'load',
      () => {
        stylesheet.dataset['loaded'] = 'true';
        resolve();
      },
      { once: true },
    );
    stylesheet.addEventListener(
      'error',
      () => {
        stylesheetPromise = null;
        reject(new Error('Unable to load the PDF viewer styles'));
      },
      { once: true },
    );
    if (!existing) {
      globalThis.document.head.append(stylesheet);
    }
  });
  return stylesheetPromise;
}
