import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  annotationDecorations,
  annotationHasStyle,
  BookRecord,
  DEFAULT_EPUB_READER_PREFERENCES,
  DEFAULT_PDF_READER_PREFERENCES,
  EpubReaderPreferences,
  keyboardNavigationDirection,
  keyboardReaderCommand,
  isPublicationAnnotationColor,
  LogicalBookRecord,
  LogicalMutationIdentity,
  PdfReaderPreferences,
  PdfRotation,
  PageNavigation,
  PublicationAnnotation,
  PublicationAnnotationColor,
  PublicationAnnotationDecoration,
  PublicationAnnotationStyle,
  PUBLICATION_ANNOTATION_BLACK_COLOR_OPTION,
  PUBLICATION_ANNOTATION_COLOR_OPTIONS,
  PublicationBookmark,
  PublicationLocator,
  PublicationMetadata,
  PublicationFormat,
  PublicationPasswordChallenge,
  PublicationSelection,
  ReaderEngine,
  ReaderCommand,
  ReaderNavigationDirection,
  ReaderPageStatus,
  ReaderPreferences,
  ReaderZoomDirection,
  ReadingProgress,
  SearchResult,
  selectionHasText,
  publicationAnnotationColorHex,
  publicationAnnotationColorLabel,
  startTouchEventNavigationGesture,
  startTouchNavigationGesture,
  TocEntry,
  TouchNavigationGesture,
  touchEventNavigationDirection,
  touchNavigationDirection,
  wheelNavigationDirection,
  wheelZoomDirection,
  VariantAvailability,
} from '@omnia-reader/reader/domain';
import { createBookSyncManifest } from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { BackNavigationService } from '../../back-navigation.service';
import { AnnotationMarkdownExportService } from './annotation-markdown-export.service';
import { PdfThumbnailComponent } from './pdf-thumbnail.component';

type ReaderPanel =
  | 'actions'
  | 'toc'
  | 'search'
  | 'settings'
  | 'thumbnails'
  | 'bookmarks'
  | 'annotations';

type AnnotationFilter = 'all' | 'notes' | PublicationAnnotationStyle;
type AnnotationSort = 'reading-order' | 'updated-desc';
const ANNOTATION_STYLE_ORDER: readonly PublicationAnnotationStyle[] = [
  'highlight',
  'underline',
  'strikethrough',
];

function decorationColor(
  decorations: readonly PublicationAnnotationDecoration[],
  style: PublicationAnnotationStyle,
  fallback: PublicationAnnotationColor,
): PublicationAnnotationColor {
  return (
    decorations.find((decoration) => decoration.style === style)?.color ??
    fallback
  );
}

function availabilityMessage(availability: VariantAvailability): string {
  if (availability.status === 'checking') return 'still being checked';
  if (availability.status === 'healthy') return 'ready';
  return `${availability.status} (${availability.cause.replace(/-/g, ' ')})`;
}

function readerMutationIdentity(): LogicalMutationIdentity {
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  return {
    changeId: `change:${deviceId}:${crypto.randomUUID()}`,
    parents: [],
    createdAt: now,
    deviceId,
    appVersion: '0.0.0',
  };
}

@Component({
  selector: 'omnia-reader-page',
  templateUrl: './reader-page.component.html',
  styleUrl: './reader-page.component.css',
  host: {
    class: 'block h-[calc(100vh-64px)]',
    '(document:keydown)': 'onDocumentKeydown($event)',
    '(document:fullscreenchange)': 'onFullscreenChange()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    CdkTrapFocus,
    NgClass,
    NgTemplateOutlet,
    ScrollingModule,
    FormsModule,
    RouterLink,
    PdfThumbnailComponent,
  ],
})
export class ReaderPageComponent implements AfterViewInit, OnDestroy {
  readonly annotationColorOptions = PUBLICATION_ANNOTATION_COLOR_OPTIONS;
  readonly annotationLineColorOptions = [
    PUBLICATION_ANNOTATION_BLACK_COLOR_OPTION,
    ...PUBLICATION_ANNOTATION_COLOR_OPTIONS,
  ];
  readonly multiFormatControlBaseClass =
    'inline-flex min-h-3.5 w-full min-w-0 items-center justify-between gap-0.5 rounded border border-stone-200/60 bg-white px-0.5 py-0 text-[6px] leading-none';
  readonly multiFormatControlProgressTrackClass =
    'h-0.5 w-7 shrink-0 overflow-hidden rounded-full bg-emerald-200/90';
  readonly multiFormatControlProgressFillClass =
    'h-full min-w-px rounded-full bg-green-600 transition-[width] duration-150 ease-out';
  readonly multiFormatControlProgressPercentClass =
    'w-5 text-right text-[6px] leading-none tabular-nums text-stone-500';
  readonly multiFormatProgressClusterClass =
    'ml-auto inline-flex shrink-0 items-center gap-0.5';
  readonly multiFormatControlLabelClass =
    'sr-only';
  readonly multiFormatControlActiveClass =
    'bg-stone-800 text-white';
  readonly multiFormatControlInactiveClass =
    'text-stone-400 bg-transparent';
  readonly multiFormatControlIconClass =
    '!h-2 !w-2 !text-[8px] text-current';
  readonly formatOrder: readonly PublicationFormat[] = ['epub', 'pdf'];
  readonly annotationFormatOptions = [
    { style: 'highlight', label: 'Highlight' },
    { style: 'underline', label: 'Underline' },
    {
      style: 'strikethrough',
      label: 'Strikethrough',
    },
  ] as const;
  @ViewChild('readerRoot', { static: true })
  private readerRoot!: ElementRef<HTMLElement>;

  @ViewChild('viewport', { static: true })
  private viewport!: ElementRef<HTMLElement>;

  @ViewChild('tocTrigger')
  private tocTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('actionsTrigger')
  private actionsTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('searchTrigger')
  private searchTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('settingsTrigger')
  private settingsTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('thumbnailsTrigger')
  private thumbnailsTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('bookmarksTrigger')
  private bookmarksTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('annotationsTrigger')
  private annotationsTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('shortcutsTrigger')
  private shortcutsTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('tocPanel')
  private tocPanel?: ElementRef<HTMLElement>;

  @ViewChild('actionsPanel')
  private actionsPanel?: ElementRef<HTMLElement>;

  @ViewChild('searchPanel')
  private searchPanel?: ElementRef<HTMLElement>;

  @ViewChild('searchInput')
  private searchInput?: ElementRef<HTMLInputElement>;

  @ViewChild('settingsPanel')
  private settingsPanel?: ElementRef<HTMLElement>;

  @ViewChild('thumbnailsPanel')
  private thumbnailsPanel?: ElementRef<HTMLElement>;

  @ViewChild('bookmarksPanel')
  private bookmarksPanel?: ElementRef<HTMLElement>;

  @ViewChild('annotationsPanel')
  private annotationsPanel?: ElementRef<HTMLElement>;

  @ViewChild('annotationSearchInput')
  private annotationSearchInput?: ElementRef<HTMLInputElement>;

  @ViewChild('shortcutsDialog')
  private shortcutsDialog?: ElementRef<HTMLElement>;

  @ViewChild('readerProgressSlider')
  private readerProgressSlider?: ElementRef<HTMLInputElement>;

  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly engines = inject(ReaderEngineRegistry);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly syncJournal = inject(SYNC_OPERATION_JOURNAL);
  private readonly platform = inject(PLATFORM_PORT);
  private readonly backNavigation = inject(BackNavigationService);
  private readonly annotationExports = inject(AnnotationMarkdownExportService);
  private readonly progressSliderThumbWidthPx = 10;

  book: BookRecord | null = null;
  logicalBook: LogicalBookRecord | null = null;
  metadata: PublicationMetadata | null = null;
  tableOfContents: readonly TocEntry[] = [];
  tocItems: readonly FlattenedTocEntry[] = [];
  visibleTocItems: readonly FlattenedTocEntry[] = [];
  chapterProgressMilestones: readonly ReaderProgressMilestone[] = [];
  searchResults: readonly SearchResult[] = [];
  searchQuery = '';
  searching = false;
  loading = true;
  errorMessage: string | null = null;
  searchError: string | null = null;
  tocOpen = false;
  actionsOpen = false;
  searchOpen = false;
  settingsOpen = false;
  thumbnailsOpen = false;
  bookmarksOpen = false;
  annotationsOpen = false;
  bookmarks: readonly PublicationBookmark[] = [];
  annotations: readonly PublicationAnnotation[] = [];
  bookmarkBusy = false;
  bookmarkError: string | null = null;
  annotationBusy = false;
  annotationError: string | null = null;
  annotationStatus: string | null = null;
  annotationStatusIsError = false;
  deletedAnnotation: PublicationAnnotation | null = null;
  pendingSelection: PublicationSelection | null = null;
  annotationEditorOpen = false;
  editingAnnotation: PublicationAnnotation | null = null;
  annotationStyle: PublicationAnnotationStyle = 'highlight';
  annotationStyles = new Set<PublicationAnnotationStyle>();
  annotationDecorationColors: Record<
    PublicationAnnotationStyle,
    PublicationAnnotationColor
  > = {
    highlight: 'yellow',
    underline: 'sky-blue',
    strikethrough: 'vermilion',
  };
  annotationColorPalette: PublicationAnnotationStyle | null = null;
  annotationNote = '';
  annotationNoteOpen = false;
  annotationGroup: readonly PublicationAnnotation[] = [];
  annotationGroupOpen = false;
  annotationQuery = '';
  annotationFilter: AnnotationFilter = 'all';
  annotationSort: AnnotationSort = 'reading-order';
  annotationExportBusy = false;
  annotationExportMessage: string | null = null;
  shortcutsOpen = false;
  zoomIndicatorPercent: number | null = null;
  navigationBusy = false;
  navigationError: string | null = null;
  private navigationLoopActive = false;
  private pendingNavigationDirection: ReaderNavigationDirection | null = null;
  pendingExternalUrl: string | null = null;
  externalLinkError: string | null = null;
  pageNavigation: PageNavigation | null = null;
  pageStatus: ReaderPageStatus | null = null;
  pageNumbers: readonly number[] = [];
  currentPageNumber = 1;
  passwordChallenge: PublicationPasswordChallenge | null = null;
  pdfPassword = '';
  passwordError: string | null = null;
  immersiveMode = false;
  immersiveToolbarRevealed = false;
  immersiveError: string | null = null;
  epubPreferences: EpubReaderPreferences = {
    ...DEFAULT_EPUB_READER_PREFERENCES,
  };
  pdfPreferences: PdfReaderPreferences = {
    ...DEFAULT_PDF_READER_PREFERENCES,
  };
  readonly keyboardShortcuts = [
    { keys: ['←', '→', '↑', '↓'], label: 'Turn pages' },
    { keys: ['T'], label: 'Open the table of contents' },
    { keys: ['/'], label: 'Search this publication' },
    { keys: ['Ctrl/⌘', 'F'], label: 'Search this publication' },
    { keys: ['M'], label: 'Add or remove a bookmark here' },
    { keys: ['B'], label: 'Open bookmarks' },
    { keys: ['A'], label: 'Open highlights and notes' },
    { keys: ['O'], label: 'Open reader settings' },
    { keys: ['F'], label: 'Enter or exit immersive reading' },
    { keys: ['?'], label: 'Show these keyboard shortcuts' },
    { keys: ['Esc'], label: 'Close the active reader panel or dialog' },
  ] as const;

  private engine: ReaderEngine | null = null;
  private progress: ReadingProgress | null = null;
  private currentLocator: PublicationLocator | null = null;
  private lastPersistedLocator = '';
  private readonly collapsedTocItemKeys = new Set<string>();
  private removeBackgroundListener: (() => void) | null = null;
  private removeRelocationListener: (() => void) | null = null;
  private removeSelectionListener: (() => void) | null = null;
  private removeSelectionActionRequestListener: (() => void) | null = null;
  private removePasswordListener: (() => void) | null = null;
  private removeAnnotationActivationListener: (() => void) | null = null;
  private removeNavigationRequestListener: (() => void) | null = null;
  private removeCommandRequestListener: (() => void) | null = null;
  private removeZoomRequestListener: (() => void) | null = null;
  private removeExternalLinkRequestListener: (() => void) | null = null;
  private lastWheelNavigationAt = Number.NEGATIVE_INFINITY;
  private touchNavigationGesture: TouchNavigationGesture | null = null;
  private touchEventNavigationGesture: TouchNavigationGesture | null = null;
  private readonly removeTransientBackHandler =
    this.backNavigation.registerTransientHandler(() =>
      this.closeTransientReaderUi(),
    );
  private progressWrite: Promise<void> = Promise.resolve();
  private zoomWrite: Promise<void> = Promise.resolve();
  private zoomIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;
  private annotationStatusTimeout: ReturnType<typeof setTimeout> | null = null;
  private annotationAutosaveTimeout: ReturnType<typeof setTimeout> | null =
    null;
  private readerPanelReturnFocus: HTMLElement | null = null;
  private shortcutsReturnFocus: HTMLElement | null = null;
  private clearSelectionInProgress = false;
  private manualProgressPercent: number | null = null;
  private pinnedProgressMilestoneKey: string | null = null;
  private destroyed = false;
  private progressSliderGeometryRefreshId: number | null = null;
  private formatProgressPercentByVariant: ReadonlyMap<string, number> = new Map();

