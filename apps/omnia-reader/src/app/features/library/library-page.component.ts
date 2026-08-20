import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Router } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import {
  BookRecord,
  LogicalBookFormatPreference,
  LogicalBookRecord,
  PublicationFormat,
  VariantAvailability,
} from '@omnia-reader/reader/domain';
import { firstValueFrom } from 'rxjs';
import {
  createLogicalLibraryCards,
  isLibraryReadingStatus,
  isLibrarySortMode,
  LibraryBookProgressSummary,
  LogicalLibraryCard,
  LibraryReadingStatus,
  LibrarySortMode,
  LibraryViewMode,
  loadLibraryViewPreferences,
  saveLibraryViewPreferences,
  selectLogicalLibraryCards,
  summarizeReadingProgress,
} from './library-view';
import { PublicationEnrichmentService } from './publication-enrichment.service';
import { PublicationAssociationService } from './publication-association.service';
import { PublicationExportService } from './publication-export.service';
import {
  describePublicationImportFailures,
  PublicationImportResult,
  PublicationImportService,
} from './publication-import.service';
import { RemovePublicationDialogComponent } from './remove-publication-dialog.component';
import { AssociatePublicationDialogComponent } from './associate-publication-dialog.component';
import { DetachPublicationDialogComponent } from './detach-publication-dialog.component';
import { PublicationRecoveryService } from './publication-recovery.service';

type FormatAction =
  | 'export'
  | 'remove'
  | 'add'
  | 'detach'
  | 'replace'
  | 'download';

@Component({
  selector: 'omnia-library-page',
  templateUrl: './library-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, MatIconModule],
})
export class LibraryPageComponent implements OnInit, OnDestroy {
  readonly formatBadgeButtonClass =
    'inline-flex min-w-0 min-h-7 flex-1 items-center justify-start gap-0.5 overflow-hidden rounded-md border border-stone-200/60 bg-white px-0.5 py-1 text-[6px] leading-none text-stone-700';
  readonly formatBadgeMissingClass =
    'grid min-w-0 min-h-7 flex-1 grid-cols-[auto_1fr] items-center justify-items-start gap-0.5 rounded-md border border-dashed border-stone-300 bg-stone-50/70 px-0.5 py-1 text-left text-[6px] leading-none text-stone-500';
  readonly formatRowClass =
    'flex min-h-8 w-full min-w-0 items-center gap-0.5 overflow-hidden';
  readonly formatBadgeGlyphClass =
    '!h-3 !w-3 shrink-0 !text-[12px] text-stone-500';
  readonly formatBadgeProgressTrackClass =
    'relative flex h-4 min-w-12 flex-1 items-center justify-center overflow-hidden rounded-full bg-emerald-200/90';
  readonly formatBadgeProgressFillClass =
    'absolute inset-y-0 left-0 block min-w-px rounded-full bg-green-600 transition-[width] duration-150 ease-out';
  readonly formatBadgeProgressPercentClass =
    'relative z-10 px-1 text-[10px] leading-none font-semibold tabular-nums';
  readonly formatBadgeProgressClusterClass =
    'ml-auto flex min-w-12 flex-1 items-center';
  readonly formatBadgeLabelClass =
    'shrink-0 truncate text-[10px] font-semibold leading-none';
  readonly formatActionContainerClass =
    'inline-flex shrink-0 items-center gap-1';
  readonly formatActionButtonClass =
    '!inline-flex !h-8 !w-8 !min-w-8 !items-center !justify-center cursor-pointer rounded-md !p-0 !text-[14px] text-stone-500 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:bg-violet-100 focus-visible:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-700 data-[preferred=true]:!bg-violet-200 data-[preferred=true]:!text-violet-800 data-[preferred=true]:hover:!bg-violet-200 [&_.mat-icon]:!m-0 [&_.mat-icon]:!h-4 [&_.mat-icon]:!w-4 [&_.mat-icon]:!text-[16px] [&_.mat-icon]:!leading-none [&_.mat-mdc-button-touch-target]:!h-8 [&_.mat-mdc-button-touch-target]:!w-8';

  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly platform = inject(PLATFORM_PORT);
  private readonly publicationImports = inject(PublicationImportService);
  private readonly enrichment = inject(PublicationEnrichmentService);
  private readonly exporter = inject(PublicationExportService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly associations = inject(PublicationAssociationService);
  private readonly recovery = inject(PublicationRecoveryService);
  private readonly document = inject(DOCUMENT);
  private readonly initialViewPreferences = loadLibraryViewPreferences();
  private removeImportListener: (() => void) | null = null;
  private readonly enrichmentInFlight = new Set<string>();
  private readonly availabilityVerificationInFlight = new Set<string>();
  private readonly availabilityVerificationQueue: string[] = [];
  private availabilityVerificationTimer: number | null = null;
  private destroyed = false;
  books: readonly BookRecord[] = [];
  logicalBooks: readonly LogicalBookRecord[] = [];
  displayedBooks: readonly LogicalLibraryCard[] = [];
  private preferences: readonly LogicalBookFormatPreference[] = [];
  private availability: ReadonlyMap<string, VariantAvailability> = new Map();
  private progressPercentByVariant: ReadonlyMap<string, number> = new Map();
  coverUrls: ReadonlyMap<string, string> = new Map();
  progressSummaries: ReadonlyMap<string, LibraryBookProgressSummary> =
    new Map();
  searchQuery = '';
  readingStatus: LibraryReadingStatus = 'all';
  sortMode: LibrarySortMode = this.initialViewPreferences.sortMode;
  viewMode: LibraryViewMode = this.initialViewPreferences.viewMode;
  resultSummary = '0 books';
  loading = true;
  importing = false;
  exportingBookId: string | null = null;
  removingBookId: string | null = null;
  addingLogicalBookId: string | null = null;
  recoveringVariantId: string | null = null;
  refreshing = false;
  readonly synchronizedRecoveryVariantIds = new Set<string>();
  readonly recoveryProgressPercentByVariant = new Map<string, number>();
  errorMessage: string | null = null;
  statusMessage: string | null = null;
  readonly formatOrder: readonly PublicationFormat[] = ['epub', 'pdf'];

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
    if (this.availabilityVerificationTimer !== null) {
      this.document.defaultView?.clearTimeout(
        this.availabilityVerificationTimer,
      );
    }
  }

