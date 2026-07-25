import type { Book, Contents, Rendition, Section } from '@likecoin/epub-ts';
import {
  BookSource,
  PublicationAnnotation,
  PublicationSelection,
} from '@omnia-reader/reader/domain';
import { EpubReaderEngine } from './epub-reader-engine';

describe('EpubReaderEngine annotations', () => {
  it('captures a CFI text quote and renders persisted highlights', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let sanitizeContent: ((document: Document) => void) | undefined;
    let attachContent: ((contents: Contents) => void) | undefined;
    const highlight = vi.fn();
    const remove = vi.fn();
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
      annotations: { highlight, remove },
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
        select: vi.fn(),
      },
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
      spine: {
        hooks: {
          content: {
            register: vi.fn((listener: (document: Document) => void) => {
              sanitizeContent = listener;
            }),
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
      '<img id="tracker" src="https://tracking.invalid/pixel.png" srcset="//tracking.invalid/pixel-2.png 2x">' +
      '<form id="form" action="https://tracking.invalid/submit"><button formaction="/submit">Submit</button></form>' +
      '<div id="styled" style="background:url(https://tracking.invalid/background.png)">Styled</div>' +
      '<style>@import "https://tracking.invalid/publication.css";</style>';
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
    expect(unsafeDocument.querySelector('#styled')?.hasAttribute('style')).toBe(
      false,
    );
    expect(unsafeDocument.querySelector('style')).toBeNull();
    const navigation: string[] = [];
    engine.onNavigationRequested((direction) => navigation.push(direction));
    const renderedContents = {
      window: globalThis.window,
      document: globalThis.document,
      cfiFromRange: vi.fn(() => 'epubcfi(/6/2!/4/2,/1:7,/1:25)'),
    } as unknown as Contents;
    attachContent?.(renderedContents);
    globalThis.document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(navigation).toEqual(['next']);

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
    await engine.setAnnotations([annotation]);

    expect(highlight).toHaveBeenCalledWith(
      'epubcfi(/6/2!/4/2,/1:7,/1:25)',
      { annotationId: annotation.id },
      undefined,
      'omnia-annotation-green',
      expect.objectContaining({ fill: '#4ade80' }),
    );

    (
      renderedContents.cfiFromRange as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => {
      throw new Error('CFI conversion is unavailable');
    });
    engine.clearSelection();
    browserSelection?.addRange(range);
    globalThis.document.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true }),
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

describe('EpubReaderEngine publication compatibility', () => {
  it('preserves fixed layout, follows RTL keys, and mediates external links', async () => {
    let attachContent: ((contents: Contents) => void) | undefined;
    const locationState: { current: unknown } = { current: undefined };
    const reportedLocation: { current: unknown } = { current: undefined };
    const direction = vi.fn();
    const registerRules = vi.fn();
    const selectTheme = vi.fn();
    const reportLocation = vi.fn(async () => {
      locationState.current = reportedLocation.current;
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
        method: 'write',
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
  it('resolves NAV-relative and fragment-only targets to canonical spine hrefs', async () => {
    const display = vi.fn().mockResolvedValue(undefined);
    const rendition = {
      on: vi.fn(),
      off: vi.fn(),
      display,
      currentLocation: vi.fn(() => undefined),
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      getContents: vi.fn(() => []),
      hooks: { content: { register: vi.fn() } },
      themes: { registerRules: vi.fn(), select: vi.fn() },
      direction: vi.fn(),
      reportLocation: vi.fn().mockResolvedValue(undefined),
      _disconnectContainerObserver: vi.fn(),
      destroy: vi.fn(),
    } as unknown as Rendition;
    const sections = [
      { href: 'Text/chapter-1.xhtml' },
      { href: 'Text/chapter-2.xhtml' },
      { href: 'OPS/Text/chapter-3.xhtml' },
    ] as Section[];
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
    await engine.goTo(chapterOne.children?.[0].locator ?? chapterOne.locator);
    await engine.goTo(chapterTwo.locator);
    await engine.goTo(chapterThree.locator);

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
