import { TestBed } from '@angular/core/testing';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import {
  BookRecord,
  BookSource,
  LibraryRepository,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { PublicationEnrichmentService } from './publication-enrichment.service';
import { PublicationImportService } from './publication-import.service';

describe('PublicationImportService', () => {
  const book: BookRecord = {
    id: `sha256:${'a'.repeat(64)}`,
    format: 'pdf',
    fileName: 'book.pdf',
    mediaType: 'application/pdf',
    size: 8,
    title: 'Book',
    authors: [],
    importedAt: '2026-07-25T00:00:00.000Z',
  };
  const source: BookSource = {
    name: 'book.pdf',
    mediaType: 'application/pdf',
    size: 8,
    open: async () => new Blob(['%PDF-1.4']),
  };
  const repository = {
    listBooks: vi.fn().mockResolvedValue([]),
    importBook: vi.fn().mockResolvedValue(book),
    removeBook: vi.fn().mockResolvedValue(undefined),
  };
  const journal = {
    append: vi.fn().mockResolvedValue(undefined),
  };
  const enrichment = {
    validateAndEnrich: vi.fn().mockResolvedValue(book),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listBooks.mockResolvedValue([]);
    repository.importBook.mockResolvedValue(book);
    repository.removeBook.mockResolvedValue(undefined);
    journal.append.mockResolvedValue(undefined);
    enrichment.validateAndEnrich.mockResolvedValue(book);
    TestBed.configureTestingModule({
      providers: [
        PublicationImportService,
        {
          provide: LIBRARY_REPOSITORY,
          useValue: repository as unknown as LibraryRepository,
        },
        {
          provide: SYNC_OPERATION_JOURNAL,
          useValue: journal as unknown as SyncOperationJournal,
        },
        {
          provide: PublicationEnrichmentService,
          useValue: enrichment,
        },
      ],
    });
  });

  it('imports through the repository and records the book for synchronization', async () => {
    const service = TestBed.inject(PublicationImportService);
    const listener = vi.fn();
    service.onImported(listener);

    await expect(service.importPublications([source])).resolves.toEqual({
      books: [book],
      added: [book],
      duplicates: [],
      failures: [],
    });
    expect(repository.importBook).toHaveBeenCalledWith(source);
    expect(enrichment.validateAndEnrich).toHaveBeenCalledWith(book);
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'book',
        entityId: `sha256:${'a'.repeat(64)}`,
        operation: 'upsert',
      }),
    );
    expect(listener).toHaveBeenCalledWith([book]);
  });

  it('keeps a successful local import when the sync journal is unavailable', async () => {
    journal.append.mockRejectedValueOnce(new Error('offline'));
    const service = TestBed.inject(PublicationImportService);

    await expect(service.importPublications([source])).resolves.toEqual({
      books: [book],
      added: [book],
      duplicates: [],
      failures: [],
    });
  });

  it('reports an exact-edition re-import as a duplicate', async () => {
    repository.listBooks.mockResolvedValueOnce([book]);
    const service = TestBed.inject(PublicationImportService);

    await expect(service.importPublications([source])).resolves.toEqual({
      books: [book],
      added: [],
      duplicates: [book],
      failures: [],
    });

    expect(repository.removeBook).not.toHaveBeenCalled();
  });

  it('rolls back a newly stored publication when validation fails', async () => {
    const malformed = new Error('Invalid PDF structure');
    enrichment.validateAndEnrich.mockRejectedValueOnce(malformed);
    const service = TestBed.inject(PublicationImportService);

    await expect(service.importPublications([source])).resolves.toEqual({
      books: [],
      added: [],
      duplicates: [],
      failures: [
        {
          sourceName: 'book.pdf',
          message: 'Invalid PDF structure',
        },
      ],
    });

    expect(repository.removeBook).toHaveBeenCalledWith(book.id);
    expect(journal.append).not.toHaveBeenCalled();
  });

  it('never removes an existing duplicate when revalidation fails', async () => {
    repository.listBooks.mockResolvedValueOnce([book]);
    enrichment.validateAndEnrich.mockRejectedValueOnce(
      new Error('Renderer temporarily unavailable'),
    );
    const service = TestBed.inject(PublicationImportService);

    await expect(service.importPublications([source])).resolves.toEqual({
      books: [],
      added: [],
      duplicates: [],
      failures: [
        {
          sourceName: 'book.pdf',
          message: 'Renderer temporarily unavailable',
        },
      ],
    });

    expect(repository.removeBook).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  it('continues a mixed batch after one publication fails validation', async () => {
    const secondSource: BookSource = {
      ...source,
      name: 'second.pdf',
    };
    const secondBook: BookRecord = {
      ...book,
      id: `sha256:${'b'.repeat(64)}`,
      fileName: secondSource.name,
      title: 'Second',
    };
    repository.importBook
      .mockResolvedValueOnce(book)
      .mockResolvedValueOnce(secondBook);
    enrichment.validateAndEnrich
      .mockRejectedValueOnce(new Error('Invalid PDF structure'))
      .mockResolvedValueOnce(secondBook);
    const service = TestBed.inject(PublicationImportService);

    await expect(
      service.importPublications([source, secondSource]),
    ).resolves.toEqual({
      books: [secondBook],
      added: [secondBook],
      duplicates: [],
      failures: [
        {
          sourceName: 'book.pdf',
          message: 'Invalid PDF structure',
        },
      ],
    });

    expect(repository.removeBook).toHaveBeenCalledWith(book.id);
    expect(journal.append).toHaveBeenCalledTimes(1);
  });
});
