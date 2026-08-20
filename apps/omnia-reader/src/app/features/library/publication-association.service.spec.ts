import { TestBed } from '@angular/core/testing';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import {
  LogicalBookId,
  SyncOperationJournal,
} from '@omnia-reader/reader/domain';
import {
  BOOK_SYNC_EXCLUSIONS,
  BookSyncExclusions,
} from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { DEVICE_ID } from '../../device-identity';
import { PublicationAssociationService } from './publication-association.service';
import { PublicationEnrichmentService } from './publication-enrichment.service';

const LOGICAL_ID = `logical:sha256:${'a'.repeat(64)}` as LogicalBookId;
const source = {
  name: 'companion.pdf',
  mediaType: 'application/pdf',
  size: 14,
  open: async () => new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }),
};

describe('PublicationAssociationService', () => {
  const addVariant = vi.fn();
  const associate = vi.fn();
  const detachVariant = vi.fn();
  const deleteVariant = vi.fn();
  const reconcileMembership = vi.fn();
  const listLogicalBooks = vi.fn();
  const getLogicalBook = vi.fn();
  const append = vi.fn();
  const validateSource = vi.fn(async (_source, book) => ({ book }));
  const syncExclusions = {
    exclude: vi.fn(),
    include: vi.fn(),
    isExcluded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    append.mockResolvedValue({});
    getLogicalBook.mockResolvedValue(logicalRecord(LOGICAL_ID, 'pdf', 'c'));
    syncExclusions.isExcluded.mockReturnValue(false);
    TestBed.configureTestingModule({
      providers: [
        PublicationAssociationService,
        {
          provide: LIBRARY_REPOSITORY,
          useValue: {
            addVariant,
            associate,
            detachVariant,
            deleteVariant,
            reconcileMembership,
            listLogicalBooks,
            getLogicalBook,
          },
        },
        {
          provide: PublicationEnrichmentService,
          useValue: { validateSource },
        },
        {
          provide: SYNC_OPERATION_JOURNAL,
          useValue: { append } as unknown as SyncOperationJournal,
        },
        {
          provide: BOOK_SYNC_EXCLUSIONS,
          useValue: syncExclusions as unknown as BookSyncExclusions,
        },
        { provide: DEVICE_ID, useValue: 'shared-test-device' },
      ],
    });
  });

  it('treats zero selections as cancellation and rejects multiple selections', async () => {
    const service = TestBed.inject(PublicationAssociationService);
    await expect(service.addFormat(LOGICAL_ID, [])).resolves.toEqual({
      status: 'cancelled',
    });
    await expect(
      service.addFormat(LOGICAL_ID, [source, source]),
    ).resolves.toEqual({
      status: 'invalid-selection',
      selectedCount: 2,
    });
    expect(addVariant).not.toHaveBeenCalled();
  });

  it('validates and enriches one source before committing locally', async () => {
    const mutation = mutationResult();
    addVariant.mockResolvedValue({ status: 'added', mutation });
    const service = TestBed.inject(PublicationAssociationService);

    await expect(service.addFormat(LOGICAL_ID, [source])).resolves.toEqual({
      status: 'added',
      mutation,
      syncPending: false,
    });
    expect(validateSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: source.name }),
      expect.objectContaining({ format: 'pdf', title: 'companion' }),
    );
    expect(addVariant).toHaveBeenCalledWith(
      LOGICAL_ID,
      expect.objectContaining({ format: 'pdf', title: 'companion' }),
      expect.objectContaining({ name: source.name }),
      expect.stringMatching(
        /^\.omnia-reader\/library\/companion--[a-f0-9]{12}\/companion\.pdf$/,
      ),
      expect.objectContaining({
        changeId: expect.stringMatching(/^change:shared-test-device:/),
        deviceId: 'shared-test-device',
      }),
      undefined,
    );
    expect(addVariant.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[0],
    );
    expect(syncExclusions.include).toHaveBeenCalledWith(
      `sha256:${'c'.repeat(64)}`,
    );
  });

  it('reports pending synchronization without rolling back a local commit', async () => {
    const mutation = mutationResult();
    addVariant.mockResolvedValue({ status: 'added', mutation });
    append.mockRejectedValueOnce(new Error('journal unavailable'));

    await expect(
      TestBed.inject(PublicationAssociationService).addFormat(LOGICAL_ID, [
        source,
      ]),
    ).resolves.toEqual({ status: 'added', mutation, syncPending: true });
  });

  it('returns the owning logical book so the UI can offer association', async () => {
    const owner = `logical:sha256:${'b'.repeat(64)}`;
    addVariant.mockResolvedValue({
      status: 'belongs-to-other-book',
      logicalBookId: owner,
    });

    await expect(
      TestBed.inject(PublicationAssociationService).addFormat(LOGICAL_ID, [
        source,
      ]),
    ).resolves.toEqual({
      status: 'belongs-to-other-book',
      logicalBookId: owner,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('does not mutate or journal when source validation fails', async () => {
    validateSource.mockRejectedValueOnce(new Error('Publication is corrupt'));

    await expect(
      TestBed.inject(PublicationAssociationService).addFormat(LOGICAL_ID, [
        source,
      ]),
    ).rejects.toThrow('Publication is corrupt');
    expect(addVariant).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('does not journal a discriminated no-mutation repository result', async () => {
    addVariant.mockResolvedValueOnce({
      status: 'same-format-conflict',
      logicalBookId: LOGICAL_ID,
      existingVariantId: `sha256:${'f'.repeat(64)}`,
    });

    await expect(
      TestBed.inject(PublicationAssociationService).addFormat(LOGICAL_ID, [
        source,
      ]),
    ).resolves.toMatchObject({ status: 'same-format-conflict' });
    expect(append).not.toHaveBeenCalled();
  });

  it('journals detach and delete only after their local commits', async () => {
    const mutation = mutationResult('detach');
    detachVariant.mockResolvedValueOnce(mutation);
    deleteVariant.mockResolvedValueOnce(deletionMutation('c'));
    const service = TestBed.inject(PublicationAssociationService);

    await expect(
      service.detach(LOGICAL_ID, `sha256:${'c'.repeat(64)}`),
    ).resolves.toEqual({ mutation, syncPending: false });
    await service.deleteVariant(LOGICAL_ID, `sha256:${'c'.repeat(64)}`);

    expect(detachVariant.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[0],
    );
    expect(deleteVariant.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[1],
    );
    expect(syncExclusions.exclude).toHaveBeenCalledWith(
      `sha256:${'c'.repeat(64)}`,
    );
  });

  it('excludes a variant before deletion and rolls back only a new exclusion on failure', async () => {
    const variantId = `sha256:${'c'.repeat(64)}`;
    deleteVariant.mockRejectedValueOnce(new Error('read-only'));
    const service = TestBed.inject(PublicationAssociationService);

    await expect(service.deleteVariant(LOGICAL_ID, variantId)).rejects.toThrow(
      'read-only',
    );

    expect(syncExclusions.exclude).toHaveBeenCalledWith(variantId);
    expect(syncExclusions.exclude.mock.invocationCallOrder[0]).toBeLessThan(
      deleteVariant.mock.invocationCallOrder[0],
    );
    expect(syncExclusions.include).toHaveBeenCalledWith(variantId);
    expect(append).not.toHaveBeenCalled();
  });

  it('preserves a pre-existing exclusion when deletion fails', async () => {
    const variantId = `sha256:${'c'.repeat(64)}`;
    syncExclusions.isExcluded.mockReturnValueOnce(true);
    deleteVariant.mockRejectedValueOnce(new Error('read-only'));

    await expect(
      TestBed.inject(PublicationAssociationService).deleteVariant(
        LOGICAL_ID,
        variantId,
      ),
    ).rejects.toThrow('read-only');

    expect(syncExclusions.exclude).toHaveBeenCalledWith(variantId);
    expect(syncExclusions.include).not.toHaveBeenCalledWith(variantId);
  });

  it('keeps deletion exclusions when journaling is unavailable', async () => {
    const variantId = `sha256:${'c'.repeat(64)}`;
    deleteVariant.mockResolvedValueOnce(deletionMutation('c'));
    append.mockRejectedValueOnce(new Error('offline'));

    await expect(
      TestBed.inject(PublicationAssociationService).deleteVariant(
        LOGICAL_ID,
        variantId,
      ),
    ).resolves.toMatchObject({ syncPending: true });

    expect(syncExclusions.exclude).toHaveBeenCalledWith(variantId);
    expect(syncExclusions.include).not.toHaveBeenCalledWith(variantId);
  });

  it('pre-excludes every member when deleting a whole logical book', async () => {
    const epubId = `sha256:${'a'.repeat(64)}`;
    const pdfId = `sha256:${'b'.repeat(64)}`;
    getLogicalBook.mockResolvedValueOnce({
      ...logicalRecord(LOGICAL_ID, 'epub', 'a'),
      variants: { epub: epubId, pdf: pdfId },
    });
    deleteVariant.mockResolvedValueOnce({
      ...deletionMutation('a'),
      deletedVariantIds: [epubId, pdfId],
    });

    await TestBed.inject(PublicationAssociationService).deleteVariant(
      LOGICAL_ID,
      null,
    );

    expect(syncExclusions.exclude).toHaveBeenCalledWith(epubId);
    expect(syncExclusions.exclude).toHaveBeenCalledWith(pdfId);
    expect(syncExclusions.exclude.mock.invocationCallOrder[0]).toBeLessThan(
      deleteVariant.mock.invocationCallOrder[0],
    );
    expect(syncExclusions.exclude.mock.invocationCallOrder[1]).toBeLessThan(
      deleteVariant.mock.invocationCallOrder[0],
    );
  });

  it('journals an explicit reconciliation only after the local decision commits', async () => {
    const mutation = mutationResult('reconcile-membership');
    reconcileMembership.mockResolvedValue(mutation);

    await expect(
      TestBed.inject(PublicationAssociationService).reconcile('conflict:test', {
        kind: 'keep-accepted',
      }),
    ).resolves.toEqual({ mutation, syncPending: false });
    expect(reconcileMembership).toHaveBeenCalledWith(
      'conflict:test',
      { kind: 'keep-accepted' },
      expect.objectContaining({ changeId: expect.stringMatching(/^change:/) }),
    );
    expect(reconcileMembership.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[0],
    );
  });

  it('offers only opposite-format candidates and journals association after commit', async () => {
    const pdfLogicalId = `logical:sha256:${'d'.repeat(64)}` as LogicalBookId;
    const otherEpubId = `logical:sha256:${'e'.repeat(64)}` as LogicalBookId;
    listLogicalBooks.mockResolvedValue([
      logicalRecord(LOGICAL_ID, 'epub', 'a'),
      logicalRecord(pdfLogicalId, 'pdf', 'b'),
      logicalRecord(otherEpubId, 'epub', 'c'),
    ]);
    const mutation = mutationResult();
    associate.mockResolvedValue(mutation);
    const service = TestBed.inject(PublicationAssociationService);

    await expect(service.compatibleCandidates(LOGICAL_ID)).resolves.toEqual([
      logicalRecord(pdfLogicalId, 'pdf', 'b'),
    ]);
    await expect(service.associate(LOGICAL_ID, pdfLogicalId)).resolves.toEqual({
      mutation,
      syncPending: false,
    });
    expect(associate.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[0],
    );
  });
});

function mutationResult(
  kind: 'add-variant' | 'detach' | 'reconcile-membership' = 'add-variant',
) {
  const change = {
    schemaVersion: 1 as const,
    changeId: 'change:test:1',
    kind,
    parents: [],
    resultingBooks: [],
    removedLogicalBookIds: [],
    createdAt: '2026-07-31T08:00:00.000Z',
    deviceId: 'test',
    appVersion: '0.0.0',
  };
  return {
    createdLogicalBookIds: [],
    updatedLogicalBookIds: [LOGICAL_ID],
    deletedLogicalBookIds: [],
    createdVariantIds: [`sha256:${'c'.repeat(64)}`],
    deletedVariantIds: [],
    resultingBooks: [],
    change,
  };
}

function deletionMutation(seed: string) {
  const variantId = `sha256:${seed.repeat(64)}`;
  const mutation = mutationResult();
  return {
    ...mutation,
    createdVariantIds: [],
    deletedVariantIds: [variantId],
    change: {
      ...mutation.change,
      changeId: 'change:test:delete',
      kind: 'delete-variant' as const,
    },
  };
}

function logicalRecord(
  id: LogicalBookId,
  format: 'epub' | 'pdf',
  seed: string,
) {
  return {
    schemaVersion: 1 as const,
    id,
    title: 'Candidate',
    authors: [],
    importedAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    coverState: 'pending' as const,
    variants: { [format]: `sha256:${seed.repeat(64)}` },
  };
}