  async ngAfterViewInit(): Promise<void> {
    const bookId = this.route.snapshot.paramMap.get('bookId');
    if (!bookId) {
      await this.router.navigate(['/library']);
      return;
    }

    this.removeBackgroundListener = this.platform.onBackground(() => {
      void this.queueProgressSave().catch(() => undefined);
    });

    try {
      const [book, progress, bookmarks, annotations, logicalBook] =
        await Promise.all([
          this.repository.getBook(bookId),
          this.repository.getProgress(bookId),
          this.repository.listBookmarks(bookId),
          this.repository.listAnnotations(bookId),
          this.repository.findLogicalBookByVariant(bookId),
        ]);
      if (!book) {
        throw new Error(
          'This publication is no longer available on this device',
        );
      }
      const opened = await this.repository.openHealthyVariant(bookId);
      if (!('source' in opened)) {
        throw new Error(
          `This ${book.format.toUpperCase()} source is ${availabilityMessage(
            opened.availability,
          )}`,
        );
      }
      const source = opened.source;

      this.book = book;
      this.logicalBook = logicalBook;
      this.progress = progress;
      await this.refreshFormatProgressPercentByVariant(logicalBook);
      this.bookmarks = bookmarks;
      this.annotations = annotations;
      const preferences =
        (await this.repository.getReaderPreferences(book.format)) ??
        (book.format === 'epub'
          ? { ...DEFAULT_EPUB_READER_PREFERENCES }
          : { ...DEFAULT_PDF_READER_PREFERENCES });
      if (preferences.format === 'epub') {
        this.epubPreferences = preferences;
      } else {
        this.pdfPreferences = preferences;
      }
      this.lastPersistedLocator = progress
        ? serializeLocator(progress.locator)
        : '';
      this.engine = await this.engines.create(book.format);
      if (this.engine.onAnnotationGroupActivated) {
        this.removeAnnotationActivationListener =
          this.engine.onAnnotationGroupActivated((annotationIds) => {
            this.openAnnotationGroup(annotationIds);
          });
      } else {
        this.removeAnnotationActivationListener =
          this.engine.onAnnotationActivated?.((annotationId) => {
            this.openAnnotationGroup([annotationId]);
          }) ?? null;
      }
      this.removeNavigationRequestListener =
        this.engine.onNavigationRequested?.((direction) => {
          void this.navigate(direction);
        }) ?? null;
      this.removeCommandRequestListener =
        this.engine.onCommandRequested?.((command) => {
          return this.handleReaderCommand(command);
        }) ?? null;
      this.removeZoomRequestListener =
        this.engine.onZoomRequested?.((direction) => {
          this.requestZoom(direction);
        }) ?? null;
      this.removeExternalLinkRequestListener =
        this.engine.onExternalLinkRequested?.((url) => {
          this.pendingExternalUrl = url;
          this.externalLinkError = null;
          this.changeDetector.markForCheck();
        }) ?? null;
      this.removePasswordListener =
        this.engine.onPasswordRequested?.((challenge) => {
          this.passwordChallenge = challenge;
          this.pdfPassword = '';
          this.passwordError =
            challenge.reason === 'incorrect'
              ? 'That password is incorrect. Please try again.'
              : null;
          this.changeDetector.markForCheck();
        }) ?? null;
      this.metadata = await this.engine.open(source);
      if (
        this.route.snapshot.queryParamMap.get('explicitFormat') === '1' &&
        logicalBook
      ) {
        const change = await this.repository.saveLogicalBookFormatPreference(
          logicalBook.id,
          book.format,
          readerMutationIdentity(),
        );
        if (change) {
          try {
            await this.syncJournal.append({
              entity: 'logical-book-change',
              entityId: change.changeId,
              operation: 'upsert',
              payload: change,
            });
          } catch {
            // The successful local preference remains pending while sync is unavailable.
          }
        }
      }
      this.book = await this.repository.updateMetadata(
        book.id,
        { ...this.metadata, cover: undefined },
        {
          markOpened: true,
        },
      );
      try {
        await this.syncJournal.append({
          entity: 'book',
          entityId: this.book.id,
          operation: 'upsert',
          payload: createBookSyncManifest(this.book),
        });
      } catch {
        // Local metadata and reading remain available while sync is offline.
      }
      await this.engine.applyPreferences(preferences);
      await this.engine.mount(this.viewport.nativeElement);
      this.removeSelectionListener = this.engine.onSelection((selection) => {
        if (!selection) {
          if (this.clearSelectionInProgress) {
            this.clearSelectionInProgress = false;
            return;
          }
          if (this.annotationEditorOpen) {
            void this.autosaveAnnotationAndClose();
          } else {
            this.pendingSelection = null;
            this.editingAnnotation = null;
            this.resetAnnotationDraft();
            this.annotationNote = '';
            this.annotationError = null;
          }
          this.changeDetector.markForCheck();
          return;
        }
        this.pendingSelection = selection;
        this.annotationEditorOpen = false;
        this.annotationError = null;
        this.editingAnnotation = null;
        this.resetAnnotationDraft();
        this.annotationNote = '';
        this.changeDetector.markForCheck();
      });
      this.removeSelectionActionRequestListener =
        this.engine.onSelectionActionRequested?.((selection) => {
          this.pendingSelection = selection;
          this.openPendingSelectionEditor();
        }) ?? null;
      await this.engine.setAnnotations(this.annotations);
      if (progress) {
        await this.engine.goTo(progress.locator);
      }
      this.removeRelocationListener = this.engine.onRelocated((locator) => {
        this.currentLocator = locator;
        this.currentPageNumber = locator.locations?.position ?? 1;
        this.pageStatus = this.engine?.pageStatus?.() ?? null;
        this.alignManualProgressPercent();
        this.scheduleProgressSliderGeometryRefresh();
        this.changeDetector.markForCheck();
        void this.queueProgressSave(locator).catch(() => undefined);
      });
      this.pageNavigation = this.engine.pageNavigation?.() ?? null;
      this.pageNumbers = this.pageNavigation
        ? Array.from(
            { length: this.pageNavigation.pageCount },
            (_, index) => index + 1,
          )
        : [];
      this.currentLocator = this.engine.currentLocator();
      this.pageStatus = this.engine.pageStatus?.() ?? null;
      this.currentPageNumber = this.currentLocator?.locations?.position ?? 1;
      this.tableOfContents = this.engine.tableOfContents();
      this.tocItems = flattenToc(this.tableOfContents);
      this.chapterProgressMilestones = deriveChapterProgressMilestones(
        this.tocItems,
        this.pageStatus,
      );
      this.scheduleProgressSliderGeometryRefresh();
      this.collapsedTocItemKeys.clear();
      for (const item of this.tocItems) {
        if (item.hasChildren) {
          this.collapsedTocItemKeys.add(item.key);
        }
      }
      this.updateVisibleTocItems();
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Unable to open this book';
    } finally {
      this.loading = false;
      this.changeDetector.markForCheck();
    }
  }

  siblingVariant(format: PublicationFormat): string | null {
    return this.logicalBook?.variants[format] ?? null;
  }

  hasMultipleFormats(): boolean {
    return !!this.logicalBook?.variants.epub && !!this.logicalBook.variants.pdf;
  }

  async switchReadingFormat(format: PublicationFormat): Promise<void> {
    const variantId = this.siblingVariant(format);
    if (!variantId || variantId === this.book?.id) return;
    if (this.annotationEditorOpen) {
      await this.autosaveAnnotationAndClose();
    }
    await this.queueProgressSave();
    this.closeTransientReaderUi();
    await this.router.navigate(['/reader', variantId], {
      queryParams: { explicitFormat: 1 },
    });
  }

  private async refreshFormatProgressPercentByVariant(
    logicalBook: LogicalBookRecord | null,
  ): Promise<void> {
    if (!logicalBook) {
      this.formatProgressPercentByVariant = new Map();
      return;
    }
    const variantIds = new Set(
      [logicalBook.variants.epub, logicalBook.variants.pdf].filter(
        (variantId): variantId is string => !!variantId,
      ),
    );
    if (variantIds.size === 0) {
      this.formatProgressPercentByVariant = new Map();
      return;
    }
    try {
      const allProgress = (await this.repository.listProgress?.()) ?? [];
      this.formatProgressPercentByVariant = new Map(
        allProgress
          .filter((entry) => variantIds.has(entry.bookId))
          .map((entry) => [entry.bookId, readingProgressPercent(entry)]),
      );
    } catch {
      this.formatProgressPercentByVariant = new Map();
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.scheduleProgressSliderGeometryRefresh();
  }

  onPublicationContextMenu(event: MouseEvent): void {
    if (!this.pendingSelection || this.loading || this.errorMessage) {
      return;
    }
    event.preventDefault();
    this.openPendingSelectionEditor();
  }

  private openPendingSelectionEditor(): void {
    if (
      this.passwordChallenge ||
      this.pendingExternalUrl ||
      this.readerPanelOpen
    ) {
      return;
    }
    this.editingAnnotation = null;
    this.annotationEditorOpen = true;
    this.annotationError = null;
    this.changeDetector.markForCheck();
  }

  onDocumentKeydown(event: KeyboardEvent): void {
    const command = keyboardReaderCommand(event);
    if (command && this.handleReaderCommand(command)) {
      event.preventDefault();
      return;
    }
    if (
      this.loading ||
      this.errorMessage ||
      this.passwordChallenge ||
      this.pendingExternalUrl ||
      this.pendingSelection ||
      this.readerPanelOpen
    ) {
      return;
    }
    const direction = keyboardNavigationDirection(
      event,
      this.metadata?.readingDirection,
    );
    if (!direction) {
      return;
    }
    event.preventDefault();
    void this.navigate(direction);
  }

  async toggleImmersiveMode(): Promise<void> {
    const readerRoot = this.readerRoot.nativeElement;
    const document = readerRoot.ownerDocument;
    this.immersiveError = null;
    try {
      if (document.fullscreenElement === readerRoot) {
        await document.exitFullscreen();
      } else {
        if (!readerRoot.requestFullscreen) {
          throw new Error(
            'Fullscreen reading is not supported by this browser',
          );
        }
        await readerRoot.requestFullscreen({ navigationUI: 'hide' });
      }
      this.onFullscreenChange();
    } catch (error) {
      this.immersiveError =
        error instanceof Error
          ? error.message
          : 'Unable to change fullscreen reading mode';
      this.changeDetector.markForCheck();
    }
  }

  onFullscreenChange(): void {
    const readerRoot = this.readerRoot.nativeElement;
    this.immersiveMode =
      readerRoot.ownerDocument.fullscreenElement === readerRoot;
    this.immersiveToolbarRevealed = false;
    if (this.immersiveMode) {
      readerRoot.focus({ preventScroll: true });
    }
    this.changeDetector.detectChanges();
    requestAnimationFrame(() => {
      requestAnimationFrame(() =>
        readerRoot.ownerDocument.defaultView?.dispatchEvent(
          new Event('resize'),
        ),
      );
    });
  }

  showImmersiveToolbar(): void {
    if (!this.immersiveMode || this.immersiveToolbarRevealed) {
      return;
    }
    this.immersiveToolbarRevealed = true;
    this.changeDetector.markForCheck();
  }

  hideImmersiveToolbar(): void {
    if (!this.immersiveToolbarRevealed) {
      return;
    }
    this.immersiveToolbarRevealed = false;
    this.changeDetector.markForCheck();
  }

  onReaderToolbarFocusOut(event: FocusEvent): void {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget instanceof HTMLElement &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    this.hideImmersiveToolbar();
  }

  get overallProgressPercent(): number | null {
    const progressionPercent = this.extractProgressPercent(this.currentLocator);
    if (progressionPercent !== null) {
      return progressionPercent;
    }
    if (this.pageStatus?.scope !== 'publication') {
      return null;
    }
    if (this.pageStatus.total <= 1) {
      return 100;
    }
    return clamp(
      ((this.pageStatus.current - 1) / (this.pageStatus.total - 1)) * 100,
      0,
      100,
    );
  }

  get displayedProgressPercent(): number | null {
    if (this.manualProgressPercent === null) {
      return this.overallProgressPercent;
    }
    if (this.pinnedProgressMilestoneKey !== null) {
      return this.manualProgressPercent;
    }
    const actualPercent = this.overallProgressPercent;
    if (
      actualPercent === null ||
      Math.abs(actualPercent - this.manualProgressPercent) <=
        PROGRESS_MILESTONE_MATCH_TOLERANCE
    ) {
      return this.manualProgressPercent;
    }
    return this.manualProgressPercent;
  }

  get displayedProgressPercentLabel(): string | null {
    const percent = this.displayedProgressPercent;
    if (percent === null) {
      return null;
    }
    return `${Math.round(percent)}% of book`;
  }

  get displayedOverallProgressPercentText(): string {
    const percent = this.displayedProgressPercent;
    return percent === null ? '--' : `${Math.round(percent)}`;
  }

  formatControlProgressPercent(format: PublicationFormat): number | null {
    const variantId = this.siblingVariant(format);
    if (!variantId) {
      return null;
    }
    const percent = this.formatProgressPercentByVariant.get(variantId);
    if (percent === undefined || !Number.isFinite(percent)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  formatActionLabel(format: PublicationFormat): string {
    return format.toUpperCase();
  }

  formatActionIcon(format: PublicationFormat): string {
    return format === 'epub' ? 'menu_book' : 'picture_as_pdf';
  }

  get progressSliderTrackBackground(): string {
    const progressPercent = this.displayedProgressPercent ?? 0;
    const normalized = normalizeProgressPercent(progressPercent);
    return `linear-gradient(to right, var(--reader-progress-slider-fill-color) ${normalized}%, var(--reader-progress-slider-track-color) ${normalized}%)`;
  }

  isProgressMilestoneReached(milestone: ReaderProgressMilestone): boolean {
    const percent = this.displayedProgressPercent;
    if (percent !== null && milestone.value <= percent) {
      return true;
    }
    if (
      this.manualProgressPercent !== null ||
      this.pageStatus?.scope !== 'section' ||
      !this.currentLocator
    ) {
      return false;
    }
    return (
      this.findProgressMilestoneForCurrentSection(this.currentLocator)?.key ===
      milestone.key
    );
  }

  get activeProgressMilestoneKey(): string | null {
    if (
      this.pinnedProgressMilestoneKey &&
      this.chapterProgressMilestones.some(
        (milestone) => milestone.key === this.pinnedProgressMilestoneKey,
      )
    ) {
      return this.pinnedProgressMilestoneKey;
    }
    if (this.manualProgressPercent === null) {
      return this.findProgressMilestoneForCurrentPage()?.key ?? null;
    }
    const percent = this.displayedProgressPercent;
    if (percent === null) {
      return null;
    }
    const nearest = this.findClosestProgressMilestoneByPercent(percent);
    if (
      nearest === null ||
      Math.abs(nearest.value - percent) > PROGRESS_MILESTONE_MATCH_TOLERANCE
    ) {
      return null;
    }
    const active = nearest;
    return active?.key ?? null;
  }

  private findProgressMilestoneForCurrentPage(): ReaderProgressMilestone | null {
    const locator = this.currentLocator;
    if (!locator) {
      return null;
    }

    const exactLocatorKey = locatorKey(locator);
    const exactLocatorMatch = this.chapterProgressMilestones.find(
      (milestone) => locatorKey(milestone.locator) === exactLocatorKey,
    );
    if (exactLocatorMatch) {
      return exactLocatorMatch;
    }

    const currentPosition = finiteAnnotationLocation(
      locator.locations?.position,
    );
    if (currentPosition !== null && this.pageStatus?.scope === 'publication') {
      const pageMatches = this.chapterProgressMilestones.filter(
        (milestone) =>
          finiteAnnotationLocation(milestone.locator.locations?.position) ===
          currentPosition,
      );
      const pageMatch = this.chooseCurrentPageMilestone(pageMatches, locator);
      if (pageMatch) {
        return pageMatch;
      }
    }

    if (this.pageStatus?.scope !== 'section' || this.pageStatus.current !== 1) {
      return null;
    }
    return this.findProgressMilestoneForCurrentSection(locator);
  }

  private findProgressMilestoneForCurrentSection(
    locator: PublicationLocator,
  ): ReaderProgressMilestone | null {
    const sectionHref = locator.href.split('#', 1)[0];
    if (!sectionHref) {
      return null;
    }
    const sectionMatches = this.chapterProgressMilestones.filter(
      (milestone) => milestone.locator.href.split('#', 1)[0] === sectionHref,
    );
    if (sectionMatches.length === 1) {
      return sectionMatches[0];
    }
    const sectionStartMatches = sectionMatches.filter(
      (milestone) => !milestone.locator.locations?.fragments?.length,
    );
    return this.chooseCurrentPageMilestone(sectionStartMatches, locator);
  }

  private chooseCurrentPageMilestone(
    candidates: readonly ReaderProgressMilestone[],
    locator: PublicationLocator,
  ): ReaderProgressMilestone | null {
    if (candidates.length === 0) {
      return null;
    }
    const locatorHref = locator.href.split('#', 1)[0];
    return (
      candidates.find(
        (candidate) => candidate.locator.href.split('#', 1)[0] === locatorHref,
      ) ??
      this.findClosestProgressMilestoneByPercent(
        this.extractProgressPercent(locator) ?? candidates[0].value,
        candidates,
      )
    );
  }

  private findClosestProgressMilestoneByPercent(
    targetPercent: number,
    candidates: readonly ReaderProgressMilestone[] = this
      .chapterProgressMilestones,
  ): ReaderProgressMilestone | null {
    let nearest: ReaderProgressMilestone | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.value - targetPercent);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = candidate;
        continue;
      }
      if (
        distance === nearestDistance &&
        nearest !== null &&
        candidate.tocItemIndex < nearest.tocItemIndex &&
        candidate.value >= targetPercent
      ) {
        nearest = candidate;
      }
    }
    return nearest;
  }

