import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  BookRecord,
  DEFAULT_EPUB_READER_PREFERENCES,
  DEFAULT_PDF_READER_PREFERENCES,
  EpubReaderPreferences,
  keyboardNavigationDirection,
  PdfReaderPreferences,
  PdfRotation,
  PageNavigation,
  PublicationAnnotation,
  PublicationAnnotationColor,
  PublicationBookmark,
  PublicationLocator,
  PublicationMetadata,
  PublicationPasswordChallenge,
  PublicationSelection,
  ReaderEngine,
  ReaderNavigationDirection,
  ReaderPageStatus,
  ReaderPreferences,
  ReaderZoomDirection,
  ReadingProgress,
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
import { createBookSyncManifest } from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { BackNavigationService } from '../../back-navigation.service';
import { PdfThumbnailComponent } from './pdf-thumbnail.component';

type ReaderPanel =
  | 'toc'
  | 'search'
  | 'settings'
  | 'thumbnails'
  | 'bookmarks'
  | 'annotations';

@Component({
  selector: 'omnia-reader-page',
  templateUrl: './reader-page.component.html',
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
    CdkTrapFocus,
    NgClass,
    ScrollingModule,
    FormsModule,
    RouterLink,
    PdfThumbnailComponent,
  ],
})
export class ReaderPageComponent implements AfterViewInit, OnDestroy {
  @ViewChild('readerRoot', { static: true })
  private readerRoot!: ElementRef<HTMLElement>;

  @ViewChild('viewport', { static: true })
  private viewport!: ElementRef<HTMLElement>;

  @ViewChild('tocTrigger')
  private tocTrigger?: ElementRef<HTMLButtonElement>;

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

  @ViewChild('tocPanel')
  private tocPanel?: ElementRef<HTMLElement>;

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

  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly engines = inject(ReaderEngineRegistry);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly syncJournal = inject(SYNC_OPERATION_JOURNAL);
  private readonly platform = inject(PLATFORM_PORT);
  private readonly backNavigation = inject(BackNavigationService);

  book: BookRecord | null = null;
  metadata: PublicationMetadata | null = null;
  tableOfContents: readonly TocEntry[] = [];
  tocItems: readonly FlattenedTocEntry[] = [];
  visibleTocItems: readonly FlattenedTocEntry[] = [];
  searchResults: readonly SearchResult[] = [];
  searchQuery = '';
  searching = false;
  loading = true;
  errorMessage: string | null = null;
  searchError: string | null = null;
  tocOpen = false;
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
  pendingSelection: PublicationSelection | null = null;
  editingAnnotation: PublicationAnnotation | null = null;
  annotationColor: PublicationAnnotationColor = 'yellow';
  annotationNote = '';
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

  private engine: ReaderEngine | null = null;
  private progress: ReadingProgress | null = null;
  private currentLocator: PublicationLocator | null = null;
  private lastPersistedLocator = '';
  private readonly collapsedTocItemKeys = new Set<string>();
  private removeBackgroundListener: (() => void) | null = null;
  private removeRelocationListener: (() => void) | null = null;
  private removeSelectionListener: (() => void) | null = null;
  private removePasswordListener: (() => void) | null = null;
  private removeAnnotationActivationListener: (() => void) | null = null;
  private removeNavigationRequestListener: (() => void) | null = null;
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
      const [book, source, progress, bookmarks, annotations] =
        await Promise.all([
          this.repository.getBook(bookId),
          this.repository.getBookSource(bookId),
          this.repository.getProgress(bookId),
          this.repository.listBookmarks(bookId),
          this.repository.listAnnotations(bookId),
        ]);
      if (!book || !source) {
        throw new Error(
          'This publication is no longer available on this device',
        );
      }

