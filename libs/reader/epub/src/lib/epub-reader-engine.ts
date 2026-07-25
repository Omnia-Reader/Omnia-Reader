import type {
  Book,
  Contents,
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
  ReaderPreferences,
  SearchResult,
  TocEntry,
} from '@omnia-reader/reader/domain';
import { epubLocationToLocator } from './epub-locator';

export type EpubRuntimeLoader = () => Promise<
  typeof import('@likecoin/epub-ts')
>;

export class EpubReaderEngine implements ReaderEngine {
  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private viewport: HTMLElement | null = null;
  private toc: readonly TocEntry[] = [];
  private locator: PublicationLocator | null = null;
  private readingDirection: PublicationReadingDirection = 'ltr';
  private publicationLayout: PublicationLayout = 'reflowable';
  private publicationSpread: EpubReaderPreferences['spread'] = 'auto';
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
  private readonly relocationListeners = new Set<
    (locator: PublicationLocator) => void
  >();
  private readonly selectionListeners = new Set<
    (selection: PublicationSelection | null) => void
  >();
  private readonly navigationRequestListeners = new Set<
    (direction: ReaderNavigationDirection) => void
  >();
  private readonly externalLinkRequestListeners = new Set<
    (url: string) => void
  >();
  private readonly contentDocuments = new Set<Document>();
  private readonly contentsByDocument = new Map<Document, Contents>();
  private readonly contentFrames = new Map<HTMLIFrameElement, EventListener>();
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
  private readonly contentLinkHandlers = new Map<Document, EventListener>();
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
    this.contentDocuments.add(document);
  };
  private readonly handleContentKeydown = (event: KeyboardEvent): void => {
    const direction = keyboardNavigationDirection(event, this.readingDirection);
    if (!direction) {
      return;
    }
    event.preventDefault();
    for (const listener of this.navigationRequestListeners) {
      listener(direction);
    }
  };
  private readonly handleRelocated = (location: unknown): void => {
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
      this.notifySelection(null);
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
  ): void {
    const quote = quoteFromRange(range, document);
    if (!quote) {
      this.notifySelection(null);
      return;
    }

    this.selectedDocument = document;
    const current = this.currentLocator();
    this.notifySelection({
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
    });
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
    this.book = ePub(bytes);
    this.book.spine.hooks.content.register(this.sanitizeContent);

    const [metadata, navigation] = await Promise.all([
      this.book.loaded.metadata,
      this.book.loaded.navigation,
      this.book.ready,
    ]);
    this.readingDirection = metadata.direction === 'rtl' ? 'rtl' : 'ltr';
    this.publicationLayout =
      metadata.layout === 'pre-paginated' ? 'pre-paginated' : 'reflowable';
    this.publicationSpread = metadata.spread === 'none' ? 'none' : 'auto';
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
    const fixedLayout = this.publicationLayout === 'pre-paginated';
    // `method` is supported by epub.ts at runtime but is missing from its
    // public RenditionOptions declaration.
    const renditionOptions = {
      width: '100%',
      height: '100%',
      manager: 'default',
      method: 'write',
      layout: this.publicationLayout,
      flow: fixedLayout
        ? 'paginated'
        : this.preferences.flow === 'scrolled'
          ? 'scrolled-doc'
          : 'paginated',
      spread: this.effectiveSpread(),
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
    this.applyAnnotationsToRendition();
  }

  async close(): Promise<void> {
    if (this.selectionMonitor) {
      clearInterval(this.selectionMonitor);
      this.selectionMonitor = null;
    }
    this.contentObserver?.disconnect();
    this.contentObserver = null;
    for (const [frame, loadHandler] of this.contentFrames) {
      frame.removeEventListener('load', loadHandler);
    }
    this.contentFrames.clear();
    for (const document of [...this.contentDocuments]) {
      this.detachContentDocument(document);
    }
    this.contentDocuments.clear();
    this.contentsByDocument.clear();
    this.contentSelectionHandlers.clear();
    this.contentSelectionChangeHandlers.clear();
    this.contentSelectionTimeouts.clear();
    this.contentLinkHandlers.clear();
    this.allowedPublicationLinks.clear();
    this.rendition?.off('relocated', this.handleRelocated);
    this.rendition?.off('selected', this.handleSelected);
    this.rendition?.destroy();
    this.book?.destroy();
    this.viewport?.classList.remove('omnia-epub-viewer-container');
    this.viewport?.removeAttribute('role');
    this.viewport?.removeAttribute('aria-label');
    this.viewport?.removeAttribute('data-publication-layout');
    this.viewport?.removeAttribute('dir');
    this.viewport?.replaceChildren();
    this.rendition = null;
    this.book = null;
    this.viewport = null;
    this.toc = [];
    this.locator = null;
    this.readingDirection = 'ltr';
    this.publicationLayout = 'reflowable';
    this.publicationSpread = 'auto';
    this.annotations = [];
    this.appliedAnnotationCfis.clear();
    this.selectedDocument = null;
    this.capturedSelectionDocument = null;
    this.capturedSelectionKey = null;
    this.monitoredSelectionDocument = null;
    this.monitoredSelectionKey = null;
    this.monitoredSelectionSince = 0;
  }

  tableOfContents(): readonly TocEntry[] {
    return this.toc;
  }

  currentLocator(): PublicationLocator | null {
    this.updateLocator(this.rendition?.currentLocation(), false);
    return this.locator;
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

  onNavigationRequested(
    listener: (direction: ReaderNavigationDirection) => void,
  ): () => void {
    this.navigationRequestListeners.add(listener);
    return () => this.navigationRequestListeners.delete(listener);
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
      this.rendition.flow(
        this.publicationLayout === 'pre-paginated'
          ? 'paginated'
          : preferences.flow === 'scrolled'
            ? 'scrolled-doc'
            : 'paginated',
      );
      this.rendition.spread(this.effectiveSpread());
      this.rendition.direction(this.readingDirection);
      this.applyPreferencesToRendition();
      await this.rendition.reportLocation();
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
    await rendition.display(target);
    this.attachRenditionContentHandlers();
    await this.refreshRenditionLocation(rendition);
  }

  async next(): Promise<void> {
    const rendition = this.requireRendition();
    await rendition.next();
    this.attachRenditionContentHandlers();
    await this.refreshRenditionLocation(rendition);
  }

  async previous(): Promise<void> {
    const rendition = this.requireRendition();
    await rendition.prev();
    this.attachRenditionContentHandlers();
    await this.refreshRenditionLocation(rendition);
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
    const linkHandler = this.contentLinkHandlers.get(document);
    if (linkHandler) {
      document.removeEventListener('click', linkHandler, true);
      for (const anchor of document.querySelectorAll('a[href]')) {
        anchor.removeEventListener('click', linkHandler, true);
      }
    }
    this.contentDocuments.delete(document);
    this.contentsByDocument.delete(document);
    this.contentSelectionHandlers.delete(document);
    this.contentSelectionChangeHandlers.delete(document);
    this.contentSelectionTimeouts.delete(document);
    this.contentLinkHandlers.delete(document);
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
    void rendition
      .display(target)
      .then(async () => {
        if (this.rendition !== rendition) {
          return;
        }
        this.attachRenditionContentHandlers();
        await this.refreshRenditionLocation(rendition);
      })
      .catch(() => undefined);
  }

  private async refreshRenditionLocation(
    rendition: Rendition,
    notify = true,
  ): Promise<void> {
    // epub.ts deliberately calculates locations asynchronously. `display()`
    // can resolve once a new spine document is visible while `currentLocation`
    // still describes the previous document (observed in Firefox). Its
    // documented reportLocation() contract completes the calculation and
    // emits `relocated`; the explicit read also covers runtimes that suppress
    // a duplicate event.
    await rendition.reportLocation();
    if (this.rendition === rendition) {
      this.updateLocator(rendition.currentLocation(), notify);
    }
  }

  private updateLocator(location: unknown, notify: boolean): void {
    const locator = epubLocationToLocator(location);
    if (!locator) {
      return;
    }

    const changed = JSON.stringify(locator) !== JSON.stringify(this.locator);
    this.locator = locator;
    if (!notify || !changed) {
      return;
    }
    for (const listener of this.relocationListeners) {
      listener(locator);
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
      await rendition.display(target);
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

  private effectiveSpread(): EpubReaderPreferences['spread'] {
    return this.preferences.spread === 'none' ||
      (this.publicationLayout === 'pre-paginated' &&
        this.publicationSpread === 'none')
      ? 'none'
      : 'auto';
  }

  private applyPreferencesToRendition(): void {
    if (!this.rendition) {
      return;
    }
    this.rendition.direction(this.readingDirection);
    if (this.publicationLayout === 'pre-paginated') {
      return;
    }

    const palette = EPUB_THEME_PALETTES[this.preferences.theme];
    const paginated = this.preferences.flow === 'paginated';
    const fontFamily =
      this.preferences.fontFamily === 'sans-serif'
        ? 'system-ui, sans-serif'
        : 'Georgia, serif';
    this.rendition.themes.registerRules('omnia-reader', {
      'html, body': {
        color: `${palette.foreground} !important`,
        'background-color': `${palette.background} !important`,
      },
      html: {
        'box-sizing': 'border-box',
      },
      body: {
        'box-sizing': 'border-box',
        margin: paginated ? '0 !important' : '0 auto !important',
        padding: paginated
          ? '0 !important'
          : `1.25rem ${this.preferences.marginPercent}% 2rem !important`,
        'max-width': paginated
          ? 'none !important'
          : `${this.preferences.maxLineWidthRem}rem !important`,
        'font-family': `${fontFamily} !important`,
        'font-size': `${this.preferences.fontSizePercent}% !important`,
        'line-height': `${this.preferences.lineHeight} !important`,
        'overflow-wrap': 'break-word',
      },
      p: {
        'margin-bottom': `${this.preferences.paragraphSpacingRem}rem !important`,
      },
      'img, svg, video': {
        'max-width': '100% !important',
        height: 'auto !important',
      },
      'table, pre': {
        'max-width': '100% !important',
        overflow: 'auto',
      },
    });
    this.rendition.themes.select('omnia-reader');
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
        this.rendition.annotations.highlight(
          cfi,
          { annotationId: annotation.id },
          undefined,
          `omnia-annotation-${annotation.color}`,
          EPUB_ANNOTATION_STYLES[annotation.color],
        );
        this.appliedAnnotationCfis.add(cfi);
      } catch {
        // Keep a stale or malformed anchor in storage for later repair.
      }
    }
  }

  private notifySelection(selection: PublicationSelection | null): void {
    for (const listener of this.selectionListeners) {
      listener(selection);
    }
  }

  private captureDocumentSelection(document: Document): void {
    const contents = this.contentsByDocument.get(document);
    const selection = document.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }
    const range = selection.getRangeAt(0);
    const selectionKey = `${range.startOffset}:${range.endOffset}:${range.toString()}`;
    if (
      this.capturedSelectionDocument === document &&
      this.capturedSelectionKey === selectionKey
    ) {
      return;
    }
    this.capturedSelectionDocument = document;
    this.capturedSelectionKey = selectionKey;
    if (contents) {
      try {
        this.captureSelectedRange(
          range,
          document,
          contents,
          contents.cfiFromRange(range),
        );
        return;
      } catch {
        // A quote remains portable even when a renderer cannot create a CFI.
      }
    }
    this.captureSelectedRange(range, document, contents);
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

  private attachRenditionContentHandlers(): void {
    for (const contents of this.rendition?.getContents() ?? []) {
      this.handleRenderedContent(contents);
    }
    this.attachFrameHandlers();
  }

  private attachFrameHandlers(captureSelection = false): void {
    for (const frame of this.viewport?.querySelectorAll('iframe') ?? []) {
      if (!this.contentFrames.has(frame)) {
        const loadHandler = (): void => {
          if (!this.handleFrameLinkTarget(frame) && frame.contentDocument) {
            this.attachContentDocument(frame.contentDocument, undefined, true);
          }
        };
        frame.addEventListener('load', loadHandler);
        this.contentFrames.set(frame, loadHandler);
      }
      if (this.handleFrameLinkTarget(frame)) {
        continue;
      }
      if (frame.contentDocument) {
        this.attachContentDocument(frame.contentDocument);
        if (captureSelection) {
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
  yellow: { fill: '#facc15', 'fill-opacity': '0.42' },
  green: { fill: '#4ade80', 'fill-opacity': '0.38' },
  blue: { fill: '#60a5fa', 'fill-opacity': '0.38' },
  pink: { fill: '#f472b6', 'fill-opacity': '0.38' },
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

function sanitizeEpubDocument(
  document: Document,
  allowedLinks: Set<string>,
): void {
  document
    .querySelectorAll(
      'script, iframe, object, embed, applet, portal, fencedframe, meta[http-equiv]',
    )
    .forEach((element) => element.remove());

  for (const style of document.querySelectorAll('style')) {
    if (containsBlockedCssUrl(style.textContent ?? '')) {
      style.remove();
    }
  }

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      if (
        name.startsWith('on') ||
        DISABLED_NAVIGATION_ATTRIBUTES.has(name) ||
        (URL_ATTRIBUTES.has(name) &&
          (isUnsafePublicationUrl(attribute.value) ||
            (!isPublicationAnchorHref(element, name) &&
              isRemotePublicationUrl(attribute.value)))) ||
        (name === 'style' && containsBlockedCssUrl(attribute.value))
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
