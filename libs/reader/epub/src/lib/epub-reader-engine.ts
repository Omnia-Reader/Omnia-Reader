import type {
  Book,
  Contents,
  GlobalLayout,
  LandmarkItem,
  NavItem,
  Rendition,
  Section,
} from '@likecoin/epub-ts';
import {
  BookSource,
  DEFAULT_EPUB_READER_PREFERENCES,
  EpubReaderPreferences,
  keyboardNavigationDirection,
  PublicationAnnotation,
  PublicationLayout,
  PublicationLocator,
  PublicationMetadata,
  PublicationReadingDirection,
  PublicationSelection,
  ReaderEngine,
  ReaderNavigationDirection,
  ReaderPageStatus,
  ReaderPreferences,
  ReaderZoomDirection,
  SearchResult,
  selectionHasText,
  startTouchEventNavigationGesture,
  startTouchNavigationGesture,
  TocEntry,
  TouchNavigationGesture,
  touchEventNavigationDirection,
  touchNavigationDirection,
  wheelNavigationDirection,
  wheelZoomDirection,
} from '@omnia-reader/reader/domain';
import {
  epubLocationToLocator,
  epubLocationToPageStatus,
} from './epub-locator';

export type EpubRuntimeLoader = () => Promise<
  typeof import('@likecoin/epub-ts')
>;

const WHEEL_NAVIGATION_INTERVAL_MS = 400;
const EPUB_LOCATION_BREAK_SIZE = 1_600;
const EPUB_READER_THEME_STYLE_ID = 'epubjs-inserted-css-omnia-reader';
type AuthoredEpubFlow = 'paginated' | 'scrolled';

class InvalidEpubError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      'This EPUB is damaged or unsupported. Verify the file in another reader or import a repaired copy.',
    );
    this.name = 'InvalidEpubError';
    this.cause = cause;
  }
}

export class EpubReaderEngine implements ReaderEngine {
  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private viewport: HTMLElement | null = null;
  private toc: readonly TocEntry[] = [];
  private locator: PublicationLocator | null = null;
  private lastNotifiedLocator = '';
  private pendingExpectedSection: {
    readonly href: string;
    readonly index?: number;
  } | null = null;
  private currentPageStatus: ReaderPageStatus | null = null;
  private readingDirection: PublicationReadingDirection = 'ltr';
  private publicationLayout: PublicationLayout = 'reflowable';
  private publicationSpread: EpubReaderPreferences['spread'] = 'auto';
  private publicationOrientation = 'auto';
  private publicationFlow: AuthoredEpubFlow = 'paginated';
  private currentSectionLayout: PublicationLayout = 'reflowable';
  private currentSectionSpread: EpubReaderPreferences['spread'] = 'auto';
  private currentSectionOrientation = 'auto';
  private currentSectionFlow: AuthoredEpubFlow = 'paginated';
  private readerThemeCss = '';
  private preferences: EpubReaderPreferences = {
    ...DEFAULT_EPUB_READER_PREFERENCES,
  };
  private annotations: readonly PublicationAnnotation[] = [];
  private appliedAnnotationCfis = new Set<string>();
  private selectedDocument: Document | null = null;
  private contentObserver: MutationObserver | null = null;
  private selectionMonitor: ReturnType<typeof setInterval> | null = null;
  private capturedSelectionDocument: Document | null = null;
  private capturedSelectionKey: string | null = null;
  private monitoredSelectionDocument: Document | null = null;
  private monitoredSelectionKey: string | null = null;
  private monitoredSelectionSince = 0;
  private lastWheelNavigationAt = Number.NEGATIVE_INFINITY;
  private sectionPresentationFrame: number | null = null;
  private pendingSectionPresentation: {
    readonly section: Section;
    readonly rendition: Rendition;
  } | null = null;
  private readonly handledWheelEvents = new WeakSet<Event>();
  private readonly handledKeyboardEvents = new WeakSet<Event>();
  private readonly relocationListeners = new Set<
    (locator: PublicationLocator) => void
  >();
  private readonly selectionListeners = new Set<
    (selection: PublicationSelection | null) => void
  >();
  private readonly navigationRequestListeners = new Set<
    (direction: ReaderNavigationDirection) => void
  >();
  private readonly zoomRequestListeners = new Set<
    (direction: ReaderZoomDirection) => void
  >();
  private readonly annotationActivationListeners = new Set<
    (annotationId: string) => void
  >();
  private readonly externalLinkRequestListeners = new Set<
    (url: string) => void
  >();
  private readonly contentDocuments = new Set<Document>();
  private readonly contentsByDocument = new Map<Document, Contents>();
  private readonly contentFrames = new Map<HTMLIFrameElement, EventListener>();
  private readonly contentFrameSelectionActionHandlers = new Map<
    HTMLIFrameElement,
    EventListener
  >();
  private readonly contentSelectionHandlers = new Map<
    Document,
    EventListener
  >();
  private readonly contentSelectionChangeHandlers = new Map<
    Document,
    EventListener
  >();
  private readonly contentSelectionTimeouts = new Map<
    Document,
    ReturnType<typeof setTimeout>
  >();
  private readonly contentContextMenuHandlers = new Map<
    Document,
    EventListener
  >();
  private readonly contentLinkHandlers = new Map<Document, EventListener>();
  private readonly contentTouchNavigationGestures = new Map<
    Document,
    TouchNavigationGesture
  >();
  private readonly contentTouchEventNavigationGestures = new Map<
    Document,
    TouchNavigationGesture
  >();
  private readonly contentTouchNavigationHandlers = new Map<
    Document,
    {
      readonly pointerDown: EventListener;
      readonly pointerUp: EventListener;
      readonly pointerCancel: EventListener;
      readonly touchStart: EventListener;
      readonly touchEnd: EventListener;
      readonly touchCancel: EventListener;
    }
  >();
  private readonly contentTouchNavigationStyles = new Map<
    Document,
    HTMLStyleElement
  >();
  private readonly allowedPublicationLinks = new Set<string>();
  private readonly handledFrameLinkTargets = new WeakMap<
    HTMLIFrameElement,
    string
  >();
  private readonly sanitizeContent = (document: Document): void => {
    sanitizeEpubDocument(document, this.allowedPublicationLinks);
  };
  private readonly handleRenderedContent = (contents: Contents): void => {
    // A rendition may recycle an iframe and its Document wrapper between
    // spine items. Refresh listeners whenever epub.ts reports new Contents,
    // because WebKit clears listeners while repopulating the reused document.
    this.applyReaderThemeToDocument(
      contents.document,
      this.currentSectionLayout !== 'pre-paginated',
    );
    this.attachContentDocument(contents.document, contents, true);
  };
  private readonly attachContentDocument = (
    document: Document,
    contents?: Contents,
    refresh = false,
  ): void => {
    if (this.contentDocuments.has(document)) {
      if (!refresh) {
        if (contents) {
          this.contentsByDocument.set(document, contents);
        }
        const linkHandler = this.contentLinkHandlers.get(document);
        if (linkHandler) {
          installPublicationLinkHandlers(document, linkHandler);
        }
        return;
      }
      const knownContents = contents ?? this.contentsByDocument.get(document);
      this.detachContentDocument(document);
      contents = knownContents;
    }
    if (contents) {
      this.contentsByDocument.set(document, contents);
    }
    // epub.ts assigns its own `onclick` property to internal anchors. Omnia
    // replaces it while retaining the original href so all link types pass
    // through the same navigation and consent policy.
    for (const anchor of document.querySelectorAll('a[href]')) {
      (anchor as HTMLElement).onclick = null;
    }
    document.addEventListener('keydown', this.handleContentKeydown);
    document.defaultView?.addEventListener(
      'keydown',
      this.handleContentKeydown,
    );
    for (const target of this.selectionActionTargets(document)) {
      target.addEventListener('wheel', this.handleContentWheel, {
        passive: false,
      });
    }
    const linkHandler = (event: Event): void => {
      const anchor = closestPublicationAnchor(event.target);
      if (!anchor) {
        return;
      }
      const link = classifyPublicationLink(publicationHref(anchor));
      event.preventDefault();
      event.stopImmediatePropagation();
      if (link.kind === 'internal') {
        this.navigateInternalLink(anchor);
      } else if (link.kind === 'external') {
        for (const listener of this.externalLinkRequestListeners) {
          listener(link.url);
        }
      }
    };
    document.addEventListener('click', linkHandler, true);
    installPublicationLinkHandlers(document, linkHandler);
    this.contentLinkHandlers.set(document, linkHandler);
    const selectionHandler = (): void => {
      this.captureDocumentSelection(document);
    };
    document.addEventListener('mouseup', selectionHandler);
    document.addEventListener('touchend', selectionHandler);
    this.contentSelectionHandlers.set(document, selectionHandler);
    const selectionChangeHandler = (): void => {
      const existing = this.contentSelectionTimeouts.get(document);
      if (existing) {
        clearTimeout(existing);
      }
      this.contentSelectionTimeouts.set(
        document,
        setTimeout(() => {
          this.contentSelectionTimeouts.delete(document);
          this.captureDocumentSelection(document);
        }, 250),
      );
    };
    document.addEventListener('selectionchange', selectionChangeHandler);
    this.contentSelectionChangeHandlers.set(document, selectionChangeHandler);
    const pointerDownHandler = (event: Event): void => {
      const gesture = startTouchNavigationGesture(event as PointerEvent);
      if (gesture) {
        this.contentTouchNavigationGestures.set(document, gesture);
      } else {
        // A secondary touch cancels a primary gesture so pinching never turns
        // into page navigation when the primary pointer is released.
        this.contentTouchNavigationGestures.delete(document);
      }
    };
    const pointerUpHandler = (event: Event): void => {
      const gesture = this.contentTouchNavigationGestures.get(document);
      this.contentTouchNavigationGestures.delete(document);
      if (!gesture || selectionHasText(document.defaultView?.getSelection())) {
        return;
      }
      const direction = touchNavigationDirection(
        gesture,
        event as PointerEvent,
        this.readingDirection,
      );
      if (!direction) {
        return;
      }
      this.contentTouchEventNavigationGestures.delete(document);
      event.preventDefault();
      for (const listener of this.navigationRequestListeners) {
        listener(direction);
      }
    };
    const pointerCancelHandler = (): void => {
      this.contentTouchNavigationGestures.delete(document);
    };
    const touchStartHandler = (event: Event): void => {
      const gesture = startTouchEventNavigationGesture(event as TouchEvent);
      if (gesture) {
        this.contentTouchEventNavigationGestures.set(document, gesture);
      } else {
        this.contentTouchEventNavigationGestures.delete(document);
      }
    };
    const touchEndHandler = (event: Event): void => {
      const gesture = this.contentTouchEventNavigationGestures.get(document);
      this.contentTouchEventNavigationGestures.delete(document);
      if (!gesture || selectionHasText(document.defaultView?.getSelection())) {
        return;
      }
      const direction = touchEventNavigationDirection(
        gesture,
        event as TouchEvent,
        this.readingDirection,
      );
      if (!direction) {
        return;
      }
      this.contentTouchNavigationGestures.delete(document);
      event.preventDefault();
      for (const listener of this.navigationRequestListeners) {
        listener(direction);
      }
    };
    const touchCancelHandler = (): void => {
      this.contentTouchEventNavigationGestures.delete(document);
    };
    // WebKit does not consistently bubble synthetic or accessibility-driven
    // pointer events from an EPUB iframe body to its Document. Register on the
    // same document/root/body chain used by wheel and selection handling.
    // Capture also lets publication/rendering handlers keep their own pointer
    // semantics without pre-emptively marking the navigation gesture handled.
    for (const target of this.selectionActionTargets(document)) {
      target.addEventListener('pointerdown', pointerDownHandler, true);
      target.addEventListener('pointerup', pointerUpHandler, true);
      target.addEventListener('pointercancel', pointerCancelHandler, true);
      target.addEventListener('touchstart', touchStartHandler, true);
      target.addEventListener('touchend', touchEndHandler, true);
      target.addEventListener('touchcancel', touchCancelHandler, true);
    }
    this.contentTouchNavigationHandlers.set(document, {
      pointerDown: pointerDownHandler,
      pointerUp: pointerUpHandler,
      pointerCancel: pointerCancelHandler,
      touchStart: touchStartHandler,
      touchEnd: touchEndHandler,
      touchCancel: touchCancelHandler,
    });
    if (document.head) {
      const touchNavigationStyle = document.createElement('style');
      touchNavigationStyle.dataset['omniaTouchNavigation'] = 'true';
      touchNavigationStyle.textContent =
        'html, body { touch-action: pan-y pinch-zoom; }';
      document.head.append(touchNavigationStyle);
      this.contentTouchNavigationStyles.set(document, touchNavigationStyle);
    }
    const contextMenuHandler = (event: Event): void => {
      if (handledSelectionActionEvents.has(event)) {
        return;
      }
      handledSelectionActionEvents.add(event);
      if (event.type === 'mousedown' && (event as MouseEvent).button !== 2) {
        return;
      }
      const selection = this.captureDocumentSelection(document, true);
      if (!selection) {
        return;
      }
      event.preventDefault();
      this.notifySelection(selection);
    };
    const handledSelectionActionEvents = new WeakSet<Event>();
    this.installSelectionActionHandler(document, contextMenuHandler);
    this.contentContextMenuHandlers.set(document, contextMenuHandler);
    this.contentDocuments.add(document);
  };
  private readonly handleContentKeydown = (event: KeyboardEvent): void => {
    if (this.handledKeyboardEvents.has(event)) {
      return;
    }
    this.handledKeyboardEvents.add(event);
    const direction = keyboardNavigationDirection(event, this.readingDirection);
    if (!direction) {
      return;
    }
    event.preventDefault();
    for (const listener of this.navigationRequestListeners) {
      listener(direction);
    }
  };
  private readonly handleContentWheel: EventListener = (event): void => {
    if (this.handledWheelEvents.has(event)) {
      return;
    }
    this.handledWheelEvents.add(event);
    const wheelEvent = event as WheelEvent;
    if (
      typeof wheelEvent.deltaX !== 'number' ||
      typeof wheelEvent.deltaY !== 'number'
    ) {
      return;
    }
    const zoomDirection = wheelZoomDirection(wheelEvent);
    if (zoomDirection) {
      event.preventDefault();
      for (const listener of this.zoomRequestListeners) {
        listener(zoomDirection);
      }
      return;
    }
    if (this.effectiveFlow() === 'scrolled-doc') {
      return;
    }
    const direction = wheelNavigationDirection(wheelEvent);
    if (!direction) {
      return;
    }
    event.preventDefault();
    const now = Date.now();
    if (now - this.lastWheelNavigationAt < WHEEL_NAVIGATION_INTERVAL_MS) {
      return;
    }
    this.lastWheelNavigationAt = now;
    for (const listener of this.navigationRequestListeners) {
      listener(direction);
    }
  };
  private readonly handleRelocated = (location: unknown): void => {
    if (this.rendition) {
      const section = this.currentSection(location);
      this.prepareSectionTheme(section);
      this.scheduleSectionPresentation(section, this.rendition);
    }
    this.updateLocator(location, true);
  };
  private readonly handleSelected = (
    cfiRange: string,
    contents: Contents,
  ): void => {
    const selection = contents.window.getSelection();
    if (
      !cfiRange.startsWith('epubcfi(') ||
      !selection ||
      selection.rangeCount === 0
    ) {
      return;
    }
    this.captureSelectedRange(
      selection.getRangeAt(0),
      contents.document,
      contents,
      cfiRange,
    );
  };

