import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  BookRecord,
  LibraryRepository,
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
      navigation?: (direction: 'previous' | 'next') => void;
      externalLink?: (url: string) => void;
    } = {};
    const setAnnotations = vi.fn().mockResolvedValue(undefined);
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
        locations: { position: 1 },
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
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    await Promise.resolve();
    expect(engine.previous).not.toHaveBeenCalled();
    callbacks.navigation?.('previous');
    await vi.waitFor(() => expect(engine.previous).toHaveBeenCalledOnce());
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
    fixture.destroy();
    vi.unstubAllGlobals();
  });
});
