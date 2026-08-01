import { TestBed } from '@angular/core/testing';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { BookRecord, BookSource } from '@omnia-reader/reader/domain';
import { PublicationRecoveryService } from './publication-recovery.service';

describe('PublicationRecoveryService', () => {
  const replaceVariantSource = vi.fn();
  const pickPublications = vi.fn();
  const source = publicationSource('replacement.epub');

  beforeEach(() => {
    vi.clearAllMocks();
    replaceVariantSource.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        PublicationRecoveryService,
        {
          provide: LIBRARY_REPOSITORY,
          useValue: { replaceVariantSource },
        },
        {
          provide: PLATFORM_PORT,
          useValue: { pickPublications },
        },
      ],
    });
  });

  it('leaves the publication unchanged when the picker is cancelled', async () => {
    pickPublications.mockResolvedValue([]);

    await expect(service().replaceFromPicker(book())).resolves.toEqual({
      status: 'cancelled',
    });
    expect(replaceVariantSource).not.toHaveBeenCalled();
  });

  it('requires exactly one replacement source', async () => {
    pickPublications.mockResolvedValue([source, source]);

    await expect(service().replaceFromPicker(book())).resolves.toEqual({
      status: 'invalid-selection',
      selectedCount: 2,
    });
    expect(replaceVariantSource).not.toHaveBeenCalled();
  });

  it('delegates exact digest, size, and format verification to the repository', async () => {
    pickPublications.mockResolvedValue([source]);
    const record = book();

    await expect(service().replaceFromPicker(record)).resolves.toEqual({
      status: 'replaced',
    });
    expect(replaceVariantSource).toHaveBeenCalledWith(record.id, source);
  });
});

function service(): PublicationRecoveryService {
  return TestBed.inject(PublicationRecoveryService);
}

function publicationSource(name: string): BookSource {
  return {
    name,
    mediaType: 'application/epub+zip',
    size: 4,
    open: async () => new Blob(['test']),
  };
}

function book(): BookRecord {
  return {
    id: `sha256:${'a'.repeat(64)}`,
    format: 'epub',
    fileName: 'book.epub',
    mediaType: 'application/epub+zip',
    size: 4,
    title: 'Book',
    authors: [],
    importedAt: '2026-07-31T08:00:00.000Z',
  };
}