  private captureSelectedRange(
    range: Range,
    document: Document,
    contents?: Contents,
    cfiRange?: string,
  ): PublicationSelection | null {
    const quote = quoteFromRange(range, document);
    if (!quote) {
      return null;
    }

    this.selectedDocument = document;
    const current = this.currentLocator();
    return {
      locator: {
        href: current?.href ?? '',
        type: 'application/xhtml+xml',
        title: current?.title,
        locations: cfiRange
          ? {
              ...current?.locations,
              fragments: [cfiRange],
            }
          : current?.locations
            ? { ...current.locations, fragments: undefined }
            : undefined,
        text: quote,
      },
    };
  }

  constructor(
    private readonly runtimeLoader: EpubRuntimeLoader = () =>
      import('@likecoin/epub-ts'),
  ) {}

  async open(source: BookSource): Promise<PublicationMetadata> {
    await this.close();
    const opened = await source.open();
    const bytes =
      opened instanceof Blob ? await opened.arrayBuffer() : opened.slice(0);
    const { default: ePub } = await this.runtimeLoader();
    try {
      this.book = ePub(bytes);
      // epub.ts rejects every deferred `loaded` promise when opening fails.
      // Observe the complete startup set immediately so one malformed package
      // does not leak sibling unhandled rejections after the caller catches
      // the primary failure.
      for (const startup of [
        this.book.opened,
        this.book.ready,
        ...Object.values(this.book.loaded),
      ]) {
        void startup?.catch(() => undefined);
      }
      this.book.spine.hooks.content.register(this.sanitizeContent);

      const [metadata, navigation] = await Promise.all([
        this.book.loaded.metadata,
        this.book.loaded.navigation,
        this.book.ready,
      ]);
      // epub.ts deliberately starts archived asset and CSS URL replacement
      // outside `Book.ready`. Rendering or destroying the book before this
      // promise settles can omit embedded fonts and races `Book.destroy()` in
      // slower WebKit environments.
      await this.book.replacementsReady;
      await sanitizeEpubStyleResources(this.book);
      this.readingDirection = metadata.direction === 'rtl' ? 'rtl' : 'ltr';
      this.publicationLayout =
        metadata.layout === 'pre-paginated' ? 'pre-paginated' : 'reflowable';
      this.publicationSpread = metadata.spread === 'none' ? 'none' : 'auto';
      this.publicationOrientation = metadata.orientation || 'auto';
      this.publicationFlow = authoredEpubFlow(metadata.flow);
      this.setCurrentSectionPresentation();
      const unnumberedTargets = this.unnumberedNavigationTargets(
        navigation.landmarks ?? [],
      );
      this.toc = navigation.toc.map((item) =>
        this.mapTocEntry(item, '', unnumberedTargets),
      );
      const cover = await this.loadCover();

      return {
        title: metadata.title || source.name,
        authors: metadata.creator ? [metadata.creator] : [],
        language: metadata.language || undefined,
        publisher: metadata.publisher || undefined,
        identifier: metadata.identifier || undefined,
        readingDirection: this.readingDirection,
        layout: this.publicationLayout,
        cover,
      };
    } catch (cause) {
      await this.close().catch(() => undefined);
      throw new InvalidEpubError(cause);
    }
  }

