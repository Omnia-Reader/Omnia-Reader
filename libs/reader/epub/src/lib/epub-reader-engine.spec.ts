import type { Book, Contents, Rendition, Section } from '@likecoin/epub-ts';
import {
  BookSource,
  DEFAULT_EPUB_READER_PREFERENCES,
  PublicationAnnotation,
  PublicationSelection,
} from '@omnia-reader/reader/domain';
import {
  EpubReaderEngine,
  sanitizeEpubCover,
  sanitizePublicationCss,
} from './epub-reader-engine';

describe('EPUB publication CSS sanitization', () => {
  it('removes remote imports and neutralizes remote font URLs without dropping local styles', () => {
    const sanitized = sanitizePublicationCss(`
      @import url("https://fonts.googleapis.com/css2?family=Mulish");
      @import/**/url("https://fonts.googleapis.com/css2?family=Mulish");
      @font-face {
        font-family: "Remote";
        src: url(https://fonts.invalid/remote.woff2) format("woff2");
      }
      @font-face {
        font-family: "Embedded";
        src: url("../fonts/embedded.woff2") format("woff2");
      }
      body { color: #222; background-image: url("//tracking.invalid/pixel"); }
    `);

    expect(sanitized).not.toContain('fonts.googleapis.com');
    expect(sanitized).not.toContain('fonts.invalid');
    expect(sanitized).not.toContain('tracking.invalid');
    expect(sanitized).toContain('../fonts/embedded.woff2');
    expect(sanitized).toContain('color: #222');
  });

  it('neutralizes unresolved publication URLs after resource substitution', () => {
    const sanitized = sanitizePublicationCss(
      `
        @font-face {
          font-family: "Embedded";
          src:
            url("blob:http://localhost/font") format("woff2"),
            url("../fonts/unresolved.woff") format("woff"),
            url("res://reader/font.ttf") format("truetype");
        }
        .icon { mask-image: url("#icon"); }
      `,
      { allowRelativeUrls: false },
    );

    expect(sanitized).toContain('blob:http://localhost/font');
    expect(sanitized).toContain('url("#icon")');
    expect(sanitized).not.toContain('../fonts/unresolved.woff');
    expect(sanitized).not.toContain('res://reader/font.ttf');
  });
});

