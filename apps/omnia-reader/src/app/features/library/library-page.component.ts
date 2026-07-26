import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { BookRecord } from '@omnia-reader/reader/domain';
import {
  bookActivityTimestamp as activityTimestamp,
  isLibrarySortMode,
  LibraryBookProgressSummary,
  LibrarySortMode,
  LibraryViewMode,
  loadLibraryViewPreferences,
  saveLibraryViewPreferences,
  selectLibraryBooks,
  summarizeReadingProgress,
} from './library-view';
import { PublicationEnrichmentService } from './publication-enrichment.service';
import { PublicationExportService } from './publication-export.service';
import { PublicationImportService } from './publication-import.service';

@Component({
  selector: 'omnia-library-page',
  templateUrl: './library-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatButtonModule, MatIconModule, RouterLink],
})
export class LibraryPageComponent implements OnInit, OnDestroy {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly platform = inject(PLATFORM_PORT);
  private readonly publicationImports = inject(PublicationImportService);
  private readonly enrichment = inject(PublicationEnrichmentService);
  private readonly exporter = inject(PublicationExportService);
  private readonly initialViewPreferences = loadLibraryViewPreferences();
  private removeImportListener: (() => void) | null = null;
  private readonly enrichmentInFlight = new Set<string>();
  private destroyed = false;

  books: readonly BookRecord[] = [];
  displayedBooks: readonly BookRecord[] = [];
  coverUrls: ReadonlyMap<string, string> = new Map();
  progressSummaries: ReadonlyMap<string, LibraryBookProgressSummary> =
    new Map();
  searchQuery = '';
  sortMode: LibrarySortMode = this.initialViewPreferences.sortMode;
  viewMode: LibraryViewMode = this.initialViewPreferences.viewMode;
  resultSummary = '0 books';
  loading = true;
  importing = false;
  exportingBookId: string | null = null;
  errorMessage: string | null = null;
  statusMessage: string | null = null;

  async ngOnInit(): Promise<void> {
    this.removeImportListener = this.publicationImports.onImported(() => {
      void this.reload();
    });
    await this.reload();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.removeImportListener?.();
    this.revokeCoverUrls();
  }

  async importBooks(): Promise<void> {
    this.importing = true;
    this.errorMessage = null;
    this.changeDetector.markForCheck();

    try {
      const sources = await this.platform.pickPublications();
      await this.publicationImports.importPublications(sources);
      await this.reload();
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'The import failed';
    } finally {
      this.importing = false;
      this.changeDetector.markForCheck();
    }
  }

  updateSearchQuery(event: Event): void {
    this.searchQuery = (event.target as HTMLInputElement).value;
    this.updateDisplayedBooks();
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.updateDisplayedBooks();
  }