  async mount(viewport: HTMLElement): Promise<void> {
    if (!this.book) {
      throw new Error('Open an EPUB before mounting its reader');
    }

    this.viewport = viewport;
    viewport.replaceChildren();
    viewport.classList.add('omnia-epub-viewer-container');
    viewport.setAttribute('role', 'document');
    viewport.setAttribute('aria-label', 'EPUB publication');
    viewport.dataset['publicationLayout'] = this.publicationLayout;
    viewport.setAttribute('dir', this.readingDirection);
    this.setCurrentSectionPresentation(this.book.spine.get?.() ?? undefined);
    const fixedLayout = this.currentSectionLayout === 'pre-paginated';
    // `method` is supported by epub.ts at runtime but is missing from its
    // public RenditionOptions declaration.
    const renditionOptions = {
      width: '100%',
      height: '100%',
      manager: 'default',
      method: 'write',
      layout: this.currentSectionLayout,
      flow: this.effectiveFlow(),
      spread: this.effectiveSpread(),
      orientation: this.currentSectionOrientation,
      direction: this.readingDirection,
      defaultDirection: this.readingDirection,
      gap: fixedLayout
        ? 0
        : epubPageGap(viewport, this.preferences.marginPercent),
      allowScriptedContent: false,
      allowPopups: false,
    } as const;
    this.rendition = this.book.renderTo(viewport, renditionOptions);
    this.applyPreferencesToRendition();
    this.rendition.hooks.content.register(this.handleRenderedContent);
    this.rendition.on('relocated', this.handleRelocated);
    this.rendition.on('selected', this.handleSelected);
    this.contentObserver = new MutationObserver(() => {
      this.attachFrameHandlers();
    });
    this.contentObserver.observe(viewport, { childList: true, subtree: true });
    await this.rendition.display();
    // Omnia only mounts readers into a visible route viewport. epub.ts's
    // bootstrap observer is therefore no longer needed once display resolves,
    // and retiring it before reportLocation prevents a queued resize loop from
    // surviving until the viewport is removed during route navigation.
    this.rendition._disconnectContainerObserver();
    this.attachRenditionContentHandlers();
    this.selectionMonitor = setInterval(() => {
      this.attachFrameHandlers(true);
    }, 200);
    await this.refreshRenditionLocation(this.rendition, false);
    await this.generateBookLocations(this.book);
    this.applyAnnotationsToRendition();
  }

  async close(): Promise<void> {
    const view = this.viewport?.ownerDocument.defaultView;
    if (this.sectionPresentationFrame !== null && view) {
      view.cancelAnimationFrame(this.sectionPresentationFrame);
    }
    this.sectionPresentationFrame = null;
    this.pendingSectionPresentation = null;
    if (this.selectionMonitor) {
      clearInterval(this.selectionMonitor);
      this.selectionMonitor = null;
    }
    this.contentObserver?.disconnect();
    this.contentObserver = null;
    for (const [frame, loadHandler] of this.contentFrames) {
      frame.removeEventListener('load', loadHandler);
      const selectionActionHandler =
        this.contentFrameSelectionActionHandlers.get(frame);
      if (selectionActionHandler) {
        frame.removeEventListener('mousedown', selectionActionHandler, true);
        frame.removeEventListener('contextmenu', selectionActionHandler, true);
      }
      frame.removeEventListener('wheel', this.handleContentWheel);
    }
    this.contentFrames.clear();
    this.contentFrameSelectionActionHandlers.clear();
    for (const document of [...this.contentDocuments]) {
      this.detachContentDocument(document);
    }
    this.contentDocuments.clear();
    this.contentsByDocument.clear();
    this.contentSelectionHandlers.clear();
    this.contentSelectionChangeHandlers.clear();
    this.contentSelectionTimeouts.clear();
    this.contentContextMenuHandlers.clear();
    this.contentLinkHandlers.clear();
    this.contentTouchNavigationGestures.clear();
    this.contentTouchEventNavigationGestures.clear();
    this.contentTouchNavigationHandlers.clear();
    this.contentTouchNavigationStyles.clear();
    this.allowedPublicationLinks.clear();
    this.rendition?.off('relocated', this.handleRelocated);
    this.rendition?.off('selected', this.handleSelected);
    this.rendition?.destroy();
    this.book?.destroy();
    this.viewport?.classList.remove('omnia-epub-viewer-container');
    this.viewport?.removeAttribute('role');
    this.viewport?.removeAttribute('aria-label');
    this.viewport?.removeAttribute('data-publication-layout');
    this.viewport?.removeAttribute('data-current-section-layout');
    this.viewport?.removeAttribute('data-current-section-flow');
    this.viewport?.removeAttribute('dir');
    this.viewport?.replaceChildren();
    this.rendition = null;
    this.book = null;
    this.viewport = null;
    this.toc = [];
    this.locator = null;
    this.lastNotifiedLocator = '';
    this.pendingExpectedSection = null;
    this.currentPageStatus = null;
    this.readingDirection = 'ltr';
    this.publicationLayout = 'reflowable';
    this.publicationSpread = 'auto';
    this.publicationOrientation = 'auto';
    this.publicationFlow = 'paginated';
    this.currentSectionLayout = 'reflowable';
    this.currentSectionSpread = 'auto';
    this.currentSectionOrientation = 'auto';
    this.currentSectionFlow = 'paginated';
    this.readerThemeCss = '';
    this.annotations = [];
    this.appliedAnnotationCfis.clear();
    this.selectedDocument = null;
    this.capturedSelectionDocument = null;
    this.capturedSelectionKey = null;
    this.monitoredSelectionDocument = null;
    this.monitoredSelectionKey = null;
    this.monitoredSelectionSince = 0;
    this.lastWheelNavigationAt = Number.NEGATIVE_INFINITY;
  }

  tableOfContents(): readonly TocEntry[] {
    return this.toc;
  }

  currentLocator(): PublicationLocator | null {
    this.updateLocator(this.rendition?.currentLocation(), false);
    return this.locator;
  }

