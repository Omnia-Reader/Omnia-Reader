import { TestBed } from '@angular/core/testing';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  BookRecord,
  LibraryRepository,
  logicalBookFromVariant,
  PublicationAnnotation,
  PublicationLocator,
  PublicationSelection,
  ReaderCommand,
  ReaderEngine,
  ReaderPageStatus,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { BackNavigationService } from '../../back-navigation.service';
import {
  hasBookSyncMetadataChanged,
  ReaderPageComponent,
} from './reader-page.component';

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
  it('treats opened activity as local but detects synchronized metadata changes', () => {
    expect(
      hasBookSyncMetadataChanged(BOOK, {
        ...BOOK,
        lastOpenedAt: '2026-08-02T12:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      hasBookSyncMetadataChanged(BOOK, {
        ...BOOK,
        title: 'Updated publication title',
        lastOpenedAt: '2026-08-02T12:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('persists a selected highlight with its note and journals it for sync', async () => {
    const deviceStorage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => deviceStorage.get(key) ?? null,
      setItem: (key: string, value: string) => deviceStorage.set(key, value),
    });
    const callbacks: {
      selection?: (selection: PublicationSelection | null) => void;
      selectionActionRequest?: (selection: PublicationSelection) => void;
      relocation?: (locator: PublicationLocator) => void;
      annotationActivation?: (annotationId: string) => void;
      navigation?: (direction: 'previous' | 'next') => void;
      command?: (command: ReaderCommand) => void;
      zoom?: (direction: 'in' | 'out') => void;
      externalLink?: (url: string) => void;
    } = {};
    const setAnnotations = vi.fn().mockResolvedValue(undefined);
    const goToProgression = vi.fn().mockResolvedValue(undefined);
    let currentPageStatus: ReaderPageStatus = {
      current: 1,
      total: 2,
      scope: 'publication',
    };
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
            locations: { totalProgression: 0, position: 1 },
          },
          children: [
            {
              title: 'Introduction',
              locator: {
                href: 'chapter-1',
                type: 'application/pdf',
                locations: {
                  totalProgression: 0,
                  position: 1,
                  fragments: ['introduction'],
                },
              },
            },
          ],
        },
        {
          title: '2 Chapter Two',
          locator: {
            href: 'chapter-2',
            type: 'application/pdf',
            locations: {
              fragments: ['chapter-two'],
              totalProgression: 0.37,
              position: 2,
            },
          },
        },
        {
          title: '3. Chapter Three',
          locator: {
            href: 'chapter-3',
            type: 'application/pdf',
            locations: { totalProgression: 0.75, position: 3 },
          },
        },
        {
          title: '4. Chapter Four',
          locator: {
            href: 'chapter-4',
            type: 'application/pdf',
            locations: { totalProgression: 0.9, position: 4 },
          },
        },
        {
          title: '5. Chapter Five',
          locator: {
            href: 'chapter-5',
            type: 'application/pdf',
            locations: { totalProgression: 1, position: 5 },
          },
        },
      ],
      currentLocator: () => ({
        href: '',
        type: 'application/pdf',
        locations: { position: 1, totalProgression: 0 },
      }),
      pageStatus: () => currentPageStatus,
      onRelocated: (listener: (locator: PublicationLocator) => void) => {
        callbacks.relocation = listener;
        return () => {
          delete callbacks.relocation;
        };
      },
      onSelection: (
        listener: (selection: PublicationSelection | null) => void,
      ) => {
        callbacks.selection = listener;
        return () => {
          delete callbacks.selection;
        };
      },
      onSelectionActionRequested: (
        listener: (selection: PublicationSelection) => void,
      ) => {
        callbacks.selectionActionRequest = listener;
        return () => {
          delete callbacks.selectionActionRequest;
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
      onCommandRequested: (listener: (command: ReaderCommand) => boolean) => {
        callbacks.command = listener;
        return () => {
          delete callbacks.command;
        };
      },
      onZoomRequested: (listener: (direction: 'in' | 'out') => void) => {
        callbacks.zoom = listener;
        return () => {
          delete callbacks.zoom;
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
    const healthySource = {
      name: BOOK.fileName,
      mediaType: BOOK.mediaType,
      size: BOOK.size,
      open: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    };
    const openHealthyVariant = vi.fn().mockResolvedValue({
      availability: { status: 'healthy' as const },
      source: healthySource,
    });
    const saveLogicalBookFormatPreference = vi.fn().mockResolvedValue(null);
    const repository = {
      getBook: vi.fn().mockResolvedValue(BOOK),
      getBookSource: vi.fn().mockResolvedValue(healthySource),
      getProgress: vi.fn().mockResolvedValue(null),
      listBookmarks: vi.fn().mockResolvedValue([]),
      listAnnotations: vi.fn().mockResolvedValue([]),
      getReaderPreferences: vi.fn().mockResolvedValue(null),
      findLogicalBookByVariant: vi.fn().mockResolvedValue({
        ...logicalBookFromVariant(BOOK),
        variants: {
          epub: `sha256:${'b'.repeat(64)}`,
          pdf: BOOK.id,
        },
      }),
      openHealthyVariant,
      updateMetadata: vi.fn().mockResolvedValue(BOOK),
      saveAnnotation,
      saveProgress: vi.fn().mockResolvedValue(undefined),
      saveReaderPreferences: vi.fn().mockResolvedValue(undefined),
      saveLogicalBookFormatPreference,
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
    const exportedAnnotationBytes: Uint8Array[] = [];
    const createFileSave = vi.fn().mockResolvedValue({
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          exportedAnnotationBytes.push(chunk.slice());
        },
      }),
    });

    await TestBed.configureTestingModule({
      imports: [ReaderPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: { get: () => BOOK.id },
              queryParamMap: {
                get: (key: string) => (key === 'explicitFormat' ? '1' : null),
              },
            },
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
            supportsStreamingFileSave: true,
            createFileSave,
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

    expect(openHealthyVariant).toHaveBeenCalledWith(BOOK.id);
    expect(openHealthyVariant.mock.invocationCallOrder[0]).toBeLessThan(
      engine.open.mock.invocationCallOrder[0],
    );
    expect(saveLogicalBookFormatPreference).toHaveBeenCalledWith(
      logicalBookFromVariant(BOOK).id,
      'pdf',
      expect.objectContaining({ changeId: expect.stringMatching(/^change:/) }),
    );
    expect(journal.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'book' }),
    );

    const annotationsTrigger = fixture.nativeElement.querySelector(
      '[aria-label="Toggle highlights and notes"]',
    ) as HTMLButtonElement;
    expect(annotationsTrigger.querySelector('mat-icon')?.textContent).toBe(
      'highlight',
    );
    expect(fixture.componentInstance.annotationStyleIcon('highlight')).toBe(
      'highlight',
    );
    const toolbarTooltips = fixture.debugElement
      .queryAll(By.directive(MatTooltip))
      .map((element) => element.injector.get(MatTooltip).message);
    expect(toolbarTooltips).toEqual([
      'Table of contents',
      'Reader actions',
      'Search publication',
      'Bookmarks',
      'Highlights and notes',
      'Reader settings',
      'Keyboard shortcuts',
      'Enter immersive reading mode',
    ]);

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
    expect(progressSlider.hasAttribute('list')).toBe(false);
    progressSlider.value = '75';
    progressSlider.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(goToProgression).toHaveBeenCalledWith(0.75));
    goToProgression.mockClear();
    vi.spyOn(progressSlider, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 300,
      top: 0,
      bottom: 20,
      width: 200,
      height: 20,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    progressSlider.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        button: 0,
        clientX: 219,
        detail: 1,
      }),
    );
    await vi.waitFor(() => expect(goToProgression).toHaveBeenCalledWith(0.6));
    goToProgression.mockClear();
    let releaseFirstProgressSeek!: () => void;
    const firstProgressSeek = new Promise<void>((resolve) => {
      releaseFirstProgressSeek = resolve;
    });
    let activeProgressSeeks = 0;
    let maximumActiveProgressSeeks = 0;
    goToProgression.mockImplementation(async (progression: number) => {
      activeProgressSeeks += 1;
      maximumActiveProgressSeeks = Math.max(
        maximumActiveProgressSeeks,
        activeProgressSeeks,
      );
      if (progression === 0.2) {
        await firstProgressSeek;
      }
      activeProgressSeeks -= 1;
    });
    progressSlider.value = '20';
    progressSlider.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(goToProgression).toHaveBeenCalledWith(0.2));
    expect(progressSlider.disabled).toBe(false);
    progressSlider.value = '80';
    progressSlider.dispatchEvent(new Event('input'));
    progressSlider.value = '10';
    progressSlider.dispatchEvent(new Event('input'));
    expect(goToProgression).toHaveBeenCalledTimes(1);
    releaseFirstProgressSeek();
    await vi.waitFor(() => expect(goToProgression).toHaveBeenCalledWith(0.1));
    expect(goToProgression).toHaveBeenCalledTimes(2);
    expect(maximumActiveProgressSeeks).toBe(1);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.navigationBusy).toBe(false),
    );
    goToProgression.mockRejectedValueOnce(new Error('Seek failed'));
    progressSlider.value = '30';
    progressSlider.dispatchEvent(new Event('input'));
    await vi.waitFor(() =>
      expect(fixture.componentInstance.navigationError).toBe('Seek failed'),
    );
    goToProgression.mockResolvedValue(undefined);
    progressSlider.value = '40';
    progressSlider.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(goToProgression).toHaveBeenCalledWith(0.4));
    await vi.waitFor(() =>
      expect(fixture.componentInstance.navigationError).toBeNull(),
    );
    fixture.detectChanges();
    const progressMilestones = fixture.nativeElement.querySelectorAll(
      '[data-testid="reader-progress-milestone"]',
    );
    expect(progressMilestones.length).toBe(8);
    const firstMilestone = progressMilestones.item(0) as HTMLElement;
    const firstMilestoneDot = firstMilestone.querySelector(
      '.reader-progress-milestone-inner',
    ) as HTMLElement;
    expect(firstMilestoneDot).toBeTruthy();
    expect(
      firstMilestone.querySelector('.reader-progress-milestone-tooltip')
        ?.textContent,
    ).toContain('Beginning');
    expect(firstMilestone.hasAttribute('aria-pressed')).toBe(false);
    expect(firstMilestone.hasAttribute('aria-describedby')).toBe(false);
    const progressMilestoneLabels = Array.from(
      fixture.nativeElement.querySelectorAll(
        '[data-testid="reader-progress-milestone"]',
      ),
      (button: HTMLElement) => button.getAttribute('aria-label') ?? '',
    );
    expect(progressMilestoneLabels).toEqual([
      'Go to Beginning (0% of book)',
      expect.stringMatching(/^Go to Preface /),
      expect.stringMatching(/^Go to Contributors /),
      expect.stringMatching(/^Go to 1 Chapter One /),
      expect.stringMatching(/^Go to 2 Chapter Two /),
      expect.stringMatching(/^Go to 3 Chapter Three /),
      expect.stringMatching(/^Go to 4 Chapter Four /),
      expect.stringMatching(/^Go to 5 Chapter Five /),
    ]);
    const component = fixture.componentInstance as unknown as {
      chapterProgressMilestones: ReadonlyArray<{
        key: string;
        value: number;
        locator: unknown;
      }>;
      getMilestoneLeftPx: (milestone: {
        key: string;
        value: number;
        locator: unknown;
      }) => number;
    };
    vi.spyOn(progressSlider, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 320,
      height: 20,
      top: 0,
      right: 320,
      bottom: 20,
      left: 0,
      toJSON: () => undefined,
    });
    fixture.detectChanges();
    expect(
      component.getMilestoneLeftPx(component.chapterProgressMilestones[0]),
    ).toBe(5);
    expect(
      component.getMilestoneLeftPx(component.chapterProgressMilestones[1]),
    ).toBe(29);
    expect(
      component.getMilestoneLeftPx(component.chapterProgressMilestones[3]),
    ).toBe(77);
    expect(
      component.getMilestoneLeftPx(component.chapterProgressMilestones[7]),
    ).toBe(315);
    const progressionCallsBeforeBeginning = goToProgression.mock.calls.length;
    progressMilestones[0].dispatchEvent(new Event('click'));
    await vi.waitFor(() =>
      expect(goToProgression).toHaveBeenCalledTimes(
        progressionCallsBeforeBeginning + 1,
      ),
    );
    expect(goToProgression).toHaveBeenLastCalledWith(0);
    fixture.detectChanges();
    const internal = component as unknown as {
      manualProgressPercent: number | null;
      pinnedProgressMilestoneKey: string | null;
    };
    expect(internal.manualProgressPercent).toBe(0);
    expect(internal.pinnedProgressMilestoneKey).toBe(
      component.chapterProgressMilestones[0]?.key,
    );
    const firstMilestoneLeft = Number.parseFloat(
      (progressMilestones.item(0) as HTMLElement).style.left,
    );
    const expectedFirstLeft = component.getMilestoneLeftPx(
      component.chapterProgressMilestones[0],
    );
    expect(firstMilestoneLeft).toBeCloseTo(expectedFirstLeft, 4);
    expect(Number(progressSlider.value)).toBeCloseTo(
      component.chapterProgressMilestones[0]?.value,
      2,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(progressMilestones.item(0));
    expect(progressMilestones.item(0)?.getAttribute('aria-current')).toBe(
      'location',
    );
    expect(
      progressMilestones
        .item(0)
        ?.classList.contains('reader-progress-milestone-active'),
    ).toBe(true);
    expect(
      progressMilestones
        .item(0)
        ?.classList.contains('reader-progress-milestone-reached'),
    ).toBe(true);
    const goToCallsBeforePreface = (engine.goTo as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    progressMilestones[1].dispatchEvent(new Event('click'));
    await vi.waitFor(() => {
      const calls = (engine.goTo as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(goToCallsBeforePreface);
      expect(calls[calls.length - 1][0].href).toBe('preface');
    });
    fixture.detectChanges();
    const secondMilestoneLeft = Number.parseFloat(
      (progressMilestones.item(1) as HTMLElement).style.left,
    );
    const expectedSecondLeft = component.getMilestoneLeftPx(
      component.chapterProgressMilestones[1],
    );
    expect(secondMilestoneLeft).toBeCloseTo(expectedSecondLeft, 4);
    expect(Number(progressSlider.value)).toBeCloseTo(
      component.chapterProgressMilestones[1]?.value,
      2,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(progressMilestones.item(1));
    expect(progressMilestones.item(1)?.getAttribute('aria-current')).toBe(
      'location',
    );
    expect(
      progressMilestones
        .item(1)
        ?.classList.contains('reader-progress-milestone-active'),
    ).toBe(true);
    expect(
      progressMilestones[1]?.getAttribute('style')?.includes('left: '),
    ).toBe(true);
    const goToCallsBeforeThirdMilestone = (
      engine.goTo as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    progressMilestones[5].dispatchEvent(new Event('click'));
    await vi.waitFor(() => {
      const calls = (engine.goTo as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(goToCallsBeforeThirdMilestone);
      expect(calls[calls.length - 1][0].href).toBe('chapter-3');
    });
    fixture.detectChanges();
    const thirdMilestoneLeft = Number.parseFloat(
      (progressMilestones.item(5) as HTMLElement).style.left,
    );
    const expectedThirdLeft = component.getMilestoneLeftPx(
      component.chapterProgressMilestones[5],
    );
    expect(thirdMilestoneLeft).toBeCloseTo(expectedThirdLeft, 4);
    expect(Number(progressSlider.value)).toBeCloseTo(
      component.chapterProgressMilestones[5]?.value,
      2,
    );
    expect(document.activeElement).toBe(progressMilestones.item(5));
    expect(progressMilestones.item(5)?.getAttribute('aria-current')).toBe(
      'location',
    );
    expect(
      progressMilestones
        .item(5)
        ?.classList.contains('reader-progress-milestone-active'),
    ).toBe(true);
    const goToCallsBeforeFourthMilestone = (
      engine.goTo as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    progressMilestones[6].dispatchEvent(new Event('click'));
    await vi.waitFor(() => {
      const calls = (engine.goTo as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(goToCallsBeforeFourthMilestone);
      expect(calls[calls.length - 1][0].href).toBe('chapter-4');
    });
    fixture.detectChanges();
    const fourthMilestoneLeft = Number.parseFloat(
      (progressMilestones.item(6) as HTMLElement).style.left,
    );
    const expectedFourthLeft = component.getMilestoneLeftPx(
      component.chapterProgressMilestones[6],
    );
    expect(fourthMilestoneLeft).toBeCloseTo(expectedFourthLeft, 4);
    expect(Number(progressSlider.value)).toBeCloseTo(
      component.chapterProgressMilestones[6]?.value,
      2,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(progressMilestones.item(6));
    expect(progressMilestones.item(6)?.getAttribute('aria-current')).toBe(
      'location',
    );
    expect(
      progressMilestones
        .item(6)
        ?.classList.contains('reader-progress-milestone-active'),
    ).toBe(true);

    currentPageStatus = {
      current: 1,
      total: 3,
      scope: 'section',
    };
    const nextCallsBeforeKeyboard = (engine.next as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    const nextKey = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
    });
    fixture.componentInstance.onDocumentKeydown(nextKey);
    await vi.waitFor(() =>
      expect(engine.next).toHaveBeenCalledTimes(nextCallsBeforeKeyboard + 1),
    );
    await vi.waitFor(() =>
      expect(fixture.componentInstance.navigationBusy).toBe(false),
    );
    expect(nextKey.defaultPrevented).toBe(true);
    callbacks.relocation?.({
      href: 'chapter-2',
      type: 'application/xhtml+xml',
      locations: {
        progression: 1 / 3,
        totalProgression: 0.37,
      },
    });
    fixture.detectChanges();
    expect(progressMilestones.item(4)?.getAttribute('aria-current')).toBe(
      'location',
    );
    expect(
      progressMilestones
        .item(4)
        ?.classList.contains('reader-progress-milestone-active'),
    ).toBe(true);

    currentPageStatus = {
      current: 2,
      total: 3,
      scope: 'section',
    };
    const nextCallsBeforeWheel = (engine.next as ReturnType<typeof vi.fn>).mock
      .calls.length;
    const wheel = new WheelEvent('wheel', {
      deltaY: 100,
      cancelable: true,
    });
    fixture.componentInstance.onPublicationWheel(wheel);
    await vi.waitFor(() =>
      expect(engine.next).toHaveBeenCalledTimes(nextCallsBeforeWheel + 1),
    );
    await vi.waitFor(() =>
      expect(fixture.componentInstance.navigationBusy).toBe(false),
    );
    expect(wheel.defaultPrevented).toBe(true);
    callbacks.relocation?.({
      href: 'chapter-2',
      type: 'application/xhtml+xml',
      locations: {
        progression: 2 / 3,
        position: 2,
        totalProgression: 0.496,
      },
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="reader-progress-milestone"][aria-current="location"]',
      ),
    ).toBeNull();
    expect(
      progressMilestones
        .item(4)
        ?.classList.contains('reader-progress-milestone-active'),
    ).toBe(false);
    expect(
      progressMilestones
        .item(4)
        ?.classList.contains('reader-progress-milestone-reached'),
    ).toBe(true);
    const chapterTwoProgress = component.chapterProgressMilestones[4]?.value;
    expect(chapterTwoProgress).toBe(37);
    expect(fixture.componentInstance.displayedProgressPercent).toBe(49.6);
    expect(Number(progressSlider.value)).toBe(49.6);
    expect(Number(progressSlider.value)).toBeGreaterThan(
      chapterTwoProgress ?? Number.POSITIVE_INFINITY,
    );
    expect(fixture.componentInstance.progressSliderTrackBackground).toContain(
      '49.6%',
    );

    currentPageStatus = {
      current: 1,
      total: 3,
      scope: 'section',
    };
    const previousCallsBeforeKeyboard = (
      engine.previous as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    const previousKey = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      cancelable: true,
    });
    fixture.componentInstance.onDocumentKeydown(previousKey);
    await vi.waitFor(() =>
      expect(engine.previous).toHaveBeenCalledTimes(
        previousCallsBeforeKeyboard + 1,
      ),
    );
    await vi.waitFor(() =>
      expect(fixture.componentInstance.navigationBusy).toBe(false),
    );
    callbacks.relocation?.({
      href: 'chapter-2',
      type: 'application/xhtml+xml',
      locations: {
        progression: 1 / 3,
        totalProgression: 0.37,
      },
    });
    fixture.detectChanges();
    expect(previousKey.defaultPrevented).toBe(true);
    expect(progressMilestones.item(4)?.getAttribute('aria-current')).toBe(
      'location',
    );
    engine.next.mockClear();
    engine.previous.mockClear();
    (
      fixture.componentInstance as unknown as {
        lastWheelNavigationAt: number;
      }
    ).lastWheelNavigationAt = Number.NEGATIVE_INFINITY;

    expect(
      fixture.nativeElement.querySelector('#reader-progress-milestones'),
    ).toBeNull();
    const visibleButtonLabels = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].map((button) => button.textContent?.trim());
    expect(visibleButtonLabels).not.toContain('Previous');
    expect(visibleButtonLabels).not.toContain('Next');
    expect(
      (
        fixture.nativeElement.querySelector(
          '[aria-label="Toggle reader actions"]',
        ) as HTMLButtonElement
      ).classList.contains('sm:!hidden'),
    ).toBe(true);
    expect(
      (
        fixture.nativeElement.querySelector(
          '[aria-label="Open publication search"]',
        ) as HTMLButtonElement
      ).classList.contains('!hidden'),
    ).toBe(true);
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
    ).toEqual([null, null, '1', '1.1', '2', '3', '4', '5']);
    expect(fixture.componentInstance.tocItems[6].displayLabel).toBe(
      '4 Chapter Four',
    );
    expect(
      fixture.componentInstance.visibleTocItems.map((item) => item.number),
    ).toEqual([null, null, '1', '2', '3', '4', '5']);
    const chapterOne = fixture.componentInstance.tocItems[2];
    expect(fixture.componentInstance.isTocItemExpanded(chapterOne)).toBe(false);
    fixture.componentInstance.toggleTocItem(chapterOne);
    expect(
      fixture.componentInstance.visibleTocItems.map((item) => item.number),
    ).toEqual([null, null, '1', '1.1', '2', '3', '4', '5']);
    expect(fixture.componentInstance.isTocItemExpanded(chapterOne)).toBe(true);
    fixture.componentInstance.toggleTocItem(chapterOne);
    expect(
      fixture.componentInstance.visibleTocItems.map((item) => item.number),
    ).toEqual([null, null, '1', '2', '3', '4', '5']);
    expect(fixture.componentInstance.isTocItemExpanded(chapterOne)).toBe(false);

    const chapterFourTocItem = fixture.componentInstance.tocItems[6];
    const chapterFourMilestone =
      fixture.componentInstance.chapterProgressMilestones[6];
    const internalProgressState = fixture.componentInstance as unknown as {
      pinnedProgressMilestoneKey: string | null;
    };
    const goToCallsBeforeTocChapterFour = (
      engine.goTo as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    await fixture.componentInstance.goToTocItem(chapterFourTocItem);
    fixture.detectChanges();
    expect(engine.goTo).toHaveBeenCalledTimes(
      goToCallsBeforeTocChapterFour + 1,
    );
    expect(engine.goTo).toHaveBeenLastCalledWith(
      chapterFourTocItem.entry.locator,
    );
    const progressSliderAfterTocChapterFour =
      fixture.nativeElement.querySelector(
        '[data-testid="reader-progress-slider"]',
      ) as HTMLInputElement;
    expect(Number(progressSliderAfterTocChapterFour.value)).toBeCloseTo(
      chapterFourMilestone?.value ?? 0,
      2,
    );
    expect(internalProgressState.pinnedProgressMilestoneKey).toBe(
      chapterFourMilestone?.key ?? null,
    );

    const chapterOneIntroduction = fixture.componentInstance.tocItems[3];
    const chapterOneMilestone =
      fixture.componentInstance.chapterProgressMilestones[3];
    const goToCallsBeforeIntro = (engine.goTo as ReturnType<typeof vi.fn>).mock
      .calls.length;
    await fixture.componentInstance.goToTocItem(chapterOneIntroduction);
    fixture.detectChanges();
    expect(engine.goTo).toHaveBeenCalledTimes(goToCallsBeforeIntro + 1);
    expect(engine.goTo).toHaveBeenLastCalledWith(
      chapterOneIntroduction.entry.locator,
    );
    const progressSliderAfterIntro = fixture.nativeElement.querySelector(
      '[data-testid="reader-progress-slider"]',
    ) as HTMLInputElement;
    expect(Number(progressSliderAfterIntro.value)).toBeCloseTo(
      chapterOneMilestone?.value ?? 0,
      2,
    );
    expect(internalProgressState.pinnedProgressMilestoneKey).toBe(
      chapterOneMilestone?.key ?? null,
    );

    const chapterFiveTocItem = fixture.componentInstance.tocItems[7];
    const chapterFiveMilestone =
      fixture.componentInstance.chapterProgressMilestones[7];
    const goToCallsBeforeTocChapterFive = (
      engine.goTo as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    await fixture.componentInstance.goToTocItem(chapterFiveTocItem);
    fixture.detectChanges();
    expect(engine.goTo).toHaveBeenCalledTimes(
      goToCallsBeforeTocChapterFive + 1,
    );
    expect(engine.goTo).toHaveBeenLastCalledWith(
      chapterFiveTocItem.entry.locator,
    );
    const progressSliderAfterTocChapterFive =
      fixture.nativeElement.querySelector(
        '[data-testid="reader-progress-slider"]',
      ) as HTMLInputElement;
    expect(Number(progressSliderAfterTocChapterFive.value)).toBeCloseTo(
      chapterFiveMilestone?.value ?? 0,
      2,
    );
    expect(internalProgressState.pinnedProgressMilestoneKey).toBe(
      chapterFiveMilestone?.key ?? null,
    );

    const panelFocusCases = [
      {
        trigger: 'Toggle reader actions',
        panel: 'Reader actions',
        close: 'Close reader actions',
      },
      {
        trigger: 'Toggle table of contents',
        panel: 'Table of contents',
        close: 'Close table of contents',
      },
      {
        trigger: 'Open publication search',
        panel: 'Publication search',
        close: 'Close publication search',
        initialSelector: '#reader-search',
      },
      {
        trigger: 'Open reader settings',
        panel: 'Reader settings',
        close: 'Close reader settings',
      },
      {
        trigger: 'Toggle bookmarks',
        panel: 'Bookmarks',
        close: 'Close bookmarks',
      },
      {
        trigger: 'Toggle highlights and notes',
        panel: 'Highlights and notes',
        close: 'Close highlights and notes',
      },
    ];
    for (const panelCase of panelFocusCases) {
      const trigger = fixture.nativeElement.querySelector(
        `[aria-label="${panelCase.trigger}"]`,
      ) as HTMLButtonElement;
      trigger.click();
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const panel = fixture.nativeElement.querySelector(
        `[aria-label="${panelCase.panel}"]`,
      ) as HTMLElement;
      const expectedFocus = panelCase.initialSelector
        ? (fixture.nativeElement.querySelector(
            panelCase.initialSelector,
          ) as HTMLElement)
        : panel;
      expect(document.activeElement).toBe(expectedFocus);
      (
        fixture.nativeElement.querySelector(
          `[aria-label="${panelCase.close}"]`,
        ) as HTMLButtonElement
      ).click();
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).toBe(trigger);
    }

    const mobileActionsTrigger = fixture.nativeElement.querySelector(
      '[aria-label="Toggle reader actions"]',
    ) as HTMLButtonElement;
    mobileActionsTrigger.click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mobileSettingsAction = [
      ...(
        fixture.nativeElement as HTMLElement
      ).querySelectorAll<HTMLButtonElement>(
        '[data-testid="mobile-reader-actions"] button',
      ),
    ].find((button) => button.textContent?.includes('Reader settings'));
    mobileSettingsAction?.click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fixture.nativeElement.querySelector('[aria-label="Reader settings"]'),
    ).not.toBeNull();
    (
      fixture.nativeElement.querySelector(
        '[aria-label="Close reader settings"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(mobileActionsTrigger);

    const shortcutsTrigger = fixture.nativeElement.querySelector(
      '[aria-label="Open keyboard shortcuts"]',
    ) as HTMLButtonElement;
    shortcutsTrigger.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '?',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shortcutsDialog = fixture.nativeElement.querySelector(
      '[aria-labelledby="reader-keyboard-shortcuts-title"]',
    ) as HTMLElement;
    expect(shortcutsDialog.textContent).toContain('Turn pages');
    expect(shortcutsDialog.textContent).toContain('Open highlights and notes');
    expect(shortcutsDialog.contains(document.activeElement)).toBe(true);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fixture.nativeElement.querySelector(
        '[aria-labelledby="reader-keyboard-shortcuts-title"]',
      ),
    ).toBeNull();
    expect(document.activeElement).toBe(shortcutsTrigger);

    callbacks.command?.('annotations');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[aria-label="Highlights and notes"]',
      ),
    ).not.toBeNull();
    callbacks.command?.('dismiss');
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '[aria-label="Toggle table of contents"]',
      ) as HTMLButtonElement
    ).click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await Promise.resolve();
    expect(engine.next).not.toHaveBeenCalled();
    (
      fixture.nativeElement.querySelector(
        '[aria-label="Close table of contents"]',
      ) as HTMLButtonElement
    ).click();

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
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="reader-zoom-indicator"]',
      ),
    ).toBeNull();
    const zoomIn = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
    });
    vi.useFakeTimers();
    viewport.dispatchEvent(zoomIn);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.applyPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'pdf',
        zoomMode: 'custom',
        zoomPercent: 105,
      }),
    );
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="reader-zoom-indicator"]',
      )?.textContent,
    ).toContain('105%');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="reader-zoom-indicator"]')
        ?.getAttribute('role'),
    ).toBe('status');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="reader-zoom-indicator"]')
        ?.getAttribute('aria-live'),
    ).toBe('polite');
    await vi.advanceTimersByTimeAsync(1_200);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="reader-zoom-indicator"]',
      ),
    ).toBeNull();
    vi.useRealTimers();
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(engine.next).toHaveBeenCalledTimes(3);
    let releaseNavigation: (() => void) | undefined;
    engine.next.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseNavigation = resolve;
        }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(4));
    expect(releaseNavigation).toBeTypeOf('function');
    releaseNavigation?.();
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(5));
    dispatchTouchPointer(viewport, 'pointerdown', {
      clientX: 180,
      clientY: 80,
    });
    const swipeNext = dispatchTouchPointer(viewport, 'pointerup', {
      clientX: 70,
      clientY: 84,
    });
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(6));
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
    expect(engine.next).toHaveBeenCalledTimes(6);
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
    expect(engine.next).toHaveBeenCalledTimes(6);
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
    await vi.waitFor(() => expect(engine.next).toHaveBeenCalledTimes(7));
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
    const nextCallsBeforeConsent = engine.next.mock.calls.length;
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await Promise.resolve();
    expect(engine.next).toHaveBeenCalledTimes(nextCallsBeforeConsent);
    await fixture.componentInstance.openExternalLink();
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://example.com/reference',
    );

    const publicationSelection: PublicationSelection = {
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
    };
    callbacks.selection?.(publicationSelection);
    expect(fixture.componentInstance.pendingSelection).toEqual(
      expect.objectContaining({
        locator: expect.objectContaining({ text: { highlight: 'Important' } }),
      }),
    );
    expect(
      fixture.nativeElement.querySelector(
        '[role="region"][aria-labelledby="annotation-editor-title"]',
      ),
    ).toBeNull();
    const selectionContextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    viewport.dispatchEvent(selectionContextMenu);
    expect(selectionContextMenu.defaultPrevented).toBe(true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[role="region"][aria-labelledby="annotation-editor-title"]',
      )?.textContent,
    ).toContain('New annotation');
    expect(
      fixture.nativeElement.querySelector(
        '[role="region"][aria-labelledby="annotation-editor-title"]',
      )?.textContent,
    ).not.toContain('Annotation tools');
    expect(
      fixture.nativeElement.querySelector(
        '[role="region"][aria-labelledby="annotation-editor-title"]',
      )?.textContent,
    ).not.toContain('Format');
    fixture.componentInstance.cancelAnnotationEditor();
    await Promise.resolve();
    callbacks.selection?.(publicationSelection);
    callbacks.selectionActionRequest?.(publicationSelection);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[role="region"][aria-labelledby="annotation-editor-title"]',
      )?.textContent,
    ).toContain('New annotation');
    let colorSelectionEditor = fixture.nativeElement.querySelector(
      '[role="region"][aria-labelledby="annotation-editor-title"]',
    ) as HTMLElement;
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="reader-toolbar"]')
        ?.contains(colorSelectionEditor),
    ).toBe(true);
    callbacks.selection?.(null);
    await Promise.resolve();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="annotation-dashboard"]',
      ),
    ).toBeNull();
    callbacks.selection?.(publicationSelection);
    callbacks.selectionActionRequest?.(publicationSelection);
    fixture.detectChanges();
    colorSelectionEditor = fixture.nativeElement.querySelector(
      '[role="region"][aria-labelledby="annotation-editor-title"]',
    ) as HTMLElement;
    const formattingButton = (label: string): HTMLButtonElement => {
      const button = colorSelectionEditor.querySelector(
        `button[aria-label="${label}"]`,
      );
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`Missing ${label} annotation formatting button`);
      }
      return button;
    };
    const colorTrigger = (label: string): HTMLButtonElement => {
      const button = colorSelectionEditor.querySelector(
        `button[aria-label^="${label} color:"]`,
      );
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`Missing ${label} annotation color button`);
      }
      return button;
    };
    const paletteColor = (
      formatLabel: string,
      colorLabel: string,
    ): HTMLButtonElement => {
      const button = globalThis.document.querySelector(
        `button[aria-label="${colorLabel} ${formatLabel.toLocaleLowerCase()} color"]`,
      );
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(
          `Missing ${colorLabel} ${formatLabel.toLocaleLowerCase()} color`,
        );
      }
      return button;
    };
    const chooseColor = (formatLabel: string, colorLabel: string): void => {
      colorTrigger(formatLabel).click();
      fixture.detectChanges();
      paletteColor(formatLabel, colorLabel).click();
      fixture.detectChanges();
    };
    const highlightButton = formattingButton('Highlight');
    const underlineButton = formattingButton('Underline');
    expect(formattingButton('Strikethrough')).toBeDefined();
    expect(highlightButton.getAttribute('aria-pressed')).toBe('false');
    expect(highlightButton.classList).not.toContain('bg-[#d9eaf7]');
    const highlightColor = colorTrigger('Highlight');
    const underlineColor = colorTrigger('Underline');
    const strikethroughColor = colorTrigger('Strikethrough');
    const highlightControl = colorSelectionEditor.querySelector(
      '[data-testid="annotation-highlight-control"]',
    ) as HTMLElement;
    expect(highlightControl.querySelectorAll(':scope > button')).toHaveLength(
      2,
    );
    expect(
      highlightControl.querySelector(
        'button[aria-label^="Highlight color:"] > span',
      ),
    ).toBeNull();
    expect(
      highlightControl.querySelectorAll(
        '[data-testid="annotation-color-chevron"]',
      ),
    ).toHaveLength(1);
    expect(
      highlightControl.querySelector(
        'button[aria-label^="Highlight color:"] mat-icon',
      ),
    ).toBeNull();
    expect(
      highlightControl.querySelector('svg path[stroke="#F0E442"]'),
    ).not.toBeNull();
    highlightButton.focus();
    highlightButton.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(globalThis.document.activeElement).toBe(highlightColor);
    expect(highlightColor.getAttribute('aria-label')).toBe(
      'Highlight color: Yellow',
    );
    expect(underlineColor.getAttribute('aria-label')).toBe(
      'Underline color: Sky blue',
    );
    expect(strikethroughColor.getAttribute('aria-label')).toBe(
      'Strikethrough color: Vermilion',
    );
    const noteButton = colorSelectionEditor.querySelector(
      'button[aria-controls="annotation-note"]',
    ) as HTMLButtonElement;
    expect(noteButton.getAttribute('aria-expanded')).toBe('false');
    expect(colorSelectionEditor.querySelector('#annotation-note')).toBeNull();
    noteButton.click();
    fixture.detectChanges();
    expect(noteButton.getAttribute('aria-expanded')).toBe('true');
    expect(
      colorSelectionEditor.querySelector('#annotation-note'),
    ).not.toBeNull();
    highlightColor.click();
    fixture.detectChanges();
    expect(
      Array.from(
        globalThis.document.querySelectorAll(
          'button[aria-label$="highlight color"]',
        ),
        (button) => button.getAttribute('aria-label'),
      ),
    ).toEqual(
      expect.arrayContaining([
        'Orange highlight color',
        'Sky blue highlight color',
        'Bluish green highlight color',
        'Yellow highlight color',
        'Dark blue highlight color',
        'Vermilion highlight color',
        'Purple highlight color',
        'Brown highlight color',
        'Gray highlight color',
      ]),
    );
    expect(
      globalThis.document.querySelectorAll(
        'button[aria-label$="highlight color"]',
      ),
    ).toHaveLength(9);
    expect(
      globalThis.document.querySelector(
        'button[aria-label="Black highlight color"]',
      ),
    ).toBeNull();
    expect(
      paletteColor('Highlight', 'Yellow').querySelector('mat-icon'),
    ).toBeNull();
    highlightColor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    expect(
      globalThis.document.querySelector(
        '[aria-label="Highlight color palette"]',
      ),
    ).toBeNull();
    highlightColor.click();
    fixture.detectChanges();
    expect(highlightColor.disabled).toBe(false);
    expect(underlineColor.disabled).toBe(false);
    const customHighlightColor =
      globalThis.document.querySelector<HTMLInputElement>(
        'input[aria-label="Custom highlight color"]',
      );
    expect(customHighlightColor?.value).toBe('#f0e442');
    if (!customHighlightColor) {
      throw new Error('Missing custom highlight color picker');
    }
    customHighlightColor.value = '#123456';
    customHighlightColor.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(highlightColor.getAttribute('aria-label')).toBe(
      'Highlight color: Custom #123456',
    );
    paletteColor('Highlight', 'Purple').click();
    fixture.detectChanges();
    expect(underlineColor.disabled).toBe(false);
    expect(strikethroughColor.disabled).toBe(false);
    underlineColor.click();
    fixture.detectChanges();
    expect(paletteColor('Underline', 'Black')).toBeDefined();
    paletteColor('Underline', 'Dark blue').click();
    fixture.detectChanges();
    chooseColor('Strikethrough', 'Vermilion');
    expect(highlightColor.getAttribute('aria-label')).toBe(
      'Highlight color: Purple',
    );
    expect(underlineColor.getAttribute('aria-label')).toBe(
      'Underline color: Dark blue',
    );
    expect(strikethroughColor.getAttribute('aria-label')).toBe(
      'Strikethrough color: Vermilion',
    );
    const styleAutosave = vi
      .spyOn(fixture.componentInstance, 'saveAnnotation')
      .mockResolvedValue();
    underlineButton.click();
    await vi.waitFor(() => expect(styleAutosave).toHaveBeenCalledOnce());
    styleAutosave.mockRestore();
    fixture.componentInstance.annotationStyles = new Set();
    fixture.detectChanges();
    fixture.componentInstance.annotationNote = 'Revisit this evidence.';
    fixture.componentInstance.annotationStyles = new Set([
      'highlight',
      'underline',
      'strikethrough',
    ]);
    expect(fixture.componentInstance.annotationNote).toBe(
      'Revisit this evidence.',
    );
    const shortcutSave = vi
      .spyOn(fixture.componentInstance, 'saveAnnotation')
      .mockResolvedValue();
    const saveShortcut = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      cancelable: true,
    });
    fixture.componentInstance.onAnnotationDashboardKeydown(saveShortcut);
    expect(saveShortcut.defaultPrevented).toBe(true);
    expect(shortcutSave).toHaveBeenCalledOnce();
    shortcutSave.mockRestore();
    await fixture.componentInstance.saveAnnotation();
    fixture.detectChanges();

    expect(saveAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: BOOK.id,
        color: 'purple',
        style: 'highlight',
        decorations: [
          { style: 'highlight', color: 'purple' },
          { style: 'underline', color: 'dark-blue' },
          { style: 'strikethrough', color: 'vermilion' },
        ],
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
      expect.objectContaining({ color: 'purple' }),
    ]);
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="annotation-dashboard"]',
      ),
    ).toBeNull();
    let storedAnnotation = saveAnnotation.mock.calls[0]?.[0] as
      | PublicationAnnotation
      | undefined;
    expect(storedAnnotation).toBeDefined();
    if (!storedAnnotation) {
      throw new Error('Expected the saved annotation');
    }
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="annotation-count-badge"]',
      )?.textContent,
    ).toContain('1');
    expect(fixture.componentInstance.annotationCount('strikethrough')).toBe(1);
    expect(fixture.componentInstance.annotationCount('underline')).toBe(1);
    expect(fixture.componentInstance.annotationCount('notes')).toBe(1);
    await fixture.componentInstance.removeAnnotationDecoration(
      storedAnnotation,
      'underline',
    );
    fixture.detectChanges();
    storedAnnotation = saveAnnotation.mock.calls[
      saveAnnotation.mock.calls.length - 1
    ]?.[0] as PublicationAnnotation | undefined;
    expect(storedAnnotation).toEqual(
      expect.objectContaining({
        decorations: [
          { style: 'highlight', color: 'purple' },
          { style: 'strikethrough', color: 'vermilion' },
        ],
      }),
    );
    if (!storedAnnotation) {
      throw new Error('Expected the annotation after removing underline');
    }
    expect(fixture.componentInstance.annotationCount('highlight')).toBe(1);
    expect(fixture.componentInstance.annotationCount('underline')).toBe(0);
    expect(fixture.componentInstance.annotationCount('strikethrough')).toBe(1);
    fixture.componentInstance.annotationQuery = 'evidence';
    fixture.componentInstance.setAnnotationFilter('notes');
    expect(fixture.componentInstance.filteredAnnotations).toEqual([
      storedAnnotation,
    ]);
    fixture.componentInstance.annotationQuery = 'missing phrase';
    expect(fixture.componentInstance.filteredAnnotations).toEqual([]);
    expect(fixture.componentInstance.annotationOverviewCustomized).toBe(true);
    fixture.componentInstance.resetAnnotationOverview();
    expect(fixture.componentInstance.annotationQuery).toBe('');
    expect(fixture.componentInstance.annotationFilter).toBe('all');
    expect(fixture.componentInstance.annotationSort).toBe('reading-order');
    expect(fixture.componentInstance.annotationOverviewCustomized).toBe(false);
    fixture.componentInstance.annotationQuery = '';
    fixture.componentInstance.setAnnotationFilter('all');
    const laterAnnotation: PublicationAnnotation = {
      ...structuredClone(storedAnnotation),
      id: 'annotation-later-in-book',
      locator: {
        ...structuredClone(storedAnnotation.locator),
        title: 'Page 2',
        locations: {
          ...structuredClone(storedAnnotation.locator.locations),
          position: 2,
          totalProgression: 1,
        },
        text: { highlight: 'Later passage' },
      },
      note: 'Most recently updated note.',
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-02T00:00:00.000Z',
    };
    fixture.componentInstance.annotations = [laterAnnotation, storedAnnotation];
    fixture.componentInstance.annotationSort = 'reading-order';
    expect(fixture.componentInstance.filteredAnnotations).toEqual([
      storedAnnotation,
      laterAnnotation,
    ]);
    fixture.componentInstance.annotationSort = 'updated-desc';
    expect(fixture.componentInstance.filteredAnnotations).toEqual([
      laterAnnotation,
      storedAnnotation,
    ]);
    fixture.componentInstance.annotationSort = 'reading-order';
    fixture.componentInstance.annotations = [storedAnnotation];
    fixture.componentInstance.toggleAnnotations();
    fixture.detectChanges();
    const annotationsPanel = fixture.nativeElement.querySelector(
      '[aria-label="Highlights and notes"]',
    ) as HTMLElement;
    expect(annotationsPanel.textContent).toContain('Strikethrough');
    expect(annotationsPanel.textContent).toContain('Page 1');
    expect(annotationsPanel.textContent).toContain('Revisit this evidence.');
    expect(
      annotationsPanel.querySelector('#annotation-sort')?.textContent,
    ).toContain('Reading order');
    expect(
      annotationsPanel.querySelector('#annotation-sort')?.textContent,
    ).toContain('Recently updated');
    expect(
      annotationsPanel.querySelector(
        '[data-testid="annotation-result-summary"]',
      )?.textContent,
    ).toContain('1 annotation');
    const annotationSearch = annotationsPanel.querySelector(
      '#annotation-search',
    ) as HTMLInputElement;
    annotationSearch.value = 'missing phrase';
    annotationSearch.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      annotationsPanel.querySelector(
        '[data-testid="annotation-result-summary"]',
      )?.textContent,
    ).toContain('0 of 1 shown');
    expect(annotationsPanel.textContent).toContain('Show all annotations');
    fixture.componentInstance.resetAnnotationOverview();
    fixture.detectChanges();
    await fixture.componentInstance.exportShownAnnotations();
    fixture.detectChanges();
    expect(createFileSave).toHaveBeenCalledWith({
      suggestedName: 'Annotation fixture-highlights-and-notes.md',
      mediaType: 'text/markdown',
      extensions: ['md'],
    });
    const exportedAnnotations = new TextDecoder().decode(
      Buffer.concat(exportedAnnotationBytes.map((chunk) => Buffer.from(chunk))),
    );
    expect(exportedAnnotations).toContain('Revisit this evidence.');
    expect(exportedAnnotations).toContain(
      'Highlight · Purple + Strikethrough · Vermilion',
    );
    expect(annotationsPanel.textContent).toContain(
      '1 annotation saved as Annotation fixture-highlights-and-notes.md.',
    );
    fixture.componentInstance.toggleAnnotations();
    fixture.detectChanges();
    callbacks.annotationActivation?.(storedAnnotation.id);
    fixture.detectChanges();
    const annotationEditor = fixture.nativeElement.querySelector(
      '[role="region"][aria-labelledby="annotation-editor-title"]',
    ) as HTMLElement;
    expect(annotationEditor.textContent).toContain('Edit annotation');
    expect(
      annotationEditor.querySelector('button[aria-label="Delete annotation"]'),
    ).not.toBeNull();
    expect(fixture.componentInstance.annotationStyle).toBe('highlight');

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
    const deletedAnnotation = saveAnnotation.mock.calls[
      saveAnnotation.mock.calls.length - 1
    ]?.[0] as PublicationAnnotation | undefined;
    expect(deletedAnnotation?.deletedAt).toEqual(expect.any(String));
    expect(
      fixture.nativeElement.querySelector('[data-testid="annotation-status"]')
        ?.textContent,
    ).toContain('Annotation deleted.');

    await fixture.componentInstance.undoAnnotationRemoval();
    fixture.detectChanges();

    const restoredAnnotation = saveAnnotation.mock.calls[
      saveAnnotation.mock.calls.length - 1
    ]?.[0] as PublicationAnnotation | undefined;
    expect(restoredAnnotation).toEqual(
      expect.objectContaining({
        id: storedAnnotation.id,
        deletedAt: undefined,
      }),
    );
    expect(Date.parse(restoredAnnotation?.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(deletedAnnotation?.updatedAt ?? ''),
    );
    expect(fixture.componentInstance.annotations).toEqual([
      expect.objectContaining({ id: storedAnnotation.id }),
    ]);
    expect(setAnnotations).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: storedAnnotation.id }),
    ]);
    expect(journal.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entity: 'annotation',
        entityId: storedAnnotation.id,
        payload: expect.objectContaining({ deletedAt: undefined }),
      }),
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="annotation-status"]')
        ?.textContent,
    ).toContain('Annotation restored.');

    if (!restoredAnnotation) {
      throw new Error('Expected the restored annotation');
    }
    await fixture.componentInstance.removeAnnotation(restoredAnnotation);
    fixture.detectChanges();
    expect(fixture.componentInstance.annotations).toEqual([]);
    fixture.componentInstance.dismissAnnotationStatus();
    Reflect.deleteProperty(readerRoot, 'requestFullscreen');
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
    fixture.destroy();
    expect(callbacks.command).toBeUndefined();
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
