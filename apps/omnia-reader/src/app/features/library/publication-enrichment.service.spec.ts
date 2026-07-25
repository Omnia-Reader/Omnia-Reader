import { TestBed } from '@angular/core/testing';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  BookRecord,
  BookSource,
  LibraryRepository,
  PublicationPasswordRequiredError,
} from '@omnia-reader/reader/domain';
import { PublicationEnrichmentService } from './publication-enrichment.service';

describe('PublicationEnrichmentService', () => {
  const cover = new Blob(['cover pixels'], { type: 'image/png' });
  const source: BookSource = {
    name: 'book.epub',
    mediaType: 'application/epub+zip',
    size: 4,
    open: async () => new Blob(['epub']),
  };
  const book: BookRecord = {
    id: `sha256:${'a'.repeat(64)}`,
    format: 'epub',
    fileName: source.name,
    mediaType: source.mediaType,
    size: source.size,
    title: 'book',
    authors: [],
    importedAt: '2026-07-25T00:00:00.000Z',
  };
  const enriched: BookRecord = {
    ...book,
    title: 'The Book',
    authors: ['Reader'],
    coverState: 'available',
  };
  const repository = {
    getBookCover: vi.fn().mockResolvedValue(null),
    getBookSource: vi.fn().mockResolvedValue(source),
    getBook: vi.fn().mockResolvedValue(book),
    updateMetadata: vi.fn().mockResolvedValue(enriched),
  };
  const engine = {
    open: vi.fn().mockResolvedValue({
      title: enriched.title,
      authors: enriched.authors,
      cover,
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const registry = {
    create: vi.fn().mockResolvedValue(engine),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    engine.open.mockResolvedValue({
      title: enriched.title,
      authors: enriched.authors,
      cover,
    });
    engine.close.mockResolvedValue(undefined);
    repository.getBook.mockResolvedValue(book);
    repository.getBookCover.mockResolvedValue(null);
    repository.updateMetadata.mockResolvedValue(enriched);
    TestBed.configureTestingModule({
      providers: [
        PublicationEnrichmentService,
        {
          provide: LIBRARY_REPOSITORY,
          useValue: repository as unknown as LibraryRepository,
        },
        {
          provide: ReaderEngineRegistry,
          useValue: registry as unknown as ReaderEngineRegistry,
        },
      ],
    });
  });

  it('extracts metadata and safe cover artwork from the stored publication', async () => {
    const service = TestBed.inject(PublicationEnrichmentService);

    await expect(service.enrich(book)).resolves.toEqual(enriched);

    expect(registry.create).toHaveBeenCalledWith('epub');
    expect(engine.open).toHaveBeenCalledWith(source);
    expect(repository.updateMetadata).toHaveBeenCalledWith(
      book.id,
      expect.objectContaining({
        title: 'The Book',
        authors: ['Reader'],
        cover,
      }),
      { markCoverUnavailable: false },
    );
    expect(engine.close).toHaveBeenCalled();
  });

  it('keeps the imported book when optional metadata extraction fails', async () => {
    engine.open.mockRejectedValueOnce(new Error('encrypted'));
    const service = TestBed.inject(PublicationEnrichmentService);

    await expect(service.enrich(book)).resolves.toEqual(book);

    expect(repository.updateMetadata).not.toHaveBeenCalled();
    expect(engine.close).toHaveBeenCalled();
  });

  it('surfaces parser failures when validating a new import', async () => {
    const malformed = new Error('Invalid EPUB package');
    engine.open.mockRejectedValueOnce(malformed);
    const service = TestBed.inject(PublicationEnrichmentService);

    await expect(service.validateAndEnrich(book)).rejects.toBe(malformed);

    expect(repository.updateMetadata).not.toHaveBeenCalled();
    expect(engine.close).toHaveBeenCalled();
  });

  it('accepts an encrypted PDF for password entry in the reader shell', async () => {
    const encryptedImport: BookRecord = {
      ...book,
      format: 'pdf',
      fileName: 'protected.pdf',
      mediaType: 'application/pdf',
    };
    const encryptedBook: BookRecord = {
      ...encryptedImport,
      coverState: 'unavailable',
    };
    engine.open.mockRejectedValueOnce(new PublicationPasswordRequiredError());
    repository.updateMetadata.mockResolvedValueOnce(encryptedBook);
    const service = TestBed.inject(PublicationEnrichmentService);

    await expect(service.validateAndEnrich(encryptedImport)).resolves.toEqual(
      encryptedBook,
    );

    expect(repository.updateMetadata).toHaveBeenCalledWith(
      encryptedImport.id,
      { title: encryptedImport.title, authors: encryptedImport.authors },
      { markCoverUnavailable: true },
    );
    expect(engine.close).toHaveBeenCalled();
  });

  it('records that enrichment completed when a publication has no cover', async () => {
    const withoutCover = {
      ...enriched,
      coverState: 'unavailable' as const,
    };
    engine.open.mockResolvedValueOnce({
      title: enriched.title,
      authors: enriched.authors,
    });
    repository.updateMetadata.mockResolvedValueOnce(withoutCover);
    const service = TestBed.inject(PublicationEnrichmentService);

    await expect(service.enrich(book)).resolves.toEqual(withoutCover);

    expect(repository.updateMetadata).toHaveBeenCalledWith(
      book.id,
      expect.objectContaining({ cover: undefined }),
      { markCoverUnavailable: true },
    );
  });

  it('does not block an import when renderer cleanup never settles', async () => {
    engine.close.mockReturnValueOnce(new Promise<void>(() => undefined));
    const service = TestBed.inject(PublicationEnrichmentService);

    await expect(service.enrich(book)).resolves.toEqual(enriched);

    expect(engine.close).toHaveBeenCalled();
  });
});