  pageStatus(): ReaderPageStatus | null {
    this.updateLocator(this.rendition?.currentLocation(), false);
    if (this.effectiveFlow() === 'scrolled-doc') {
      return null;
    }
    return this.currentPageStatus;
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

  onAnnotationActivated(listener: (annotationId: string) => void): () => void {
    this.annotationActivationListeners.add(listener);
    return () => this.annotationActivationListeners.delete(listener);
  }

  onNavigationRequested(
    listener: (direction: ReaderNavigationDirection) => void,
  ): () => void {
    this.navigationRequestListeners.add(listener);
    return () => this.navigationRequestListeners.delete(listener);
  }

  onZoomRequested(
    listener: (direction: ReaderZoomDirection) => void,
  ): () => void {
    this.zoomRequestListeners.add(listener);
    return () => this.zoomRequestListeners.delete(listener);
  }

  onExternalLinkRequested(listener: (url: string) => void): () => void {
    this.externalLinkRequestListeners.add(listener);
    return () => this.externalLinkRequestListeners.delete(listener);
  }

  clearSelection(): void {
    this.selectedDocument?.defaultView?.getSelection()?.removeAllRanges();
    this.selectedDocument = null;
    this.capturedSelectionDocument = null;
    this.capturedSelectionKey = null;
    this.monitoredSelectionDocument = null;
    this.monitoredSelectionKey = null;
    this.monitoredSelectionSince = 0;
    this.notifySelection(null);
  }

  async setAnnotations(
    annotations: readonly PublicationAnnotation[],
  ): Promise<void> {
    this.annotations = annotations.filter(
      (annotation) =>
        annotation.format === 'epub' && annotation.deletedAt === undefined,
    );
    this.applyAnnotationsToRendition();
  }

  async applyPreferences(preferences: ReaderPreferences): Promise<void> {
    if (preferences.format !== 'epub') {
      throw new Error('EPUB preferences are required by the EPUB reader');
    }

    this.preferences = { ...preferences };
    if (this.rendition) {
      const rendition = this.rendition;
      rendition.flow(this.effectiveFlow());
      this.updateCurrentSectionFlowDataset();
      rendition.spread(this.effectiveSpread());
      rendition.direction(this.readingDirection);
      this.applyPreferencesToRendition();
      await this.refreshRenditionLocation(rendition, false);
      // epub.ts can repopulate a reused iframe while applying flow/theme
      // changes. Reinstall document handlers after that lifecycle completes so
      // keyboard, wheel, selection, and link behavior survive reader zoom.
      if (this.rendition === rendition) {
        this.attachRenditionContentHandlers(true);
      }
    }
  }

  async goTo(locator: PublicationLocator): Promise<void> {
    const rendition = this.requireRendition();
    const fragment = locator.locations?.fragments?.[0];
    let target: string;
    if (fragment?.startsWith('epubcfi(')) {
      target = fragment;
    } else {
      const section = this.book?.spine.get(locator.href);
      if (!section?.href) {
        throw new Error(
          'This publication section is not available. Its table of contents may be invalid.',
        );
      }
      target = fragment ? `${section.href}#${fragment}` : section.href;
    }
    const targetSection = this.sectionForTarget(target);
    this.prepareSectionTheme(targetSection);
    await rendition.display(target);
    this.applySectionPresentation(targetSection, rendition);
    this.attachRenditionContentHandlers();
    await this.refreshRenditionLocation(rendition, true, targetSection);
  }

  async goToProgression(totalProgression: number): Promise<void> {
    const book = this.book;
    const rendition = this.requireRendition();
    const locations = book?.locations;
    if (
      !locations ||
      typeof locations.cfiFromPercentage !== 'function' ||
      typeof locations.total !== 'number' ||
      locations.total <= 0
    ) {
      throw new Error('Book position seeking is not available yet');
    }
    if (!Number.isFinite(totalProgression)) {
      throw new Error('Book position must be a finite number');
    }

    const target = locations.cfiFromPercentage(
      Math.min(1, Math.max(0, totalProgression)),
    );
    if (typeof target !== 'string' || !target.startsWith('epubcfi(')) {
      throw new Error('The requested book position is not available');
    }

    const targetSection = this.sectionForTarget(target);
    this.prepareSectionTheme(targetSection);
    await rendition.display(target);
    this.applySectionPresentation(targetSection, rendition);
    this.attachRenditionContentHandlers();
    await this.refreshRenditionLocation(rendition, true, targetSection);
  }

  async next(): Promise<void> {
    const rendition = this.requireRendition();
    this.updateLocator(rendition.currentLocation(), false);
    const targetSection =
      this.currentPageStatus &&
      this.currentPageStatus.current >= this.currentPageStatus.total
        ? this.currentSection()?.next?.()
        : undefined;
    this.prepareSectionTheme(targetSection);
    await rendition.next();
    const renderedSection =
      this.renderedSection(rendition, 'next') ?? targetSection;
    this.applySectionPresentation(
      renderedSection ?? this.currentSection(rendition.currentLocation()),
      rendition,
    );
    this.attachRenditionContentHandlers();
    await this.refreshRenditionLocation(rendition, true, renderedSection);
  }

  async previous(): Promise<void> {
    const rendition = this.requireRendition();
    this.updateLocator(rendition.currentLocation(), false);
    const targetSection =
      this.currentPageStatus && this.currentPageStatus.current <= 1
        ? this.currentSection()?.prev?.()
        : undefined;
    this.prepareSectionTheme(targetSection);
    await rendition.prev();
    const renderedSection =
      this.renderedSection(rendition, 'previous') ?? targetSection;
    this.applySectionPresentation(
      renderedSection ?? this.currentSection(rendition.currentLocation()),
      rendition,
    );
    this.attachRenditionContentHandlers();
    await this.refreshRenditionLocation(rendition, true, renderedSection);
  }

  async *search(query: string): AsyncIterable<SearchResult> {
    const book = this.book;
    if (!book || !query.trim()) {
      return;
    }

    const sections: Section[] = [];
    book.spine.each((section) => sections.push(section));

    for (const section of sections) {
      const href = section.href;
      const resourceUrl = section.url ?? href;
      if (!href || !resourceUrl) {
        continue;
      }
      const previousDocument = section.document;
      const previousContents = section.contents;
      try {
        const searchDocument =
          previousDocument ?? (await book.load(resourceUrl));
        if (!isDocument(searchDocument)) {
          continue;
        }
        sanitizeEpubDocument(searchDocument, this.allowedPublicationLinks);
        section.document = searchDocument;
        section.contents = searchDocument.documentElement;
        for (const match of section.find(query)) {
          yield {
            locator: {
              href,
              type: 'application/xhtml+xml',
              locations: { fragments: [match.cfi] },
            },
            excerpt: match.excerpt,
          };
        }
      } finally {
        section.document = previousDocument;
        section.contents = previousContents;
      }
    }
  }

  private mapTocEntry(
    item: NavItem,
    parentHref = '',
    unnumberedTargets: ReadonlySet<string> = new Set(),
  ): TocEntry {
    const hashIndex = item.href.indexOf('#');
    const rawHref =
      hashIndex === -1 ? item.href : item.href.slice(0, hashIndex);
    const fragment =
      hashIndex === -1 ? undefined : item.href.slice(hashIndex + 1);
    const href = this.resolveTocHref(rawHref, parentHref);
    return {
      title: item.label,
      locator: {
        href,
        type: 'application/xhtml+xml',
        locations: fragment ? { fragments: [fragment] } : undefined,
      },
      numbering: unnumberedTargets.has(tocTargetKey(href, fragment))
        ? 'unnumbered'
        : undefined,
      children: item.subitems?.map((child) =>
        this.mapTocEntry(child, href, unnumberedTargets),
      ),
    };
  }

  private unnumberedNavigationTargets(
    landmarks: readonly LandmarkItem[],
  ): ReadonlySet<string> {
    const targets = new Set<string>();
    for (const landmark of landmarks) {
      const types = landmark.type?.toLowerCase().split(/\s+/) ?? [];
      if (
        !landmark.href ||
        !types.some((type) => UNNUMBERED_EPUB_LANDMARK_TYPES.has(type))
      ) {
        continue;
      }
      const hashIndex = landmark.href.indexOf('#');
      const rawHref =
        hashIndex === -1 ? landmark.href : landmark.href.slice(0, hashIndex);
      const fragment =
        hashIndex === -1 ? undefined : landmark.href.slice(hashIndex + 1);
      const href = this.resolveTocHref(rawHref, '');
      targets.add(tocTargetKey(href, fragment));
    }
    return targets;
  }

  private resolveTocHref(rawHref: string, parentHref: string): string {
    const book = this.book;
    const inheritedHref = rawHref || parentHref;
    if (!book || !inheritedHref) {
      return inheritedHref;
    }

    const navigationPath =
      book.packaging?.navPath || book.packaging?.ncxPath || '';
    const candidates = new Set<string>([inheritedHref]);
    if (rawHref && navigationPath) {
      const resolved = resolveEpubRelativePath(navigationPath, rawHref);
      if (resolved) {
        candidates.add(resolved);
      }
    }

    for (const candidate of candidates) {
      const section = book.spine.get(candidate);
      if (section?.href) {
        return section.href;
      }
    }

    const normalizedCandidates = new Set(
      [...candidates].map(normalizeEpubPath).filter(Boolean),
    );
    const suffixMatches: Section[] = [];
    book.spine.each((section) => {
      if (!section.href) {
        return;
      }
      const sectionPath = normalizeEpubPath(section.href);
      if (
        sectionPath &&
        [...normalizedCandidates].some(
          (candidate) =>
            candidate === sectionPath ||
            candidate.endsWith(`/${sectionPath}`) ||
            sectionPath.endsWith(`/${candidate}`),
        )
      ) {
        suffixMatches.push(section);
      }
    });
    return suffixMatches.length === 1 && suffixMatches[0].href
      ? suffixMatches[0].href
      : inheritedHref;
  }

  private async loadCover(): Promise<Blob | undefined> {
    try {
      const coverUrl = await this.book?.coverUrl();
      if (!coverUrl) {
        return undefined;
      }
      const response = await fetch(coverUrl);
      return response.ok ? await response.blob() : undefined;
    } catch {
      // Invalid optional artwork must not prevent the publication from opening.
      return undefined;
    }
  }

  private requireRendition(): Rendition {
    if (!this.rendition) {
      throw new Error('The EPUB reader is not mounted');
    }
    return this.rendition;
  }

  private detachContentDocument(document: Document): void {
    document.removeEventListener('keydown', this.handleContentKeydown);
    document.defaultView?.removeEventListener(
      'keydown',
      this.handleContentKeydown,
    );
    for (const target of this.selectionActionTargets(document)) {
      target.removeEventListener('wheel', this.handleContentWheel);
    }
    const selectionHandler = this.contentSelectionHandlers.get(document);
    if (selectionHandler) {
      document.removeEventListener('mouseup', selectionHandler);
      document.removeEventListener('touchend', selectionHandler);
    }
    const selectionChangeHandler =
      this.contentSelectionChangeHandlers.get(document);
    if (selectionChangeHandler) {
      document.removeEventListener('selectionchange', selectionChangeHandler);
    }
    const selectionTimeout = this.contentSelectionTimeouts.get(document);
    if (selectionTimeout) {
      clearTimeout(selectionTimeout);
    }
    const contextMenuHandler = this.contentContextMenuHandlers.get(document);
    if (contextMenuHandler) {
      this.removeSelectionActionHandler(document, contextMenuHandler);
    }
    const linkHandler = this.contentLinkHandlers.get(document);
    if (linkHandler) {
      document.removeEventListener('click', linkHandler, true);
      for (const anchor of document.querySelectorAll('a[href]')) {
        anchor.removeEventListener('click', linkHandler, true);
      }
    }
    const touchNavigationHandlers =
      this.contentTouchNavigationHandlers.get(document);
    if (touchNavigationHandlers) {
      for (const target of this.selectionActionTargets(document)) {
        target.removeEventListener(
          'pointerdown',
          touchNavigationHandlers.pointerDown,
          true,
        );
        target.removeEventListener(
          'pointerup',
          touchNavigationHandlers.pointerUp,
          true,
        );
        target.removeEventListener(
          'pointercancel',
          touchNavigationHandlers.pointerCancel,
          true,
        );
        target.removeEventListener(
          'touchstart',
          touchNavigationHandlers.touchStart,
          true,
        );
        target.removeEventListener(
          'touchend',
          touchNavigationHandlers.touchEnd,
          true,
        );
        target.removeEventListener(
          'touchcancel',
          touchNavigationHandlers.touchCancel,
          true,
        );
      }
    }
    this.contentTouchNavigationStyles.get(document)?.remove();
    this.contentDocuments.delete(document);
    this.contentsByDocument.delete(document);
    this.contentSelectionHandlers.delete(document);
    this.contentSelectionChangeHandlers.delete(document);
    this.contentSelectionTimeouts.delete(document);
    this.contentContextMenuHandlers.delete(document);
    this.contentLinkHandlers.delete(document);
    this.contentTouchNavigationGestures.delete(document);
    this.contentTouchEventNavigationGestures.delete(document);
    this.contentTouchNavigationHandlers.delete(document);
    this.contentTouchNavigationStyles.delete(document);
  }

  private navigateInternalLink(anchor: Element): void {
    const href = publicationHref(anchor).trim();
    if (!href || !this.rendition) {
      return;
    }
    const resolvedHrefValue: unknown = anchor.hasAttribute(
      PUBLICATION_HREF_ATTRIBUTE,
    )
      ? href
      : 'href' in anchor
        ? anchor.href
        : undefined;
    const resolvedHref =
      typeof resolvedHrefValue === 'string' ? resolvedHrefValue : href;
    const target = anchor.hasAttribute(PUBLICATION_HREF_ATTRIBUTE)
      ? href.startsWith('#') && this.locator?.href
        ? `${this.locator.href}${href}`
        : href
      : (this.book?.path?.relative(resolvedHref) ?? href);
    const rendition = this.rendition;
    const targetSection = this.sectionForTarget(target);
    this.prepareSectionTheme(targetSection);
    void rendition
      .display(target)
      .then(async () => {
        if (this.rendition !== rendition) {
          return;
        }
        this.applySectionPresentation(targetSection, rendition);
        this.attachRenditionContentHandlers();
        await this.refreshRenditionLocation(rendition);
      })
      .catch(() => undefined);
  }

  private async refreshRenditionLocation(
    rendition: Rendition,
    notify = true,
    expectedSection?: Section,
  ): Promise<void> {
    // epub.ts resolves reportLocation() after queueing its requestAnimationFrame,
    // not after updating Rendition.location. `display()` can therefore resolve
    // once a new spine document is visible while currentLocation() still
    // describes the previous document (observed in Firefox). Queue one frame
    // behind epub.ts before reading, while the explicit read still covers
    // runtimes that suppress a duplicate relocated event.
    await rendition.reportLocation();
    const view = this.viewport?.ownerDocument.defaultView;
    if (view) {
      await new Promise<void>((resolve) =>
        view.requestAnimationFrame(() => resolve()),
      );
    }
    if (this.rendition === rendition) {
      this.updateLocator(rendition.currentLocation(), notify, expectedSection);
    }
  }

  private updateLocator(
    location: unknown,
    notify: boolean,
    expectedSection?: Section,
  ): void {
    const locator = epubLocationToLocator(location);
    if (!locator) {
      return;
    }
    if (expectedSection?.href) {
      this.pendingExpectedSection = {
        href: expectedSection.href,
        ...(expectedSection.index !== undefined
          ? { index: expectedSection.index }
          : {}),
      };
    }
    const expected = this.pendingExpectedSection;
    if (expected && locator.href === expected.href) {
      this.pendingExpectedSection = null;
    } else if (expected) {
      locator.href = expected.href;
      locator.locations = {
        ...(expected.index !== undefined
          ? { position: expected.index + 1 }
          : {}),
        ...(locator.locations?.totalProgression !== undefined
          ? { totalProgression: locator.locations.totalProgression }
          : {}),
      };
    }

    const cfi = locator.locations?.fragments?.[0];
    const locations = this.book?.locations;
    if (
      cfi &&
      locations &&
      typeof locations.total === 'number' &&
      locations.total > 0
    ) {
      const generatedProgression = locations.percentageFromCfi(cfi);
      if (
        typeof generatedProgression === 'number' &&
        Number.isFinite(generatedProgression) &&
        generatedProgression >= 0 &&
        generatedProgression <= 1
      ) {
        locator.locations = {
          ...locator.locations,
          totalProgression: generatedProgression,
        };
      }
    }
    this.currentPageStatus = epubLocationToPageStatus(location);
    const serializedLocator = JSON.stringify(locator);
    this.locator = locator;
    if (!notify || serializedLocator === this.lastNotifiedLocator) {
      return;
    }
    this.lastNotifiedLocator = serializedLocator;
    for (const listener of this.relocationListeners) {
      listener(locator);
    }
  }

  private async generateBookLocations(book: Book): Promise<void> {
    const locations = book.locations;
    if (!locations || typeof locations.generate !== 'function') {
      return;
    }
    try {
      await locations.generate(EPUB_LOCATION_BREAK_SIZE);
    } catch {
      return;
    }
    if (this.book === book && this.rendition) {
      await this.refreshRenditionLocation(this.rendition);
    }
  }

  private handleFrameLinkTarget(frame: HTMLIFrameElement): boolean {
    const documentUrl = frame.contentDocument?.URL;
    if (!documentUrl) {
      return false;
    }
    let url: URL;
    try {
      url = new URL(documentUrl);
    } catch {
      return false;
    }
    if (
      !url.pathname.endsWith(READER_LINK_TARGET_PATH) ||
      !url.hash.startsWith(`#${READER_LINK_HASH_PREFIX}`)
    ) {
      this.handledFrameLinkTargets.delete(frame);
      return false;
    }
    if (this.handledFrameLinkTargets.get(frame) === url.href) {
      return true;
    }
    this.handledFrameLinkTargets.set(frame, url.href);
    let href: string;
    try {
      href = decodeURIComponent(
        url.hash.slice(READER_LINK_HASH_PREFIX.length + 1),
      );
    } catch {
      return true;
    }
    if (!this.allowedPublicationLinks.has(href)) {
      return true;
    }
    void this.routePublicationLink(href);
    return true;
  }

  private async routePublicationLink(href: string): Promise<void> {
    const rendition = this.rendition;
    if (!rendition) {
      return;
    }
    const link = classifyPublicationLink(href);
    if (link.kind === 'internal') {
      const target =
        href.startsWith('#') && this.locator?.href
          ? `${this.locator.href}${href}`
          : href;
      const targetSection = this.sectionForTarget(target);
      this.prepareSectionTheme(targetSection);
      await rendition.display(target);
      this.applySectionPresentation(targetSection, rendition);
    } else {
      if (this.locator?.href) {
        await rendition.display(this.locator.href);
      }
      if (link.kind === 'external') {
        for (const listener of this.externalLinkRequestListeners) {
          listener(link.url);
        }
      }
    }
    this.attachRenditionContentHandlers();
  }

  private currentSection(location?: unknown): Section | undefined {
    if (!this.book) {
      return undefined;
    }
    const sectionIndex = epubLocationSectionIndex(
      location ?? this.rendition?.currentLocation(),
    );
    if (sectionIndex !== undefined) {
      const indexedSection = this.book.spine.get?.(sectionIndex);
      if (indexedSection) {
        return indexedSection;
      }
    }
    return this.book.spine.get?.(this.locator?.href) ?? undefined;
  }

  private renderedSection(
    rendition: Rendition,
    direction: ReaderNavigationDirection,
  ): Section | undefined {
    const contents = rendition.getContents();
    const rendered =
      direction === 'next' ? contents[contents.length - 1] : contents[0];
    return rendered && Number.isInteger(rendered.sectionIndex)
      ? (this.book?.spine.get?.(rendered.sectionIndex) ?? undefined)
      : undefined;
  }

  private sectionForTarget(target: string): Section | undefined {
    return this.book?.spine.get?.(target) ?? undefined;
  }

  private sectionPresentation(section?: Section): {
    readonly layout: PublicationLayout;
    readonly spread: EpubReaderPreferences['spread'];
    readonly orientation: string;
    readonly flow: AuthoredEpubFlow;
  } {
    const properties = section?.properties ?? [];
    const layoutProperty = renditionProperty(properties, 'layout');
    const spreadProperty = renditionProperty(properties, 'spread');
    const flowProperty = renditionProperty(properties, 'flow');
    return {
      layout:
        layoutProperty === 'pre-paginated'
          ? 'pre-paginated'
          : layoutProperty === 'reflowable'
            ? 'reflowable'
            : this.publicationLayout,
      spread:
        spreadProperty === 'none'
          ? 'none'
          : spreadProperty
            ? 'auto'
            : this.publicationSpread,
      orientation:
        renditionProperty(properties, 'orientation') ??
        this.publicationOrientation,
      flow: flowProperty
        ? authoredEpubFlow(flowProperty)
        : this.publicationFlow,
    };
  }

  private setCurrentSectionPresentation(section?: Section): void {
    const presentation = this.sectionPresentation(section);
    this.currentSectionLayout = presentation.layout;
    this.currentSectionSpread = presentation.spread;
    this.currentSectionOrientation = presentation.orientation;
    this.currentSectionFlow = presentation.flow;
    if (this.viewport) {
      this.viewport.dataset['currentSectionLayout'] = presentation.layout;
      this.updateCurrentSectionFlowDataset();
    }
  }

  private updateCurrentSectionFlowDataset(): void {
    if (this.viewport) {
      this.viewport.dataset['currentSectionFlow'] =
        this.effectiveFlow() === 'scrolled-doc' ? 'scrolled' : 'paginated';
    }
  }

  private prepareSectionTheme(section?: Section): void {
    if (!this.rendition || !section) {
      return;
    }
    const nextLayout = this.sectionPresentation(section).layout;
    if (nextLayout === this.currentSectionLayout) {
      return;
    }
    if (nextLayout === 'pre-paginated') {
      this.rendition.themes.select('default');
      this.setReaderThemeEnabled(false);
    } else {
      this.applyReaderTheme();
    }
  }

  private scheduleSectionPresentation(
    section: Section | undefined,
    rendition: Rendition,
  ): void {
    if (!section) {
      return;
    }
    this.pendingSectionPresentation = { section, rendition };
    if (this.sectionPresentationFrame !== null) {
      return;
    }
    const view = this.viewport?.ownerDocument.defaultView;
    if (!view) {
      this.pendingSectionPresentation = null;
      this.applySectionPresentation(section, rendition);
      return;
    }
    this.sectionPresentationFrame = view.requestAnimationFrame(() => {
      this.sectionPresentationFrame = null;
      const pending = this.pendingSectionPresentation;
      this.pendingSectionPresentation = null;
      if (!pending || this.rendition !== pending.rendition) {
        return;
      }
      this.applySectionPresentation(pending.section, pending.rendition);
    });
  }

  private applySectionPresentation(
    section: Section | undefined,
    rendition: Rendition,
  ): void {
    if (!section) {
      return;
    }
    const presentation = this.sectionPresentation(section);
    const changed =
      presentation.layout !== this.currentSectionLayout ||
      presentation.spread !== this.currentSectionSpread ||
      presentation.orientation !== this.currentSectionOrientation ||
      presentation.flow !== this.currentSectionFlow;
    this.setCurrentSectionPresentation(section);
    if (!changed) {
      return;
    }

    const flow = this.effectiveFlow();
    if (rendition.settings?.flow !== flow) {
      rendition.flow(flow);
    }
    const defaults = rendition.settings?.globalLayoutProperties;
    const layout: GlobalLayout = {
      layout: presentation.layout,
      spread: this.effectiveSpread(),
      orientation: presentation.orientation,
      flow,
      viewport: defaults?.viewport ?? '',
      minSpreadWidth: defaults?.minSpreadWidth ?? 800,
      direction: this.readingDirection,
    };
    rendition.layout(layout);
  }

  private effectiveSpread(): EpubReaderPreferences['spread'] {
    return this.preferences.spread === 'none' ||
      (this.currentSectionLayout === 'pre-paginated' &&
        this.currentSectionSpread === 'none')
      ? 'none'
      : 'auto';
  }

  private effectiveFlow(): 'paginated' | 'scrolled-doc' {
    if (this.preferences.flow === 'paginated') {
      return 'paginated';
    }
    if (this.preferences.flow === 'scrolled') {
      return 'scrolled-doc';
    }
    return this.currentSectionFlow === 'scrolled'
      ? 'scrolled-doc'
      : 'paginated';
  }

  private applyPreferencesToRendition(): void {
    if (!this.rendition) {
      return;
    }
    this.rendition.direction(this.readingDirection);
    if (this.currentSectionLayout === 'pre-paginated') {
      return;
    }
    this.applyReaderTheme();
  }

  private applyReaderTheme(): void {
    if (!this.rendition) {
      return;
    }
    const palette = EPUB_THEME_PALETTES[this.preferences.theme];
    const paginated = this.effectiveFlow() === 'paginated';
    const fontFamily =
      this.preferences.fontFamily === 'sans-serif'
        ? 'system-ui, sans-serif'
        : 'Georgia, serif';
    this.readerThemeCss = `
        body {
          color: ${palette.foreground} !important;
          background-color: ${palette.background} !important;
          box-sizing: border-box;
          margin: ${paginated ? '0' : '0 auto'} !important;
          padding: ${
            paginated ? '0' : `1.25rem ${this.preferences.marginPercent}% 2rem`
          } !important;
          max-width: ${
            paginated ? 'none' : `${this.preferences.maxLineWidthRem}rem`
          } !important;
          font-family: ${fontFamily} !important;
          font-size: ${this.preferences.fontSizePercent}% !important;
          line-height: ${this.preferences.lineHeight} !important;
          overflow-wrap: break-word;
        }
        body p {
          margin-bottom: ${this.preferences.paragraphSpacingRem}rem !important;
        }
        body img,
        body svg,
        body video {
          max-width: 100% !important;
          height: auto !important;
        }
        body table,
        body pre {
          max-width: 100% !important;
          overflow: auto;
        }
      `;
    this.rendition.themes.registerCss('omnia-reader', this.readerThemeCss);
    this.rendition.themes.select('omnia-reader');
    this.setReaderThemeEnabled(true);
  }

  private setReaderThemeEnabled(enabled: boolean): void {
    const documents = new Set(this.contentDocuments);
    for (const contents of this.rendition?.getContents() ?? []) {
      documents.add(contents.document);
    }
    for (const frame of this.viewport?.querySelectorAll('iframe') ?? []) {
      if (frame.contentDocument) {
        documents.add(frame.contentDocument);
      }
    }
    for (const document of documents) {
      this.applyReaderThemeToDocument(document, enabled);
    }
  }

  private applyReaderThemeToDocument(
    document: Document,
    enabled: boolean,
  ): void {
    const existing = document.getElementById(EPUB_READER_THEME_STYLE_ID);
    if (!enabled) {
      existing?.remove();
      document.body?.classList.remove('omnia-reader');
      return;
    }
    if (!document.head) {
      return;
    }
    const style = existing ?? document.createElement('style');
    style.id = EPUB_READER_THEME_STYLE_ID;
    style.textContent = this.readerThemeCss;
    if (!style.isConnected) {
      document.head.append(style);
    }
  }

  private applyAnnotationsToRendition(): void {
    if (!this.rendition) {
      return;
    }
    for (const cfi of this.appliedAnnotationCfis) {
      try {
        this.rendition.annotations.remove(cfi, 'highlight');
      } catch {
        // A stale CFI must not prevent the remaining annotations from rendering.
      }
    }
    this.appliedAnnotationCfis.clear();

    for (const annotation of this.annotations) {
      const cfi = annotation.locator.locations?.fragments?.find((fragment) =>
        fragment.startsWith('epubcfi('),
      );
      if (!cfi) {
        continue;
      }
      try {
        const activateAnnotation: EventListener = (event) => {
          event.preventDefault();
          event.stopPropagation();
          for (const listener of this.annotationActivationListeners) {
            listener(annotation.id);
          }
        };
        const renderedAnnotation = this.rendition.annotations.highlight(
          cfi,
          { annotationId: annotation.id },
          activateAnnotation,
          `omnia-annotation-${annotation.color}`,
          EPUB_ANNOTATION_STYLES[annotation.color],
        );
        const decorateMark = (mark: unknown): void => {
          this.decorateAnnotationMark(mark, annotation, activateAnnotation);
        };
        renderedAnnotation?.on('attach', decorateMark);
        decorateMark(renderedAnnotation?.mark);
        this.appliedAnnotationCfis.add(cfi);
      } catch {
        // Keep a stale or malformed anchor in storage for later repair.
      }
    }
  }

  private decorateAnnotationMark(
    mark: unknown,
    annotation: PublicationAnnotation,
    activate: EventListener,
  ): void {
    const element = (
      mark as
        | {
            element?: Element;
          }
        | null
        | undefined
    )?.element;
    if (!element) {
      return;
    }
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.setAttribute(
      'aria-label',
      annotation.locator.text?.highlight
        ? `Edit highlight: ${annotation.locator.text.highlight.slice(0, 120)}`
        : 'Edit highlight',
    );
    element.addEventListener('contextmenu', activate);
    element.addEventListener('keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
        activate(event);
      }
    });
  }

  private notifySelection(selection: PublicationSelection | null): void {
    for (const listener of this.selectionListeners) {
      listener(selection);
    }
  }

  private captureDocumentSelection(
    document: Document,
    force = false,
  ): PublicationSelection | null {
    const contents = this.contentsByDocument.get(document);
    const selection = document.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const selectionKey = `${range.startOffset}:${range.endOffset}:${range.toString()}`;
    if (
      this.capturedSelectionDocument === document &&
      this.capturedSelectionKey === selectionKey &&
      !force
    ) {
      return null;
    }
    this.capturedSelectionDocument = document;
    this.capturedSelectionKey = selectionKey;
    if (contents) {
      try {
        return this.captureSelectedRange(
          range,
          document,
          contents,
          contents.cfiFromRange(range),
        );
      } catch {
        // A quote remains portable even when a renderer cannot create a CFI.
      }
    }
    return this.captureSelectedRange(range, document, contents);
  }

  private monitorDocumentSelection(document: Document): void {
    const selection = document.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (this.monitoredSelectionDocument === document) {
        this.monitoredSelectionDocument = null;
        this.monitoredSelectionKey = null;
        this.monitoredSelectionSince = 0;
      }
      return;
    }
    const range = selection.getRangeAt(0);
    const selectionKey = `${range.startOffset}:${range.endOffset}:${range.toString()}`;
    if (
      this.monitoredSelectionDocument !== document ||
      this.monitoredSelectionKey !== selectionKey
    ) {
      this.monitoredSelectionDocument = document;
      this.monitoredSelectionKey = selectionKey;
      this.monitoredSelectionSince = Date.now();
      return;
    }
    if (Date.now() - this.monitoredSelectionSince >= 300) {
      this.captureDocumentSelection(document);
    }
  }

  private refreshSelectionActionHandler(document: Document): void {
    const handler = this.contentContextMenuHandlers.get(document);
    if (!handler) {
      return;
    }
    this.removeSelectionActionHandler(document, handler);
    this.installSelectionActionHandler(document, handler);
  }

  private installSelectionActionHandler(
    document: Document,
    handler: EventListener,
  ): void {
    for (const target of this.selectionActionTargets(document)) {
      target.addEventListener('mousedown', handler, true);
      target.addEventListener('contextmenu', handler, true);
    }
  }

  private removeSelectionActionHandler(
    document: Document,
    handler: EventListener,
  ): void {
    for (const target of this.selectionActionTargets(document)) {
      target.removeEventListener('mousedown', handler, true);
      target.removeEventListener('contextmenu', handler, true);
    }
  }

  private selectionActionTargets(document: Document): readonly EventTarget[] {
    return [document, document.documentElement, document.body].filter(
      (target): target is Document | HTMLElement => Boolean(target),
    );
  }

  private attachRenditionContentHandlers(refreshFrameDocuments = false): void {
    for (const contents of this.rendition?.getContents() ?? []) {
      this.handleRenderedContent(contents);
    }
    this.attachFrameHandlers(false, refreshFrameDocuments);
  }

  private attachFrameHandlers(
    captureSelection = false,
    refreshDocuments = false,
  ): void {
    for (const frame of this.viewport?.querySelectorAll('iframe') ?? []) {
      if (!this.contentFrames.has(frame)) {
        const loadHandler = (): void => {
          if (!this.handleFrameLinkTarget(frame) && frame.contentDocument) {
            this.attachContentDocument(frame.contentDocument, undefined, true);
          }
        };
        const selectionActionHandler = (event: Event): void => {
          if (
            event.type === 'mousedown' &&
            (event as MouseEvent).button !== 2
          ) {
            return;
          }
          const document = frame.contentDocument;
          if (!document) {
            return;
          }
          const selection = this.captureDocumentSelection(document, true);
          if (!selection) {
            return;
          }
          event.preventDefault();
          this.notifySelection(selection);
        };
        frame.addEventListener('load', loadHandler);
        frame.addEventListener('mousedown', selectionActionHandler, true);
        frame.addEventListener('contextmenu', selectionActionHandler, true);
        frame.addEventListener('wheel', this.handleContentWheel, {
          passive: false,
        });
        this.contentFrames.set(frame, loadHandler);
        this.contentFrameSelectionActionHandlers.set(
          frame,
          selectionActionHandler,
        );
      }
      if (this.handleFrameLinkTarget(frame)) {
        continue;
      }
      if (frame.contentDocument) {
        this.attachContentDocument(
          frame.contentDocument,
          undefined,
          refreshDocuments,
        );
        if (captureSelection) {
          this.refreshSelectionActionHandler(frame.contentDocument);
          this.monitorDocumentSelection(frame.contentDocument);
        }
      }
    }
  }
}