  async importBooks(): Promise<void> {
    this.importing = true;
    this.errorMessage = null;
    this.statusMessage = null;
    this.changeDetector.markForCheck();

    try {
      const sources = await this.platform.pickPublications();
      const result = await this.publicationImports.importPublications(sources);
      await this.reload();
      this.statusMessage = importStatusMessage(result);
      this.errorMessage = describePublicationImportFailures(result);
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

  clearFilters(): void {
    this.searchQuery = '';
    this.readingStatus = 'all';
    this.updateDisplayedBooks();
  }

  updateReadingStatus(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isLibraryReadingStatus(value)) {
      return;
    }
    this.readingStatus = value;
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

  async requestBookRemoval(book: BookRecord): Promise<void> {
    if (this.exportingBookId || this.removingBookId) {
      return;
    }

    const confirmed = await firstValueFrom(
      this.dialog
        .open<RemovePublicationDialogComponent, BookRecord, boolean>(
          RemovePublicationDialogComponent,
          {
            data: book,
            autoFocus: 'first-tabbable',
            restoreFocus: true,
            width: 'min(32rem, calc(100vw - 2rem))',
          },
        )
        .afterClosed(),
    );
    if (!confirmed) {
      return;
    }
    await this.removeBook(book);
  }

  async exportBook(book: BookRecord): Promise<void> {
    if (this.exportingBookId || this.removingBookId) {
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

  bookCoverUrl(bookId: string): string | null {
    return this.coverUrls.get(bookId) ?? null;
  }

  formatBadgeDisabled(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): boolean {
    return card.availability[format]?.status !== 'healthy';
  }

  isAddingLogicalBook(): boolean {
    return this.addingLogicalBookId !== null;
  }

  formatBadgeId(card: LogicalLibraryCard, format: PublicationFormat): string {
    return `format-badge-${card.id}-${format}`;
  }

  formatActionAriaLabel(
    format: PublicationFormat,
    action: FormatAction,
    title: string,
  ): string {
    if (action === 'add') {
      return `Add ${format.toUpperCase()} for ${title}`;
    }
    if (action === 'export') {
      return `Export ${format.toUpperCase()} for ${title}`;
    }
    if (action === 'detach') {
      return `Separate ${format.toUpperCase()} from ${title}`;
    }
    if (action === 'replace') {
      return `Replace ${format.toUpperCase()} for ${title} from this device`;
    }
    if (action === 'download') {
      return `Download synchronized ${format.toUpperCase()} for ${title}`;
    }
    return `Remove ${format.toUpperCase()} for ${title}`;
  }

  hasMultipleVariants(card: LogicalLibraryCard): boolean {
    return (
      this.formatOrder.filter((format) => !!card.variants[format]).length > 1
    );
  }

  canRecoverFromSynchronization(book: BookRecord): boolean {
    return this.synchronizedRecoveryVariantIds.has(book.id);
  }

  recoveryProgress(book: BookRecord): number | null {
    return this.recoveryProgressPercentByVariant.get(book.id) ?? null;
  }

  formatBadgeLabel(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): string {
    const displayLabel = format.toUpperCase();
    if (!card.variants[format]) return `Add ${displayLabel}`;
    const availability = card.availability[format];
    if (!availability || availability.status === 'checking') {
      return `${displayLabel} (Checking)`;
    }
    if (availability.status === 'healthy') {
      return `${displayLabel} (open)`;
    }
    const state =
      availability.status === 'unavailable' ? 'Unavailable' : 'Quarantined';
    return `${displayLabel} (${state}: ${availability.cause.replace(/-/g, ' ')})`;
  }

  formatBadgeGlyph(format: PublicationFormat): string {
    return format === 'pdf' ? 'picture_as_pdf' : 'menu_book';
  }

  formatBadgePercentValue(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): number | null {
    const availability = card.availability[format];
    if (!availability || availability.status !== 'healthy') {
      return null;
    }
    const percent = this.formatBadgeRawPercent(card, format);
    if (!Number.isFinite(percent)) {
      return null;
    }
    if (percent <= 0) {
      return 0;
    }
    return Math.max(1, Math.min(100, Math.round(percent)));
  }

  private formatBadgeRawPercent(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): number {
    const variant = card.variants[format];
    if (!variant) {
      return Number.NaN;
    }
    if (!this.progressPercentByVariant.has(variant.id)) {
      return Number.NaN;
    }
    return this.progressPercentByVariant.get(variant.id) ?? 0;
  }

  async activateFormatBadge(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): Promise<void> {
    const availability = card.availability[format];
    if (!availability || availability.status !== 'healthy') {
      const state = availability
        ? availabilityLabel(availability)
        : 'not ready yet';
      this.statusMessage = `${format.toUpperCase()} for “${card.title}” is ${state}.`;
      this.focusFormatBadge(card.id, format);
      this.changeDetector.markForCheck();
      return;
    }
    await this.readFormat(card, format);
  }

  async addFormat(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): Promise<void> {
    if (this.addingLogicalBookId) return;
    this.addingLogicalBookId = card.logicalBook.id;
    this.errorMessage = null;
    this.statusMessage = null;
    this.changeDetector.markForCheck();
    try {
      const sources = await this.platform.pickPublications();
      const result = await this.associations.addFormat(
        card.logicalBook.id,
        sources,
      );
      if (result.status === 'cancelled') {
        this.statusMessage = `Adding a format to “${card.logicalBook.title}” was cancelled.`;
      } else if (result.status === 'invalid-selection') {
        this.errorMessage = 'Choose exactly one EPUB or PDF file to add.';
      } else if (result.status === 'added') {
        await this.reload();
        this.statusMessage = `Format added to “${card.logicalBook.title}”${
          result.syncPending ? '; synchronization remains pending.' : '.'
        }`;
      } else if (result.status === 'belongs-to-other-book') {
        const owner = await this.repository.getLogicalBook(
          result.logicalBookId,
        );
        if (!owner) {
          this.errorMessage =
            'That publication belongs to an entry that is no longer available. Reload the library and try again.';
        } else {
          this.statusMessage =
            'That exact publication already belongs to another library entry. Confirm whether to associate the entries.';
          await this.associateLogicalCandidates(card, [owner], format);
        }
      } else if (result.status === 'already-member') {
        this.statusMessage = `That exact format is already part of “${card.logicalBook.title}”.`;
      } else {
        await this.reload();
        this.errorMessage = `“${card.logicalBook.title}” already has a ${format.toUpperCase()} source in that format slot.`;
      }
    } catch (error) {
      this.errorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to add the selected format';
    } finally {
      this.addingLogicalBookId = null;
      this.changeDetector.markForCheck();
      this.focusFormatBadge(card.logicalBook.id, format);
    }
  }

  private async associateLogicalCandidates(
    card: LogicalLibraryCard,
    candidates: readonly LogicalBookRecord[],
    format: PublicationFormat,
  ): Promise<void> {
    const sourceId = await firstValueFrom(
      this.dialog
        .open(AssociatePublicationDialogComponent, {
          data: { destination: card.logicalBook, candidates, format },
          autoFocus: 'first-tabbable',
          restoreFocus: true,
          width: 'min(36rem, calc(100vw - 2rem))',
        })
        .afterClosed(),
    );
    if (!sourceId) return;
    const result = await this.associations.associate(
      card.logicalBook.id,
      sourceId,
    );
    await this.reload();
    this.statusMessage = `Existing formats associated with “${card.title}”${
      result.syncPending ? '; synchronization remains pending.' : '.'
    }`;
    this.focusFormatBadge(card.logicalBook.id, format);
  }

  async readFormat(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): Promise<void> {
    const variant = card.variants[format];
    if (!variant) return;
    const opened = await this.repository.openHealthyVariant(variant.id);
    if (opened.availability.status !== 'healthy') {
      this.availability = new Map(this.availability).set(
        variant.id,
        opened.availability,
      );
      this.rebuildLogicalCards();
      this.errorMessage = `${format.toUpperCase()} is ${availabilityLabel(
        opened.availability,
      )}.`;
      return;
    }
    await this.router.navigate(['/reader', variant.id], {
      queryParams: { explicitFormat: 1 },
    });
  }

  async openPreferredFormat(card: LogicalLibraryCard): Promise<void> {
    const format = this.healthyOpenFormat(card);
    if (!format) {
      this.statusMessage = `No readable format is currently available for “${card.title}”. Use a replacement action to restore a source.`;
      this.changeDetector.markForCheck();
      return;
    }
    await this.readFormat(card, format);
  }

  isPreferredFormat(
    card: LogicalLibraryCard,
    format: PublicationFormat,
  ): boolean {
    return this.preferredFormat(card) === format;
  }

  isFormatActionDisabled(): boolean {
    return (
      this.exportingBookId !== null ||
      this.removingBookId !== null ||
      this.recoveringVariantId !== null
    );
  }

  async replaceVariantLocally(book: BookRecord): Promise<void> {
    if (this.isFormatActionDisabled()) return;
    this.recoveringVariantId = book.id;
    this.errorMessage = null;
    this.statusMessage = null;
    this.changeDetector.markForCheck();
    try {
      const result = await this.recovery.replaceFromPicker(book);
      if (result.status === 'cancelled') {
        this.statusMessage = `Replacement of ${book.format.toUpperCase()} for “${book.title}” was cancelled.`;
      } else if (result.status === 'invalid-selection') {
        this.errorMessage = 'Choose exactly one matching publication file.';
      } else {
        await this.reload();
        this.statusMessage = `${book.format.toUpperCase()} for “${book.title}” was restored from this device.`;
      }
    } catch (error) {
      this.errorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to replace the publication';
    } finally {
      this.recoveringVariantId = null;
      this.changeDetector.markForCheck();
      this.focusFormatBadgeByVariant(book.id);
    }
  }

  async recoverVariantFromSynchronization(book: BookRecord): Promise<void> {
    if (this.isFormatActionDisabled()) return;
    this.recoveringVariantId = book.id;
    this.errorMessage = null;
    this.statusMessage = `Downloading synchronized ${book.format.toUpperCase()} for “${book.title}”…`;
    this.recoveryProgressPercentByVariant.delete(book.id);
    this.changeDetector.markForCheck();
    try {
      await this.recovery.replaceFromSynchronization(book, {
        onProgress: (progress) => {
          const percent =
            progress.totalBytes > 0
              ? Math.round(
                  (100 * progress.transferredBytes) / progress.totalBytes,
                )
              : 0;
          this.recoveryProgressPercentByVariant.set(book.id, percent);
          this.changeDetector.markForCheck();
        },
      });
      await this.reload();
      this.statusMessage = `${book.format.toUpperCase()} for “${book.title}” was restored from synchronization.`;
    } catch (error) {
      this.errorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to download the synchronized publication';
      await this.probeSynchronizedRecovery(book);
    } finally {
      this.recoveryProgressPercentByVariant.delete(book.id);
      this.recoveringVariantId = null;
      this.changeDetector.markForCheck();
      this.focusFormatBadgeByVariant(book.id);
    }
  }

  async requestVariantDetach(
    card: LogicalLibraryCard,
    book: BookRecord,
  ): Promise<void> {
    if (!this.hasMultipleVariants(card) || this.isFormatActionDisabled())
      return;
    const confirmed = await firstValueFrom(
      this.dialog
        .open(DetachPublicationDialogComponent, {
          data: { book, logicalTitle: card.title },
          autoFocus: 'first-tabbable',
          restoreFocus: true,
          width: 'min(32rem, calc(100vw - 2rem))',
        })
        .afterClosed(),
    );
    if (!confirmed) return;
    this.removingBookId = book.id;
    this.errorMessage = null;
    this.statusMessage = null;
    try {
      const result = await this.associations.detach(
        card.logicalBook.id,
        book.id,
      );
      await this.reload();
      this.statusMessage = `${book.format.toUpperCase()} was separated from “${card.title}”${
        result.syncPending ? '; synchronization remains pending.' : '.'
      }`;
    } catch (error) {
      this.errorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to separate the format';
    } finally {
      this.removingBookId = null;
      this.changeDetector.markForCheck();
    }
  }

  private async reload(): Promise<void> {
    const initialLoad = this.logicalBooks.length === 0;
    this.loading = initialLoad;
    this.refreshing = !initialLoad;
    this.changeDetector.markForCheck();
    try {
      const [books, logicalBooks] = await Promise.all([
        this.repository.listBooks(),
        this.repository.listLogicalBooks(),
      ]);
      const variantIds = logicalBooks.flatMap((logicalBook) =>
        Object.values(logicalBook.variants).filter((id): id is string => !!id),
      );
      const [covers, progressResult, availability, preferences] =
        await Promise.all([
          Promise.all(
            logicalBooks.map(async (logicalBook) => ({
              bookId: logicalBook.id,
              cover: await this.repository.getLogicalBookCover(logicalBook.id),
            })),
          ),
          this.repository
            .listProgress()
            .then((records) => ({ records, available: true as const }))
            .catch(() => ({ records: [], available: false as const })),
          this.repository.resolveVariantAvailability(variantIds),
          Promise.all(
            logicalBooks.map((logicalBook) =>
              this.repository.getLogicalBookFormatPreference(logicalBook.id),
            ),
          ),
        ]);
      if (this.destroyed) {
        return;
      }
      this.books = books;
      this.logicalBooks = logicalBooks;
      this.availability = availability;
      this.preferences = preferences.filter(
        (preference): preference is LogicalBookFormatPreference => !!preference,
      );
      this.replaceCoverUrls(covers);
      const bookIds = new Set(books.map((book) => book.id));
      if (progressResult.available) {
        this.progressSummaries = new Map(
          progressResult.records
            .filter((progress) => bookIds.has(progress.bookId))
            .map(
              (progress) =>
                [progress.bookId, summarizeReadingProgress(progress)] as const,
            ),
        );
        this.progressPercentByVariant = new Map(
          progressResult.records
            .filter((progress) => bookIds.has(progress.bookId))
            .map((progress) => [
              progress.bookId,
              100 *
                Math.min(
                  1,
                  Math.max(
                    0,
                    Number.isFinite(
                      progress.locator.locations?.totalProgression ??
                        progress.furthestTotalProgression,
                    )
                      ? (progress.locator.locations?.totalProgression ??
                          progress.furthestTotalProgression)
                      : 0,
                  ),
                ),
            ]),
        );
      }
      this.rebuildLogicalCards();
      void this.probeUnhealthySynchronizedRecoveries();
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
      this.refreshing = false;
      this.changeDetector.markForCheck();
      this.enqueueCheckingAvailabilityVerification();
    }
  }

  private async removeBook(book: BookRecord): Promise<void> {
    this.removingBookId = book.id;
    this.errorMessage = null;
    this.statusMessage = null;
    this.changeDetector.markForCheck();
    try {
      const logicalBook = await this.repository.findLogicalBookByVariant(
        book.id,
      );
      if (!logicalBook) {
        throw new Error('The selected library entry is no longer available');
      }
      const result = await this.associations.deleteVariant(
        logicalBook.id,
        book.id,
      );
      await this.reload();
      if (!this.errorMessage) {
        this.statusMessage = `“${book.title}” removed${
          result.syncPending
            ? '; synchronization remains pending.'
            : ' and queued for synchronization.'
        }`;
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Unknown storage error';
      this.errorMessage = `Unable to remove “${book.title}”: ${detail}`;
    } finally {
      this.removingBookId = null;
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
    const cards = createLogicalLibraryCards(
      this.logicalBooks,
      this.books,
      [],
      this.availability,
      this.preferences,
    ).map((card) => ({
      ...card,
      progress: Object.fromEntries(
        Object.entries(card.variants).flatMap(([format, variant]) => {
          const summary = variant
            ? this.progressSummaries.get(variant.id)
            : null;
          return summary ? [[format, summary]] : [];
        }),
      ),
    }));
    this.displayedBooks = selectLogicalLibraryCards(
      cards,
      this.searchQuery,
      this.sortMode,
      this.readingStatus,
    );
    const total = this.logicalBooks.length;
    const shown = this.displayedBooks.length;
    this.resultSummary =
      this.searchQuery.trim() || this.readingStatus !== 'all'
        ? `Showing ${shown} of ${total} ${total === 1 ? 'book' : 'books'}`
        : `${total} ${total === 1 ? 'book' : 'books'}`;
    this.changeDetector.markForCheck();
  }

  private rebuildLogicalCards(): void {
    this.updateDisplayedBooks();
  }

  private async verifyCheckingVariant(variantId: string): Promise<void> {
    if (
      this.destroyed ||
      this.availability.get(variantId)?.status !== 'checking' ||
      this.availabilityVerificationInFlight.has(variantId)
    ) {
      return;
    }
    this.availabilityVerificationInFlight.add(variantId);
    try {
      const verified = await this.repository.openHealthyVariant(variantId);
      if (this.destroyed) return;
      this.availability = new Map(this.availability).set(
        variantId,
        verified.availability,
      );
      this.rebuildLogicalCards();
    } catch {
      if (this.destroyed) return;
      this.availability = new Map(this.availability).set(variantId, {
        status: 'unavailable',
        cause: 'inaccessible',
      });
      this.rebuildLogicalCards();
    } finally {
      this.availabilityVerificationInFlight.delete(variantId);
      this.changeDetector.markForCheck();
    }
  }

  private enqueueCheckingAvailabilityVerification(): void {
    if (!this.document.defaultView?.IntersectionObserver) return;
    for (const [variantId, availability] of this.availability) {
      if (
        availability.status === 'checking' &&
        !this.availabilityVerificationInFlight.has(variantId) &&
        !this.availabilityVerificationQueue.includes(variantId)
      ) {
        this.availabilityVerificationQueue.push(variantId);
      }
    }
    this.scheduleNextAvailabilityVerification();
  }

  private scheduleNextAvailabilityVerification(): void {
    const view = this.document.defaultView;
    if (
      !view ||
      this.destroyed ||
      this.availabilityVerificationTimer !== null ||
      this.availabilityVerificationQueue.length === 0
    ) {
      return;
    }
    this.availabilityVerificationTimer = view.setTimeout(() => {
      this.availabilityVerificationTimer = null;
      const variantId = this.availabilityVerificationQueue.shift();
      if (!variantId || this.destroyed) return;
      void this.verifyCheckingVariant(variantId).finally(() =>
        this.scheduleNextAvailabilityVerification(),
      );
    }, 0);
  }

  private focusFormatBadge(
    logicalBookId: string,
    format: PublicationFormat,
  ): void {
    queueMicrotask(() => {
      this.document
        .getElementById(`format-eye-${logicalBookId}-${format}`)
        ?.focus();
    });
  }

  private preferredFormat(card: LogicalLibraryCard): PublicationFormat | null {
    if (card.preferredFormat && card.variants[card.preferredFormat]) {
      return card.preferredFormat;
    }
    return this.formatOrder.find((format) => !!card.variants[format]) ?? null;
  }

  private healthyOpenFormat(
    card: LogicalLibraryCard,
  ): PublicationFormat | null {
    const preferred = this.preferredFormat(card);
    if (
      preferred &&
      card.variants[preferred] &&
      card.availability[preferred]?.status === 'healthy'
    ) {
      return preferred;
    }
    return (
      this.formatOrder.find(
        (format) =>
          !!card.variants[format] &&
          card.availability[format]?.status === 'healthy',
      ) ?? null
    );
  }

  private async probeUnhealthySynchronizedRecoveries(): Promise<void> {
    const currentIds = new Set(this.books.map((book) => book.id));
    for (const variantId of this.synchronizedRecoveryVariantIds) {
      if (!currentIds.has(variantId)) {
        this.synchronizedRecoveryVariantIds.delete(variantId);
      }
    }
    const unhealthy = this.books.filter(
      (book) => this.availability.get(book.id)?.status !== 'healthy',
    );
    await Promise.all(
      unhealthy.map((book) => this.probeSynchronizedRecovery(book)),
    );
  }

  private async probeSynchronizedRecovery(book: BookRecord): Promise<void> {
    const descriptor = await this.recovery.synchronizedReplacement(book);
    if (this.destroyed) return;
    if (descriptor) {
      this.synchronizedRecoveryVariantIds.add(book.id);
    } else {
      this.synchronizedRecoveryVariantIds.delete(book.id);
    }
    this.changeDetector.markForCheck();
  }

  private focusFormatBadgeByVariant(variantId: string): void {
    const card = this.displayedBooks.find((candidate) =>
      this.formatOrder.some(
        (format) => candidate.variants[format]?.id === variantId,
      ),
    );
    const format = card
      ? this.formatOrder.find(
          (candidate) => card.variants[candidate]?.id === variantId,
        )
      : null;
    if (card && format) this.focusFormatBadge(card.id, format);
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

function importStatusMessage(result: PublicationImportResult): string | null {
  const added = result.added.length;
  const duplicates = result.duplicates.length;
  if (added === 0 && duplicates === 0) {
    return null;
  }
  if (added === 1 && duplicates === 0) {
    return `“${result.added[0].title}” added to your library.`;
  }
  if (added === 0 && duplicates === 1) {
    return `“${result.duplicates[0].title}” is already in your library.`;
  }
  if (duplicates === 0) {
    return `${added} books added to your library.`;
  }
  if (added === 0) {
    return `${duplicates} selected books are already in your library.`;
  }
  return `${added} ${added === 1 ? 'book' : 'books'} added; ${duplicates} ${
    duplicates === 1 ? 'is' : 'are'
  } already in your library.`;
}

function availabilityLabel(availability: VariantAvailability): string {
  if (availability.status === 'healthy') return 'ready';
  if (availability.status === 'checking') return 'still being checked';
  return `${availability.status}: ${availability.cause.replace(/-/g, ' ')}`;
}
