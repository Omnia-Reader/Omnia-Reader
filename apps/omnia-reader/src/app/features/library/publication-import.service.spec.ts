import { TestBed } from '@angular/core/testing';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import {
  BookRecord,
  BookSource,
  LibraryRepository,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import {
  BOOK_SYNC_EXCLUSIONS,
  BookSyncExclusions,
  bookObjectPath,
} from '@omnia-reader/sync/core';
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
    listLogicalBooks: vi.fn().mockResolvedValue([]),
    importBook: vi.fn().mockResolvedValue(book),
    findLogicalBookByVariant: vi.fn().mockResolvedValue(null),
    removeBook: vi.fn().mockResolvedValue(undefined),
  };
  const journal = {
    append: vi.fn().mockResolvedValue(undefined),
  };
  const enrichment = {
    validateAndEnrich: vi.fn().mockResolvedValue(book),
  };
  const syncExclusions = {
    exclude: vi.fn(),
    include: vi.fn(),
    isExcluded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listBooks.mockResolvedValue([]);
    repository.listLogicalBooks.mockResolvedValue([]);
    repository.importBook.mockResolvedValue(book);
    repository.findLogicalBookByVariant.mockResolvedValue(null);
    repository.removeBook.mockResolvedValue(undefined);
    journal.append.mockResolvedValue(undefined);
    enrichment.validateAndEnrich.mockResolvedValue(book);
    syncExclusions.isExcluded.mockReturnValue(false);
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
        {
          provide: BOOK_SYNC_EXCLUSIONS,
          useValue: syncExclusions as unknown as BookSyncExclusions,
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
    expect(syncExclusions.include).toHaveBeenCalledWith(book.id);
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

  it('removes locally before journaling a durable remote deletion', async () => {
    const service = TestBed.inject(PublicationImportService);

    await service.removePublication(book);

    expect(repository.removeBook).toHaveBeenCalledWith(book.id);
    expect(syncExclusions.exclude).toHaveBeenCalledWith(book.id);
    expect(journal.append).toHaveBeenCalledWith({
      entity: 'book',
      entityId: book.id,
      operation: 'delete',
      payload: expect.objectContaining({
        schemaVersion: 2,
        deleted: true,
        bookId: book.id,
        fileName: book.fileName,
      }),
    });
    expect(repository.removeBook.mock.invocationCallOrder[0]).toBeLessThan(
      journal.append.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('rolls back a new exclusion when local removal fails', async () => {
    repository.removeBook.mockRejectedValueOnce(new Error('read-only'));
    const service = TestBed.inject(PublicationImportService);

    await expect(service.removePublication(book)).rejects.toThrow('read-only');

    expect(syncExclusions.include).toHaveBeenCalledWith(book.id);
    expect(journal.append).not.toHaveBeenCalled();
  });

  it('reports an exact-edition re-import as a duplicate', async () => {
    repository.listBooks.mockResolvedValueOnce([book]);
    repository.listLogicalBooks.mockResolvedValueOnce([logicalBook(book)]);
    const service = TestBed.inject(PublicationImportService);

    await expect(service.importPublications([source])).resolves.toEqual({
      books: [book],
      added: [],
      duplicates: [book],
      failures: [],
    });

    expect(repository.removeBook).not.toHaveBeenCalled();
    expect(syncExclusions.include).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  it('restores an ownerless retained exact edition as an added book', async () => {
    repository.listBooks.mockResolvedValueOnce([book]);
    repository.listLogicalBooks.mockResolvedValueOnce([]);
    repository.findLogicalBookByVariant.mockResolvedValueOnce(
      logicalBook(book),
    );
    const service = TestBed.inject(PublicationImportService);

    await expect(service.importPublications([source])).resolves.toEqual({
      books: [book],
      added: [book],
      duplicates: [],
      failures: [],
    });

    expect(repository.removeBook).not.toHaveBeenCalled();
    expect(syncExclusions.include).toHaveBeenCalledWith(book.id);
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'logical-book-change',
        operation: 'upsert',
        payload: expect.objectContaining({
          variantEffects: [
            expect.objectContaining({ objectPath: bookObjectPath(book) }),
          ],
        }),
      }),
    );
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
    repository.listLogicalBooks.mockResolvedValueOnce([logicalBook(book)]);
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

  it('removes a failed repair that was not visible before re-import', async () => {
    repository.listBooks.mockResolvedValueOnce([book]);
    repository.listLogicalBooks.mockResolvedValueOnce([]);
    enrichment.validateAndEnrich.mockRejectedValueOnce(
      new Error('Renderer temporarily unavailable'),
    );
    const service = TestBed.inject(PublicationImportService);

    await expect(service.importPublications([source])).resolves.toMatchObject({
      books: [],
      added: [],
      duplicates: [],
      failures: [{ message: 'Renderer temporarily unavailable' }],
    });

    expect(repository.removeBook).toHaveBeenCalledWith(book.id);
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

function logicalBook(variant: BookRecord) {
  return {
    schemaVersion: 1 as const,
    id: `logical:sha256:${variant.id.slice('sha256:'.length)}` as const,
    title: variant.title,
    authors: variant.authors,
    importedAt: variant.importedAt,
    updatedAt: variant.importedAt,
    coverState: 'pending' as const,
    variants: { [variant.format]: variant.id },
  };
}