function resolveEpubRelativePath(
  navigationPath: string,
  target: string,
): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) {
    return '';
  }
  try {
    const root = new URL('https://omnia-reader.invalid/');
    const base = new URL(navigationPath, root);
    const resolved = new URL(target, base);
    return resolved.origin === root.origin
      ? normalizeEpubPath(resolved.pathname)
      : '';
  } catch {
    return '';
  }
}

function normalizeEpubPath(value: string): string {
  try {
    const path = new URL(value, 'https://omnia-reader.invalid/').pathname;
    return decodeURIComponent(path).replace(/^\/+/, '');
  } catch {
    return value.replace(/^\/+/, '');
  }
}

function tocTargetKey(href: string, fragment?: string): string {
  return `${href}#${fragment ?? ''}`;
}

const UNNUMBERED_EPUB_LANDMARK_TYPES = new Set([
  'acknowledgments',
  'afterword',
  'appendix',
  'backmatter',
  'bibliography',
  'colophon',
  'contributors',
  'copyright-page',
  'dedication',
  'epigraph',
  'errata',
  'foreword',
  'frontmatter',
  'glossary',
  'halftitlepage',
  'imprimatur',
  'index',
  'introduction',
  'notes',
  'other-credits',
  'preface',
  'prologue',
  'references',
  'revision-history',
  'titlepage',
]);