describe('EPUB cover sanitization', () => {
  it('removes external SVG fonts and active resources before cover decoding', async () => {
    const sanitized = await sanitizeEpubCover(
      new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
            <style>
              @import url("https://fonts.googleapis.com/css2?family=Mulish");
              @font-face {
                font-family: Mulish;
                src: url("https://fonts.gstatic.com/s/mulish/font.woff2");
              }
            </style>
            <script>globalThis.compromised = true</script>
            <image href="https://tracking.invalid/cover.png"/>
            <use xlink:href="#safe-shape"/>
            <text onclick="globalThis.compromised = true" style="fill:url(https://tracking.invalid/pattern)">Cover</text>
          </svg>`,
        ],
        { type: 'image/svg+xml' },
      ),
    );
    const content = await readBlobText(sanitized);

    expect(sanitized.type).toBe('image/svg+xml');
    expect(content).not.toContain('fonts.googleapis.com');
    expect(content).not.toContain('fonts.gstatic.com');
    expect(content).not.toContain('tracking.invalid');
    expect(content).not.toContain('<script');
    expect(content).not.toContain('onclick');
    expect(content).toContain('#safe-shape');
  });
});

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}

describe('EpubReaderEngine annotations', () => {
  it('captures a CFI text quote and renders persisted annotation styles', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let sanitizeContent: ((document: Document) => void) | undefined;
    const spineContentHooks = new Set<
      (document: Document, section?: Section) => void | Promise<void>
    >();
    let attachContent: ((contents: Contents) => void) | undefined;
    const annotationElement = globalThis.document.createElementNS(
      'http://www.w3.org/2000/svg',
      'g',
    );
    const renderedMark = {
      element: annotationElement,
      render: vi.fn(),
    };
    const renderedAnnotation = {
      mark: renderedMark,
      on: vi.fn(),
    };
    const highlight = vi.fn((...args: unknown[]) => {
      void args;
      return renderedAnnotation;
    });
    const underline = vi.fn((...args: unknown[]) => {
      void args;
      return renderedAnnotation;
    });
    const remove = vi.fn();
    const locations = {
      total: 100,
      generate: vi.fn().mockResolvedValue([]),
      percentageFromCfi: vi.fn().mockReturnValue(0.42),
      cfiFromPercentage: vi.fn().mockReturnValue('epubcfi(/6/4!/4/2)'),
    };
    const rendition = {
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) =>
        listeners.set(name, listener),
      ),
      off: vi.fn((name: string) => listeners.delete(name)),
      display: vi.fn().mockResolvedValue(undefined),
      currentLocation: vi.fn(() => ({
        href: 'chapter.xhtml',
        cfi: 'epubcfi(/6/2!/4/2)',
        location: 1,
        percentage: 0.1,
        displayed: { page: 1, total: 10 },
      })),
      reportLocation: vi.fn().mockResolvedValue(undefined),
      annotations: { highlight, underline, remove },
      getContents: vi.fn(() => []),
      hooks: {
        content: {
          register: vi.fn((listener: (contents: Contents) => void) => {
            attachContent = listener;
          }),
        },
      },
      themes: {
        registerRules: vi.fn(),
        registerCss: vi.fn(),
        select: vi.fn(),
      },
      flow: vi.fn(),
      spread: vi.fn(),
      direction: vi.fn(),
      _disconnectContainerObserver: vi.fn(),
      destroy: vi.fn(),
    } as unknown as Rendition;
    const book = {
      loaded: {
        metadata: Promise.resolve({
          title: 'EPUB fixture',
          creator: 'Reader',
          direction: 'ltr',
        }),
        navigation: Promise.resolve({ toc: [] }),
      },
      ready: Promise.resolve(),
      locations,
      spine: {
        hooks: {
          content: {
            register: vi.fn(
              (
                listener: (
                  document: Document,
                  section?: Section,
                ) => void | Promise<void>,
              ) => {
                spineContentHooks.add(listener);
                sanitizeContent ??= listener;
              },
            ),
            deregister: vi.fn(
              (
                listener: (
                  document: Document,
                  section?: Section,
                ) => void | Promise<void>,
              ) => spineContentHooks.delete(listener),
            ),
          },
        },
      },
      renderTo: vi.fn(() => rendition),
      coverUrl: vi.fn().mockResolvedValue(null),
      destroy: vi.fn(),
    } as unknown as Book;
    const engine = new EpubReaderEngine(
      async () =>
        ({
          default: () => book,
        }) as unknown as typeof import('@likecoin/epub-ts'),
    );
    await engine.open(source());
    const viewport = globalThis.document.createElement('div');
    globalThis.document.body.append(viewport);
    await engine.mount(viewport);
    expect(rendition._disconnectContainerObserver).toHaveBeenCalled();
    expect(engine.pageStatus()).toEqual({
      current: 1,
      total: 10,
      scope: 'section',
    });
    expect(locations.generate).toHaveBeenCalledWith(150);
    expect(engine.currentLocator()?.locations?.totalProgression).toBe(0.42);
    await engine.goToProgression(0.75);
    expect(locations.cfiFromPercentage).toHaveBeenCalledWith(0.75);
    expect(rendition.display).toHaveBeenLastCalledWith('epubcfi(/6/4!/4/2)');
    await engine.applyPreferences({
      ...DEFAULT_EPUB_READER_PREFERENCES,
      flow: 'scrolled',
    });
    expect(engine.pageStatus()).toBeNull();
    await engine.applyPreferences(DEFAULT_EPUB_READER_PREFERENCES);
    const unsafeDocument =
      globalThis.document.implementation.createHTMLDocument('Unsafe chapter');
    unsafeDocument.body.innerHTML =
      '<script>globalThis.compromised = true</script>' +
      '<iframe src="https://tracking.invalid/frame"></iframe>' +
      '<meta http-equiv="refresh" content="0;url=https://tracking.invalid/refresh">' +
      '<button onclick="globalThis.compromised = true">Unsafe</button>' +
      '<a href="javascript:globalThis.compromised=true">Unsafe link</a>' +
      '<a id="internal" href="chapter-2.xhtml#target">Safe link</a>' +
      '<a id="external" href="https://example.com/reference">External link</a>' +
      '<link id="remote-styles" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Mulish">' +
      '<img id="tracker" src="https://tracking.invalid/pixel.png" srcset="//tracking.invalid/pixel-2.png 2x">' +
      '<form id="form" action="https://tracking.invalid/submit"><button formaction="/submit">Submit</button></form>' +
      '<div id="styled" style="color: red; background:url(https://tracking.invalid/background.png)">Styled</div>' +
      '<style>body { color: black } @import "https://tracking.invalid/publication.css";</style>';
    sanitizeContent?.(unsafeDocument);
    expect(unsafeDocument.querySelector('script')).toBeNull();
    expect(unsafeDocument.querySelector('iframe')).toBeNull();
    expect(
      unsafeDocument.querySelector('meta[http-equiv="refresh"]'),
    ).toBeNull();
    expect(
      unsafeDocument.querySelector('button')?.hasAttribute('onclick'),
    ).toBe(false);
    expect(unsafeDocument.querySelector('a')?.hasAttribute('href')).toBe(false);
    const internalLink = unsafeDocument.querySelector('#internal');
    expect(internalLink?.getAttribute('data-omnia-publication-href')).toBe(
      'chapter-2.xhtml#target',
    );
    expect(internalLink?.getAttribute('href')).toContain(
      '/reader-link-target.html#omnia-link:chapter-2.xhtml%23target',
    );
    expect(internalLink?.hasAttribute('onclick')).toBe(false);
    expect(
      unsafeDocument
        .querySelector('#external')
        ?.getAttribute('data-omnia-publication-href'),
    ).toBe('https://example.com/reference');
    expect(unsafeDocument.querySelector('#tracker')?.hasAttribute('src')).toBe(
      false,
    );
    expect(
      unsafeDocument.querySelector('#tracker')?.hasAttribute('srcset'),
    ).toBe(false);
    expect(unsafeDocument.querySelector('#form')?.hasAttribute('action')).toBe(
      false,
    );
    expect(
      unsafeDocument.querySelector('#form button')?.hasAttribute('formaction'),
    ).toBe(false);
    expect(unsafeDocument.querySelector('#remote-styles')).toBeNull();
    expect(unsafeDocument.querySelector('#styled')?.getAttribute('style')).toBe(
      'color: red; background:url("data:,")',
    );
    expect(unsafeDocument.querySelector('style')?.textContent).toContain(
      'body { color: black }',
    );
    expect(unsafeDocument.querySelector('style')?.textContent).not.toContain(
      'tracking.invalid',
    );
    const navigation: string[] = [];
    const zoom: string[] = [];
    const commands: string[] = [];
    engine.onNavigationRequested((direction) => navigation.push(direction));
    const removeCommandListener = engine.onCommandRequested((command) => {
      commands.push(command);
      return true;
    });
    engine.onZoomRequested((direction) => zoom.push(direction));
    const renderedContents = {
      window: globalThis.window,
      document: globalThis.document,
      cfiFromRange: vi.fn(() => 'epubcfi(/6/2!/4/2,/1:7,/1:25)'),
    } as unknown as Contents;
    attachContent?.(renderedContents);
    globalThis.document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    globalThis.document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    globalThis.document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    const shortcutsEvent = new KeyboardEvent('keydown', {
      key: '?',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    globalThis.document.dispatchEvent(shortcutsEvent);
    globalThis.document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    globalThis.document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        repeat: true,
        bubbles: true,
      }),
    );
    const editor = globalThis.document.createElement('textarea');
    globalThis.document.body.append(editor);
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    );
    const wheelDown = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    globalThis.document.dispatchEvent(wheelDown);
    expect(navigation).toEqual(['next', 'previous', 'next', 'next']);
    expect(commands).toEqual(['shortcuts', 'search']);
    expect(shortcutsEvent.defaultPrevented).toBe(true);
    removeCommandListener();
    const unhandledEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    globalThis.document.dispatchEvent(unhandledEscape);
    expect(unhandledEscape.defaultPrevented).toBe(false);
    expect(wheelDown.defaultPrevented).toBe(true);
    const zoomIn = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
    });
    globalThis.document.dispatchEvent(zoomIn);
    const zoomOut = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: 120,
    });
    globalThis.document.dispatchEvent(zoomOut);
    expect(zoom).toEqual(['in', 'out']);
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(zoomOut.defaultPrevented).toBe(true);
    expect(navigation).toEqual(['next', 'previous', 'next', 'next']);
    dispatchTouchPointer(globalThis.document.body, 'pointerdown', {
      clientX: 180,
      clientY: 80,
    });
    const swipeNext = dispatchTouchPointer(
      globalThis.document.body,
      'pointerup',
      {
        clientX: 70,
        clientY: 84,
      },
    );
    expect(navigation).toEqual(['next', 'previous', 'next', 'next', 'next']);
    expect(swipeNext.defaultPrevented).toBe(true);
    const publicationControl = globalThis.document.createElement('button');
    globalThis.document.body.append(publicationControl);
    dispatchTouchPointer(publicationControl, 'pointerdown', {
      clientX: 180,
      clientY: 80,
    });
    dispatchTouchPointer(publicationControl, 'pointerup', {
      clientX: 70,
      clientY: 84,
    });
    expect(navigation).toHaveLength(5);
    publicationControl.remove();
    dispatchLegacyTouch(globalThis.document.body, 'touchstart', {
      clientX: 180,
      clientY: 80,
    });
    const legacySwipeNext = dispatchLegacyTouch(
      globalThis.document.body,
      'touchend',
      {
        clientX: 70,
        clientY: 84,
      },
    );
    expect(navigation).toHaveLength(6);
    expect(legacySwipeNext.defaultPrevented).toBe(true);

    const selections: Array<PublicationSelection | null> = [];
    engine.onSelection((selection) => selections.push(selection));

    const paragraph = globalThis.document.createElement('p');
    paragraph.textContent = 'Before selected quotation after';
    globalThis.document.body.append(paragraph);
    const range = globalThis.document.createRange();
    range.setStart(paragraph.firstChild as Text, 7);
    range.setEnd(paragraph.firstChild as Text, 25);
    const browserSelection = globalThis.document.getSelection();
    browserSelection?.removeAllRanges();
    browserSelection?.addRange(range);
    globalThis.document.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true }),
    );
    expect(selections).toEqual([]);
    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    paragraph.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);

    const captured = selections[selections.length - 1];
    expect(captured?.locator).toMatchObject({
      href: 'chapter.xhtml',
      locations: {
        fragments: ['epubcfi(/6/2!/4/2,/1:7,/1:25)'],
      },
      text: {
        highlight: 'selected quotation',
      },
    });

    const annotation: PublicationAnnotation = {
      schemaVersion: 1,
      id: 'b14404ee-bb96-43ee-9a63-776da638eabd',
      bookId: `sha256:${'a'.repeat(64)}`,
      format: 'epub',
      deviceId: 'epub-engine-test',
      locator: structuredClone(captured?.locator ?? fallbackLocator()),
      color: 'green',
      createdAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:00.000Z',
    };
    const activatedAnnotations: string[] = [];
    engine.onAnnotationActivated((annotationId) =>
      activatedAnnotations.push(annotationId),
    );
    await engine.setAnnotations([annotation]);

    expect(highlight).toHaveBeenCalledWith(
      'epubcfi(/6/2!/4/2,/1:7,/1:25)',
      { annotationId: annotation.id },
      expect.any(Function),
      'omnia-annotation-green',
      expect.objectContaining({ fill: '#4ade80' }),
    );
    expect(renderedAnnotation.on).toHaveBeenCalledWith(
      'attach',
      expect.any(Function),
    );
    expect(annotationElement.getAttribute('role')).toBe('button');
    expect(annotationElement.getAttribute('tabindex')).toBe('0');
    const activateHighlight = highlight.mock.calls[0]?.[2] as EventListener;
    const activateEvent = new Event('click', { cancelable: true });
    activateHighlight(activateEvent);
    expect(activateEvent.defaultPrevented).toBe(true);
    expect(activatedAnnotations).toEqual([annotation.id]);
    annotationElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
    );
    expect(activatedAnnotations).toEqual([annotation.id, annotation.id]);

    await engine.setAnnotations([
      { ...annotation, style: 'underline', color: 'blue' },
    ]);
    expect(underline).toHaveBeenLastCalledWith(
      'epubcfi(/6/2!/4/2,/1:7,/1:25)',
      { annotationId: annotation.id },
      expect.any(Function),
      'omnia-annotation-blue-underline',
      expect.objectContaining({ stroke: '#2563eb' }),
    );

    const rectangle = globalThis.document.createElementNS(
      'http://www.w3.org/2000/svg',
      'rect',
    );
    rectangle.setAttribute('y', '10');
    rectangle.setAttribute('height', '20');
    const line = globalThis.document.createElementNS(
      'http://www.w3.org/2000/svg',
      'line',
    );
    line.setAttribute('y1', '29');
    line.setAttribute('y2', '29');
    annotationElement.replaceChildren(rectangle, line);
    await engine.setAnnotations([
      { ...annotation, style: 'strikethrough', color: 'pink' },
    ]);
    expect(underline).toHaveBeenLastCalledWith(
      'epubcfi(/6/2!/4/2,/1:7,/1:25)',
      { annotationId: annotation.id },
      expect.any(Function),
      'omnia-annotation-pink-strikethrough',
      expect.objectContaining({ stroke: '#db2777' }),
    );
    expect(line.getAttribute('y1')).toBe('20');
    expect(line.getAttribute('y2')).toBe('20');

    (
      renderedContents.cfiFromRange as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error('CFI conversion is unavailable');
    });
    engine.clearSelection();
    browserSelection?.addRange(range);
    globalThis.document.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true }),
    );
    expect(selections[selections.length - 1]).toBeNull();
    paragraph.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(selections[selections.length - 1]?.locator).toMatchObject({
      href: 'chapter.xhtml',
      text: { highlight: 'selected quotation' },
    });
    expect(
      selections[selections.length - 1]?.locator.locations?.fragments,
    ).toBeUndefined();

    const iframe = globalThis.document.createElement('iframe');
    viewport.append(iframe);
    const frameDocument = iframe.contentDocument;
    if (!frameDocument) {
      throw new Error('Expected an iframe document');
    }
    const frameParagraph = frameDocument.createElement('p');
    frameParagraph.textContent = 'WebKit selection monitor fallback';
    frameDocument.body.append(frameParagraph);
    const frameRange = frameDocument.createRange();
    frameRange.selectNodeContents(frameParagraph);
    const frameSelection = frameDocument.defaultView?.getSelection();
    frameSelection?.removeAllRanges();
    frameSelection?.addRange(frameRange);
    const selectionCountBeforeContextMenu = selections.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(selections).toHaveLength(selectionCountBeforeContextMenu);
    frameParagraph.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(
      () => {
        expect(selections[selections.length - 1]?.locator.text).toMatchObject({
          highlight: 'WebKit selection monitor fallback',
        });
      },
      { timeout: 1_000 },
    );

    engine.clearSelection();
    expect(selections[selections.length - 1]).toBeNull();
    paragraph.remove();
    await engine.close();
    viewport.remove();
  });
});

describe('EpubReaderEngine mixed-layout compatibility', () => {
  it('switches item-level fixed layouts on relocated spine boundaries', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const layout = vi.fn();
    const selectTheme = vi.fn();
    const registerCss = vi.fn();
    const contentDocument =
      globalThis.document.implementation.createHTMLDocument('Mixed layout');
    const contents = {
      document: contentDocument,
      sectionIndex: 0,
    } as unknown as Contents;
    const sections = [
      {
        index: 0,
        href: 'text.xhtml',
        cfiBase: '/6/2',
        properties: [],
      },
      {
        index: 1,
        href: 'painting.xhtml',
        cfiBase: '/6/4',
        properties: [
          'rendition:flow-paginated',
          'rendition:layout-pre-paginated',
          'rendition:orientation-landscape',
          'rendition:spread-none',
        ],
      },
      {
        index: 2,
        href: 'next-text.xhtml',
        cfiBase: '/6/6',
        properties: [],
      },
    ] as Section[];
    sections[0].next = () => sections[1];
    sections[1].prev = () => sections[0];
    sections[1].next = () => sections[2];
    sections[2].prev = () => sections[1];
    const textSectionDocument =
      globalThis.document.implementation.createHTMLDocument('Text section');
    const finalParagraph = textSectionDocument.createElement('p');
    finalParagraph.textContent = 'Last readable text.';
    textSectionDocument.body.append(
      finalParagraph,
      textSectionDocument.createTextNode('\n   '),
    );
    const finalTextLocation = 'epubcfi(/6/2!/4/8/2,:18,:19)';
    sections[0].cfiFromRange = vi.fn((range: Range) => {
      expect(range.toString()).toBe('.');
      return finalTextLocation;
    });

    const locationState: { current: unknown } = { current: undefined };
    const renditionSettings = {
      flow: 'scrolled-doc',
      globalLayoutProperties: {
        layout: 'reflowable',
        spread: 'auto',
        orientation: 'auto',
        flow: 'scrolled-doc',
        viewport: '',
        minSpreadWidth: 800,
        direction: 'ltr',
      },
    };
    const flow = vi.fn((value: string) => {
      renditionSettings.flow = value;
      renditionSettings.globalLayoutProperties.flow = value;
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const previous = vi.fn().mockResolvedValue(undefined);
    const display = vi.fn(async (target?: string) => {
      if (target === finalTextLocation) {
        locationState.current = sectionLocation(0, 'text.xhtml', 4, 4, 4);
        contents.sectionIndex = 0;
      } else if (target?.startsWith('epubcfi(')) {
        locationState.current = sectionLocation(1, 'painting.xhtml');
        contents.sectionIndex = 1;
      }
    });
    const rendition = {
      settings: renditionSettings,
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) =>
        listeners.set(name, listener),
      ),
      off: vi.fn((name: string) => listeners.delete(name)),
      display,
      next,
      prev: previous,
      currentLocation: vi.fn(() => locationState.current),
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      getContents: vi.fn(() => [contents]),
      hooks: { content: { register: vi.fn() } },
      themes: { registerRules: vi.fn(), registerCss, select: selectTheme },
      direction: vi.fn(),
      flow,
      spread: vi.fn(),
      layout,
      reportLocation: vi.fn().mockResolvedValue(undefined),
      _disconnectContainerObserver: vi.fn(),
      destroy: vi.fn(),
    } as unknown as Rendition;
    const renderTo = vi.fn(() => rendition);
    const spineContentHooks = new Set<
      (document: Document, section: Section) => void | Promise<void>
    >();
    const spine = {
      get: vi.fn((target?: string | number) => {
        if (target === undefined) {
          return sections[0];
        }
        if (typeof target === 'number') {
          return sections[target] ?? null;
        }
        const href = target.split('#', 1)[0];
        return sections.find((section) => section.href === href) ?? null;
      }),
      each: vi.fn((callback: (section: Section) => void) =>
        sections.forEach(callback),
      ),
      hooks: {
        content: {
          register: vi.fn(
            (
              callback: (
                document: Document,
                section: Section,
              ) => void | Promise<void>,
            ) => spineContentHooks.add(callback),
          ),
          deregister: vi.fn(
            (
              callback: (
                document: Document,
                section: Section,
              ) => void | Promise<void>,
            ) => spineContentHooks.delete(callback),
          ),
        },
      },
    };
    const book = {
      loaded: {
        metadata: Promise.resolve({
          title: 'Mixed layout fixture',
          creator: 'Reader',
          direction: 'ltr',
          flow: 'scrolled-doc',
        }),
        navigation: Promise.resolve({ toc: [] }),
      },
      ready: Promise.resolve(),
      spine,
      locations: {
        _locations: [
          'epubcfi(/6/2!/4/2/2:0)',
          finalTextLocation,
          'epubcfi(/6/4!/4/2/2:0)',
          'epubcfi(/6/6!/4/2/2:0)',
        ],
        total: 4,
        generate: vi.fn(async () => {
          for (const callback of spineContentHooks) {
            await callback(textSectionDocument, sections[0]);
          }
        }),
        percentageFromCfi: vi.fn().mockReturnValue(0.25),
      },
      renderTo,
      coverUrl: vi.fn().mockResolvedValue(null),
      destroy: vi.fn(),
    } as unknown as Book;
    const engine = new EpubReaderEngine(
      async () =>
        ({
          default: () => book,
        }) as unknown as typeof import('@likecoin/epub-ts'),
    );
    const relocations: string[] = [];
    engine.onRelocated((locator) => relocations.push(locator.href));

    await engine.open(source());
    const viewport = globalThis.document.createElement('div');
    globalThis.document.body.append(viewport);
    await engine.mount(viewport);
    expect(viewport.dataset['currentSectionLayout']).toBe('reflowable');
    expect(viewport.dataset['currentSectionFlow']).toBe('scrolled');
    expect(renderTo).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({ flow: 'scrolled-doc' }),
    );
    expect(engine.pageStatus()).toBeNull();
    expect(
      contentDocument.getElementById('epubjs-inserted-css-omnia-reader'),
    ).not.toBeNull();

    locationState.current = sectionLocation(1, 'painting.xhtml');
    contents.sectionIndex = 1;
    expect(engine.currentLocator()?.href).toBe('painting.xhtml');
    listeners.get('relocated')?.(locationState.current);
    expect(relocations).toEqual(['painting.xhtml']);
    await vi.waitFor(() =>
      expect(viewport.dataset['currentSectionLayout']).toBe('pre-paginated'),
    );
    expect(viewport.dataset['currentSectionFlow']).toBe('paginated');
    expect(rendition.flow).toHaveBeenLastCalledWith('paginated');
    expect(selectTheme).toHaveBeenLastCalledWith('default');
    expect(
      contentDocument.getElementById('epubjs-inserted-css-omnia-reader'),
    ).toBeNull();
    expect(layout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: 'pre-paginated',
        spread: 'none',
        orientation: 'landscape',
      }),
    );

    const paintingReturnTarget =
      engine.currentLocator()?.locations?.fragments?.[0];
    expect(paintingReturnTarget).toMatch(/^epubcfi\(/);
    await engine.previous();
    expect(display).toHaveBeenLastCalledWith(finalTextLocation);
    expect(previous).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(engine.currentLocator()).toMatchObject({
      href: 'text.xhtml',
      locations: { progression: 1 },
    });
    await engine.next();
    expect(display).toHaveBeenLastCalledWith(paintingReturnTarget);
    expect(next).not.toHaveBeenCalled();
    expect(engine.currentLocator()).toMatchObject({ href: 'painting.xhtml' });
    await vi.waitFor(() =>
      expect(viewport.dataset['currentSectionLayout']).toBe('pre-paginated'),
    );

    next.mockClear();
    relocations.length = 0;
    contents.sectionIndex = 2;
    await engine.next();
    expect(rendition.display).toHaveBeenLastCalledWith('next-text.xhtml');
    expect(next).not.toHaveBeenCalled();
    expect(engine.currentLocator()).toMatchObject({
      href: 'next-text.xhtml',
      locations: { position: 3 },
    });
    expect(relocations).toEqual(['next-text.xhtml']);
    await vi.waitFor(() =>
      expect(viewport.dataset['currentSectionLayout']).toBe('reflowable'),
    );
    expect(viewport.dataset['currentSectionFlow']).toBe('scrolled');
    expect(rendition.flow).toHaveBeenLastCalledWith('scrolled-doc');
    expect(selectTheme).toHaveBeenLastCalledWith('omnia-reader');
    expect(
      contentDocument.getElementById('epubjs-inserted-css-omnia-reader'),
    ).not.toBeNull();
    expect(registerCss).toHaveBeenCalled();
    expect(layout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: 'reflowable',
        spread: 'auto',
        orientation: 'auto',
      }),
    );

    await engine.applyPreferences({
      ...DEFAULT_EPUB_READER_PREFERENCES,
      flow: 'paginated',
    });
    expect(viewport.dataset['currentSectionFlow']).toBe('paginated');
    expect(rendition.flow).toHaveBeenLastCalledWith('paginated');
    await engine.applyPreferences(DEFAULT_EPUB_READER_PREFERENCES);
    expect(viewport.dataset['currentSectionFlow']).toBe('scrolled');
    expect(rendition.flow).toHaveBeenLastCalledWith('scrolled-doc');

    await engine.close();
    viewport.remove();
  });
});

describe('EpubReaderEngine publication compatibility', () => {
  it('preserves fixed layout, follows RTL keys, and mediates external links', async () => {
    let attachContent: ((contents: Contents) => void) | undefined;
    const locationState: { current: unknown } = { current: undefined };
    const reportedLocation: { current: unknown } = { current: undefined };
    const direction = vi.fn();
    const registerRules = vi.fn();
    const registerCss = vi.fn();
    const selectTheme = vi.fn();
    const reportLocation = vi.fn(async () => {
      requestAnimationFrame(() => {
        locationState.current = reportedLocation.current;
      });
    });
    const rendition = {
      on: vi.fn(),
      off: vi.fn(),
      display: vi.fn().mockResolvedValue(undefined),
      currentLocation: vi.fn(() => locationState.current),
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      getContents: vi.fn(() => []),
      hooks: {
        content: {
          register: vi.fn((listener: (contents: Contents) => void) => {
            attachContent = listener;
          }),
        },
      },
      themes: {
        registerRules,
        registerCss,
        select: selectTheme,
      },
      direction,
      flow: vi.fn(),
      spread: vi.fn(),
      reportLocation,
      _disconnectContainerObserver: vi.fn(),
      destroy: vi.fn(),
    } as unknown as Rendition;
    const renderTo = vi.fn(() => rendition);
    const book = {
      loaded: {
        metadata: Promise.resolve({
          title: 'Fixed RTL fixture',
          creator: 'Reader',
          direction: 'rtl',
          layout: 'pre-paginated',
          spread: 'none',
        }),
        navigation: Promise.resolve({ toc: [] }),
      },
      ready: Promise.resolve(),
      spine: {
        get: vi.fn((target?: string | number) =>
          target === 'page-2.xhtml'
            ? ({ href: 'page-2.xhtml' } as Section)
            : null,
        ),
        hooks: {
          content: {
            register: vi.fn(),
          },
        },
      },
      renderTo,
      coverUrl: vi.fn().mockResolvedValue(null),
      destroy: vi.fn(),
    } as unknown as Book;
    const engine = new EpubReaderEngine(
      async () =>
        ({
          default: () => book,
        }) as unknown as typeof import('@likecoin/epub-ts'),
    );
    const navigation: string[] = [];
    const externalLinks: string[] = [];
    const relocations: string[] = [];
    engine.onNavigationRequested((request) => navigation.push(request));
    engine.onExternalLinkRequested((url) => externalLinks.push(url));
    engine.onRelocated((locator) => relocations.push(locator.href));

    await expect(engine.open(source())).resolves.toMatchObject({
      readingDirection: 'rtl',
      layout: 'pre-paginated',
    });
    const viewport = globalThis.document.createElement('div');
    globalThis.document.body.append(viewport);
    await engine.mount(viewport);

    reportedLocation.current = {
      href: 'page-2.xhtml',
      cfi: 'epubcfi(/6/4!/4/2)',
      location: 2,
      percentage: 0.5,
      displayed: { page: 1, total: 1 },
    };
    await engine.goTo({
      href: 'page-2.xhtml',
      type: 'application/xhtml+xml',
    });
    expect(engine.currentLocator()).toMatchObject({
      href: 'page-2.xhtml',
      locations: {
        fragments: ['epubcfi(/6/4!/4/2)'],
        position: 2,
        totalProgression: 0.5,
      },
    });
    expect(relocations).toEqual(['page-2.xhtml']);
    expect(reportLocation).toHaveBeenCalled();
    expect(rendition._disconnectContainerObserver).toHaveBeenCalled();

    expect(renderTo).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({
        layout: 'pre-paginated',
        method: 'blobUrl',
        flow: 'paginated',
        spread: 'none',
        direction: 'rtl',
        gap: 0,
        allowScriptedContent: false,
        allowPopups: false,
      }),
    );
    expect(viewport.dataset['publicationLayout']).toBe('pre-paginated');
    expect(viewport.dir).toBe('rtl');
    expect(direction).toHaveBeenCalledWith('rtl');
    expect(registerRules).not.toHaveBeenCalled();
    expect(registerCss).not.toHaveBeenCalled();
    expect(selectTheme).not.toHaveBeenCalled();

    const chapter =
      globalThis.document.implementation.createHTMLDocument('Fixed chapter');
    chapter.body.innerHTML = `
      <a id="internal" href="page-2.xhtml#destination">Internal</a>
      <a id="external" href="https://example.com/reference">External</a>
      <a id="blocked" href="mailto:reader@example.com">Blocked</a>
    `;
    attachContent?.({
      window: chapter.defaultView,
      document: chapter,
    } as unknown as Contents);
    chapter.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    expect(navigation).toEqual(['next']);
    dispatchTouchPointer(chapter.body, 'pointerdown', {
      clientX: 180,
      clientY: 80,
    });
    dispatchTouchPointer(chapter.body, 'pointerup', {
      clientX: 70,
      clientY: 84,
    });
    expect(navigation).toEqual(['next', 'previous']);
    dispatchLegacyTouch(chapter.body, 'touchstart', {
      clientX: 70,
      clientY: 80,
    });
    dispatchLegacyTouch(chapter.body, 'touchend', {
      clientX: 180,
      clientY: 84,
    });
    expect(navigation).toEqual(['next', 'previous', 'next']);
    dispatchTouchPointer(
      chapter.querySelector('#internal') as Element,
      'pointerdown',
      {
        clientX: 180,
        clientY: 80,
      },
    );
    dispatchTouchPointer(
      chapter.querySelector('#internal') as Element,
      'pointerup',
      {
        clientX: 70,
        clientY: 84,
      },
    );
    expect(navigation).toEqual(['next', 'previous', 'next']);

    const internalClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    chapter.querySelector('#internal')?.dispatchEvent(internalClick);
    expect(internalClick.defaultPrevented).toBe(true);
    expect(rendition.display).toHaveBeenLastCalledWith(
      'page-2.xhtml#destination',
    );

    const externalClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    chapter.querySelector('#external')?.dispatchEvent(externalClick);
    expect(externalClick.defaultPrevented).toBe(true);
    expect(externalLinks).toEqual(['https://example.com/reference']);

    const blockedClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    chapter.querySelector('#blocked')?.dispatchEvent(blockedClick);
    expect(blockedClick.defaultPrevented).toBe(true);
    expect(externalLinks).toHaveLength(1);

    await engine.close();
    viewport.remove();
  });
});

describe('EpubReaderEngine table of contents navigation', () => {
  it('resolves fragment targets and maps their progress without reloading sections', async () => {
    const display = vi.fn().mockResolvedValue(undefined);
    const rendition = {
      on: vi.fn(),
      off: vi.fn(),
      display,
      currentLocation: vi.fn(() => undefined),
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      getContents: vi.fn(() => []),
      hooks: { content: { register: vi.fn() } },
      themes: {
        registerRules: vi.fn(),
        registerCss: vi.fn(),
        select: vi.fn(),
      },
      direction: vi.fn(),
      reportLocation: vi.fn().mockResolvedValue(undefined),
      _disconnectContainerObserver: vi.fn(),
      destroy: vi.fn(),
    } as unknown as Rendition;
    const createSection = (href: string, cfiBase: string): Section => {
      return {
        href,
        cfiBase,
        load: vi.fn(),
        cfiFromElement: vi.fn(),
        unload: vi.fn(),
      } as unknown as Section;
    };
    const sections = [
      createSection('Text/chapter-1.xhtml', '/6/2[chapter-1]'),
      createSection('Text/chapter-2.xhtml', '/6/4[chapter-2]'),
      createSection('OPS/Text/chapter-3.xhtml', '/6/6[chapter-3]'),
    ];
    const progressionByCfiBase = new Map([
      ['/6/2[chapter-1]', 0.02],
      ['/6/4[chapter-2]', 0.42],
      ['/6/6[chapter-3]', 0.81],
    ]);
    const locations = {
      total: 100,
      generate: vi.fn().mockResolvedValue([]),
      percentageFromCfi: vi.fn((cfi: string) => {
        const cfiBase = [...progressionByCfiBase.keys()].find((candidate) =>
          cfi.includes(candidate),
        );
        return cfiBase ? (progressionByCfiBase.get(cfiBase) ?? null) : null;
      }),
    };
    const spine = {
      get: vi.fn((target?: string | number) => {
        if (target === undefined) {
          return sections[0];
        }
        const href = String(target).split('#', 1)[0];
        return sections.find((section) => section.href === href) ?? null;
      }),
      each: vi.fn(
        (
          callback: (
            section: Section,
            index: number,
            sections: Section[],
          ) => void,
        ) => sections.forEach(callback),
      ),
      hooks: { content: { register: vi.fn() } },
    };
    const book = {
      loaded: {
        metadata: Promise.resolve({
          title: 'Nested navigation fixture',
          creator: 'Reader',
          direction: 'ltr',
        }),
        navigation: Promise.resolve({
          toc: [
            {
              id: 'preface',
              href: '../Text/chapter-1.xhtml#preface',
              label: 'Preface',
              subitems: [],
            },
            {
              id: 'chapter-one',
              href: '../Text/chapter-1.xhtml#intro',
              label: 'Chapter One',
              subitems: [
                {
                  id: 'chapter-one-details',
                  href: '#details',
                  label: 'Details',
                  subitems: [],
                },
              ],
            },
            {
              id: 'chapter-two',
              href: '/OEBPS/Text/chapter-2.xhtml#part-two',
              label: 'Chapter Two',
              subitems: [],
            },
            {
              id: 'chapter-three',
              href: '../Text/chapter-3.xhtml#appendix',
              label: 'Chapter Three',
              subitems: [],
            },
          ],
          landmarks: [
            {
              href: '../Text/chapter-1.xhtml#preface',
              label: 'Preface',
              type: 'frontmatter preface',
            },
          ],
        }),
      },
      ready: Promise.resolve(),
      packaging: {
        navPath: 'Navigation/toc.xhtml',
        ncxPath: '',
      },
      locations,
      spine,
      renderTo: vi.fn(() => rendition),
      coverUrl: vi.fn().mockResolvedValue(null),
      destroy: vi.fn(),
    } as unknown as Book;
    const engine = new EpubReaderEngine(
      async () =>
        ({
          default: () => book,
        }) as unknown as typeof import('@likecoin/epub-ts'),
    );

    await engine.open(source());
    const [preface, chapterOne, chapterTwo, chapterThree] =
      engine.tableOfContents();
    expect(preface).toMatchObject({
      numbering: 'unnumbered',
      locator: {
        href: 'Text/chapter-1.xhtml',
        locations: { fragments: ['preface'] },
      },
    });
    expect(chapterOne.numbering).toBeUndefined();
    expect(chapterOne.locator).toMatchObject({
      href: 'Text/chapter-1.xhtml',
      locations: { fragments: ['intro'] },
    });
    expect(chapterOne.children?.[0].locator).toMatchObject({
      href: 'Text/chapter-1.xhtml',
      locations: { fragments: ['details'] },
    });
    expect(chapterTwo.locator).toMatchObject({
      href: 'Text/chapter-2.xhtml',
      locations: { fragments: ['part-two'] },
    });
    expect(chapterThree.locator).toMatchObject({
      href: 'OPS/Text/chapter-3.xhtml',
      locations: { fragments: ['appendix'] },
    });

    const viewport = globalThis.document.createElement('div');
    globalThis.document.body.append(viewport);
    await engine.mount(viewport);
    expect(locations.generate).toHaveBeenCalledWith(150);
    for (const section of sections) {
      expect(section.load).not.toHaveBeenCalled();
      expect(section.cfiFromElement).not.toHaveBeenCalled();
      expect(section.unload).not.toHaveBeenCalled();
    }
    const [
      enrichedPreface,
      enrichedChapterOne,
      enrichedChapterTwo,
      enrichedChapterThree,
    ] = engine.tableOfContents();
    expect(enrichedPreface.locator.locations?.totalProgression).toBe(0.02);
    expect(enrichedChapterOne.locator.locations?.totalProgression).toBe(0.02);
    expect(
      enrichedChapterOne.children?.[0].locator.locations?.totalProgression,
    ).toBe(0.02);
    expect(enrichedChapterTwo.locator.locations?.totalProgression).toBe(0.42);
    expect(enrichedChapterThree.locator.locations?.totalProgression).toBe(0.81);

    await engine.goTo(
      enrichedChapterOne.children?.[0].locator ?? enrichedChapterOne.locator,
    );
    await engine.goTo(enrichedChapterTwo.locator);
    await engine.goTo(enrichedChapterThree.locator);

    expect(display).toHaveBeenNthCalledWith(2, 'Text/chapter-1.xhtml#details');
    expect(display).toHaveBeenNthCalledWith(3, 'Text/chapter-2.xhtml#part-two');
    expect(display).toHaveBeenNthCalledWith(
      4,
      'OPS/Text/chapter-3.xhtml#appendix',
    );
    await engine.close();
    viewport.remove();
  });
});

describe('EpubReaderEngine resource readiness', () => {
  it('resets a partially opened book and reports a readable EPUB error', async () => {
    const parsingError = new Error('Missing package document');
    const destroy = vi.fn();
    const book = {
      loaded: {
        metadata: Promise.reject(parsingError),
        navigation: Promise.resolve({ toc: [] }),
      },
      ready: Promise.resolve(),
      spine: {
        hooks: {
          content: {
            register: vi.fn(),
          },
        },
      },
      destroy,
    } as unknown as Book;
    const engine = new EpubReaderEngine(
      async () =>
        ({
          default: () => book,
        }) as unknown as typeof import('@likecoin/epub-ts'),
    );

    await expect(engine.open(source())).rejects.toMatchObject({
      message:
        'This EPUB is damaged or unsupported. Verify the file in another reader or import a repaired copy.',
      cause: parsingError,
    });
    expect(destroy).toHaveBeenCalledOnce();
    await expect(
      engine.mount(globalThis.document.createElement('div')),
    ).rejects.toThrow('Open an EPUB before mounting its reader');
  });

  it('waits for archived CSS and font replacements before opening', async () => {
    let resolveReplacements: (() => void) | undefined;
    const replacementsReady = new Promise<void>((resolve) => {
      resolveReplacements = resolve;
    });
    const book = {
      loaded: {
        metadata: Promise.resolve({
          title: 'Embedded font fixture',
          creator: 'Reader',
          direction: 'ltr',
        }),
        navigation: Promise.resolve({ toc: [] }),
      },
      ready: Promise.resolve(),
      replacementsReady,
      spine: {
        hooks: {
          content: {
            register: vi.fn(),
          },
        },
      },
      coverUrl: vi.fn().mockResolvedValue(null),
      destroy: vi.fn(),
    } as unknown as Book;
    const engine = new EpubReaderEngine(
      async () =>
        ({
          default: () => book,
        }) as unknown as typeof import('@likecoin/epub-ts'),
    );

    const opening = engine.open(source());
    const earlyResult = await Promise.race([
      opening.then(() => 'opened'),
      new Promise<'waiting'>((resolve) =>
        setTimeout(() => resolve('waiting'), 0),
      ),
    ]);

    expect(earlyResult).toBe('waiting');
    resolveReplacements?.();
    await expect(opening).resolves.toMatchObject({
      title: 'Embedded font fixture',
    });
    await engine.close();
  });
});

function source(): BookSource {
  return {
    name: 'fixture.epub',
    mediaType: 'application/epub+zip',
    size: 4,
    open: async () => new Uint8Array([80, 75, 3, 4]).buffer,
  };
}

function fallbackLocator() {
  return {
    href: 'chapter.xhtml',
    type: 'application/xhtml+xml',
    locations: {
      fragments: ['epubcfi(/6/2!/4/2,/1:7,/1:25)'],
    },
    text: { highlight: 'selected quotation' },
  };
}

function sectionLocation(
  index: number,
  href: string,
  page = 1,
  total = 1,
  endPage = page,
) {
  return {
    start: {
      index,
      href,
      cfi: `epubcfi(/6/${index * 2 + 2}!/4/2)`,
      displayed: { page, total },
    },
    end: {
      index,
      href,
      cfi: `epubcfi(/6/${index * 2 + 2}!/4/4)`,
      displayed: { page: endPage, total },
    },
  };
}

function dispatchTouchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointerup',
  coordinates: { clientX: number; clientY: number },
): PointerEvent {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as PointerEvent;
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: coordinates.clientX },
    clientY: { value: coordinates.clientY },
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: 'touch' },
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchLegacyTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchend',
  coordinates: { clientX: number; clientY: number },
): TouchEvent {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as TouchEvent;
  const touch = {
    clientX: coordinates.clientX,
    clientY: coordinates.clientY,
    identifier: 1,
    target,
  } as Touch;
  const activeTouches = type === 'touchstart' ? touchList(touch) : touchList();
  Object.defineProperties(event, {
    changedTouches: { value: touchList(touch) },
    targetTouches: { value: activeTouches },
    touches: { value: activeTouches },
  });
  target.dispatchEvent(event);
  return event;
}

function touchList(...touches: Touch[]): TouchList {
  return Object.assign(touches, {
    item: (index: number) => touches[index] ?? null,
  }) as unknown as TouchList;
}