  getMilestoneLeftPx(milestone: ReaderProgressMilestone): number {
    const progressPercent = normalizeProgressPercent(milestone.value);
    const slider = this.readerProgressSlider?.nativeElement;
    if (slider === undefined) {
      return 0;
    }
    return this.progressPercentToPixelOffset(progressPercent, slider);
  }

  private progressPercentToPixelOffset(
    progressPercent: number,
    slider: HTMLInputElement,
  ): number {
    const sliderRect = slider.getBoundingClientRect();
    const sliderWidth = Math.max(0, sliderRect.width);
    if (sliderWidth <= 0) {
      return 0;
    }

    const min = Number.parseFloat(slider.min || '0');
    const max = Number.parseFloat(slider.max || '100');
    const denominator = Math.max(0.000001, max - min);
    const progressRatio = clamp((progressPercent - min) / denominator, 0, 1);

    const thumbWidth = Math.min(this.progressSliderThumbWidthPx, sliderWidth);
    const trackWidth = Math.max(0, sliderWidth - thumbWidth);
    return thumbWidth / 2 + progressRatio * trackWidth;
  }

  private scheduleProgressSliderGeometryRefresh(): void {
    if (this.destroyed) {
      return;
    }
    if (this.progressSliderGeometryRefreshId !== null) {
      return;
    }
    this.progressSliderGeometryRefreshId = requestAnimationFrame(() => {
      this.progressSliderGeometryRefreshId = null;
      this.changeDetector.markForCheck();
    });
  }

  get progressSeekingAvailable(): boolean {
    return (
      typeof this.engine?.goToProgression === 'function' &&
      this.overallProgressPercent !== null
    );
  }

  get readerPanelOpen(): boolean {
    return this.shortcutsOpen || this.activeReaderPanel !== null;
  }

  toggleKeyboardShortcuts(): void {
    if (this.shortcutsOpen) {
      this.closeKeyboardShortcuts();
      return;
    }
    this.openKeyboardShortcuts();
  }

  async seekToProgress(event: Event): Promise<void> {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const percent = input.valueAsNumber;
    if (!Number.isFinite(percent)) {
      return;
    }
    const normalized = normalizeProgressPercent(percent);
    this.setManualProgressPercent(normalized);
    this.pinnedProgressMilestoneKey = null;
    this.changeDetector.markForCheck();
    await this.seekToProgressPercent(normalized);
  }

  onProgressSliderInput(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const percent = input.valueAsNumber;
    if (!Number.isFinite(percent)) {
      return;
    }
    this.setManualProgressPercent(normalizeProgressPercent(percent));
    this.pinnedProgressMilestoneKey = null;
    this.changeDetector.markForCheck();
  }

  async seekToChapterMilestone(
    milestone: ReaderProgressMilestone,
    event?: MouseEvent,
  ): Promise<void> {
    if (this.loading || this.navigationBusy) {
      return;
    }
    if (!milestone) {
      return;
    }
    const locator = milestone.locator;
    const normalized = normalizeProgressPercent(milestone.value);
    this.setManualProgressPercent(normalized);
    this.pinnedProgressMilestoneKey = milestone.key;
    if (event?.currentTarget instanceof HTMLElement) {
      event.currentTarget.focus({ preventScroll: true });
      this.queueFocus(event.currentTarget);
    }
    this.changeDetector.markForCheck();
    await this.seekToLocator(locator, true);
  }

