import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  BookRecord,
  LibraryRepository,
  PublicationAnnotation,
  PublicationSelection,
  ReaderEngine,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { BackNavigationService } from '../../back-navigation.service';
import { ReaderPageComponent } from './reader-page.component';

const BOOK: BookRecord = {
  id: `sha256:${'a'.repeat(64)}`,
  format: 'pdf',
  fileName: 'annotation.pdf',
  mediaType: 'application/pdf',
  size: 4,
  title: 'Annotation fixture',
  authors: [],
  importedAt: '2026-07-25T08:00:00.000Z',
};

describe('ReaderPageComponent annotations', () => {
  it('persists a selected highlight with its note and journals it for sync', async () => {
    const deviceStorage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => deviceStorage.get(key) ?? null,
      setItem: (key: string, value: string) => deviceStorage.set(key, value),
    });
    const callbacks: {
      selection?: (selection: PublicationSelection | null) => void;
      annotationActivation?: (annotationId: string) => void;
      navigation?: (direction: 'previous' | 'next') => void;
      externalLink?: (url: string) => void;
    } = {};
    const setAnnotations = vi.fn().mockResolvedValue(undefined);
    const goToProgression = vi.fn().mockResolvedValue(undefined);
    const engine = {
      open: vi.fn().mockResolvedValue({ title: BOOK.title, authors: [] }),
      mount: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      tableOfContents: () => [
        {
          title: 'Preface',
          numbering: 'unnumbered',
          locator: {
            href: 'preface',
            type: 'application/pdf',
            locations: { position: 1 },
          },
        },
        {
          title: 'Contributors',
          locator: {
            href: 'contributors',
            type: 'application/pdf',
            locations: { position: 1 },
          },
        },
        {
          title: 'Chapter One',
          locator: {
            href: 'chapter-1',
            type: 'application/pdf',
            locations: { position: 1 },
          },
          children: [
            {
              title: 'Introduction',
              locator: {
                href: 'chapter-1',
                type: 'application/pdf',
                locations: { position: 1, fragments: ['introduction'] },
              },
            },
          ],
        },
        {
          title: 'Chapter Two',
          locator: {
            href: 'chapter-2',
            type: 'application/pdf',
            locations: { position: 2 },
          },
        },
      ],
      currentLocator: () => ({
        href: '',
        type: 'application/pdf',
        locations: { position: 1, totalProgression: 0 },
      }),
      pageStatus: () => ({
        current: 1,
        total: 2,
        scope: 'publication' as const,
      }),
      onRelocated: () => () => undefined,
      onSelection: (
        listener: (selection: PublicationSelection | null) => void,
      ) => {
        callbacks.selection = listener;
        return () => {
          delete callbacks.selection;
        };
      },
      onAnnotationActivated: (listener: (annotationId: string) => void) => {
        callbacks.annotationActivation = listener;
        return () => {
          delete callbacks.annotationActivation;
        };
      },
      onNavigationRequested: (
        listener: (direction: 'previous' | 'next') => void,
      ) => {
        callbacks.navigation = listener;
        return () => {
          delete callbacks.navigation;
        };
      },
      onExternalLinkRequested: (listener: (url: string) => void) => {
        callbacks.externalLink = listener;
        return () => {
          delete callbacks.externalLink;
        };
      },
      clearSelection: vi.fn(),
      setAnnotations,
      applyPreferences: vi.fn().mockResolvedValue(undefined),
      goTo: vi.fn().mockResolvedValue(undefined),
      goToProgression,
      next: vi.fn().mockResolvedValue(undefined),
      previous: vi.fn().mockResolvedValue(undefined),
      async *search() {
        yield* [];
      },
      pageNavigation: () => null,
    } satisfies ReaderEngine;
    const saveAnnotation = vi.fn().mockResolvedValue(undefined);
    const repository = {
      getBook: vi.fn().mockResolvedValue(BOOK),
      getBookSource: vi.fn().mockResolvedValue({
        name: BOOK.fileName,
        mediaType: BOOK.mediaType,
        size: BOOK.size,
        open: async () => new Uint8Array([37, 80, 68, 70]).buffer,
      }),
      getProgress: vi.fn().mockResolvedValue(null),
      listBookmarks: vi.fn().mockResolvedValue([]),
      listAnnotations: vi.fn().mockResolvedValue([]),
      getReaderPreferences: vi.fn().mockResolvedValue(null),
      updateMetadata: vi.fn().mockResolvedValue(BOOK),
      saveAnnotation,
      saveProgress: vi.fn().mockResolvedValue(undefined),
    } as unknown as LibraryRepository;
    const journal = {
      append: vi.fn().mockImplementation(async (input) => ({
        ...input,
        id: crypto.randomUUID(),
        revision: 1,
        createdAt: new Date().toISOString(),
      })),
      pending: vi.fn().mockResolvedValue([]),
      acknowledge: vi.fn().mockResolvedValue(undefined),
    } satisfies SyncOperationJournal;
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);

    await TestBed.configureTestingModule({
      imports: [ReaderPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: () => BOOK.id } },
          },
        },
        { provide: LIBRARY_REPOSITORY, useValue: repository },
        {
          provide: ReaderEngineRegistry,
          useValue: { create: vi.fn().mockResolvedValue(engine) },
        },
        { provide: SYNC_OPERATION_JOURNAL, useValue: journal },
        {
          provide: PLATFORM_PORT,
          useValue: {
            kind: 'web',
            onBackground: () => () => undefined,
            openExternalUrl,
          },
        },
        {
          provide: BackNavigationService,
          useValue: {
            registerTransientHandler: () => () => undefined,
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ReaderPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(callbacks.selection).toBeTypeOf('function'));
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="reader-page-status"]')
        ?.textContent,
    ).toContain('Page 1 of 2');
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="reader-overall-progress"]',
      )?.textContent,
    ).toContain('0% of book');
    const progressSlider = fixture.nativeElement.querySelector(
      '[data-testid="reader-progress-slider"]',
    ) as HTMLInputElement;
    expect(progressSlider.getAttribute('aria-valuetext')).toBe('0% of book');
    progressSlider.value = '75';
    progressSlider.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(goToProgression).toHaveBeenCalledWith(0.75));
    const visibleButtonLabels = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].map((button) => button.textContent?.trim());
    expect(visibleButtonLabels).not.toContain('Previous');
    expect(visibleButtonLabels).not.toContain('Next');
    const readerRoot = fixture.nativeElement.querySelector(
      '[data-testid="reader-root"]',
    ) as HTMLElement;
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(readerRoot, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = readerRoot;
        document.dispatchEvent(new Event('fullscreenchange'));
      }),
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      }),
    });
    await fixture.componentInstance.toggleImmersiveMode();
    fixture.detectChanges();
    expect(fixture.componentInstance.immersiveMode).toBe(true);
    expect(readerRoot.dataset['immersiveMode']).toBe('true');
    expect(
      readerRoot.classList.contains('grid-rows-[minmax(0,1fr)_auto]'),
    ).toBe(true);
    expect(
      readerRoot.classList.contains('grid-rows-[auto_minmax(0,1fr)_auto]'),
    ).toBe(false);
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="reader-toolbar"]')
        .classList.contains('absolute'),
    ).toBe(true);
    const readerToolbar = fixture.nativeElement.querySelector(
      '[data-testid="reader-toolbar"]',
    ) as HTMLElement;
    const toolbarReveal = fixture.nativeElement.querySelector(
      '[data-testid="immersive-toolbar-reveal"]',
    ) as HTMLButtonElement;
    expect(fixture.componentInstance.immersiveToolbarRevealed).toBe(false);
    expect(readerToolbar.getAttribute('aria-hidden')).toBe('true');
    expect(toolbarReveal.getAttribute('aria-expanded')).toBe('false');
    toolbarReveal.focus();
    fixture.detectChanges();
    expect(fixture.componentInstance.immersiveToolbarRevealed).toBe(true);
    expect(readerToolbar.hasAttribute('aria-hidden')).toBe(false);
    expect(readerToolbar.classList.contains('translate-y-0')).toBe(true);
    (
      fixture.nativeElement.querySelector(
        '[aria-label="Hide reader controls"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.immersiveToolbarRevealed).toBe(false);
    expect(readerToolbar.getAttribute('aria-hidden')).toBe('true');
    await fixture.componentInstance.toggleImmersiveMode();
    fixture.detectChanges();
    expect(fixture.componentInstance.immersiveMode).toBe(false);
    expect(readerRoot.hasAttribute('data-immersive-mode')).toBe(false);
    expect(
      readerRoot.classList.contains('grid-rows-[auto_minmax(0,1fr)_auto]'),
    ).toBe(true);
    expect(
      fixture.componentInstance.tocItems.map((item) => item.number),
    ).toEqual([null, null, '1', '1.1', '2']);
    expect(
      fixture.componentInstance.visibleTocItems.map((item) => item.number),
    ).toEqual([null, null, '1', '2']);
    const chapterOne = fixture.componentInstance.tocItems[2];
    expect(fixture.componentInstance.isTocItemExpanded(chapterOne)).toBe(false);
    fixture.componentInstance.toggleTocItem(chapterOne);
    expect(
      fixture.componentInstance.visibleTocItems.map((item) => item.number),
    ).toEqual([null, null, '1', '1.1', '2']);
    expect(fixture.componentInstance.isTocItemExpanded(chapterOne)).toBe(true);
    fixture.componentInstance.toggleTocItem(chapterOne);
    expect(
      fixture.componentInstance.visibleTocItems.map((item) => item.number),
    ).toEqual([null, null, '1', '2']);
    expect(fixture.componentInstance.isTocItemExpanded(chapterOne)).toBe(false);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledOnce());
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    await vi.waitFor(() => expect(engine.previous).toHaveBeenCalledOnce());
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(2));
    const viewport = fixture.nativeElement.querySelector(
      '[data-testid="publication-viewport"]',
    ) as HTMLElement;
    const wheelDown = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    viewport.dispatchEvent(wheelDown);
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(3));
    expect(wheelDown.defaultPrevented).toBe(true);
    dispatchTouchPointer(viewport, 'pointerdown', {
      clientX: 180,
      clientY: 80,
    });
    const swipeNext = dispatchTouchPointer(viewport, 'pointerup', {
      clientX: 70,
      clientY: 84,
    });
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(4));
    expect(swipeNext.defaultPrevented).toBe(true);
    dispatchTouchPointer(viewport, 'pointerdown', {
      clientX: 180,
      clientY: 80,
    });
    dispatchTouchPointer(viewport, 'pointerup', {
      clientX: 170,
      clientY: 190,
    });
    await Promise.resolve();
    expect(engine.next).toHaveBeenCalledTimes(4);
    const publicationControl = document.createElement('button');
    viewport.append(publicationControl);
    dispatchTouchPointer(publicationControl, 'pointerdown', {
      clientX: 180,
      clientY: 80,
    });
    dispatchTouchPointer(publicationControl, 'pointerup', {
      clientX: 70,
      clientY: 84,
    });
    await Promise.resolve();
    expect(engine.next).toHaveBeenCalledTimes(4);
    publicationControl.remove();
    dispatchTouchPointer(viewport, 'pointerdown', { clientX: 70, clientY: 80 });
    dispatchTouchPointer(viewport, 'pointerup', { clientX: 180, clientY: 84 });
    await vi.waitFor(() => expect(engine.previous).toHaveBeenCalledTimes(2));
    dispatchLegacyTouch(viewport, 'touchstart', {
      clientX: 180,
      clientY: 80,
    });
    const legacySwipeNext = dispatchLegacyTouch(viewport, 'touchend', {
      clientX: 70,
      clientY: 84,
    });
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(5));
    expect(legacySwipeNext.defaultPrevented).toBe(true);
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    await Promise.resolve();
    expect(engine.previous).toHaveBeenCalledTimes(2);
    callbacks.navigation?.('previous');
    await vi.waitFor(() => expect(engine.previous).toHaveBeenCalledTimes(3));
    input.remove();

    callbacks.externalLink?.('https://example.com/reference');
    fixture.detectChanges();
    expect(fixture.componentInstance.pendingExternalUrl).toBe(
      'https://example.com/reference',
    );
    await fixture.componentInstance.openExternalLink();
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://example.com/reference',
    );

    callbacks.selection?.({
      locator: {
        href: '',
        type: 'application/pdf',
        title: 'Page 1',
        locations: {
          fragments: ['pdf-text=1:0:9', 'pdf-rect=10,20,70,34'],
          position: 1,
        },
        text: { highlight: 'Important' },
      },
    });
    fixture.componentInstance.annotationColor = 'pink';
    fixture.componentInstance.annotationNote = 'Revisit this evidence.';
    callbacks.selection?.({
      locator: {
        href: '',
        type: 'application/pdf',
        title: 'Page 1',
        locations: { position: 1 },
        text: { highlight: 'Important' },
      },
    });
    expect(fixture.componentInstance.annotationColor).toBe('pink');
    expect(fixture.componentInstance.annotationNote).toBe(
      'Revisit this evidence.',
    );
    await fixture.componentInstance.saveAnnotation();
    fixture.detectChanges();

    expect(saveAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: BOOK.id,
        color: 'pink',
        note: 'Revisit this evidence.',
        locator: expect.objectContaining({
          text: { highlight: 'Important' },
        }),
      }),
    );
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'annotation' }),
    );
    expect(setAnnotations).toHaveBeenLastCalledWith([
      expect.objectContaining({ color: 'pink' }),
    ]);
    const storedAnnotation = saveAnnotation.mock.calls[0]?.[0] as
      | PublicationAnnotation
      | undefined;
    expect(storedAnnotation).toBeDefined();
    if (!storedAnnotation) {
      throw new Error('Expected the saved annotation');
    }
    callbacks.annotationActivation?.(storedAnnotation.id);
    fixture.detectChanges();
    const annotationEditor = fixture.nativeElement.querySelector(
      '[role="dialog"][aria-labelledby="annotation-editor-title"]',
    ) as HTMLElement;
    expect(annotationEditor.textContent).toContain('Edit highlight');
    expect(annotationEditor.textContent).toContain('Delete highlight');

    await fixture.componentInstance.removeEditingAnnotation();
    fixture.detectChanges();
    expect(saveAnnotation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: storedAnnotation.id,
        deletedAt: expect.any(String),
      }),
    );
    expect(setAnnotations).toHaveBeenLastCalledWith([]);
    expect(fixture.componentInstance.annotations).toEqual([]);
    expect(fixture.componentInstance.pendingSelection).toBeNull();
    Reflect.deleteProperty(readerRoot, 'requestFullscreen');
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
    fixture.destroy();
    vi.unstubAllGlobals();
  });
});

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