      this.book = book;
      this.progress = progress;
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
      this.removeAnnotationActivationListener =
        this.engine.onAnnotationActivated?.((annotationId) => {
          const annotation = this.annotations.find(
            (candidate) => candidate.id === annotationId,
          );
          if (!annotation) {
            return;
          }
          this.beginEditAnnotation(annotation);
          this.changeDetector.markForCheck();
        }) ?? null;
      this.removeNavigationRequestListener =
        this.engine.onNavigationRequested?.((direction) => {
          void this.navigate(direction);
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
        if (!selection || this.pendingSelection) {
          return;
        }
        this.pendingSelection = selection;
        this.editingAnnotation = null;
        this.annotationColor = 'yellow';
        this.annotationNote = '';
        this.annotationError = null;
        this.changeDetector.markForCheck();
      });
      await this.engine.setAnnotations(this.annotations);
      if (progress) {
        await this.engine.goTo(progress.locator);
      }
      this.removeRelocationListener = this.engine.onRelocated((locator) => {
        this.currentLocator = locator;
        this.currentPageNumber = locator.locations?.position ?? 1;
        this.pageStatus = this.engine?.pageStatus?.() ?? null;
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

  onDocumentKeydown(event: KeyboardEvent): void {
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
    const progression = this.currentLocator?.locations?.totalProgression;
    if (progression !== undefined && Number.isFinite(progression)) {
      return Math.round(Math.min(1, Math.max(0, progression)) * 100);
    }
    if (this.pageStatus?.scope !== 'publication') {
      return null;
    }
    if (this.pageStatus.total <= 1) {
      return 100;
    }
    return Math.round(
      ((this.pageStatus.current - 1) / (this.pageStatus.total - 1)) * 100,
    );
  }

  get progressSeekingAvailable(): boolean {
    return (
      typeof this.engine?.goToProgression === 'function' &&
      this.overallProgressPercent !== null
    );
  }

  get readerPanelOpen(): boolean {
    return this.activeReaderPanel !== null;
  }

  async seekToProgress(event: Event): Promise<void> {
    const input = event.currentTarget;
    const engine = this.engine;
    const seek = engine?.goToProgression;
    if (
      !(input instanceof HTMLInputElement) ||
      !seek ||
      this.loading ||
      this.navigationBusy
    ) {
      return;
    }
    const percent = Number(input.value);
    if (!Number.isFinite(percent)) {
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

  async goTo(entry: TocEntry): Promise<void> {
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
    await this.engine?.goTo(bookmark.locator);
    this.closeReaderPanelsForReading();
  }

  beginEditAnnotation(annotation: PublicationAnnotation): void {
    this.editingAnnotation = annotation;
    this.pendingSelection = { locator: structuredClone(annotation.locator) };
    this.annotationColor = annotation.color;
    this.annotationNote = annotation.note ?? '';
    this.annotationError = null;
    this.annotationsOpen = false;
  }

  cancelAnnotationEditor(): void {
    this.pendingSelection = null;
    this.editingAnnotation = null;
    this.annotationNote = '';
    this.annotationError = null;
    this.engine?.clearSelection();
  }

  async saveAnnotation(): Promise<void> {
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
      const annotation: PublicationAnnotation = {
        schemaVersion: 1,
        id: this.editingAnnotation?.id ?? crypto.randomUUID(),
        bookId: this.book.id,
        format: this.book.format,
        deviceId: getDeviceId(),
        locator: structuredClone(this.pendingSelection.locator),
        color: this.annotationColor,
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
      this.cancelAnnotationEditor();
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

  async removeEditingAnnotation(): Promise<void> {
    const annotation = this.editingAnnotation;
    if (!annotation) {
      return;
    }
    if (await this.removeAnnotation(annotation)) {
      this.cancelAnnotationEditor();
    }
  }

  async goToAnnotation(annotation: PublicationAnnotation): Promise<void> {
    await this.engine?.goTo(annotation.locator);
    this.closeReaderPanelsForReading();
  }

  async goToPdfPage(pageNumber: number): Promise<void> {
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
    void this.zoomPublication(direction).catch((error) => {
      this.navigationError =
        error instanceof Error ? error.message : 'Unable to change zoom';
      this.changeDetector.markForCheck();
    });
  }

  private async zoomPublication(direction: ReaderZoomDirection): Promise<void> {
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
      return;
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
    const readerRoot = this.readerRoot.nativeElement;
    if (readerRoot.ownerDocument.fullscreenElement === readerRoot) {
      void readerRoot.ownerDocument.exitFullscreen().catch(() => undefined);
    }
    this.removeTransientBackHandler();
    this.removeBackgroundListener?.();
    this.removeRelocationListener?.();
    this.removeSelectionListener?.();
    this.removeAnnotationActivationListener?.();
    this.removeNavigationRequestListener?.();
    this.removeZoomRequestListener?.();
    this.removeExternalLinkRequestListener?.();
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
    const opening = this.activeReaderPanel !== panel;
    const returningFocusTarget = opening
      ? undefined
      : this.readerPanelTriggerElement(panel);
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
    const returningFocusTarget = this.readerPanelTriggerElement(panel);
    this.closeReaderPanels();
    this.changeDetector.detectChanges();
    this.queueFocus(returningFocusTarget);
    return true;
  }

  private closeReaderPanelsForReading(): void {
    this.closeReaderPanels();
    this.changeDetector.detectChanges();
    this.queueFocus(this.readerRoot.nativeElement);
  }

  private setReaderPanelOpen(panel: ReaderPanel, open: boolean): void {
    switch (panel) {
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
    return this.closeReaderPanelsAndRestoreTrigger();
  }

  private async navigate(direction: ReaderNavigationDirection): Promise<void> {
    const engine = this.engine;
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
  return (
    depth > 0 ||
    !UNNUMBERED_TOP_LEVEL_TOC_TITLES.has(normalizeTocTitle(entry.title))
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
const EPUB_MINIMUM_ZOOM_PERCENT = 75;
const EPUB_MAXIMUM_ZOOM_PERCENT = 200;
const PDF_MINIMUM_ZOOM_PERCENT = 25;
const PDF_MAXIMUM_ZOOM_PERCENT = 400;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