  private async seekToLocator(
    locator: PublicationLocator,
    keepManualProgress = false,
  ): Promise<void> {
    if (!keepManualProgress) {
      this.clearProgressMilestonePin();
    }
    const engine = this.engine;
    if (!engine || this.loading || this.navigationBusy) {
      return;
    }

    this.navigationBusy = true;
    this.navigationError = null;
    this.changeDetector.markForCheck();
    try {
      await engine.goTo(locator);
    } catch (error) {
      this.navigationError =
        error instanceof Error
          ? error.message
          : 'Unable to move to this chapter';
    } finally {
      this.navigationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  private async seekToProgressPercent(percent: number): Promise<void> {
    const engine = this.engine;
    const seek = engine?.goToProgression;
    if (!seek || this.loading || this.navigationBusy) {
      return;
    }

    this.navigationBusy = true;
    this.navigationError = null;
    this.changeDetector.markForCheck();
    try {
      await seek.call(engine, Math.min(100, Math.max(0, percent)) / 100);
    } catch (error) {
      this.navigationError =
        error instanceof Error
          ? error.message
          : 'Unable to move to this book position';
    } finally {
      this.navigationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  private setManualProgressPercent(percent: number | null): void {
    if (percent === null) {
      this.manualProgressPercent = null;
      return;
    }
    const normalized = normalizeProgressPercent(percent);
    this.manualProgressPercent = normalized;
    const slider = this.readerProgressSlider?.nativeElement;
    if (slider) {
      slider.value = String(normalized);
      this.scheduleProgressSliderGeometryRefresh();
    }
  }

  private extractProgressPercent(
    locator: PublicationLocator | null,
  ): number | null {
    const directProgression =
      locator?.locations?.totalProgression ?? locator?.locations?.progression;
    if (directProgression !== undefined && Number.isFinite(directProgression)) {
      return normalizeProgressPercent(directProgression * 100);
    }
    return null;
  }

  onPublicationWheel(event: WheelEvent): void {
    if (
      !this.book ||
      this.loading ||
      this.errorMessage ||
      this.passwordChallenge ||
      this.pendingSelection ||
      this.readerPanelOpen
    ) {
      return;
    }
    const zoomDirection = wheelZoomDirection(event);
    if (zoomDirection) {
      event.preventDefault();
      this.requestZoom(zoomDirection);
      return;
    }
    if (this.book.format !== 'pdf') {
      return;
    }
    const direction = wheelNavigationDirection(event);
    if (!direction) {
      return;
    }
    event.preventDefault();
    const now = Date.now();
    if (now - this.lastWheelNavigationAt < WHEEL_NAVIGATION_INTERVAL_MS) {
      return;
    }
    this.lastWheelNavigationAt = now;
    void this.navigate(direction);
  }

  onPublicationPointerDown(event: PointerEvent): void {
    if (
      this.book?.format !== 'pdf' ||
      this.loading ||
      this.errorMessage ||
      this.passwordChallenge ||
      this.pendingSelection ||
      this.readerPanelOpen ||
      this.navigationBusy
    ) {
      this.touchNavigationGesture = null;
      return;
    }
    this.touchNavigationGesture = startTouchNavigationGesture(event);
  }

  onPublicationPointerUp(event: PointerEvent): void {
    const gesture = this.touchNavigationGesture;
    this.touchNavigationGesture = null;
    if (
      !gesture ||
      this.book?.format !== 'pdf' ||
      this.loading ||
      this.errorMessage ||
      this.passwordChallenge ||
      this.pendingSelection ||
      this.readerPanelOpen ||
      this.navigationBusy ||
      selectionHasText(this.viewport.nativeElement.ownerDocument.getSelection())
    ) {
      return;
    }
    const direction = touchNavigationDirection(
      gesture,
      event,
      this.metadata?.readingDirection,
    );
    if (!direction) {
      return;
    }
    this.touchEventNavigationGesture = null;
    event.preventDefault();
    void this.navigate(direction);
  }

  onPublicationPointerCancel(event: PointerEvent): void {
    if (this.touchNavigationGesture?.pointerId === event.pointerId) {
      this.touchNavigationGesture = null;
    }
  }

  onPublicationTouchStart(event: TouchEvent): void {
    if (
      this.book?.format !== 'pdf' ||
      this.loading ||
      this.errorMessage ||
      this.passwordChallenge ||
      this.pendingSelection ||
      this.readerPanelOpen ||
      this.navigationBusy
    ) {
      this.touchEventNavigationGesture = null;
      return;
    }
    this.touchEventNavigationGesture = startTouchEventNavigationGesture(event);
  }

  onPublicationTouchEnd(event: TouchEvent): void {
    const gesture = this.touchEventNavigationGesture;
    this.touchEventNavigationGesture = null;
    if (
      !gesture ||
      this.book?.format !== 'pdf' ||
      this.loading ||
      this.errorMessage ||
      this.passwordChallenge ||
      this.pendingSelection ||
      this.readerPanelOpen ||
      this.navigationBusy ||
      selectionHasText(this.viewport.nativeElement.ownerDocument.getSelection())
    ) {
      return;
    }
    const direction = touchEventNavigationDirection(
      gesture,
      event,
      this.metadata?.readingDirection,
    );
    if (!direction) {
      return;
    }
    this.touchNavigationGesture = null;
    event.preventDefault();
    void this.navigate(direction);
  }

  onPublicationTouchCancel(): void {
    this.touchEventNavigationGesture = null;
  }

  async goTo(
    entry: TocEntry,
    options: { progressMilestone?: ReaderProgressMilestone | null } = {},
  ): Promise<void> {
    if (options.progressMilestone) {
      this.setManualProgressPercent(options.progressMilestone.value);
      this.pinnedProgressMilestoneKey = options.progressMilestone.key;
    } else {
      this.clearProgressMilestonePin();
    }
    if (!this.engine || this.loading || this.navigationBusy) {
      return;
    }
    this.navigationBusy = true;
    this.navigationError = null;
    this.changeDetector.markForCheck();
    try {
      await this.engine.goTo(entry.locator);
      this.closeReaderPanelsForReading();
    } catch (error) {
      this.navigationError =
        error instanceof Error
          ? error.message
          : 'Unable to navigate this publication';
    } finally {
      this.navigationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  toggleToc(): void {
    this.toggleReaderPanel('toc');
  }

  toggleReaderActions(): void {
    this.toggleReaderPanel('actions');
  }

  goToTocItem(item: FlattenedTocEntry): Promise<void> {
    const milestone = this.getProgressMilestoneForTocItem(item);
    return this.goTo(item.entry, {
      progressMilestone: milestone,
    });
  }

  private getProgressMilestoneForTocItem(
    tocItem: FlattenedTocEntry,
  ): ReaderProgressMilestone | null {
    const tocItemIndex = this.tocItems.findIndex(
      (item) => item.key === tocItem.key,
    );
    const targetTocIndex = tocItemIndex;

    const byTocKey = this.chapterProgressMilestones.find(
      (milestone) => milestone.tocItemKey === tocItem.key,
    );
    if (byTocKey) {
      return byTocKey;
    }

    const itemLocatorKey = locatorKey({
      href: tocItem.entry.locator.href,
      type: tocItem.entry.locator.type,
      locations: tocItem.entry.locator.locations,
    });
    const byLocatorCandidates = this.chapterProgressMilestones.filter(
      (milestone) => locatorKey(milestone.locator) === itemLocatorKey,
    );
    if (byLocatorCandidates.length === 1) {
      return byLocatorCandidates[0] ?? null;
    }
    if (byLocatorCandidates.length > 1) {
      return this.chooseClosestMilestoneByTocIndex(
        targetTocIndex,
        byLocatorCandidates,
      );
    }

    const byLocatorHref =
      this.findProgressMilestoneForTocItemByHrefWithoutFragment(tocItem);
    if (byLocatorHref) {
      return byLocatorHref;
    }

    const byTocAncestor =
      this.findProgressMilestoneForTocItemByAncestor(tocItem);
    if (byTocAncestor) {
      return byTocAncestor;
    }

    const byChapterMilestoneOrder =
      this.findProgressMilestoneByChapterMilestoneOrder(tocItem);
    if (byChapterMilestoneOrder) {
      return byChapterMilestoneOrder;
    }

    return this.findProgressMilestoneForTocItemFallback(
      tocItem,
      itemLocatorKey,
    );
  }

  private findProgressMilestoneByChapterMilestoneOrder(
    tocItem: FlattenedTocEntry,
  ): ReaderProgressMilestone | null {
    const topLevelItems = this.tocItems.filter((item) => item.depth === 0);
    if (topLevelItems.length === 0) {
      return null;
    }

    const chapterMilestoneItems = chooseChapterMilestoneEntries(
      topLevelItems,
      this.tocItems,
    );
    if (chapterMilestoneItems.length === 0) {
      return null;
    }

    const orderedMilestones = this.chapterProgressMilestones
      .slice()
      .sort((left, right) => left.tocItemIndex - right.tocItemIndex);

    if (!orderedMilestones.length) {
      return null;
    }

    const directMatch = orderedMilestones.find(
      (milestone) => milestone.tocItemKey === tocItem.key,
    );
    if (directMatch) {
      return directMatch;
    }

    const tocItemIsChapter = isChapterLikeTocEntry(tocItem);
    if (tocItemIsChapter) {
      const chapterMilestoneItemsLength = chapterMilestoneItems.length;
      const chapterIndex = chapterMilestoneItems.findIndex(
        (item) => item.key === tocItem.key,
      );
      if (chapterIndex >= 0 && chapterIndex < chapterMilestoneItemsLength) {
        return orderedMilestones[chapterIndex] ?? null;
      }
    }

    const targetIndex = this.tocItems.findIndex(
      (item) => item.key === tocItem.key,
    );
    if (targetIndex < 0) {
      return orderedMilestones[0] ?? null;
    }

    return this.chooseClosestMilestoneByTocIndex(
      targetIndex,
      orderedMilestones,
    );
  }

  private findProgressMilestoneForTocItemByAncestor(
    tocItem: FlattenedTocEntry,
  ): ReaderProgressMilestone | null {
    for (let index = tocItem.parentKeys.length - 1; index >= 0; index -= 1) {
      const parentKey = tocItem.parentKeys[index];
      const parentMilestone = this.chapterProgressMilestones.find(
        (milestone) => milestone.tocItemKey === parentKey,
      );
      if (parentMilestone) {
        return parentMilestone;
      }
    }
    return null;
  }

  private findProgressMilestoneForTocItemByHrefWithoutFragment(
    tocItem: FlattenedTocEntry,
  ): ReaderProgressMilestone | null {
    const targetHref = tocItem.entry.locator.href.split('#', 1)[0];
    if (!targetHref) {
      return null;
    }
    const candidates = this.chapterProgressMilestones.filter(
      (milestone) => milestone.locator.href.split('#', 1)[0] === targetHref,
    );
    if (candidates.length === 0) {
      return null;
    }
    const targetIndex = this.tocItems.findIndex(
      (item) => item.key === tocItem.key,
    );
    if (targetIndex < 0) {
      return candidates[0] ?? null;
    }
    return this.chooseClosestMilestoneByTocIndex(targetIndex, candidates);
  }

  private findProgressMilestoneForTocItemFallback(
    tocItem: FlattenedTocEntry,
    itemLocatorKey: string,
  ): ReaderProgressMilestone | null {
    if (this.chapterProgressMilestones.length === 0) {
      return null;
    }

    const fallbackIndex = this.tocItems.findIndex(
      (item) => item.key === tocItem.key,
    );
    if (fallbackIndex >= 0) {
      return this.chooseClosestMilestoneByTocIndex(fallbackIndex);
    }

    const targetPercent = inferLocatorProgressionPercent(
      tocItem.entry.locator,
      this.pageStatus,
    );
    if (targetPercent === null) {
      return this.chapterProgressMilestones[0] ?? null;
    }

    const fallbackByProgress = this.chooseClosestMilestoneByPercent(
      itemLocatorKey,
      targetPercent,
    );
    return fallbackByProgress ?? this.chapterProgressMilestones[0];
  }

  private chooseClosestMilestoneByTocIndex(
    tocIndex: number,
    candidates: readonly ReaderProgressMilestone[] = this
      .chapterProgressMilestones,
  ): ReaderProgressMilestone | null {
    if (candidates.length === 0) {
      return null;
    }
    if (tocIndex < 0) {
      return candidates[0] ?? null;
    }
    let best: ReaderProgressMilestone | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const candidateDistance = Math.abs(candidate.tocItemIndex - tocIndex);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        best = candidate;
        continue;
      }
      if (candidateDistance === bestDistance) {
        if (best === null || candidate.tocItemIndex > best.tocItemIndex) {
          best = candidate;
        }
      }
    }

    return best;
  }

  private chooseClosestMilestoneByPercent(
    targetLocatorKey: string,
    targetPercent: number,
  ): ReaderProgressMilestone | null {
    let best: ReaderProgressMilestone | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of this.chapterProgressMilestones) {
      const distance = Math.abs(candidate.value - targetPercent);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
        continue;
      }
      if (distance !== bestDistance) {
        continue;
      }
      if (
        best === null ||
        (candidate.value === best.value &&
          locatorKey(candidate.locator) === targetLocatorKey)
      ) {
        best = candidate;
        continue;
      }
      if (candidate.value > best.value) {
        best = candidate;
      }
    }

    return best;
  }

  openReaderPanelFromActions(
    panel: Exclude<ReaderPanel, 'actions' | 'toc'>,
  ): void {
    this.readerPanelReturnFocus ??= this.actionsTrigger?.nativeElement ?? null;
    this.closeReaderPanels();
    this.setReaderPanelOpen(panel, true);
    this.changeDetector.detectChanges();
    this.queueFocus(
      panel === 'search'
        ? this.searchInput?.nativeElement
        : this.readerPanelElement(panel),
    );
  }

  toggleTocItem(item: FlattenedTocEntry): void {
    if (!item.hasChildren) {
      return;
    }
    if (this.collapsedTocItemKeys.has(item.key)) {
      this.collapsedTocItemKeys.delete(item.key);
    } else {
      this.collapsedTocItemKeys.add(item.key);
    }
    this.updateVisibleTocItems();
    this.changeDetector.markForCheck();
  }

  isTocItemExpanded(item: FlattenedTocEntry): boolean {
    return !this.collapsedTocItemKeys.has(item.key);
  }

  toggleSearch(): void {
    this.toggleReaderPanel('search');
  }

  toggleSettings(): void {
    this.toggleReaderPanel('settings');
  }

  toggleThumbnails(): void {
    this.toggleReaderPanel('thumbnails');
  }

  toggleBookmarks(): void {
    this.toggleReaderPanel('bookmarks');
    this.bookmarkError = null;
  }

  toggleAnnotations(): void {
    this.toggleReaderPanel('annotations');
    this.annotationError = null;
  }

  async toggleCurrentBookmarkFromActions(): Promise<void> {
    await this.toggleCurrentBookmark();
    this.closeReaderPanelsAndRestoreTrigger();
  }

  toggleImmersiveModeFromActions(): void {
    this.closeReaderPanelsAndRestoreTrigger();
    void this.toggleImmersiveMode();
  }

  get currentBookmark(): PublicationBookmark | null {
    if (!this.currentLocator) {
      return null;
    }
    const key = locatorKey(this.currentLocator);
    return (
      this.bookmarks.find((bookmark) => locatorKey(bookmark.locator) === key) ??
      null
    );
  }

  async toggleCurrentBookmark(): Promise<void> {
    if (this.bookmarkBusy || !this.book || !this.engine) {
      return;
    }
    const locator = this.currentLocator ?? this.engine.currentLocator();
    if (!locator) {
      return;
    }

    this.bookmarkBusy = true;
    this.bookmarkError = null;
    try {
      const existing = this.bookmarks.find(
        (bookmark) => locatorKey(bookmark.locator) === locatorKey(locator),
      );
      if (existing) {
        await this.deleteBookmark(existing);
        return;
      }

      const timestamp = new Date().toISOString();
      const bookmark: PublicationBookmark = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        bookId: this.book.id,
        format: this.book.format,
        deviceId: getDeviceId(),
        locator: structuredClone(locator),
        label: createBookmarkLabel(locator, this.bookmarks.length + 1),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.repository.saveBookmark(bookmark);
      this.bookmarks = [bookmark, ...this.bookmarks];
      await this.journalBookmark(bookmark);
    } catch (error) {
      this.bookmarkError =
        error instanceof Error ? error.message : 'Unable to update bookmark';
    } finally {
      this.bookmarkBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async deleteBookmark(bookmark: PublicationBookmark): Promise<void> {
    const timestamp = new Date().toISOString();
    const tombstone: PublicationBookmark = {
      ...bookmark,
      deviceId: getDeviceId(),
      updatedAt: timestamp,
      deletedAt: timestamp,
    };
    await this.repository.saveBookmark(tombstone);
    this.bookmarks = this.bookmarks.filter(
      (candidate) => candidate.id !== bookmark.id,
    );
    await this.journalBookmark(tombstone);
    this.changeDetector.markForCheck();
  }

  async removeBookmark(bookmark: PublicationBookmark): Promise<void> {
    if (this.bookmarkBusy) {
      return;
    }
    this.bookmarkBusy = true;
    this.bookmarkError = null;
    try {
      await this.deleteBookmark(bookmark);
    } catch (error) {
      this.bookmarkError =
        error instanceof Error ? error.message : 'Unable to remove bookmark';
    } finally {
      this.bookmarkBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async goToBookmark(bookmark: PublicationBookmark): Promise<void> {
    this.clearProgressMilestonePin();
    await this.engine?.goTo(bookmark.locator);
    this.closeReaderPanelsForReading();
  }

  get annotationColor(): PublicationAnnotationColor {
    return this.annotationDecorationColors[this.annotationStyle];
  }

  set annotationColor(color: PublicationAnnotationColor) {
    this.annotationDecorationColors = {
      ...this.annotationDecorationColors,
      [this.annotationStyle]: color,
    };
  }

  get canSaveAnnotation(): boolean {
    return (
      this.annotationStyles.size > 0 || this.annotationNote.trim().length > 0
    );
  }

  annotationStyleSelected(style: PublicationAnnotationStyle): boolean {
    return this.annotationStyles.has(style);
  }

  async applyAnnotationStyle(style: PublicationAnnotationStyle): Promise<void> {
    this.clearAnnotationAutosaveTimeout();
    await this.waitForAnnotationIdle();
    const selected = new Set(this.annotationStyles);
    if (selected.has(style)) {
      selected.delete(style);
    } else {
      selected.add(style);
    }
    this.annotationStyle = style;
    this.annotationStyles = selected;
    this.annotationColorPalette = null;
    if (selected.size === 0 && !this.annotationNote.trim()) {
      if (this.editingAnnotation) {
        await this.removeEditingAnnotation();
      }
      return;
    }
    await this.saveAnnotation(false);
  }

  toggleAnnotationColorPalette(style: PublicationAnnotationStyle): void {
    if (this.annotationColorPalette === style) {
      this.closeAnnotationColorPalette();
      return;
    }
    this.annotationColorPalette = style;
    setTimeout(() => {
      this.readerRoot.nativeElement.ownerDocument
        .getElementById(`annotation-${style}-color-palette`)
        ?.querySelector<HTMLElement>('button, input')
        ?.focus();
    }, 0);
  }

  closeAnnotationColorPalette(event?: Event): void {
    const style = this.annotationColorPalette;
    event?.preventDefault();
    event?.stopPropagation();
    this.annotationColorPalette = null;
    if (!style) {
      return;
    }
    setTimeout(() => {
      this.readerRoot.nativeElement.ownerDocument
        .querySelector<HTMLElement>(
          `button[aria-controls="annotation-${style}-color-palette"]`,
        )
        ?.focus();
    }, 0);
  }

  async chooseAnnotationColor(
    style: PublicationAnnotationStyle,
    color: PublicationAnnotationColor,
  ): Promise<void> {
    this.setAnnotationDecorationColor(style, color);
    this.closeAnnotationColorPalette();
    if (this.annotationStyleSelected(style) && this.editingAnnotation) {
      await this.waitForAnnotationIdle();
      await this.saveAnnotation(false);
    }
  }

  toggleAnnotationNote(): void {
    if (this.annotationNoteOpen) {
      void this.flushAnnotationAutosave();
    }
    this.annotationNoteOpen = !this.annotationNoteOpen;
    this.annotationColorPalette = null;
  }

  onAnnotationNoteChange(): void {
    this.scheduleAnnotationAutosave();
  }

  onAnnotationColorInput(
    style: PublicationAnnotationStyle,
    color: unknown,
  ): void {
    this.setAnnotationDecorationColor(style, color);
    if (this.annotationStyleSelected(style) && this.editingAnnotation) {
      this.scheduleAnnotationAutosave();
    }
  }

  async autosaveAnnotationAndClose(): Promise<void> {
    const hasPendingAutosave =
      !!this.annotationAutosaveTimeout && this.canSaveAnnotation;
    if (hasPendingAutosave) {
      this.clearAnnotationAutosaveTimeout();
    }
    await this.waitForAnnotationIdle();
    if (hasPendingAutosave) {
      await this.saveAnnotation();
      return;
    }
    this.cancelAnnotationEditor();
  }

  async flushAnnotationAutosave(): Promise<void> {
    if (!this.annotationAutosaveTimeout) {
      return;
    }
    this.clearAnnotationAutosaveTimeout();
    if (this.canSaveAnnotation) {
      await this.waitForAnnotationIdle();
      await this.saveAnnotation(false);
    }
  }

  onAnnotationDashboardKeydown(event: KeyboardEvent): void {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      this.canSaveAnnotation &&
      !this.annotationBusy
    ) {
      event.preventDefault();
      void this.saveAnnotation();
    }
  }

  onAnnotationFormattingKeydown(event: KeyboardEvent): void {
    if (
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
      !(event.currentTarget instanceof HTMLElement)
    ) {
      return;
    }
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ),
    );
    if (buttons.length === 0) {
      return;
    }
    const currentIndex = buttons.indexOf(
      event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
    );
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowLeft'
            ? (Math.max(currentIndex, 0) - 1 + buttons.length) % buttons.length
            : (Math.max(currentIndex, -1) + 1) % buttons.length;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  }

  setAnnotationDecorationColor(
    style: PublicationAnnotationStyle,
    color: unknown,
  ): void {
    if (!isPublicationAnnotationColor(color)) {
      return;
    }
    this.annotationDecorationColors = {
      ...this.annotationDecorationColors,
      [style]: color.startsWith('#')
        ? publicationAnnotationColorHex(color)
        : color,
    };
  }

  annotationColorPickerValue(style: PublicationAnnotationStyle): string {
    return publicationAnnotationColorHex(
      this.annotationDecorationColors[style],
    );
  }

  annotationColorIsCustom(style: PublicationAnnotationStyle): boolean {
    return this.annotationDecorationColors[style].startsWith('#');
  }

  annotationColorHex(color: PublicationAnnotationColor): string {
    return publicationAnnotationColorHex(color);
  }

  annotationColorLabel(color: PublicationAnnotationColor): string {
    return color.startsWith('#')
      ? `Custom ${color.toUpperCase()}`
      : publicationAnnotationColorLabel(color);
  }

  annotationColorOptionsFor(style: PublicationAnnotationStyle) {
    return style === 'highlight'
      ? this.annotationColorOptions
      : this.annotationLineColorOptions;
  }

  annotationDecorationsOf(
    annotation: PublicationAnnotation,
  ): readonly PublicationAnnotationDecoration[] {
    return annotationDecorations(annotation);
  }

  annotationContainsStyle(
    annotation: PublicationAnnotation,
    style: PublicationAnnotationStyle,
  ): boolean {
    return annotationHasStyle(annotation, style);
  }

  openAnnotationGroup(annotationIds: readonly string[]): void {
    const ids = new Set(annotationIds);
    const annotations = this.annotations.filter((annotation) =>
      ids.has(annotation.id),
    );
    if (annotations.length === 0) {
      return;
    }
    if (annotations.length === 1) {
      this.beginEditAnnotation(annotations[0]);
      this.changeDetector.markForCheck();
      return;
    }
    this.annotationGroup = annotations;
    this.annotationGroupOpen = true;
    this.annotationsOpen = false;
    this.changeDetector.markForCheck();
  }

  closeAnnotationGroup(): void {
    this.annotationGroup = [];
    this.annotationGroupOpen = false;
  }

  editAnnotationFromGroup(annotation: PublicationAnnotation): void {
    this.closeAnnotationGroup();
    this.beginEditAnnotation(annotation);
  }

  async removeAnnotationFromGroup(
    annotation: PublicationAnnotation,
  ): Promise<void> {
    if (await this.removeAnnotation(annotation)) {
      this.refreshOpenAnnotationGroup();
    }
  }

  beginEditAnnotation(annotation: PublicationAnnotation): void {
    const decorations = annotationDecorations(annotation);
    this.editingAnnotation = annotation;
    this.annotationEditorOpen = true;
    this.pendingSelection = { locator: structuredClone(annotation.locator) };
    this.annotationStyles = new Set(
      decorations.map((decoration) => decoration.style),
    );
    this.annotationDecorationColors = {
      highlight: decorationColor(decorations, 'highlight', 'yellow'),
      underline: decorationColor(decorations, 'underline', 'sky-blue'),
      strikethrough: decorationColor(decorations, 'strikethrough', 'vermilion'),
    };
    this.annotationStyle = decorations[0]?.style ?? 'highlight';
    this.annotationNote = annotation.note ?? '';
    this.annotationNoteOpen = !!annotation.note;
    this.annotationError = null;
    this.annotationsOpen = false;
  }

  cancelAnnotationEditor(): void {
    this.clearAnnotationAutosaveTimeout();
    this.pendingSelection = null;
    this.editingAnnotation = null;
    this.annotationEditorOpen = false;
    this.resetAnnotationDraft();
    this.annotationNote = '';
    this.annotationError = null;
    if (!this.engine) {
      return;
    }
    this.clearSelectionInProgress = true;
    try {
      this.engine.clearSelection();
    } finally {
      queueMicrotask(() => {
        this.clearSelectionInProgress = false;
      });
    }
  }

  private resetAnnotationDraft(): void {
    this.annotationStyle = 'highlight';
    this.annotationStyles = new Set();
    this.annotationDecorationColors = {
      highlight: 'yellow',
      underline: 'sky-blue',
      strikethrough: 'vermilion',
    };
    this.annotationColorPalette = null;
    this.annotationNoteOpen = false;
  }

  async saveAnnotation(closeEditor = true): Promise<void> {
    if (
      this.annotationBusy ||
      !this.book ||
      !this.engine ||
      !this.pendingSelection
    ) {
      return;
    }
    this.annotationBusy = true;
    this.annotationError = null;
    try {
      const timestamp = new Date().toISOString();
      const note = this.annotationNote.trim();
      const decorations = ANNOTATION_STYLE_ORDER.filter((style) =>
        this.annotationStyles.has(style),
      ).map((style) => ({
        style,
        color: this.annotationDecorationColors[style],
      }));
      if (decorations.length === 0 && !note) {
        if (this.editingAnnotation) {
          const annotation = this.editingAnnotation;
          this.annotationBusy = false;
          await this.removeAnnotation(annotation);
          this.cancelAnnotationEditor();
        }
        return;
      }
      const primaryDecoration = decorations[0] ?? {
        style: this.editingAnnotation?.style ?? 'highlight',
        color: this.editingAnnotation?.color ?? 'yellow',
      };
      const annotation: PublicationAnnotation = {
        schemaVersion: 1,
        id: this.editingAnnotation?.id ?? crypto.randomUUID(),
        bookId: this.book.id,
        format: this.book.format,
        deviceId: getDeviceId(),
        locator: structuredClone(this.pendingSelection.locator),
        color: primaryDecoration.color,
        style: primaryDecoration.style,
        decorations,
        note: note || undefined,
        createdAt: this.editingAnnotation?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await this.repository.saveAnnotation(annotation);
      this.annotations = [
        annotation,
        ...this.annotations.filter(
          (candidate) => candidate.id !== annotation.id,
        ),
      ];
      await this.journalAnnotation(annotation);
      await this.engine.setAnnotations(this.annotations);
      if (closeEditor) {
        this.cancelAnnotationEditor();
      } else {
        this.editingAnnotation = annotation;
      }
    } catch (error) {
      this.annotationError =
        error instanceof Error ? error.message : 'Unable to save annotation';
    } finally {
      this.annotationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async removeAnnotation(annotation: PublicationAnnotation): Promise<boolean> {
    if (this.annotationBusy) {
      return false;
    }
    this.annotationBusy = true;
    this.annotationError = null;
    let removed = false;
    try {
      const timestamp = new Date().toISOString();
      const tombstone: PublicationAnnotation = {
        ...annotation,
        deviceId: getDeviceId(),
        updatedAt: timestamp,
        deletedAt: timestamp,
      };
      await this.repository.saveAnnotation(tombstone);
      this.annotations = this.annotations.filter(
        (candidate) => candidate.id !== annotation.id,
      );
      await this.engine?.setAnnotations(this.annotations);
      await this.journalAnnotation(tombstone);
      this.offerAnnotationUndo(tombstone);
      removed = true;
    } catch (error) {
      this.annotationError =
        error instanceof Error ? error.message : 'Unable to remove annotation';
    } finally {
      this.annotationBusy = false;
      this.changeDetector.markForCheck();
    }
    return removed;
  }

  async removeAnnotationDecoration(
    annotation: PublicationAnnotation,
    style: PublicationAnnotationStyle,
  ): Promise<void> {
    const decorations = annotationDecorations(annotation).filter(
      (decoration) => decoration.style !== style,
    );
    if (decorations.length === annotationDecorations(annotation).length) {
      return;
    }
    if (decorations.length === 0 && !annotation.note) {
      if (await this.removeAnnotation(annotation)) {
        this.refreshOpenAnnotationGroup();
      }
      return;
    }
    if (this.annotationBusy) {
      return;
    }
    this.annotationBusy = true;
    this.annotationError = null;
    try {
      const primaryDecoration = decorations[0] ?? {
        style: annotation.style ?? 'highlight',
        color: annotation.color,
      };
      const updated: PublicationAnnotation = {
        ...annotation,
        deviceId: getDeviceId(),
        color: primaryDecoration.color,
        style: primaryDecoration.style,
        decorations,
        updatedAt: timestampAfter(annotation.updatedAt),
      };
      await this.repository.saveAnnotation(updated);
      this.annotations = [
        updated,
        ...this.annotations.filter((candidate) => candidate.id !== updated.id),
      ];
      await this.journalAnnotation(updated);
      await this.engine?.setAnnotations(this.annotations);
      this.refreshOpenAnnotationGroup();
      this.annotationStatus = `${this.annotationStyleLabel(style)} removed.`;
      this.annotationStatusIsError = false;
      this.scheduleAnnotationStatusDismissal(4_000);
    } catch (error) {
      this.annotationError =
        error instanceof Error
          ? error.message
          : `Unable to remove ${this.annotationStyleLabel(style).toLocaleLowerCase()}`;
    } finally {
      this.annotationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  private refreshOpenAnnotationGroup(): void {
    if (!this.annotationGroupOpen) {
      return;
    }
    const ids = new Set(
      this.annotationGroup.map((annotation) => annotation.id),
    );
    this.annotationGroup = this.annotations.filter((annotation) =>
      ids.has(annotation.id),
    );
    if (this.annotationGroup.length === 0) {
      this.closeAnnotationGroup();
    }
  }

  async removeEditingAnnotation(): Promise<void> {
    const annotation = this.editingAnnotation;
    if (!annotation) {
      return;
    }
    if (await this.removeAnnotation(annotation)) {
      this.cancelAnnotationEditor();
    }
  }

  async undoAnnotationRemoval(): Promise<void> {
    const deletedAnnotation = this.deletedAnnotation;
    if (!deletedAnnotation || this.annotationBusy) {
      return;
    }
    this.clearAnnotationStatusTimeout();
    this.annotationBusy = true;
    this.annotationError = null;
    this.annotationStatus = 'Restoring annotation…';
    this.annotationStatusIsError = false;
    this.changeDetector.markForCheck();
    try {
      const restored: PublicationAnnotation = {
        ...deletedAnnotation,
        deviceId: getDeviceId(),
        updatedAt: timestampAfter(deletedAnnotation.updatedAt),
        deletedAt: undefined,
      };
      await this.repository.saveAnnotation(restored);
      this.annotations = [
        restored,
        ...this.annotations.filter((candidate) => candidate.id !== restored.id),
      ];
      await this.journalAnnotation(restored);
      await this.engine?.setAnnotations(this.annotations);
      this.deletedAnnotation = null;
      this.annotationStatus = 'Annotation restored.';
      this.scheduleAnnotationStatusDismissal(4_000);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to restore annotation';
      this.annotationError = message;
      this.annotationStatus = message;
      this.annotationStatusIsError = true;
    } finally {
      this.annotationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  dismissAnnotationStatus(): void {
    this.clearAnnotationStatusTimeout();
    this.deletedAnnotation = null;
    this.annotationStatus = null;
    this.annotationStatusIsError = false;
    this.changeDetector.markForCheck();
  }

  async goToAnnotation(annotation: PublicationAnnotation): Promise<void> {
    this.clearProgressMilestonePin();
    await this.engine?.goTo(annotation.locator);
    this.closeReaderPanelsForReading();
  }

  get filteredAnnotations(): readonly PublicationAnnotation[] {
    const query = this.annotationQuery.trim().toLocaleLowerCase();
    return this.annotations
      .filter((annotation) => {
        if (
          this.annotationFilter !== 'all' &&
          (this.annotationFilter === 'notes'
            ? !annotation.note
            : !annotationHasStyle(annotation, this.annotationFilter))
        ) {
          return false;
        }
        if (!query) {
          return true;
        }
        return [
          annotation.locator.text?.highlight,
          annotation.note,
          annotation.locator.title,
          this.annotationLocationLabel(annotation),
          this.annotationStyleSummary(annotation),
        ].some((value) => value?.toLocaleLowerCase().includes(query));
      })
      .sort((left, right) => this.compareAnnotationOverviewOrder(left, right));
  }

  annotationCount(filter: AnnotationFilter): number {
    if (filter === 'all') {
      return this.annotations.length;
    }
    if (filter === 'notes') {
      return this.annotations.filter((annotation) => !!annotation.note).length;
    }
    return this.annotations.filter((annotation) =>
      annotationHasStyle(annotation, filter),
    ).length;
  }

  setAnnotationFilter(filter: AnnotationFilter): void {
    this.annotationFilter = filter;
    this.annotationExportMessage = null;
  }

  get annotationOverviewCustomized(): boolean {
    return (
      this.annotationQuery.trim().length > 0 ||
      this.annotationFilter !== 'all' ||
      this.annotationSort !== 'reading-order'
    );
  }

  clearAnnotationSearch(): void {
    this.annotationQuery = '';
    this.annotationExportMessage = null;
    this.queueFocus(this.annotationSearchInput?.nativeElement);
  }

  resetAnnotationOverview(): void {
    this.annotationQuery = '';
    this.annotationFilter = 'all';
    this.annotationSort = 'reading-order';
    this.annotationExportMessage = null;
    this.queueFocus(this.annotationSearchInput?.nativeElement);
  }

  async exportShownAnnotations(): Promise<void> {
    const book = this.book;
    const annotations = this.filteredAnnotations;
    if (!book || annotations.length === 0 || this.annotationExportBusy) {
      return;
    }
    this.annotationExportBusy = true;
    this.annotationError = null;
    this.annotationExportMessage = null;
    this.changeDetector.markForCheck();
    try {
      const result = await this.annotationExports.exportAnnotations(
        book,
        annotations,
      );
      this.annotationExportMessage =
        result.status === 'cancelled'
          ? 'Annotation export cancelled.'
          : `${result.annotationCount} ${
              result.annotationCount === 1 ? 'annotation' : 'annotations'
            } saved as ${result.fileName}.`;
    } catch (error) {
      this.annotationError =
        error instanceof Error ? error.message : 'Unable to export annotations';
    } finally {
      this.annotationExportBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  private compareAnnotationOverviewOrder(
    left: PublicationAnnotation,
    right: PublicationAnnotation,
  ): number {
    if (this.annotationSort === 'updated-desc') {
      return (
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id)
      );
    }

    const leftPosition = finiteAnnotationLocation(
      left.locator.locations?.position,
    );
    const rightPosition = finiteAnnotationLocation(
      right.locator.locations?.position,
    );
    if (leftPosition !== null && rightPosition !== null) {
      const positionOrder = leftPosition - rightPosition;
      if (positionOrder !== 0) {
        return positionOrder;
      }
    }

    const leftProgression = finiteAnnotationLocation(
      left.locator.locations?.totalProgression,
    );
    const rightProgression = finiteAnnotationLocation(
      right.locator.locations?.totalProgression,
    );
    if (leftProgression !== null && rightProgression !== null) {
      const progressionOrder = leftProgression - rightProgression;
      if (progressionOrder !== 0) {
        return progressionOrder;
      }
    }

    return (
      left.locator.href.localeCompare(right.locator.href) ||
      (left.locator.locations?.fragments?.join('|') ?? '').localeCompare(
        right.locator.locations?.fragments?.join('|') ?? '',
      ) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  }

  annotationStyleOf(
    annotation: PublicationAnnotation,
  ): PublicationAnnotationStyle {
    return annotationDecorations(annotation)[0]?.style ?? 'highlight';
  }

  annotationStyleSummary(annotation: PublicationAnnotation): string {
    const labels = annotationDecorations(annotation).map((decoration) =>
      this.annotationStyleLabel(decoration.style),
    );
    return labels.length > 0 ? labels.join(' + ') : 'Note';
  }

  annotationStyleLabel(style: PublicationAnnotationStyle): string {
    switch (style) {
      case 'underline':
        return 'Underline';
      case 'strikethrough':
        return 'Strikethrough';
      default:
        return 'Highlight';
    }
  }

  annotationStyleIcon(style: PublicationAnnotationStyle): string {
    switch (style) {
      case 'underline':
        return 'format_underlined';
      case 'strikethrough':
        return 'strikethrough_s';
      default:
        return 'highlight';
    }
  }

  annotationLocationLabel(annotation: PublicationAnnotation): string {
    const title = annotation.locator.title?.trim();
    if (title) {
      return title;
    }
    const position = annotation.locator.locations?.position;
    if (position) {
      return `Page ${position}`;
    }
    const totalProgression = annotation.locator.locations?.totalProgression;
    if (totalProgression !== undefined && Number.isFinite(totalProgression)) {
      return `${Math.round(clamp(totalProgression, 0, 1) * 100)}% of book`;
    }
    return 'Saved location';
  }

  async goToPdfPage(pageNumber: number): Promise<void> {
    this.clearProgressMilestonePin();
    await this.engine?.goTo({
      href: '',
      type: 'application/pdf',
      title: `Page ${pageNumber}`,
      locations: {
        fragments: [`page=${pageNumber}`],
        position: pageNumber,
      },
    });
    this.closeReaderPanelsForReading();
  }

  submitPdfPassword(event: Event): void {
    event.preventDefault();
    const password = this.pdfPassword;
    if (!password || !this.passwordChallenge) {
      return;
    }
    const challenge = this.passwordChallenge;
    this.passwordChallenge = null;
    this.passwordError = null;
    this.pdfPassword = '';
    challenge.submit(password);
  }

  cancelPdfPassword(): void {
    const challenge = this.passwordChallenge;
    this.passwordChallenge = null;
    this.pdfPassword = '';
    this.passwordError = null;
    challenge?.cancel();
  }

  cancelExternalLink(): void {
    this.pendingExternalUrl = null;
    this.externalLinkError = null;
  }

  async openExternalLink(): Promise<void> {
    const url = this.pendingExternalUrl;
    if (!url) {
      return;
    }
    this.pendingExternalUrl = null;
    this.externalLinkError = null;
    try {
      await this.platform.openExternalUrl(url);
    } catch {
      this.externalLinkError = 'Unable to open this link in your browser.';
    } finally {
      this.changeDetector.markForCheck();
    }
  }

  async updateEpubPreferences(
    patch: Partial<EpubReaderPreferences>,
  ): Promise<void> {
    this.epubPreferences = { ...this.epubPreferences, ...patch };
    await this.persistPreferences(this.epubPreferences);
  }

  async updatePdfPreferences(
    patch: Partial<PdfReaderPreferences>,
  ): Promise<void> {
    this.pdfPreferences = { ...this.pdfPreferences, ...patch };
    await this.persistPreferences(this.pdfPreferences);
  }

  private requestZoom(direction: ReaderZoomDirection): void {
    this.zoomWrite = this.zoomWrite
      .then(async () => {
        const percent = await this.zoomPublication(direction);
        this.showZoomIndicator(percent);
      })
      .catch((error) => {
        this.navigationError =
          error instanceof Error ? error.message : 'Unable to change zoom';
        this.changeDetector.markForCheck();
      });
  }

  private async zoomPublication(
    direction: ReaderZoomDirection,
  ): Promise<number> {
    const delta =
      direction === 'in' ? WHEEL_ZOOM_STEP_PERCENT : -WHEEL_ZOOM_STEP_PERCENT;
    if (this.book?.format === 'epub') {
      const fontSizePercent = clamp(
        this.epubPreferences.fontSizePercent + delta,
        EPUB_MINIMUM_ZOOM_PERCENT,
        EPUB_MAXIMUM_ZOOM_PERCENT,
      );
      if (fontSizePercent !== this.epubPreferences.fontSizePercent) {
        await this.updateEpubPreferences({ fontSizePercent });
      }
      return fontSizePercent;
    }

    const zoomPercent = clamp(
      this.pdfPreferences.zoomPercent + delta,
      PDF_MINIMUM_ZOOM_PERCENT,
      PDF_MAXIMUM_ZOOM_PERCENT,
    );
    if (
      zoomPercent !== this.pdfPreferences.zoomPercent ||
      this.pdfPreferences.zoomMode !== 'custom'
    ) {
      await this.updatePdfPreferences({ zoomMode: 'custom', zoomPercent });
    }
    return zoomPercent;
  }

  private showZoomIndicator(percent: number): void {
    if (this.destroyed) {
      return;
    }
    if (this.zoomIndicatorTimeout) {
      clearTimeout(this.zoomIndicatorTimeout);
    }
    this.zoomIndicatorPercent = percent;
    this.changeDetector.markForCheck();
    this.zoomIndicatorTimeout = setTimeout(() => {
      this.zoomIndicatorTimeout = null;
      this.zoomIndicatorPercent = null;
      this.changeDetector.markForCheck();
    }, ZOOM_INDICATOR_DURATION_MS);
  }

  async rotatePdf(delta: -90 | 90): Promise<void> {
    const rotation = ((this.pdfPreferences.rotation + delta + 360) %
      360) as PdfRotation;
    await this.updatePdfPreferences({ rotation });
  }

  async runSearch(event: Event): Promise<void> {
    event.preventDefault();
    const query = this.searchQuery.trim();
    if (!query || !this.engine) {
      this.searchResults = [];
      return;
    }

    this.searching = true;
    this.searchError = null;
    this.searchResults = [];
    this.changeDetector.markForCheck();

    try {
      const results: SearchResult[] = [];
      for await (const result of this.engine.search(query)) {
        results.push(result);
        if (results.length >= 100) {
          break;
        }
      }
      this.searchResults = results;
    } catch (error) {
      this.searchError =
        error instanceof Error ? error.message : 'Search failed';
    } finally {
      this.searching = false;
      this.changeDetector.markForCheck();
    }
  }

  async goToSearchResult(result: SearchResult): Promise<void> {
    await this.engine?.goTo(result.locator);
    this.closeReaderPanelsForReading();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    const readerRoot = this.readerRoot.nativeElement;
    if (this.progressSliderGeometryRefreshId !== null) {
      cancelAnimationFrame(this.progressSliderGeometryRefreshId);
      this.progressSliderGeometryRefreshId = null;
    }
    if (readerRoot.ownerDocument.fullscreenElement === readerRoot) {
      void readerRoot.ownerDocument.exitFullscreen().catch(() => undefined);
    }
    this.removeTransientBackHandler();
    this.removeBackgroundListener?.();
    this.removeRelocationListener?.();
    this.removeSelectionListener?.();
    this.removeSelectionActionRequestListener?.();
    this.removeAnnotationActivationListener?.();
    this.removeNavigationRequestListener?.();
    this.removeCommandRequestListener?.();
    this.removeZoomRequestListener?.();
    this.removeExternalLinkRequestListener?.();
    if (this.zoomIndicatorTimeout) {
      clearTimeout(this.zoomIndicatorTimeout);
      this.zoomIndicatorTimeout = null;
    }
    this.clearAnnotationAutosaveTimeout();
    this.clearAnnotationStatusTimeout();
    this.passwordChallenge?.cancel();
    this.removePasswordListener?.();
    const engine = this.engine;
    void this.queueProgressSave(this.currentLocator ?? undefined).catch(
      () => undefined,
    );
    // Tear down renderer observers before Angular removes the viewport. Waiting
    // for IndexedDB would leave EPUB resize observers attached to a detached
    // container and can surface an undelivered ResizeObserver notification.
    void engine?.close().catch(() => undefined);
  }

  private get activeReaderPanel(): ReaderPanel | null {
    if (this.actionsOpen) {
      return 'actions';
    }
    if (this.tocOpen) {
      return 'toc';
    }
    if (this.searchOpen) {
      return 'search';
    }
    if (this.settingsOpen) {
      return 'settings';
    }
    if (this.thumbnailsOpen) {
      return 'thumbnails';
    }
    if (this.bookmarksOpen) {
      return 'bookmarks';
    }
    if (this.annotationsOpen) {
      return 'annotations';
    }
    return null;
  }

  private toggleReaderPanel(panel: ReaderPanel): void {
    const activePanel = this.activeReaderPanel;
    const opening = activePanel !== panel;
    const returningFocusTarget = opening
      ? undefined
      : (this.readerPanelReturnFocus ?? this.readerPanelTriggerElement(panel));
    if (opening) {
      this.readerPanelReturnFocus =
        this.readerPanelTriggerElement(panel) ?? null;
    } else {
      this.readerPanelReturnFocus = null;
    }
    this.closeReaderPanels();
    if (opening) {
      this.setReaderPanelOpen(panel, true);
    }
    this.changeDetector.detectChanges();

    const focusTarget = opening
      ? panel === 'search'
        ? this.searchInput?.nativeElement
        : this.readerPanelElement(panel)
      : returningFocusTarget;
    this.queueFocus(focusTarget);
  }

  private closeReaderPanels(): void {
    this.actionsOpen = false;
    this.tocOpen = false;
    this.searchOpen = false;
    this.settingsOpen = false;
    this.thumbnailsOpen = false;
    this.bookmarksOpen = false;
    this.annotationsOpen = false;
  }

  private closeReaderPanelsAndRestoreTrigger(): boolean {
    const panel = this.activeReaderPanel;
    if (!panel) {
      return false;
    }
    const returningFocusTarget =
      this.readerPanelReturnFocus ?? this.readerPanelTriggerElement(panel);
    this.readerPanelReturnFocus = null;
    this.closeReaderPanels();
    this.changeDetector.detectChanges();
    this.queueFocus(returningFocusTarget);
    return true;
  }

  private closeReaderPanelsForReading(): void {
    this.readerPanelReturnFocus = null;
    this.closeReaderPanels();
    this.changeDetector.detectChanges();
    this.queueFocus(this.readerRoot.nativeElement);
  }

  private setReaderPanelOpen(panel: ReaderPanel, open: boolean): void {
    switch (panel) {
      case 'actions':
        this.actionsOpen = open;
        break;
      case 'toc':
        this.tocOpen = open;
        break;
      case 'search':
        this.searchOpen = open;
        break;
      case 'settings':
        this.settingsOpen = open;
        break;
      case 'thumbnails':
        this.thumbnailsOpen = open;
        break;
      case 'bookmarks':
        this.bookmarksOpen = open;
        break;
      case 'annotations':
        this.annotationsOpen = open;
        break;
    }
  }

  private readerPanelElement(panel: ReaderPanel): HTMLElement | undefined {
    switch (panel) {
      case 'actions':
        return this.actionsPanel?.nativeElement;
      case 'toc':
        return this.tocPanel?.nativeElement;
      case 'search':
        return this.searchPanel?.nativeElement;
      case 'settings':
        return this.settingsPanel?.nativeElement;
      case 'thumbnails':
        return this.thumbnailsPanel?.nativeElement;
      case 'bookmarks':
        return this.bookmarksPanel?.nativeElement;
      case 'annotations':
        return this.annotationsPanel?.nativeElement;
    }
  }

  private readerPanelTriggerElement(
    panel: ReaderPanel,
  ): HTMLButtonElement | undefined {
    const queriedTrigger = this.readerRoot.nativeElement.querySelector(
      `[aria-controls="reader-${panel}-panel"]`,
    ) as HTMLButtonElement | null;
    return (
      queriedTrigger ??
      {
        actions: this.actionsTrigger,
        toc: this.tocTrigger,
        search: this.searchTrigger,
        settings: this.settingsTrigger,
        thumbnails: this.thumbnailsTrigger,
        bookmarks: this.bookmarksTrigger,
        annotations: this.annotationsTrigger,
      }[panel]?.nativeElement
    );
  }

  private queueFocus(element: HTMLElement | undefined): void {
    if (!element) {
      return;
    }
    setTimeout(() => {
      if (element.isConnected) {
        element.focus({ preventScroll: true });
      }
    }, 0);
  }

  private closeTransientReaderUi(): boolean {
    if (this.pendingExternalUrl) {
      this.cancelExternalLink();
      this.changeDetector.markForCheck();
      return true;
    }
    if (this.passwordChallenge) {
      this.cancelPdfPassword();
      this.changeDetector.markForCheck();
      return true;
    }

    if (this.pendingSelection) {
      this.cancelAnnotationEditor();
      this.changeDetector.markForCheck();
      return true;
    }
    if (this.annotationGroupOpen) {
      this.closeAnnotationGroup();
      this.changeDetector.markForCheck();
      return true;
    }
    if (this.closeKeyboardShortcuts()) {
      return true;
    }
    return this.closeReaderPanelsAndRestoreTrigger();
  }

  private handleReaderCommand(command: ReaderCommand): boolean {
    if (command === 'dismiss') {
      return this.closeTransientReaderUi();
    }
    if (this.shortcutsOpen) {
      return true;
    }
    if (
      this.passwordChallenge ||
      this.pendingExternalUrl ||
      this.pendingSelection ||
      this.annotationGroupOpen
    ) {
      return true;
    }
    if (command === 'shortcuts') {
      this.openKeyboardShortcuts();
      return true;
    }
    if (this.loading || this.errorMessage) {
      return false;
    }

    switch (command) {
      case 'toc':
        if (this.tableOfContents.length > 0) {
          this.toggleToc();
        }
        return true;
      case 'search':
        this.toggleSearch();
        return true;
      case 'toggle-bookmark':
        void this.toggleCurrentBookmark();
        return true;
      case 'bookmarks':
        this.toggleBookmarks();
        return true;
      case 'annotations':
        this.toggleAnnotations();
        return true;
      case 'settings':
        this.toggleSettings();
        return true;
      case 'fullscreen':
        void this.toggleImmersiveMode();
        return true;
    }
  }

  private openKeyboardShortcuts(): void {
    if (this.shortcutsOpen) {
      return;
    }
    const activePanel = this.activeReaderPanel;
    const activeElement =
      this.readerRoot.nativeElement.ownerDocument.activeElement;
    this.shortcutsReturnFocus = activePanel
      ? (this.readerPanelReturnFocus ??
        this.readerPanelTriggerElement(activePanel) ??
        this.readerRoot.nativeElement)
      : activeElement instanceof HTMLElement &&
          this.readerRoot.nativeElement.contains(activeElement)
        ? activeElement
        : (this.shortcutsTrigger?.nativeElement ??
          this.readerRoot.nativeElement);
    this.readerPanelReturnFocus = null;
    this.closeReaderPanels();
    this.shortcutsOpen = true;
    this.changeDetector.detectChanges();
    this.queueFocus(this.shortcutsDialog?.nativeElement);
  }

  private closeKeyboardShortcuts(): boolean {
    if (!this.shortcutsOpen) {
      return false;
    }
    const returnFocus =
      this.shortcutsReturnFocus ??
      this.shortcutsTrigger?.nativeElement ??
      this.readerRoot.nativeElement;
    this.shortcutsOpen = false;
    this.shortcutsReturnFocus = null;
    this.changeDetector.detectChanges();
    this.queueFocus(returnFocus);
    return true;
  }

  private async navigate(direction: ReaderNavigationDirection): Promise<void> {
    const engine = this.engine;
    this.clearProgressMilestonePin();
    if (!engine || this.loading || this.readerPanelOpen) {
      return;
    }
    if (this.navigationBusy) {
      if (this.navigationLoopActive) {
        this.pendingNavigationDirection = direction;
      }
      return;
    }
    this.navigationLoopActive = true;
    this.navigationBusy = true;
    this.navigationError = null;
    this.changeDetector.markForCheck();
    try {
      let nextDirection: ReaderNavigationDirection | null = direction;
      while (nextDirection) {
        this.pendingNavigationDirection = null;
        if (nextDirection === 'next') {
          await engine.next();
        } else {
          await engine.previous();
        }
        nextDirection = this.pendingNavigationDirection;
      }
    } catch (error) {
      this.navigationError =
        error instanceof Error
          ? error.message
          : 'Unable to navigate this publication';
    } finally {
      this.pendingNavigationDirection = null;
      this.navigationLoopActive = false;
      this.navigationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  private updateVisibleTocItems(): void {
    this.visibleTocItems = this.tocItems.filter((item) =>
      item.parentKeys.every(
        (parentKey) => !this.collapsedTocItemKeys.has(parentKey),
      ),
    );
  }

  private queueProgressSave(locator?: PublicationLocator): Promise<void> {
    this.progressWrite = this.progressWrite
      .catch(() => undefined)
      .then(() => this.saveProgress(locator));
    return this.progressWrite;
  }

  private async journalBookmark(bookmark: PublicationBookmark): Promise<void> {
    try {
      await this.syncJournal.append({
        entity: 'bookmark',
        entityId: bookmark.id,
        operation: 'upsert',
        payload: bookmark,
      });
    } catch {
      // The durable local bookmark remains available while sync is offline.
    }
  }

  private async journalAnnotation(
    annotation: PublicationAnnotation,
  ): Promise<void> {
    try {
      await this.syncJournal.append({
        entity: 'annotation',
        entityId: annotation.id,
        operation: 'upsert',
        payload: annotation,
      });
    } catch {
      // The durable local annotation remains available while sync is offline.
    }
  }

  private offerAnnotationUndo(tombstone: PublicationAnnotation): void {
    this.clearAnnotationStatusTimeout();
    this.deletedAnnotation = structuredClone(tombstone);
    this.annotationStatus = 'Annotation deleted.';
    this.annotationStatusIsError = false;
    this.scheduleAnnotationStatusDismissal(10_000);
  }

  private scheduleAnnotationStatusDismissal(delayMs: number): void {
    this.annotationStatusTimeout = setTimeout(() => {
      this.annotationStatusTimeout = null;
      this.deletedAnnotation = null;
      this.annotationStatus = null;
      this.annotationStatusIsError = false;
      this.changeDetector.markForCheck();
    }, delayMs);
  }

  private clearAnnotationStatusTimeout(): void {
    if (!this.annotationStatusTimeout) {
      return;
    }
    clearTimeout(this.annotationStatusTimeout);
    this.annotationStatusTimeout = null;
  }

  private scheduleAnnotationAutosave(): void {
    this.clearAnnotationAutosaveTimeout();
    this.annotationAutosaveTimeout = setTimeout(() => {
      this.annotationAutosaveTimeout = null;
      if (this.canSaveAnnotation) {
        void this.autosaveAnnotation();
      }
    }, 400);
  }

  private async autosaveAnnotation(): Promise<void> {
    await this.waitForAnnotationIdle();
    if (this.canSaveAnnotation) {
      await this.saveAnnotation(false);
    }
  }

  private async waitForAnnotationIdle(): Promise<void> {
    while (this.annotationBusy && !this.destroyed) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private clearAnnotationAutosaveTimeout(): void {
    if (!this.annotationAutosaveTimeout) {
      return;
    }
    clearTimeout(this.annotationAutosaveTimeout);
    this.annotationAutosaveTimeout = null;
  }

  private async persistPreferences(
    preferences: ReaderPreferences,
  ): Promise<void> {
    await this.engine?.applyPreferences(preferences);
    // Persist only after the renderer has completed its preference lifecycle.
    // This keeps rapid reader inputs from observing saved state while an EPUB
    // iframe is still being replaced and its interaction handlers restored.
    await this.repository.saveReaderPreferences(preferences);
  }

  private async saveProgress(
    relocatedLocator?: PublicationLocator,
  ): Promise<void> {
    if (!this.book || !this.engine) {
      return;
    }

    const locator = relocatedLocator ?? this.engine.currentLocator();
    if (!locator) {
      return;
    }
    const serializedLocator = serializeLocator(locator);
    if (serializedLocator === this.lastPersistedLocator) {
      return;
    }

    const totalProgression = locator.locations?.totalProgression ?? 0;
    const readingProgress: ReadingProgress = {
      schemaVersion: 1,
      bookId: this.book.id,
      format: this.book.format,
      deviceId: getDeviceId(),
      locator,
      furthestTotalProgression: Math.max(
        this.progress?.furthestTotalProgression ?? 0,
        totalProgression,
      ),
      updatedAt: new Date().toISOString(),
      appVersion: '0.0.0',
    };
    this.progress = readingProgress;
    if (this.book?.id) {
      this.formatProgressPercentByVariant = new Map(
        this.formatProgressPercentByVariant,
      ).set(this.book.id, readingProgressPercent(readingProgress));
    }
    await this.repository.saveProgress(readingProgress);
    this.lastPersistedLocator = serializedLocator;
    try {
      await this.syncJournal.append({
        entity: 'progress',
        entityId: this.book.id,
        operation: 'upsert',
        payload: readingProgress,
      });
    } catch {
      // Local progress is authoritative; sync availability must never block reading.
    }
  }

  get hasProgressMilestones(): boolean {
    return this.chapterProgressMilestones.length > 0;
  }

  private alignManualProgressPercent(): void {
    if (this.manualProgressPercent === null) {
      return;
    }
    if (this.pinnedProgressMilestoneKey !== null) {
      return;
    }
    const currentPercent = this.overallProgressPercent;
    if (currentPercent === null) {
      return;
    }
    if (
      Math.abs(currentPercent - this.manualProgressPercent) >
      PROGRESS_MILESTONE_MATCH_TOLERANCE
    ) {
      this.manualProgressPercent = null;
    }
  }

  private clearProgressMilestonePin(): void {
    this.pinnedProgressMilestoneKey = null;
    this.manualProgressPercent = null;
  }
}

function serializeLocator(locator: ReadingProgress['locator']): string {
  return JSON.stringify(locator);
}

function locatorKey(locator: PublicationLocator): string {
  return JSON.stringify({
    href: locator.href,
    type: locator.type,
    fragments: locator.locations?.fragments ?? [],
    progression: locator.locations?.progression,
    position: locator.locations?.position,
  });
}

function createBookmarkLabel(
  locator: PublicationLocator,
  sequence: number,
): string {
  const title = locator.title?.trim();
  if (title) {
    return title;
  }
  const position = locator.locations?.position;
  if (position) {
    return `Page ${position}`;
  }
  const totalProgression = locator.locations?.totalProgression;
  if (totalProgression !== undefined) {
    return `${Math.round(totalProgression * 100)}%`;
  }
  const fileName = locator.href.split('#', 1)[0].split('/').pop();
  if (fileName) {
    let decoded = fileName;
    try {
      decoded = decodeURIComponent(fileName);
    } catch {
      // Keep the safe raw path segment when a publication uses bad escaping.
    }
    decoded = decoded
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    if (decoded) {
      return decoded;
    }
  }
  return `Bookmark ${sequence}`;
}

interface FlattenedTocEntry {
  entry: TocEntry;
  depth: number;
  number: string | null;
  displayLabel: string;
  key: string;
  parentKeys: readonly string[];
  hasChildren: boolean;
}

interface ReaderProgressMilestone {
  readonly key: string;
  readonly value: number;
  readonly label: string;
  readonly locator: TocEntry['locator'];
  readonly tocItemKey: string;
  readonly tocItemIndex: number;
}

function deriveChapterProgressMilestones(
  tocItems: readonly FlattenedTocEntry[],
  pageStatus: ReaderPageStatus | null,
): readonly ReaderProgressMilestone[] {
  const topLevel = tocItems.filter((entry) => entry.depth === 0);
  if (topLevel.length === 0) {
    return [];
  }

  const chapterCandidates = chooseChapterMilestoneEntries(topLevel, tocItems);
  if (chapterCandidates.length < 2) {
    return [];
  }

  const itemIndexByKey = new Map(
    tocItems.map((item, index) => [item.key, index]),
  );
  const milestones: ReaderProgressMilestone[] = [];

  for (let index = 0; index < chapterCandidates.length; index += 1) {
    const item = chapterCandidates[index];
    const value = extractLocatorProgressionPercent(
      item.entry.locator,
      index,
      chapterCandidates.length - 1,
      pageStatus,
    );
    milestones.push({
      key: `${item.key}:${item.entry.locator.href}:${item.entry.locator.title ?? ''}:${milestones.length}`,
      value,
      label: item.displayLabel,
      locator: item.entry.locator,
      tocItemKey: item.key,
      tocItemIndex: itemIndexByKey.get(item.key) ?? index,
    });
  }

  return milestones;
}

function chooseChapterMilestoneEntries(
  topLevel: readonly FlattenedTocEntry[],
  tocItems: readonly FlattenedTocEntry[],
): readonly FlattenedTocEntry[] {
  const topLevelChapterCandidates = topLevel.filter(isChapterLikeTocEntry);
  if (topLevelChapterCandidates.length >= 2) {
    return topLevelChapterCandidates;
  }

  const maximumDepth = tocItems.reduce(
    (result, entry) => Math.max(result, entry.depth),
    0,
  );
  for (let depth = 1; depth <= maximumDepth; depth += 1) {
    const candidatesAtDepth = tocItems.filter(
      (entry) => entry.depth === depth && isChapterLikeTocEntry(entry),
    );
    if (candidatesAtDepth.length >= 2) {
      return candidatesAtDepth;
    }
  }

  if (topLevel.length >= 2 && topLevelChapterCandidates.length === 0) {
    return topLevel;
  }

  return topLevelChapterCandidates;
}

function isChapterLikeTocEntry(entry: FlattenedTocEntry): boolean {
  if (entry.entry.numbering === 'numbered') {
    return true;
  }
  if (entry.entry.numbering === 'unnumbered') {
    return false;
  }
  if (entry.number !== null) {
    return true;
  }
  if (
    entry.depth === 0 &&
    isLikelyNonChapterTopLevelTocTitle(entry.entry.title)
  ) {
    return false;
  }
  return (
    entry.depth > 0 ||
    !UNNUMBERED_TOP_LEVEL_TOC_TITLES.has(normalizeTocTitle(entry.entry.title))
  );
}

function extractLocatorProgressionPercent(
  locator: TocEntry['locator'],
  fallbackIndex: number,
  fallbackTotal: number,
  pageStatus: ReaderPageStatus | null,
): number {
  const directProgression =
    locator.locations?.totalProgression ?? locator.locations?.progression;
  if (
    typeof directProgression === 'number' &&
    Number.isFinite(directProgression)
  ) {
    return normalizeProgressPercent(directProgression * 100);
  }

  const directPosition = locator.locations?.position;
  if (
    pageStatus &&
    pageStatus.scope === 'publication' &&
    pageStatus.total > 1 &&
    typeof directPosition === 'number' &&
    Number.isFinite(directPosition)
  ) {
    const cappedPosition = clamp(directPosition, 1, pageStatus.total);
    return normalizeProgressPercent(
      ((cappedPosition - 1) / (pageStatus.total - 1)) * 100,
    );
  }

  if (fallbackTotal <= 0) {
    return 0;
  }

  return normalizeProgressPercent((fallbackIndex / fallbackTotal) * 100);
}

function inferLocatorProgressionPercent(
  locator: TocEntry['locator'],
  pageStatus: ReaderPageStatus | null,
): number | null {
  const directProgression =
    locator.locations?.totalProgression ?? locator.locations?.progression;
  if (
    typeof directProgression === 'number' &&
    Number.isFinite(directProgression)
  ) {
    return normalizeProgressPercent(directProgression * 100);
  }

  const directPosition = locator.locations?.position;
  if (
    pageStatus &&
    pageStatus.scope === 'publication' &&
    pageStatus.total > 1 &&
    typeof directPosition === 'number' &&
    Number.isFinite(directPosition)
  ) {
    const cappedPosition = clamp(directPosition, 1, pageStatus.total);
    return normalizeProgressPercent(
      ((cappedPosition - 1) / (pageStatus.total - 1)) * 100,
    );
  }

  return null;
}

function flattenToc(
  entries: readonly TocEntry[],
  depth = 0,
  parentNumber: string | null = null,
  parentCanNumber = true,
  parentKeys: readonly string[] = [],
  parentPath: readonly number[] = [],
): readonly FlattenedTocEntry[] {
  let numberedIndex = 0;
  return entries.flatMap((entry, index) => {
    const path = [...parentPath, index + 1];
    const numbered = parentCanNumber && shouldNumberTocEntry(entry, depth);
    if (numbered) {
      numberedIndex += 1;
    }
    const number = numbered
      ? parentNumber
        ? `${parentNumber}.${numberedIndex}`
        : String(numberedIndex)
      : null;
    const children = entry.children ?? [];
    const key = path.join('.');
    return [
      {
        entry,
        depth,
        number,
        displayLabel: tocDisplayLabel(entry.title, number),
        key,
        parentKeys,
        hasChildren: children.length > 0,
      },
      ...flattenToc(
        children,
        depth + 1,
        number,
        numbered,
        [...parentKeys, key],
        path,
      ),
    ];
  });
}

function tocDisplayLabel(title: string, number: string | null): string {
  if (!number) {
    return title;
  }
  const escapedNumber = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const authoredPrefix = new RegExp(
    `^\\s*${escapedNumber}(?:[.)]|\\s*[-–—:]\\s*|\\s+)`,
  );
  const titleWithoutDuplicateNumber = title.replace(authoredPrefix, '').trim();
  return `${number} ${titleWithoutDuplicateNumber || title.trim()}`;
}

function shouldNumberTocEntry(entry: TocEntry, depth: number): boolean {
  if (entry.numbering) {
    return entry.numbering === 'numbered';
  }
  if (depth === 0 && isLikelyNonChapterTopLevelTocTitle(entry.title)) {
    return false;
  }
  return (
    depth > 0 ||
    !UNNUMBERED_TOP_LEVEL_TOC_TITLES.has(normalizeTocTitle(entry.title))
  );
}

function isLikelyNonChapterTopLevelTocTitle(title: string): boolean {
  const normalized = normalizeTocTitle(title);
  return (
    normalized.startsWith('part ') ||
    normalized === 'part' ||
    normalized.startsWith('volume ') ||
    normalized === 'volume'
  );
}

function normalizeTocTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const WHEEL_NAVIGATION_INTERVAL_MS = 400;
const WHEEL_ZOOM_STEP_PERCENT = 5;
const ZOOM_INDICATOR_DURATION_MS = 1_200;
const EPUB_MINIMUM_ZOOM_PERCENT = 75;
const EPUB_MAXIMUM_ZOOM_PERCENT = 200;
const PDF_MINIMUM_ZOOM_PERCENT = 25;
const PDF_MAXIMUM_ZOOM_PERCENT = 400;
const PROGRESS_MILESTONE_MATCH_TOLERANCE = 0.6;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeProgressPercent(value: number): number {
  return Number(clamp(value, 0, 100).toFixed(2));
}

function readingProgressPercent(progress: ReadingProgress): number {
  const progression =
    progress.locator.locations?.totalProgression ?? progress.furthestTotalProgression;
  if (!Number.isFinite(progression)) {
    return 0;
  }
  return normalizeProgressPercent(progression * 100);
}

function finiteAnnotationLocation(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

const UNNUMBERED_TOP_LEVEL_TOC_TITLES = new Set([
  'about the author',
  'about the authors',
  'acknowledgements',
  'acknowledgments',
  'afterword',
  'bibliography',
  'colophon',
  'contents',
  'contributors',
  'copyright',
  'copyright page',
  'dedication',
  'endnotes',
  'epigraph',
  'epilogue',
  'foreword',
  'glossary',
  'half title',
  'index',
  'introduction',
  'notes',
  'preface',
  'prologue',
  'references',
  'table of contents',
  'title page',
]);

function getDeviceId(): string {
  const storageKey = 'omnia-reader-device-id';
  let deviceId = localStorage.getItem(storageKey);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(storageKey, deviceId);
  }
  return deviceId;
}

function timestampAfter(value: string): string {
  const previous = Date.parse(value);
  return new Date(
    Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0),
  ).toISOString();
}