const EPUB_THEME_PALETTES = {
  light: { background: '#fffdf9', foreground: '#292524' },
  sepia: { background: '#f4ecd8', foreground: '#4b3621' },
  dark: { background: '#171717', foreground: '#e7e5e4' },
} as const;

const EPUB_ANNOTATION_STYLES = {
  yellow: {
    fill: '#facc15',
    'fill-opacity': '0.42',
    'pointer-events': 'all',
    cursor: 'pointer',
  },
  green: {
    fill: '#4ade80',
    'fill-opacity': '0.38',
    'pointer-events': 'all',
    cursor: 'pointer',
  },
  blue: {
    fill: '#60a5fa',
    'fill-opacity': '0.38',
    'pointer-events': 'all',
    cursor: 'pointer',
  },
  pink: {
    fill: '#f472b6',
    'fill-opacity': '0.38',
    'pointer-events': 'all',
    cursor: 'pointer',
  },
} as const;

function quoteFromRange(
  range: Range,
  document: Document,
): PublicationLocator['text'] | null {
  const highlight = range.toString().trim();
  const body = document.body;
  if (!highlight || highlight.length > 4096 || !body) {
    return null;
  }

  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(body);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = range.cloneRange();
  afterRange.selectNodeContents(body);
  afterRange.setStart(range.endContainer, range.endOffset);
  return {
    before: beforeRange.toString().slice(-256),
    highlight,
    after: afterRange.toString().slice(0, 256),
  };
}

