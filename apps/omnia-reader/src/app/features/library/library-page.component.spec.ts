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

  beforeEach(async () => {
    vi.clearAllMocks();
    repository.listBooks.mockResolvedValue([book]);
    repository.listProgress.mockResolvedValue([]);
    repository.getBookCover.mockResolvedValue(null);
    repository.removeBook.mockResolvedValue(undefined);
    publicationImports.onImported.mockReturnValue(() => undefined);
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
});
