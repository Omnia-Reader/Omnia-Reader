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
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
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
  ReaderPreferences,
  ReadingProgress,
  SearchResult,
  TocEntry,
} from '@omnia-reader/reader/domain';
import { createBookSyncManifest } from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { BackNavigationService } from '../../back-navigation.service';
import { PdfThumbnailComponent } from './pdf-thumbnail.component';

@Component({
  selector: 'omnia-reader-page',
  templateUrl: './reader-page.component.html',
  host: {
    class: 'block h-[calc(100vh-64px)]',
    '(document:keydown)': 'onDocumentKeydown($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    ScrollingModule,
    FormsModule,
    RouterLink,
    PdfThumbnailComponent,
  ],
})
export class ReaderPageComponent implements AfterViewInit, OnDestroy {
  @ViewChild('viewport', { static: true })
  private viewport!: ElementRef<HTMLElement>;

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
  pendingExternalUrl: string | null = null;
  externalLinkError: string | null = null;
  pageNavigation: PageNavigation | null = null;
  pageNumbers: readonly number[] = [];
  currentPageNumber = 1;
  passwordChallenge: PublicationPasswordChallenge | null = null;
  pdfPassword = '';
  passwordError: string | null = null;
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
  private removeBackgroundListener: (() => void) | null = null;
  private removeRelocationListener: (() => void) | null = null;
  private removeSelectionListener: (() => void) | null = null;
  private removePasswordListener: (() => void) | null = null;
  private removeNavigationRequestListener: (() => void) | null = null;
  private removeExternalLinkRequestListener: (() => void) | null = null;
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
      this.removeNavigationRequestListener =
        this.engine.onNavigationRequested?.((direction) => {
          void this.navigate(direction);
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
      this.currentPageNumber = this.currentLocator?.locations?.position ?? 1;
      this.tableOfContents = this.engine.tableOfContents();
      this.tocItems = flattenToc(this.tableOfContents);
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Unable to open this book';
    } finally {
      this.loading = false;
      this.changeDetector.markForCheck();
    }
  }

  async previous(): Promise<void> {
    await this.navigate('previous');
  }

  async next(): Promise<void> {
    await this.navigate('next');
  }

  onDocumentKeydown(event: KeyboardEvent): void {
    if (
      this.loading ||
      this.errorMessage ||
      this.passwordChallenge ||
      this.pendingSelection
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

  async goTo(entry: TocEntry): Promise<void> {
    await this.engine?.goTo(entry.locator);
    this.tocOpen = false;
  }

  toggleToc(): void {
    this.tocOpen = !this.tocOpen;
    this.searchOpen = false;
    this.settingsOpen = false;
    this.thumbnailsOpen = false;
    this.bookmarksOpen = false;
    this.annotationsOpen = false;
  }

  toggleSearch(): void {
    this.searchOpen = !this.searchOpen;
    this.tocOpen = false;
    this.settingsOpen = false;
    this.thumbnailsOpen = false;
    this.bookmarksOpen = false;
    this.annotationsOpen = false;
  }

  toggleSettings(): void {
    this.settingsOpen = !this.settingsOpen;
    this.tocOpen = false;
    this.searchOpen = false;
    this.thumbnailsOpen = false;
    this.bookmarksOpen = false;
    this.annotationsOpen = false;
  }

  toggleThumbnails(): void {
    this.thumbnailsOpen = !this.thumbnailsOpen;
    this.tocOpen = false;
    this.searchOpen = false;
    this.settingsOpen = false;
    this.bookmarksOpen = false;
    this.annotationsOpen = false;
  }

  toggleBookmarks(): void {
    this.bookmarksOpen = !this.bookmarksOpen;
    this.tocOpen = false;
    this.searchOpen = false;
    this.settingsOpen = false;
    this.thumbnailsOpen = false;
    this.annotationsOpen = false;
    this.bookmarkError = null;
  }

  toggleAnnotations(): void {
    this.annotationsOpen = !this.annotationsOpen;
    this.tocOpen = false;
    this.searchOpen = false;
    this.settingsOpen = false;
    this.thumbnailsOpen = false;
    this.bookmarksOpen = false;
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
    this.bookmarksOpen = false;
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

  async removeAnnotation(annotation: PublicationAnnotation): Promise<void> {
    if (this.annotationBusy) {
      return;
    }
    this.annotationBusy = true;
    this.annotationError = null;
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
    } catch (error) {
      this.annotationError =
        error instanceof Error ? error.message : 'Unable to remove annotation';
    } finally {
      this.annotationBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async goToAnnotation(annotation: PublicationAnnotation): Promise<void> {
    await this.engine?.goTo(annotation.locator);
    this.annotationsOpen = false;
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
    this.thumbnailsOpen = false;
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
    this.searchOpen = false;
  }

  ngOnDestroy(): void {
    this.removeTransientBackHandler();
    this.removeBackgroundListener?.();
    this.removeRelocationListener?.();
    this.removeSelectionListener?.();
    this.removeNavigationRequestListener?.();
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

    if (
      !this.tocOpen &&
      !this.searchOpen &&
      !this.settingsOpen &&
      !this.thumbnailsOpen &&
      !this.bookmarksOpen &&
      !this.annotationsOpen &&
      !this.pendingSelection
    ) {
      return false;
    }

    this.tocOpen = false;
    this.searchOpen = false;
    this.settingsOpen = false;
    this.thumbnailsOpen = false;
    this.bookmarksOpen = false;
    this.annotationsOpen = false;
    if (this.pendingSelection) {
      this.cancelAnnotationEditor();
    }
    this.changeDetector.markForCheck();
    return true;
  }

  private async navigate(direction: ReaderNavigationDirection): Promise<void> {
    if (!this.engine || this.loading || this.navigationBusy) {
      return;
    }
    this.navigationBusy = true;
    this.navigationError = null;
    this.changeDetector.markForCheck();
    try {
      if (direction === 'next') {
        await this.engine.next();
      } else {
        await this.engine.previous();
      }
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
    await this.repository.saveReaderPreferences(preferences);
    await this.engine?.applyPreferences(preferences);
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
}

function flattenToc(
  entries: readonly TocEntry[],
  depth = 0,
): readonly FlattenedTocEntry[] {
  return entries.flatMap((entry) => [
    { entry, depth },
    ...flattenToc(entry.children ?? [], depth + 1),
  ]);
}

function getDeviceId(): string {
  const storageKey = 'omnia-reader-device-id';
  let deviceId = localStorage.getItem(storageKey);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(storageKey, deviceId);
  }
  return deviceId;
}