  updateSortMode(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isLibrarySortMode(value)) {
      return;
    }
    this.sortMode = value;
    this.persistViewPreferences();
    this.updateDisplayedBooks();
  }

  setViewMode(viewMode: LibraryViewMode): void {
    if (this.viewMode === viewMode) {
      return;
    }
    this.viewMode = viewMode;
    this.persistViewPreferences();
  }

  async removeBook(book: BookRecord): Promise<void> {
    if (!window.confirm(`Remove "${book.title}" from this device?`)) {
      return;
    }

    await this.repository.removeBook(book.id);
    await this.reload();
  }

  async exportBook(book: BookRecord): Promise<void> {
    if (this.exportingBookId) {
      return;
    }
    this.exportingBookId = book.id;
    this.errorMessage = null;
    this.statusMessage = null;
    this.changeDetector.markForCheck();

    try {
      const result = await this.exporter.exportPublication(book);
      this.statusMessage =
        result === 'saved'
          ? `“${book.title}” exported as ${book.fileName}.`
          : `Export of “${book.title}” cancelled.`;
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'The book export failed';
    } finally {
      this.exportingBookId = null;
      this.changeDetector.markForCheck();
    }
  }

  formatFileSize(size: number): string {
    if (size < 1024 * 1024) {
      return `${Math.max(1, Math.round(size / 1024))} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  bookCoverUrl(bookId: string): string | null {
    return this.coverUrls.get(bookId) ?? null;
  }

  bookActivityTimestamp(book: BookRecord): string {
    return activityTimestamp(book);
  }

  bookActivityLabel(book: BookRecord): string {
    return book.lastOpenedAt ? 'Last opened' : 'Added';
  }

  bookProgressSummary(bookId: string): LibraryBookProgressSummary | null {
    return this.progressSummaries.get(bookId) ?? null;
  }

  bookOpenLabel(book: BookRecord): string {
    const progress = this.bookProgressSummary(book.id);
    return progress
      ? `${progress.actionLabel} ${book.title}, ${progress.label}`
      : `Start reading ${book.title}`;
  }

  private async reload(): Promise<void> {
    this.loading = true;
    this.changeDetector.markForCheck();
    try {
      const books = await this.repository.listBooks();
      const [covers, progressRecords] = await Promise.all([
        Promise.all(
          books.map(async (book) => ({
            bookId: book.id,
            cover: await this.repository.getBookCover(book.id),
          })),
        ),
        this.repository.listProgress().catch(() => []),
      ]);
      if (this.destroyed) {
        return;
      }
      this.books = books;
      this.updateDisplayedBooks();
      this.replaceCoverUrls(covers);
      const bookIds = new Set(books.map((book) => book.id));
      this.progressSummaries = new Map(
        progressRecords
          .filter((progress) => bookIds.has(progress.bookId))
          .map(
            (progress) =>
              [progress.bookId, summarizeReadingProgress(progress)] as const,
          ),
      );
      this.scheduleEnrichment(
        books,
        new Set(
          covers.filter((entry) => !!entry.cover).map((entry) => entry.bookId),
        ),
      );
      this.errorMessage = null;
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Unable to load the library';
    } finally {
      this.loading = false;
      this.changeDetector.markForCheck();
    }
  }

  private scheduleEnrichment(
    books: readonly BookRecord[],
    booksWithCovers: ReadonlySet<string>,
  ): void {
    for (const book of books) {
      if (
        book.coverState === 'unavailable' ||
        (book.coverState === 'available' && booksWithCovers.has(book.id)) ||
        this.enrichmentInFlight.has(book.id)
      ) {
        continue;
      }
      this.enrichmentInFlight.add(book.id);
      void this.enrichBook(book);
    }
  }

  private async enrichBook(book: BookRecord): Promise<void> {
    try {
      const enriched = await this.enrichment.enrich(book);
      const cover = await this.repository.getBookCover(book.id);
      if (this.destroyed) {
        return;
      }
      this.books = this.books.map((candidate) =>
        candidate.id === enriched.id ? enriched : candidate,
      );
      this.updateDisplayedBooks();
      if (cover) {
        this.setCoverUrl(book.id, cover);
      }
      this.changeDetector.markForCheck();
    } catch {
      // A damaged optional cover must not make the library unavailable.
    } finally {
      this.enrichmentInFlight.delete(book.id);
    }
  }

  private updateDisplayedBooks(): void {
    this.displayedBooks = selectLibraryBooks(
      this.books,
      this.searchQuery,
      this.sortMode,
    );
    const total = this.books.length;
    const shown = this.displayedBooks.length;
    this.resultSummary = this.searchQuery.trim()
      ? `Showing ${shown} of ${total} ${total === 1 ? 'book' : 'books'}`
      : `${total} ${total === 1 ? 'book' : 'books'}`;
    this.changeDetector.markForCheck();
  }

  private persistViewPreferences(): void {
    saveLibraryViewPreferences({
      viewMode: this.viewMode,
      sortMode: this.sortMode,
    });
  }

  private replaceCoverUrls(
    covers: readonly { bookId: string; cover: Blob | null }[],
  ): void {
    this.revokeCoverUrls();
    this.coverUrls = new Map(
      covers
        .filter(
          (entry): entry is { bookId: string; cover: Blob } => !!entry.cover,
        )
        .map(
          (entry) => [entry.bookId, URL.createObjectURL(entry.cover)] as const,
        ),
    );
  }

  private setCoverUrl(bookId: string, cover: Blob): void {
    const urls = new Map(this.coverUrls);
    const existing = urls.get(bookId);
    if (existing) {
      URL.revokeObjectURL(existing);
    }
    urls.set(bookId, URL.createObjectURL(cover));
    this.coverUrls = urls;
  }

  private revokeCoverUrls(): void {
    for (const url of this.coverUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.coverUrls = new Map();
  }
}
