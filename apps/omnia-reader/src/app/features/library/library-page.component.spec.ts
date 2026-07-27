import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import {
  BookRecord,
  LibraryRepository,
  PlatformPort,
  ReadingProgress,
} from '@omnia-reader/reader/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOK_SYNC_EXCLUSIONS,
  BookSyncExclusions,
} from '@omnia-reader/sync/core';
import { LibraryPageComponent } from './library-page.component';
import { PublicationEnrichmentService } from './publication-enrichment.service';
import { PublicationExportService } from './publication-export.service';
import { PublicationImportService } from './publication-import.service';

describe('LibraryPageComponent', () => {
  const book: BookRecord = {
    id: `sha256:${'b'.repeat(64)}`,
    format: 'epub',
    fileName: 'owned-book.epub',
    mediaType: 'application/epub+zip',
    size: 1024,
    title: 'Owned book',
    authors: ['Reader'],
    importedAt: '2026-07-26T00:00:00.000Z',
    coverState: 'unavailable',
  };
  const repository = {
    listBooks: vi.fn(),
    listProgress: vi.fn(),
    getBookCover: vi.fn(),
    removeBook: vi.fn(),
  };
  const platform = {
    kind: 'web',
    supportsStreamingFileSave: false,
    pickPublications: vi.fn(),
  };
  const publicationImports = {
    onImported: vi.fn(),
    importPublications: vi.fn(),
  };
  const enrichment = {
    enrich: vi.fn(),
  };
  const exporter = {
    exportPublication: vi.fn(),
  };
  const syncExclusions = {
    exclude: vi.fn(),
    include: vi.fn(),
    isExcluded: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    repository.listBooks.mockResolvedValue([book]);
    repository.listProgress.mockResolvedValue([]);
    repository.getBookCover.mockResolvedValue(null);
    repository.removeBook.mockResolvedValue(undefined);
    publicationImports.onImported.mockReturnValue(() => undefined);
    publicationImports.importPublications.mockResolvedValue({
      books: [],
      added: [],
      duplicates: [],
      failures: [],
    });
    platform.pickPublications.mockResolvedValue([]);
    exporter.exportPublication.mockResolvedValue('saved');
    await TestBed.configureTestingModule({
      imports: [LibraryPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: LIBRARY_REPOSITORY,
          useValue: repository as unknown as LibraryRepository,
        },
        {
          provide: PLATFORM_PORT,
          useValue: platform as unknown as PlatformPort,
        },
        {
          provide: PublicationImportService,
          useValue: publicationImports,
        },
        {
          provide: PublicationEnrichmentService,
          useValue: enrichment,
        },
        {
          provide: PublicationExportService,
          useValue: exporter,
        },
        {
          provide: BOOK_SYNC_EXCLUSIONS,
          useValue: syncExclusions as unknown as BookSyncExclusions,
        },
      ],
    }).compileComponents();
  });

  it('exports a publication from an accessible per-book action', async () => {
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const exportButton = fixture.nativeElement.querySelector(
      'button[aria-label="Export Owned book"]',
    ) as HTMLButtonElement;
    expect(exportButton).toBeTruthy();

    exportButton.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(exporter.exportPublication).toHaveBeenCalledWith(book);
    expect(fixture.nativeElement.textContent).toContain(
      '“Owned book” exported as owned-book.epub.',
    );
  });

  it('reports cancellation and export failures without changing the library', async () => {
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    exporter.exportPublication.mockResolvedValueOnce('cancelled');
    await fixture.componentInstance.exportBook(book);
    expect(fixture.componentInstance.statusMessage).toBe(
      'Export of “Owned book” cancelled.',
    );

    exporter.exportPublication.mockRejectedValueOnce(
      new Error('The stored publication failed its size validation'),
    );
    await fixture.componentInstance.exportBook(book);
    fixture.detectChanges();

    expect(repository.removeBook).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelector('[role="alert"]').textContent,
    ).toContain('The stored publication failed its size validation');
  });

  it('explains destructive removal and restores focus when cancelled', async () => {
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const removeButton = fixture.nativeElement.querySelector(
      'button[aria-label="Remove Owned book"]',
    ) as HTMLButtonElement;
    removeButton.focus();
    removeButton.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });
    expect(document.body.textContent).toContain(
      'reading progress, bookmarks, highlights, and notes',
    );

    const cancelButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel',
    );
    expect(cancelButton).toBeTruthy();
    (cancelButton as HTMLButtonElement).click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(removeButton);
    });
    expect(repository.removeBook).not.toHaveBeenCalled();
  });

  it('removes a confirmed publication and announces completion', async () => {
    repository.removeBook.mockImplementationOnce(async () => {
      repository.listBooks.mockResolvedValue([]);
    });
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    (
      fixture.nativeElement.querySelector(
        'button[aria-label="Remove Owned book"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeTruthy(),
    );
    const confirmButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Remove book',
    );
    expect(confirmButton).toBeTruthy();
    (confirmButton as HTMLButtonElement).click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.removingBookId).toBeNull();
      expect(fixture.componentInstance.books).toEqual([]);
    });

    expect(repository.removeBook).toHaveBeenCalledWith(book.id);
    expect(syncExclusions.exclude).toHaveBeenCalledWith(book.id);
    expect(syncExclusions.include).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain(
      '“Owned book” removed from this device.',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Your library is empty',
    );
  });

  it('keeps a publication available and reports storage removal failures', async () => {
    repository.removeBook.mockRejectedValueOnce(
      new Error('Offline storage is read-only'),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    (
      fixture.nativeElement.querySelector(
        'button[aria-label="Remove Owned book"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeTruthy(),
    );
    const confirmButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Remove book',
    );
    (confirmButton as HTMLButtonElement).click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(repository.removeBook).toHaveBeenCalledWith(book.id);
      expect(fixture.componentInstance.removingBookId).toBeNull();
      expect(fixture.componentInstance.errorMessage).toBe(
        'Unable to remove “Owned book”: Offline storage is read-only',
      );
    });

    expect(fixture.componentInstance.books).toEqual([book]);
    expect(syncExclusions.exclude).toHaveBeenCalledWith(book.id);
    expect(syncExclusions.include).toHaveBeenCalledWith(book.id);
    expect(
      fixture.nativeElement.querySelector('[role="alert"]').textContent,
    ).toContain('Unable to remove “Owned book”: Offline storage is read-only');
    const retryButton = fixture.nativeElement.querySelector(
      'button[aria-label="Remove Owned book"]',
    ) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(false);
  });

  it('shows durable reading progress and a continue-reading card label', async () => {
    const progress: ReadingProgress = {
      schemaVersion: 1,
      bookId: book.id,
      format: book.format,
      deviceId: 'test-device',
      locator: {
        href: 'chapter-2.xhtml',
        type: 'application/xhtml+xml',
        locations: { totalProgression: 0.42 },
      },
      furthestTotalProgression: 0.64,
      updatedAt: '2026-07-26T01:00:00.000Z',
      appVersion: '0.0.0',
    };
    repository.listProgress.mockResolvedValue([progress]);
    const fixture = TestBed.createComponent(LibraryPageComponent);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const bookLink = fixture.nativeElement.querySelector(
      'a[aria-label="Continue reading Owned book, 42% read"]',
    ) as HTMLAnchorElement;
    const progressElement = fixture.nativeElement.querySelector(
      'progress[aria-label="Reading progress for Owned book: 42% read"]',
    ) as HTMLProgressElement;

    expect(bookLink).toBeTruthy();
    expect(progressElement.value).toBe(42);
    expect(fixture.nativeElement.textContent).toContain('Continue reading');
    expect(fixture.nativeElement.textContent).toContain('42% read');
  });

  it('filters the loaded library by durable reading status', async () => {
    const unreadBook: BookRecord = {
      ...book,
      id: `sha256:${'c'.repeat(64)}`,
      fileName: 'unread-book.pdf',
      format: 'pdf',
      mediaType: 'application/pdf',
      title: 'Unread book',
    };
    const progress: ReadingProgress = {
      schemaVersion: 1,
      bookId: book.id,
      format: book.format,
      deviceId: 'test-device',
      locator: {
        href: 'chapter-2.xhtml',
        type: 'application/xhtml+xml',
        locations: { totalProgression: 0.42 },
      },
      furthestTotalProgression: 0.42,
      updatedAt: '2026-07-26T01:00:00.000Z',
      appVersion: '0.0.0',
    };
    repository.listBooks.mockResolvedValue([book, unreadBook]);
    repository.listProgress.mockResolvedValue([progress]);
    const fixture = TestBed.createComponent(LibraryPageComponent);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const statusSelect = fixture.nativeElement.querySelector(
      '#library-reading-status',
    ) as HTMLSelectElement;
    statusSelect.value = 'unread';
    statusSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(fixture.componentInstance.displayedBooks).toEqual([unreadBook]);
    expect(fixture.componentInstance.resultSummary).toBe(
      'Showing 1 of 2 books',
    );

    statusSelect.value = 'finished';
    statusSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(fixture.componentInstance.displayedBooks).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('No books found');

    const clearFilters = Array.from(
      fixture.nativeElement.querySelectorAll(
        'button',
      ) as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.includes('Clear filters'));
    expect(clearFilters).toBeTruthy();
    clearFilters?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.readingStatus).toBe('all');
    expect(fixture.componentInstance.displayedBooks).toHaveLength(2);
  });

  it('keeps the library usable when optional progress presentation fails', async () => {
    repository.listProgress.mockRejectedValue(
      new Error('progress unavailable'),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    expect(
      fixture.nativeElement.querySelector(
        'a[aria-label="Start reading Owned book"]',
      ),
    ).toBeTruthy();
    expect(fixture.componentInstance.errorMessage).toBeNull();
  });

  it('reports duplicate and mixed multi-book import outcomes', async () => {
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    publicationImports.importPublications.mockResolvedValueOnce({
      books: [book],
      added: [],
      duplicates: [book],
      failures: [],
    });
    await fixture.componentInstance.importBooks();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[role="status"]').textContent,
    ).toContain('“Owned book” is already in your library.');

    publicationImports.importPublications.mockResolvedValueOnce({
      books: [book, book],
      added: [book],
      duplicates: [book],
      failures: [],
    });
    await fixture.componentInstance.importBooks();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[role="status"]').textContent,
    ).toContain('1 book added; 1 is already in your library.');
  });

  it('keeps successful books while identifying damaged files in a batch', async () => {
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });
    publicationImports.importPublications.mockResolvedValueOnce({
      books: [book],
      added: [book],
      duplicates: [],
      failures: [
        {
          sourceName: 'damaged.pdf',
          message: 'Invalid PDF structure',
        },
      ],
    });

    await fixture.componentInstance.importBooks();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[role="status"]').textContent,
    ).toContain('“Owned book” added to your library.');
    expect(
      fixture.nativeElement.querySelector('[role="alert"]').textContent,
    ).toContain('Could not import “damaged.pdf”: Invalid PDF structure');
  });
});