function epubPageGap(viewport: HTMLElement, marginPercent: number): number {
  const width = viewport.clientWidth || 800;
  return Math.round(
    Math.min(96, Math.max(24, (width * marginPercent * 2) / 100)),
  );
}

function renditionProperty(
  properties: readonly string[],
  name: 'flow' | 'layout' | 'orientation' | 'spread',
): string | undefined {
  const prefix = `rendition:${name}-`;
  return properties
    .find((property) => property.startsWith(prefix))
    ?.slice(prefix.length);
}

function authoredEpubFlow(value: string | undefined): AuthoredEpubFlow {
  return value === 'scrolled-doc' || value === 'scrolled-continuous'
    ? 'scrolled'
    : 'paginated';
}

function epubLocationSectionIndex(location: unknown): number | undefined {
  if (!location || typeof location !== 'object') {
    return undefined;
  }
  const start = (location as { start?: unknown }).start;
  if (!start || typeof start !== 'object') {
    return undefined;
  }
  const index = (start as { index?: unknown }).index;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0
    ? index
    : undefined;
}

function sanitizeEpubDocument(
  document: Document,
  allowedLinks: Set<string>,
): void {
  document
    .querySelectorAll(
      'script, iframe, object, embed, applet, portal, fencedframe, meta[http-equiv]',
    )
    .forEach((element) => element.remove());

  for (const link of document.querySelectorAll('link[href]')) {
    const href = link.getAttribute('href') ?? '';
    if (isUnsafePublicationUrl(href) || isRemotePublicationUrl(href)) {
      link.remove();
    }
  }

  for (const style of document.querySelectorAll('style')) {
    const authoredCss = style.textContent ?? '';
    const sanitizedCss = sanitizePublicationCss(authoredCss);
    if (!sanitizedCss.trim()) {
      style.remove();
    } else if (sanitizedCss !== authoredCss) {
      style.textContent = sanitizedCss;
    }
  }

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      if (name === 'style' && containsBlockedCssUrl(attribute.value)) {
        const sanitizedStyle = sanitizePublicationCss(attribute.value);
        if (sanitizedStyle.trim()) {
          element.setAttribute(attribute.name, sanitizedStyle);
        } else {
          element.removeAttribute(attribute.name);
        }
        continue;
      }
      if (
        name.startsWith('on') ||
        DISABLED_NAVIGATION_ATTRIBUTES.has(name) ||
        (URL_ATTRIBUTES.has(name) &&
          (isUnsafePublicationUrl(attribute.value) ||
            (!isPublicationAnchorHref(element, name) &&
              isRemotePublicationUrl(attribute.value))))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  const baseHref =
    document.querySelector('base')?.getAttribute('href') ??
    globalThis.location.href;
  const linkTargetUrl = new URL(READER_LINK_TARGET_PATH, baseHref);
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    allowedLinks.add(href);
    anchor.setAttribute(PUBLICATION_HREF_ATTRIBUTE, href);
    linkTargetUrl.hash = `${READER_LINK_HASH_PREFIX}${encodeURIComponent(href)}`;
    anchor.setAttribute('href', linkTargetUrl.href);
  }
}

