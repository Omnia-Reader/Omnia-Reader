import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import {
  BookRecord,
  LibraryRepository,
  logicalBookFromVariant,
  PlatformPort,
  ReadingProgress,
} from '@omnia-reader/reader/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryPageComponent } from './library-page.component';
import { PublicationAssociationService } from './publication-association.service';
import { PublicationEnrichmentService } from './publication-enrichment.service';
import { PublicationExportService } from './publication-export.service';
import { PublicationRecoveryService } from './publication-recovery.service';
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
  const secondBook: BookRecord = {
    id: `sha256:${'c'.repeat(64)}`,
    format: 'pdf',
    fileName: 'owned-book.pdf',
    mediaType: 'application/pdf',
    size: 1024,
    title: 'Owned book',
    authors: ['Reader'],
    importedAt: '2026-07-26T00:00:00.000Z',
    coverState: 'unavailable',
  };
  const repository = {
    listBooks: vi.fn(),
    listLogicalBooks: vi.fn(),
    listProgress: vi.fn(),
    getBookCover: vi.fn(),
    getLogicalBookCover: vi.fn(),
    getLogicalBookFormatPreference: vi.fn(),
    resolveVariantAvailability: vi.fn(),
    openHealthyVariant: vi.fn(),
    findLogicalBookByVariant: vi.fn(),
    listOpenMembershipReconciliations: vi.fn(),
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
    removePublication: vi.fn(),
  };
  const enrichment = {
    enrich: vi.fn(),
  };
  const exporter = {
    exportPublication: vi.fn(),
  };
  const recovery = {
    replaceFromPicker: vi.fn(),
  };
  const associations = {
    addFormat: vi.fn(),
    compatibleCandidates: vi.fn(),
    associate: vi.fn(),
    deleteVariant: vi.fn(),
    reconcile: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    repository.listBooks.mockResolvedValue([book]);
    repository.listLogicalBooks.mockImplementation(async () =>
      (await repository.listBooks()).map((variant: BookRecord) =>
        logicalBookFromVariant(variant),
      ),
    );
    repository.listProgress.mockResolvedValue([]);
    repository.getBookCover.mockResolvedValue(null);
    repository.getLogicalBookCover.mockResolvedValue(null);
    repository.getLogicalBookFormatPreference.mockResolvedValue(null);
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'checking' }]]),
    );
    repository.openHealthyVariant.mockResolvedValue({
      availability: { status: 'healthy' },
      source: {},
    });
    repository.findLogicalBookByVariant.mockImplementation(async () =>
      logicalBookFromVariant(book),
    );
    repository.listOpenMembershipReconciliations.mockResolvedValue([]);
    repository.removeBook.mockResolvedValue(undefined);
    publicationImports.onImported.mockReturnValue(() => undefined);
    publicationImports.importPublications.mockResolvedValue({
      books: [],
      added: [],
      duplicates: [],
      failures: [],
    });
    publicationImports.removePublication.mockResolvedValue(undefined);
    platform.pickPublications.mockResolvedValue([]);
    exporter.exportPublication.mockResolvedValue('saved');
    associations.deleteVariant.mockResolvedValue({
      mutation: {},
      syncPending: false,
    });
    associations.compatibleCandidates.mockResolvedValue([]);
    associations.associate.mockResolvedValue({
      mutation: {},
      syncPending: false,
    });
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
          provide: PublicationAssociationService,
          useValue: associations,
        },
        {
          provide: PublicationExportService,
          useValue: exporter,
        },
        {
          provide: PublicationRecoveryService,
          useValue: recovery,
        },
      ],
    }).compileComponents();
  });

  it('exports a publication from compact format actions', async () => {
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const exportButton = fixture.nativeElement.querySelector(
      'button[aria-label="Export EPUB for Owned book"]',
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

    expect(publicationImports.removePublication).not.toHaveBeenCalled();
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
      'button[aria-label="Remove EPUB for Owned book"]',
    ) as HTMLButtonElement;
    expect(removeButton).toBeTruthy();
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
    expect(publicationImports.removePublication).not.toHaveBeenCalled();
  });

  it('removes a confirmed publication and announces completion', async () => {
    associations.deleteVariant.mockImplementationOnce(async () => {
      repository.listBooks.mockResolvedValue([]);
      return { mutation: {}, syncPending: false };
    });
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const removeButton = document.querySelector(
      'button[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    (
      document.querySelector(
        'button[aria-label="Remove EPUB for Owned book"]',
      ) as HTMLButtonElement
    )?.click();
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

    expect(associations.deleteVariant).toHaveBeenCalledWith(
      logicalBookFromVariant(book).id,
      book.id,
    );
    expect(fixture.nativeElement.textContent).toContain(
      '“Owned book” removed and queued for synchronization.',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Your library is empty',
    );
  });

  it('keeps a publication available and reports storage removal failures', async () => {
    associations.deleteVariant.mockRejectedValueOnce(
      new Error('Offline storage is read-only'),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const removeButton = document.querySelector(
      'button[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    removeButton?.parentElement?.dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    (
      document.querySelector(
        'button[aria-label="Remove EPUB for Owned book"]',
      ) as HTMLButtonElement
    )?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeTruthy(),
    );
    const confirmButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Remove book',
    );
    (confirmButton as HTMLButtonElement).click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(associations.deleteVariant).toHaveBeenCalledWith(
        logicalBookFromVariant(book).id,
        book.id,
      );
      expect(fixture.componentInstance.removingBookId).toBeNull();
      expect(fixture.componentInstance.errorMessage).toBe(
        'Unable to remove “Owned book”: Offline storage is read-only',
      );
    });

    expect(fixture.componentInstance.books).toEqual([book]);
    expect(
      fixture.nativeElement.querySelector('[role="alert"]').textContent,
    ).toContain('Unable to remove “Owned book”: Offline storage is read-only');
    const retryButton = fixture.nativeElement.querySelector(
      'button[aria-label="Remove EPUB for Owned book"]',
    ) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(false);
  });

  it('uses exactly two compact format controls and keeps helper actions minimal', async () => {
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
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'healthy' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const badges = Array.from(
      fixture.nativeElement.querySelectorAll('[data-format-badge]'),
    ) as HTMLButtonElement[];
    expect(badges).toHaveLength(2);
    expect(badges[0].getAttribute('aria-label')).toBe('EPUB');
    expect(badges[1].getAttribute('aria-label')).toContain('PDF');
    const formatRow = badges[0].parentElement;
    expect(formatRow?.className).toContain('flex');
    expect(formatRow?.className).toContain('w-full');
    const exportButton = fixture.nativeElement.querySelector(
      'button[aria-label="Export EPUB for Owned book"]',
    ) as HTMLButtonElement;
    const removeButton = fixture.nativeElement.querySelector(
      'button[aria-label="Remove EPUB for Owned book"]',
    ) as HTMLButtonElement;
    expect(exportButton).toBeTruthy();
    expect(removeButton).toBeTruthy();
    expect(exportButton.className).not.toContain('opacity-0');
    expect(removeButton.className).not.toContain('opacity-0');
    expect(badges[0].getAttribute('aria-label')).toBe('EPUB');
    expect(fixture.nativeElement.textContent).not.toContain('Read EPUB');
    expect(fixture.nativeElement.textContent).not.toContain('Read PDF');
    expect(fixture.nativeElement.textContent).not.toContain('Add local');
  });

  it('does not render progress percent text for 0% readings', async () => {
    const progress: ReadingProgress = {
      schemaVersion: 1,
      bookId: book.id,
      format: book.format,
      deviceId: 'test-device',
      locator: {
        href: 'chapter-2.xhtml',
        type: 'application/xhtml+xml',
        locations: { totalProgression: 0 },
      },
      furthestTotalProgression: 0,
      updatedAt: '2026-07-26T01:00:00.000Z',
      appVersion: '0.0.0',
    };
    repository.listProgress.mockResolvedValue([progress]);
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'healthy' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const badges = Array.from(
      fixture.nativeElement.querySelectorAll('[data-format-badge]'),
    ) as HTMLButtonElement[];
    expect(badges[0].getAttribute('aria-label')).toContain('EPUB');
    expect(badges[0].getAttribute('aria-label')).not.toContain('0%');
    expect(fixture.nativeElement.textContent).not.toContain('(0%)');
    expect(fixture.nativeElement.textContent).not.toContain(' 0%');
  });

  it('does not render percent UI for missing formats', async () => {
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'healthy' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
    expect(fixture.componentInstance.loading).toBe(false);
    });

    const missingPdfBadge = fixture.nativeElement.querySelector(
      '[data-format-badge="pdf"]',
    ) as HTMLButtonElement;
    expect(missingPdfBadge).toBeTruthy();
    expect(missingPdfBadge.textContent).not.toContain('%');
    expect(
      missingPdfBadge.parentElement?.querySelector('.bg-emerald-200'),
    ).toBeNull();
  });

  it('does not render percent UI for unavailable formats', async () => {
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([
        [book.id, { status: 'healthy' }],
        [secondBook.id, { status: 'unavailable', cause: 'missing' }],
      ]),
    );
    repository.listBooks.mockResolvedValue([book, secondBook]);
    repository.listLogicalBooks.mockResolvedValue([
      {
        schemaVersion: 1,
        id: 'logical:sha256:shared',
        title: 'Owned book',
        authors: ['Reader'],
        importedAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
        coverState: 'available',
        variants: {
          epub: book.id,
          pdf: secondBook.id,
        },
      },
    ]);
    const progress: ReadingProgress = {
      schemaVersion: 1,
      bookId: book.id,
      format: book.format,
      deviceId: 'test-device',
      locator: {
        href: 'chapter-2.xhtml',
        type: 'application/xhtml+xml',
        locations: { totalProgression: 0.75 },
      },
      furthestTotalProgression: 0.75,
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

    const epubBadge = fixture.nativeElement.querySelector(
      '[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    const pdfBadge = fixture.nativeElement.querySelector(
      '[data-format-badge="pdf"]',
    ) as HTMLButtonElement;
    expect(epubBadge).toBeTruthy();
    expect(pdfBadge).toBeTruthy();
    expect(pdfBadge.getAttribute('aria-label')).toContain('Unavailable');
    expect(epubBadge.textContent).toContain('75%');
    expect(epubBadge.parentElement?.querySelector('.bg-emerald-200')).toBeTruthy();
    expect(pdfBadge.textContent).not.toContain('1%');
    expect(
      pdfBadge.parentElement?.querySelector('.bg-emerald-200'),
    ).toBeNull();
  });

  it('shows at least 1% for very low positive reading progress', async () => {
    const progress: ReadingProgress = {
      schemaVersion: 1,
      bookId: book.id,
      format: book.format,
      deviceId: 'test-device',
      locator: {
        href: 'chapter-2.xhtml',
        type: 'application/xhtml+xml',
        locations: { totalProgression: 0.0034 },
      },
      furthestTotalProgression: 0.0034,
      updatedAt: '2026-07-26T01:00:00.000Z',
      appVersion: '0.0.0',
    };
    repository.listProgress.mockResolvedValue([progress]);
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'healthy' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    expect(fixture.nativeElement.textContent).toContain('1%');
  });

  it('keeps format actions visible while moving focus inside a row', async () => {
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'healthy' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const exportButton = fixture.nativeElement.querySelector(
      'button[aria-label="Export EPUB for Owned book"]',
    ) as HTMLButtonElement;
    const removeButton = fixture.nativeElement.querySelector(
      'button[aria-label="Remove EPUB for Owned book"]',
    ) as HTMLButtonElement;
    expect(exportButton).toBeTruthy();
    expect(removeButton).toBeTruthy();
  });

  it('shows per-format actions for both formats at once', async () => {
    repository.listBooks.mockResolvedValue([book, secondBook]);
    repository.listLogicalBooks.mockResolvedValueOnce([
      {
        schemaVersion: 1,
        id: 'logical:sha256:shared',
        title: 'Owned book',
        authors: ['Reader'],
        importedAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
        coverState: 'available',
        variants: {
          epub: book.id,
          pdf: secondBook.id,
        },
      },
    ]);
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([
        [book.id, { status: 'healthy' }],
        [secondBook.id, { status: 'healthy' }],
      ]),
    );

    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const badges = Array.from(
      fixture.nativeElement.querySelectorAll('[data-format-badge]'),
    ) as HTMLButtonElement[];
    expect(badges).toHaveLength(2);
    const actionRows = badges[0].parentElement;
    expect(actionRows).toBeTruthy();
    expect(actionRows?.className).toContain('flex');
    expect(actionRows?.className).toContain('w-full');
    const epubExportButton = fixture.nativeElement.querySelector(
      'button[aria-label="Export EPUB for Owned book"]',
    ) as HTMLButtonElement;
    const pdfExportButton = fixture.nativeElement.querySelector(
      'button[aria-label="Export PDF for Owned book"]',
    ) as HTMLButtonElement;
    expect(epubExportButton).toBeTruthy();
    expect(pdfExportButton).toBeTruthy();
    expect(epubExportButton.className).not.toContain('opacity-0');
    expect(pdfExportButton.className).not.toContain('opacity-0');
  });

  it('adds a missing format from the compact format badge', async () => {
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const missingBadge = fixture.nativeElement.querySelector(
      '[data-format-badge="pdf"]',
    ) as HTMLButtonElement;
    expect(missingBadge).toBeTruthy();

    platform.pickPublications.mockResolvedValueOnce([
      {
        name: 'owned-book.pdf',
        mediaType: 'application/pdf',
        open: async () => new Blob([new Uint8Array([1, 2, 3])]),
      },
    ]);
    associations.addFormat.mockResolvedValueOnce({
      status: 'cancelled',
    });

    missingBadge.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(platform.pickPublications).toHaveBeenCalled();
    });
    expect(associations.addFormat).toHaveBeenCalledWith(
      logicalBookFromVariant(book).id,
      expect.any(Array),
    );
    expect(platform.pickPublications).toHaveBeenCalled();
    const addedSources = (associations.addFormat.mock.calls[
      associations.addFormat.mock.calls.length - 1
    ]?.[1] ?? []) as unknown[];
    expect(addedSources[0]).toEqual({
      name: 'owned-book.pdf',
      mediaType: 'application/pdf',
      open: expect.any(Function),
    } as unknown);

    expect(
      fixture.nativeElement.querySelector('[data-format-badge="pdf"]'),
    ).toBeTruthy();
  });

  it('keeps an unreadable present badge focusable and separate from recovery', async () => {
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'unavailable', cause: 'inaccessible' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    const badge = fixture.nativeElement.querySelector(
      '[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    expect(badge.disabled).toBe(false);
    expect(badge.getAttribute('aria-disabled')).toBe('true');
    expect(badge.getAttribute('aria-label')).toContain(
      'Unavailable: inaccessible',
    );
    badge.focus();
    badge.click();
    await fixture.whenStable();
    expect(repository.openHealthyVariant).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(badge);
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-label="Replace EPUB for Owned book"]',
      ),
    ).toBeFalsy();
  });

  it.each([
    [{ status: 'checking' }, 'Checking'],
    [{ status: 'healthy' }, '(open)'],
    [{ status: 'unavailable', cause: 'missing' }, 'Unavailable: missing'],
    [{ status: 'unavailable', cause: 'evicted' }, 'Unavailable: evicted'],
    [
      { status: 'unavailable', cause: 'inaccessible' },
      'Unavailable: inaccessible',
    ],
    [
      { status: 'unavailable', cause: 'incomplete' },
      'Unavailable: incomplete',
    ],
    [
      { status: 'quarantined', cause: 'integrity-invalid' },
      'Quarantined: integrity invalid',
    ],
    [
      { status: 'quarantined', cause: 'unsupported' },
      'Quarantined: unsupported',
    ],
    [
      { status: 'quarantined', cause: 'malformed-reference' },
      'Quarantined: malformed reference',
    ],
  ])(
    'presents the canonical health row %# without conflating recovery',
    async (availability, expectedDescription) => {
      repository.resolveVariantAvailability.mockResolvedValue(
        new Map([[book.id, availability]]),
      );
      const fixture = TestBed.createComponent(LibraryPageComponent);
      fixture.detectChanges();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(fixture.componentInstance.loading).toBe(false);
      });

      const badge = fixture.nativeElement.querySelector(
        '[data-format-badge="epub"]',
      ) as HTMLButtonElement;
      expect(badge.getAttribute('aria-label')).toContain(expectedDescription);
      expect(badge.getAttribute('aria-disabled')).toBe(
        availability.status === 'healthy' ? null : 'true',
      );
      badge.focus();
      expect(
        !!document.querySelector(
          'button[aria-label="Replace EPUB for Owned book"]',
        ),
      ).toBe(false);

      if (availability.status !== 'healthy') {
        badge.click();
        await fixture.whenStable();
        expect(repository.openHealthyVariant).not.toHaveBeenCalled();
        expect(recovery.replaceFromPicker).not.toHaveBeenCalled();
      }
    },
  );

  it('settles a visible checking badge through authoritative verification', async () => {
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'checking' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });

    await fixture.componentInstance['verifyCheckingVariant'](book.id);
    fixture.detectChanges();

    expect(repository.openHealthyVariant).toHaveBeenCalledWith(book.id);
    const badge = fixture.nativeElement.querySelector(
      '[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    expect(badge.getAttribute('aria-disabled')).toBeNull();
    expect(badge.getAttribute('aria-label')).toContain('(open)');
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

    expect(
      fixture.componentInstance.displayedBooks.map((card) => card.title),
    ).toEqual(['Unread book']);
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

    const badge = fixture.nativeElement.querySelector(
      'button[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    expect(badge.getAttribute('aria-label')).toContain('Checking');
    expect(badge.getAttribute('aria-disabled')).toBe('true');
    expect(fixture.componentInstance.errorMessage).toBeNull();
  });

  it('retains open badge state through pending and failed refreshes', async () => {
    const initialProgress: ReadingProgress = {
      schemaVersion: 1,
      bookId: book.id,
      format: 'epub',
      deviceId: 'device-a',
      locator: {
        href: 'chapter.xhtml',
        type: 'application/xhtml+xml',
        locations: { totalProgression: 0.42 },
      },
      furthestTotalProgression: 0.42,
      updatedAt: '2026-07-31T08:00:00.000Z',
      appVersion: '0.0.0',
    };
    repository.listProgress.mockResolvedValue([initialProgress]);
    repository.resolveVariantAvailability.mockResolvedValue(
      new Map([[book.id, { status: 'healthy' }]]),
    );
    const fixture = TestBed.createComponent(LibraryPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.loading).toBe(false);
    });
    const badge = fixture.nativeElement.querySelector(
      '[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    badge.focus();

    let resolveProgress!: (records: readonly ReadingProgress[]) => void;
    repository.listProgress.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProgress = resolve;
      }),
    );
    const pendingReload = fixture.componentInstance['reload']();
    fixture.detectChanges();
    expect(badge.getAttribute('aria-label')).toContain('(open)');
    expect(document.activeElement).toBe(badge);

    resolveProgress([
      {
        ...initialProgress,
        locator: {
          href: 'chapter.xhtml',
          type: 'application/xhtml+xml',
          locations: { totalProgression: 0.6 },
        },
        furthestTotalProgression: 0.6,
      },
    ]);
    await pendingReload;
    fixture.detectChanges();
    const refreshedBadge = fixture.nativeElement.querySelector(
      '[data-format-badge="epub"]',
    ) as HTMLButtonElement;
    expect(refreshedBadge.getAttribute('aria-label')).toContain('(open)');
    expect(document.activeElement).toBe(refreshedBadge);

    repository.listProgress.mockRejectedValueOnce(new Error('offline'));
    await fixture.componentInstance['reload']();
    fixture.detectChanges();
    expect(refreshedBadge.getAttribute('aria-label')).toContain('(open)');
    expect(document.activeElement).toBe(refreshedBadge);
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