function isUnsafePublicationUrl(value: string): boolean {
  const normalized = normalizePublicationUrl(value);
  return (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:text/html') ||
    normalized.startsWith('data:application/xhtml+xml')
  );
}

function isRemotePublicationUrl(value: string): boolean {
  const normalized = normalizePublicationUrl(value);
  return (
    normalized.startsWith('//') ||
    normalized.startsWith('http:') ||
    normalized.startsWith('https:')
  );
}

function normalizePublicationUrl(value: string): string {
  let normalized = '';
  for (const character of value.trim()) {
    if (character.charCodeAt(0) > 0x20) {
      normalized += character;
    }
  }
  return normalized.toLocaleLowerCase();
}

function isPublicationAnchorHref(element: Element, name: string): boolean {
  return name === 'href' && element.localName.toLocaleLowerCase() === 'a';
}

function containsBlockedCssUrl(value: string): boolean {
  const normalized = value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();
  return /(?:url\(|@import(?:url\()?)['"]?(?:\/\/|https?:|javascript:|vbscript:|data:text\/html|data:application\/xhtml\+xml)/.test(
    normalized,
  );
}

export function sanitizePublicationCss(value: string): string {
  const withoutRemoteImports = value.replace(
    /@import\s+(?:url\(\s*)?(?:(['"])(.*?)\1|([^;\s)]+))\s*\)?[^;]*;/giu,
    (statement, _quote: string, quotedUrl: string, unquotedUrl: string) => {
      const url = quotedUrl ?? unquotedUrl ?? '';
      return isBlockedCssResourceUrl(url) ? '' : statement;
    },
  );

  return withoutRemoteImports.replace(
    /url\(\s*(?:(['"])(.*?)\1|([^)]*))\s*\)/giu,
    (token, _quote: string, quotedUrl: string, unquotedUrl: string) => {
      const url = (quotedUrl ?? unquotedUrl ?? '').trim();
      return isBlockedCssResourceUrl(url) ? 'url("data:,")' : token;
    },
  );
}

async function sanitizeEpubStyleResources(book: Book): Promise<void> {
  const resources = book.resources;
  if (
    !resources ||
    !Array.isArray(resources.cssUrls) ||
    !Array.isArray(resources.urls) ||
    !Array.isArray(resources.replacementUrls)
  ) {
    return;
  }

  for (const cssUrl of resources.cssUrls) {
    const resourceIndex = resources.urls.indexOf(cssUrl);
    const replacementUrl = resources.replacementUrls[resourceIndex];
    if (resourceIndex < 0 || !replacementUrl) {
      continue;
    }

    try {
      const authoredCss = isBlockedCssResourceUrl(replacementUrl)
        ? ''
        : await (await fetch(replacementUrl)).text();
      const sanitizedCss = sanitizePublicationCss(authoredCss);
      if (sanitizedCss === authoredCss) {
        continue;
      }
      const sanitizedUrl = URL.createObjectURL(
        new Blob([sanitizedCss], { type: 'text/css' }),
      );
      resources.replacementUrls[resourceIndex] = sanitizedUrl;
      if (replacementUrl.startsWith('blob:')) {
        URL.revokeObjectURL(replacementUrl);
      }
    } catch {
      // CSP remains the final boundary if an optional publication stylesheet
      // cannot be inspected. Rendering the readable chapter takes priority.
    }
  }
}

function isBlockedCssResourceUrl(value: string): boolean {
  return isUnsafePublicationUrl(value) || isRemotePublicationUrl(value);
}

function isDocument(value: unknown): value is Document {
  return (
    typeof value === 'object' &&
    value !== null &&
    'documentElement' in value &&
    typeof (value as { documentElement?: unknown }).documentElement === 'object'
  );
}

const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'data',
  'formaction',
  'href',
  'ping',
  'poster',
  'src',
  'srcset',
  'xlink:href',
]);
const DISABLED_NAVIGATION_ATTRIBUTES = new Set([
  'action',
  'formaction',
  'ping',
]);
const PUBLICATION_HREF_ATTRIBUTE = 'data-omnia-publication-href';
const READER_LINK_TARGET_PATH = '/reader-link-target.html';
const READER_LINK_HASH_PREFIX = 'omnia-link:';

type PublicationLink =
  | { kind: 'internal' }
  | { kind: 'external'; url: string }
  | { kind: 'blocked' };

function closestPublicationAnchor(target: EventTarget | null): Element | null {
  const closest = (
    target as {
      closest?: (selector: string) => Element | null;
    } | null
  )?.closest;
  return typeof closest === 'function' ? closest.call(target, 'a[href]') : null;
}

function publicationHref(anchor: Element): string {
  return (
    anchor.getAttribute(PUBLICATION_HREF_ATTRIBUTE) ??
    anchor.getAttribute('href') ??
    ''
  );
}

function classifyPublicationLink(value: string): PublicationLink {
  const href = value.trim();
  if (!href || href.startsWith('#') || !hasUrlScheme(href)) {
    return { kind: 'internal' };
  }

  try {
    const url = new URL(href.startsWith('//') ? `https:${href}` : href);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? { kind: 'external', url: url.href }
      : { kind: 'blocked' };
  } catch {
    return { kind: 'blocked' };
  }
}

function hasUrlScheme(value: string): boolean {
  return value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function installPublicationLinkHandlers(
  document: Document,
  linkHandler: EventListener,
): void {
  for (const anchor of document.querySelectorAll('a[href]')) {
    anchor.removeAttribute('target');
    anchor.addEventListener('click', linkHandler, true);
    // The rewritten href remains the WebKit-compatible fallback when a
    // recycled srcdoc document drops parent-installed listeners. Avoid an
    // `onclick` property because the publication CSP deliberately rejects all
    // inline event handlers.
  }
}
