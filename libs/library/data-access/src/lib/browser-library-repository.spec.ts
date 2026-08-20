import 'fake-indexeddb/auto';
import {
  BookRecord,
  DEFAULT_EPUB_READER_PREFERENCES,
  LogicalMutationIdentity,
  PublicationAnnotation,
  PublicationBookmark,
  ReadingProgress,
} from '@omnia-reader/reader/domain';
import { BrowserLibraryRepository } from './browser-library-repository';
import { publicationFingerprint } from './browser-library-repository';
import { PublicationBinaryStorage } from './publication-binary-storage';
import { LibraryRestoreStaleRevisionError } from './library-restore';

describe('publicationFingerprint', () => {
  it('creates a stable exact-edition SHA-256 identifier', async () => {
    const first = await publicationFingerprint(blob('same edition'));
    const second = await publicationFingerprint(blob('same edition'));
    const revised = await publicationFingerprint(blob('revised edition'));

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(revised).not.toBe(first);
  });
});

describe('BrowserLibraryRepository reader preferences', () => {
  it('persists format-specific preferences across repository instances', async () => {
    const preferences = {
      ...DEFAULT_EPUB_READER_PREFERENCES,
      theme: 'sepia' as const,
      fontSizePercent: 125,
    };
    await new BrowserLibraryRepository().saveReaderPreferences(preferences);

    await expect(
      new BrowserLibraryRepository().getReaderPreferences('epub'),
    ).resolves.toEqual(preferences);
    await expect(
      new BrowserLibraryRepository().getReaderPreferences('pdf'),
    ).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository atomic backup restore', () => {
  it('commits publication bytes, membership, and reader state together', async () => {
    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      'atomic-backup-restore',
    );
    const content = new Blob(['%PDF-1.7 atomic restore'], {
      type: 'application/pdf',
    });
    const id = await publicationFingerprint(content);
    const book: BookRecord = {
      id,
      format: 'pdf',
      fileName: 'atomic.pdf',
      mediaType: content.type,
      size: content.size,
      title: 'Atomic',
      authors: [],
      importedAt: '2026-08-20T00:00:00.000Z',
    };
    const snapshot = await repository.getLogicalLibrarySnapshot();

    await repository.restoreLibraryBackupAtomically({
      expectedLogicalRevision: snapshot.revision,
      publications: [{ record: book, content }],
      logicalBooks: [
        {
          schemaVersion: 1,
          id: `logical:sha256:${id.slice('sha256:'.length)}`,
          title: book.title,
          authors: [],
          importedAt: book.importedAt,
          updatedAt: book.importedAt,
          coverState: 'unavailable',
          variants: { pdf: id },
        },
      ],
      logicalBookPreferences: [],
      membershipReconciliations: [],
      logicalBookCovers: new Map(),
      progress: [],
      progressDocuments: [],
      readerPreferences: [],
      bookmarks: [],
      annotations: [],
    });

    await expect(repository.getBook(id)).resolves.toEqual(book);
    await expect((await repository.getBookSource(id))?.open()).resolves.toEqual(
      content,
    );
    await expect(
      repository.findLogicalBookByVariant(id),
    ).resolves.toMatchObject({
      variants: { pdf: id },
    });
  });

  it('aborts without publishing staged records when the logical revision is stale', async () => {
    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      'stale-backup-restore',
    );
    const stale = await repository.getLogicalLibrarySnapshot();
    await repository.importBook(
      source(
        'concurrent.pdf',
        new Blob(['%PDF-1.7 concurrent'], { type: 'application/pdf' }),
      ),
    );
    const content = new Blob(['%PDF-1.7 stale candidate'], {
      type: 'application/pdf',
    });
    const id = await publicationFingerprint(content);
    const book: BookRecord = {
      id,
      format: 'pdf',
      fileName: 'stale.pdf',
      mediaType: content.type,
      size: content.size,
      title: 'Stale',
      authors: [],
      importedAt: '2026-08-20T00:00:00.000Z',
    };

    await expect(
      repository.restoreLibraryBackupAtomically({
        expectedLogicalRevision: stale.revision,
        publications: [{ record: book, content }],
        logicalBooks: [],
        logicalBookPreferences: [],
        membershipReconciliations: [],
        logicalBookCovers: new Map(),
        progress: [],
        progressDocuments: [],
        readerPreferences: [],
        bookmarks: [],
        annotations: [],
      }),
    ).rejects.toBeInstanceOf(LibraryRestoreStaleRevisionError);
    await expect(repository.getBook(id)).resolves.toBeNull();
  });

  it('rolls back publication bytes when the restore transaction fails', async () => {
    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      'failed-atomic-backup-restore',
    );
    const content = new Blob(['%PDF-1.7 rollback candidate'], {
      type: 'application/pdf',
    });
    const id = await publicationFingerprint(content);
    const book: BookRecord = {
      id,
      format: 'pdf',
      fileName: 'rollback.pdf',
      mediaType: content.type,
      size: content.size,
      title: 'Rollback',
      authors: [],
      importedAt: '2026-08-20T00:00:00.000Z',
    };
    const snapshot = await repository.getLogicalLibrarySnapshot();
    const logical = {
      schemaVersion: 1 as const,
      id: `logical:sha256:${'1'.repeat(64)}` as const,
      title: book.title,
      authors: [],
      importedAt: book.importedAt,
      updatedAt: book.importedAt,
      coverState: 'unavailable' as const,
      variants: { pdf: id },
    };

    await expect(
      repository.restoreLibraryBackupAtomically({
        expectedLogicalRevision: snapshot.revision,
        publications: [{ record: book, content }],
        logicalBooks: [
          logical,
          {
            ...logical,
            id: `logical:sha256:${'2'.repeat(64)}`,
          },
        ],
        logicalBookPreferences: [],
        membershipReconciliations: [],
        logicalBookCovers: new Map(),
        progress: [],
        progressDocuments: [],
        readerPreferences: [],
        bookmarks: [],
        annotations: [],
      }),
    ).rejects.toBeDefined();
    await expect(repository.getBook(id)).resolves.toBeNull();
    await expect(repository.getBookSource(id)).resolves.toBeNull();
    await expect(repository.listLogicalBooks()).resolves.toEqual([]);
  });
});

describe('BrowserLibraryRepository logical singleton and availability', () => {
  it('creates one deterministic singleton for standalone and synchronized variants', async () => {
    const repository = new BrowserLibraryRepository();
    const localBytes = new Blob(['%PDF-1.4 local singleton'], {
      type: 'application/pdf',
    });
    const imported = await repository.importBook({
      name: 'local.pdf',
      mediaType: localBytes.type,
      size: localBytes.size,
      open: async () => localBytes,
    });
    const remoteBytes = new Blob(['remote epub singleton'], {
      type: 'application/epub+zip',
    });
    const remoteId = await publicationFingerprint(remoteBytes);
    await repository.storeSyncedBook(
      {
        id: remoteId,
        format: 'epub',
        fileName: 'remote.epub',
        mediaType: remoteBytes.type,
        size: remoteBytes.size,
        title: 'Remote',
        authors: [],
        importedAt: '2026-07-31T08:00:00.000Z',
      },
      {
        name: 'remote.epub',
        mediaType: remoteBytes.type,
        size: remoteBytes.size,
        open: async () => remoteBytes,
      },
    );

    await expect(repository.listLogicalBooks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variants: { pdf: imported.id } }),
        expect.objectContaining({ variants: { epub: remoteId } }),
      ]),
    );
  });

  it('repairs an ownerless retained exact edition without rewriting healthy bytes', async () => {
    const databaseName = 'ownerless-reimport-repair';
    const bytes = new Blob(['%PDF-1.4 ownerless retained edition'], {
      type: 'application/pdf',
    });
    const binaryStorage = controlledBinaryStorage('indexeddb', bytes);
    const repository = new BrowserLibraryRepository(
      binaryStorage,
      undefined,
      databaseName,
    );
    const publication = source('retained.pdf', bytes);
    const imported = await repository.importBook(publication);
    const logical = await repository.findLogicalBookByVariant(imported.id);
    assertPresent(logical);
    await deleteRawLibraryRecord('logicalBooks', logical.id, databaseName);

    await expect(repository.listBooks()).resolves.toEqual([imported]);
    await expect(
      repository.findLogicalBookByVariant(imported.id),
    ).resolves.toBeNull();

    await expect(repository.importBook(publication)).resolves.toEqual(imported);

    await expect(repository.listBooks()).resolves.toEqual([imported]);
    await expect(
      repository.findLogicalBookByVariant(imported.id),
    ).resolves.toMatchObject({ variants: { pdf: imported.id } });
    expect(binaryStorage.save).toHaveBeenCalledTimes(1);
  });

  it('distinguishes lightweight checking from authoritative healthy status', async () => {
    const repository = new BrowserLibraryRepository();
    const bytes = new Blob(['%PDF-1.4 health'], { type: 'application/pdf' });
    const book = await repository.importBook({
      name: 'health.pdf',
      mediaType: bytes.type,
      size: bytes.size,
      open: async () => bytes,
    });

    await expect(
      repository.resolveVariantAvailability([book.id]),
    ).resolves.toEqual(new Map([[book.id, { status: 'checking' }]]));
    await expect(repository.openHealthyVariant(book.id)).resolves.toMatchObject(
      {
        availability: { status: 'healthy' },
        source: { name: 'health.pdf' },
      },
    );
  });

  it.each([
    ['opfs', null, 'evicted', '1'],
    ['indexeddb', null, 'inaccessible', '2'],
    ['indexeddb', new Blob(['short']), 'incomplete', '3'],
  ] as const)(
    'reports unavailable bytes with the required cause',
    async (storage, opened, cause, digestDigit) => {
      const bookId = `sha256:${digestDigit.repeat(64)}`;
      const bytes = new Blob(['%PDF-1.4 availability fixture'], {
        type: 'application/pdf',
      });
      const binaryStorage = controlledBinaryStorage(storage, opened);
      const repository = new BrowserLibraryRepository(
        binaryStorage,
        async () => bookId,
        `availability-${cause}`,
      );
      await repository.importBook({
        name: 'availability.pdf',
        mediaType: bytes.type,
        size: bytes.size,
        open: async () => bytes,
      });

      await expect(repository.openHealthyVariant(bookId)).resolves.toEqual({
        availability: { status: 'unavailable', cause },
      });
    },
  );

  it('quarantines same-size digest mismatch before returning a source', async () => {
    const bookId = `sha256:${'9'.repeat(64)}`;
    const wrongId = `sha256:${'8'.repeat(64)}`;
    const bytes = new Blob(['%PDF-1.4 same-size corrupt'], {
      type: 'application/pdf',
    });
    const fingerprint = vi
      .fn<(blob: Blob) => Promise<string>>()
      .mockResolvedValueOnce(bookId)
      .mockResolvedValue(wrongId);
    const repository = new BrowserLibraryRepository(
      controlledBinaryStorage('indexeddb', bytes),
      fingerprint,
      'availability-digest-mismatch',
    );
    await repository.importBook({
      name: 'digest.pdf',
      mediaType: bytes.type,
      size: bytes.size,
      open: async () => bytes,
    });

    await expect(repository.openHealthyVariant(bookId)).resolves.toEqual({
      availability: { status: 'quarantined', cause: 'integrity-invalid' },
    });
    await expect(repository.getBookSource(bookId)).resolves.toBeNull();
  });

  it('quarantines a detected-format mismatch before returning a source', async () => {
    const bookId = `sha256:${'6'.repeat(64)}`;
    const declaredPdf = new Blob(['%PDF-x'], { type: 'application/pdf' });
    const storedEpub = new Blob(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])],
      {
        type: 'application/epub+zip',
      },
    );
    const repository = new BrowserLibraryRepository(
      controlledBinaryStorage('indexeddb', storedEpub),
      async () => bookId,
      'availability-format-mismatch',
    );
    await repository.importBook({
      name: 'declared.pdf',
      mediaType: declaredPdf.type,
      size: declaredPdf.size,
      open: async () => declaredPdf,
    });

    await expect(repository.openHealthyVariant(bookId)).resolves.toEqual({
      availability: { status: 'quarantined', cause: 'unsupported' },
    });
  });

  it('quarantines a malformed active reference with the canonical cause', async () => {
    const databaseName = 'availability-malformed-reference';
    const bytes = new Blob(['%PDF-1.4 malformed reference'], {
      type: 'application/pdf',
    });
    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      databaseName,
    );
    const book = await repository.importBook({
      name: 'malformed.pdf',
      mediaType: bytes.type,
      size: bytes.size,
      open: async () => bytes,
    });
    await putRawLibraryRecords(
      [
        {
          storeName: 'binaries',
          value: {
            schemaVersion: 2,
            storage: 'opfs',
            bookId: book.id,
            fileName: 'malformed.pdf',
            mediaType: 'application/pdf',
            size: bytes.size,
            opfsFileName: '../unsafe.pdf',
          },
        },
      ],
      databaseName,
    );

    await expect(repository.openHealthyVariant(book.id)).resolves.toEqual({
      availability: { status: 'quarantined', cause: 'malformed-reference' },
    });
  });

  it('reports a missing active reference and excludes cover state from health', async () => {
    const databaseName = 'availability-missing-cover-exclusion';
    const bytes = new Blob(['%PDF-1.4 cover independent'], {
      type: 'application/pdf',
    });
    const repository = new BrowserLibraryRepository(
      undefined,
      undefined,
      databaseName,
    );
    const book = await repository.importBook({
      name: 'cover-independent.pdf',
      mediaType: bytes.type,
      size: bytes.size,
      open: async () => bytes,
    });
    const logical = await repository.findLogicalBookByVariant(book.id);
    assertPresent(logical);
    await putRawLibraryRecords(
      [
        {
          storeName: 'logicalBookCovers',
          value: { logicalBookId: logical.id, mediaType: '', bytes: 'bad' },
        },
      ],
      databaseName,
    );
    await expect(
      repository.getLogicalBookCover(logical.id),
    ).resolves.toBeNull();
    await expect(repository.openHealthyVariant(book.id)).resolves.toMatchObject(
      {
        availability: { status: 'healthy' },
      },
    );

    await deleteRawLibraryRecord('binaries', book.id, databaseName);
    await expect(repository.openHealthyVariant(book.id)).resolves.toEqual({
      availability: { status: 'unavailable', cause: 'missing' },
    });
  });

  it('accepts exact replacement after historical quarantine', async () => {
    const bytes = new Blob(['%PDF-1.4 replacement fixture'], {
      type: 'application/pdf',
    });
    const bookId = await publicationFingerprint(bytes);
    let active: Blob | null = bytes;
    const storage = controlledBinaryStorage('indexeddb', () => active);
    const fingerprint = vi
      .fn<(blob: Blob) => Promise<string>>()
      .mockResolvedValueOnce(bookId)
      .mockResolvedValueOnce(`sha256:${'7'.repeat(64)}`)
      .mockResolvedValue(bookId);
    const repository = new BrowserLibraryRepository(
      storage,
      fingerprint,
      'availability-replacement',
    );
    await repository.importBook({
      name: 'replacement.pdf',
      mediaType: bytes.type,
      size: bytes.size,
      open: async () => bytes,
    });
    await repository.openHealthyVariant(bookId);
    active = bytes;
    await repository.replaceVariantSource(bookId, {
      name: 'replacement.pdf',
      mediaType: bytes.type,
      size: bytes.size,
      open: async () => bytes,
    });

    await expect(repository.openHealthyVariant(bookId)).resolves.toMatchObject({
      availability: { status: 'healthy' },
    });
  });
});

describe('BrowserLibraryRepository add logical-book variant', () => {
  it('atomically adds an opposite format without creating another card', async () => {
    const repository = new BrowserLibraryRepository();
    const pdf = new Blob(['%PDF-1.4 destination'], { type: 'application/pdf' });
    const destination = await repository.importBook(
      source('destination.pdf', pdf),
    );
    const logical = await repository.findLogicalBookByVariant(destination.id);
    assertPresent(logical);
    const epub = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2])], {
      type: 'application/epub+zip',
    });
    const variant = bookRecord(
      await publicationFingerprint(epub),
      'epub',
      epub,
    );

    await expect(
      repository.addVariant(
        logical.id,
        variant,
        source('candidate.epub', epub),
        testObjectPath(variant),
        mutation('add:1'),
      ),
    ).resolves.toMatchObject({
      status: 'added',
      mutation: { createdVariantIds: [variant.id] },
    });
    await expect(repository.listLogicalBooks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variants: { pdf: destination.id, epub: variant.id },
        }),
      ]),
    );
    await expect(
      repository.openHealthyVariant(variant.id),
    ).resolves.toMatchObject({
      availability: { status: 'healthy' },
    });
  });

  it('returns discriminated duplicate and same-format ownership results', async () => {
    const repository = new BrowserLibraryRepository();
    const firstPdf = new Blob(['%PDF-1.4 first'], { type: 'application/pdf' });
    const secondPdf = new Blob(['%PDF-1.4 second'], {
      type: 'application/pdf',
    });
    const epub = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 4])], {
      type: 'application/epub+zip',
    });
    const first = await repository.importBook(source('first.pdf', firstPdf));
    const existingEpub = await repository.importBook(
      source('existing.epub', epub),
    );
    const firstLogical = await repository.findLogicalBookByVariant(first.id);
    assertPresent(firstLogical);
    const secondVariant = bookRecord(
      await publicationFingerprint(secondPdf),
      'pdf',
      secondPdf,
      'second.pdf',
    );
    const epubVariant = bookRecord(
      existingEpub.id,
      'epub',
      epub,
      'existing.epub',
    );

    await expect(
      repository.addVariant(
        firstLogical.id,
        bookRecord(first.id, 'pdf', firstPdf, 'first.pdf'),
        source('first.pdf', firstPdf),
        testObjectPath(bookRecord(first.id, 'pdf', firstPdf, 'first.pdf')),
        mutation('add:duplicate-here'),
      ),
    ).resolves.toEqual({
      status: 'already-member',
      logicalBookId: firstLogical.id,
    });
    await expect(
      repository.addVariant(
        firstLogical.id,
        secondVariant,
        source('second.pdf', secondPdf),
        testObjectPath(secondVariant),
        mutation('add:same-format'),
      ),
    ).resolves.toEqual({
      status: 'same-format-conflict',
      logicalBookId: firstLogical.id,
      existingVariantId: first.id,
    });
    await expect(
      repository.addVariant(
        firstLogical.id,
        epubVariant,
        source('existing.epub', epub),
        testObjectPath(epubVariant),
        mutation('add:other-owner'),
      ),
    ).resolves.toMatchObject({ status: 'belongs-to-other-book' });
  });

  it('leaves staged bytes unreachable when the destination disappeared', async () => {
    const removed: unknown[] = [];
    const storage = controlledBinaryStorage('opfs', null);
    storage.remove = vi.fn(async (stored) => {
      removed.push(stored);
    });
    const repository = new BrowserLibraryRepository(storage);
    const pdf = new Blob(['%PDF-1.4 destination gone'], {
      type: 'application/pdf',
    });
    const destination = await repository.importBook(source('gone.pdf', pdf));
    const logical = await repository.findLogicalBookByVariant(destination.id);
    assertPresent(logical);
    await deleteRawLibraryRecord('logicalBooks', logical.id);
    const epub = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9])], {
      type: 'application/epub+zip',
    });
    const variant = bookRecord(
      await publicationFingerprint(epub),
      'epub',
      epub,
    );

    await expect(
      repository.addVariant(
        logical.id,
        variant,
        source('candidate.epub', epub),
        testObjectPath(variant),
        mutation('add:gone'),
      ),
    ).rejects.toThrow('not found');
    expect(removed).toHaveLength(0);
  });

  it('cleans staged bytes after a metadata transaction failure and permits retry', async () => {
    const databaseName = 'add-variant-transaction-retry';
    const storage = controlledBinaryStorage('opfs', null);
    const repository = new BrowserLibraryRepository(
      storage,
      undefined,
      databaseName,
    );
    const pdf = new Blob(['%PDF-1.4 transaction destination'], {
      type: 'application/pdf',
    });
    const destination = await repository.importBook(
      source('transaction.pdf', pdf),
    );
    const logical = await repository.findLogicalBookByVariant(destination.id);
    assertPresent(logical);
    const epub = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 12])], {
      type: 'application/epub+zip',
    });
    const variant = bookRecord(
      await publicationFingerprint(epub),
      'epub',
      epub,
    );
    await putRawLibraryRecords(
      [{ storeName: 'books', value: variant }],
      databaseName,
    );

    await expect(
      repository.addVariant(
        logical.id,
        variant,
        source('candidate.epub', epub),
        testObjectPath(variant),
        mutation('add:transaction-retry'),
      ),
    ).rejects.toBeTruthy();
    expect(storage.remove).toHaveBeenCalledTimes(1);
    await expect(repository.getLogicalBook(logical.id)).resolves.toMatchObject({
      variants: { pdf: destination.id },
    });

    await deleteRawLibraryRecord('books', variant.id, databaseName);
    await expect(
      repository.addVariant(
        logical.id,
        variant,
        source('candidate.epub', epub),
        testObjectPath(variant),
        mutation('add:transaction-retry'),
      ),
    ).resolves.toMatchObject({
      status: 'added',
      mutation: {
        change: {
          variantEffects: [
            expect.objectContaining({ objectPath: testObjectPath(variant) }),
          ],
        },
      },
    });
  });

  it('leaves membership unchanged when staging fails for quota', async () => {
    const databaseName = 'add-variant-quota-failure';
    const storage = controlledBinaryStorage('opfs', null);
    const repository = new BrowserLibraryRepository(
      storage,
      undefined,
      databaseName,
    );
    const pdf = new Blob(['%PDF-1.4 quota destination'], {
      type: 'application/pdf',
    });
    const destination = await repository.importBook(source('quota.pdf', pdf));
    const logical = await repository.findLogicalBookByVariant(destination.id);
    assertPresent(logical);
    vi.mocked(storage.save).mockRejectedValueOnce(
      new DOMException('Storage quota exceeded', 'QuotaExceededError'),
    );
    const epub = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 13])], {
      type: 'application/epub+zip',
    });
    const variant = bookRecord(
      await publicationFingerprint(epub),
      'epub',
      epub,
    );

    await expect(
      repository.addVariant(
        logical.id,
        variant,
        source('candidate.epub', epub),
        testObjectPath(variant),
        mutation('add:quota'),
      ),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(repository.getLogicalBook(logical.id)).resolves.toMatchObject({
      variants: { pdf: destination.id },
    });
    await expect(repository.getBook(variant.id)).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository logical-book association', () => {
  it('keeps destination presentation and preserves exact variant state', async () => {
    const repository = new BrowserLibraryRepository();
    const epubBytes = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 11])], {
      type: 'application/epub+zip',
    });
    const pdfBytes = new Blob(['%PDF-1.4 association'], {
      type: 'application/pdf',
    });
    const epub = await repository.importBook(
      source('destination.epub', epubBytes),
    );
    const pdf = await repository.importBook(source('source.pdf', pdfBytes));
    const destination = await repository.findLogicalBookByVariant(epub.id);
    const sourceLogical = await repository.findLogicalBookByVariant(pdf.id);
    assertPresent(destination);
    assertPresent(sourceLogical);
    await repository.saveProgress(progressDocument(pdf.id, 'association', 0.4));

    await expect(
      repository.associate(
        destination.id,
        sourceLogical.id,
        mutation('associate:1'),
      ),
    ).resolves.toMatchObject({
      updatedLogicalBookIds: [destination.id],
      deletedLogicalBookIds: [sourceLogical.id],
      resultingBooks: [
        expect.objectContaining({
          id: destination.id,
          title: destination.title,
          variants: { epub: epub.id, pdf: pdf.id },
        }),
      ],
    });
    await expect(
      repository.getLogicalBook(sourceLogical.id),
    ).resolves.toBeNull();
    await expect(repository.getProgress(pdf.id)).resolves.toMatchObject({
      bookId: pdf.id,
    });
    await expect(repository.getBookSource(epub.id)).resolves.not.toBeNull();
    await expect(repository.getBookSource(pdf.id)).resolves.not.toBeNull();
  });

  it('rejects same-format and self association without mutation', async () => {
    const repository = new BrowserLibraryRepository();
    const leftBytes = new Blob(['%PDF-1.4 left association'], {
      type: 'application/pdf',
    });
    const rightBytes = new Blob(['%PDF-1.4 right association'], {
      type: 'application/pdf',
    });
    const left = await repository.importBook(source('left.pdf', leftBytes));
    const right = await repository.importBook(source('right.pdf', rightBytes));
    const leftLogical = await repository.findLogicalBookByVariant(left.id);
    const rightLogical = await repository.findLogicalBookByVariant(right.id);
    assertPresent(leftLogical);
    assertPresent(rightLogical);

    await expect(
      repository.associate(
        leftLogical.id,
        rightLogical.id,
        mutation('associate:conflict'),
      ),
    ).rejects.toThrow('already contain a PDF');
    await expect(
      repository.associate(
        leftLogical.id,
        leftLogical.id,
        mutation('associate:self'),
      ),
    ).rejects.toThrow('itself');
    await expect(
      repository.getLogicalBook(rightLogical.id),
    ).resolves.not.toBeNull();
  });
});

describe('BrowserLibraryRepository logical-book management', () => {
  it('detaches the selected format without changing either exact publication', async () => {
    const repository = new BrowserLibraryRepository();
    const epubBytes = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 21])], {
      type: 'application/epub+zip',
    });
    const pdfBytes = new Blob(['%PDF-1.4 detach'], {
      type: 'application/pdf',
    });
    const epub = await repository.importBook(source('anchor.epub', epubBytes));
    const pdf = await repository.importBook(source('detached.pdf', pdfBytes));
    const destination = await repository.findLogicalBookByVariant(epub.id);
    const sourceLogical = await repository.findLogicalBookByVariant(pdf.id);
    assertPresent(destination);
    assertPresent(sourceLogical);
    await repository.associate(
      destination.id,
      sourceLogical.id,
      mutation('associate:detach'),
    );
    await repository.saveLogicalBookFormatPreference(
      destination.id,
      'pdf',
      mutation('preference:pdf'),
    );

    const result = await repository.detachVariant(
      destination.id,
      pdf.id,
      mutation('detach:pdf'),
    );

    expect(result.createdLogicalBookIds).toHaveLength(1);
    await expect(repository.listLogicalBooks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: destination.id,
          variants: { epub: epub.id },
        }),
        expect.objectContaining({ variants: { pdf: pdf.id } }),
      ]),
    );
    await expect(
      repository.getLogicalBookFormatPreference(destination.id),
    ).resolves.toMatchObject({ preferredFormat: 'epub' });
    await expect(repository.getBookSource(epub.id)).resolves.not.toBeNull();
    await expect(repository.getBookSource(pdf.id)).resolves.not.toBeNull();
  });

  it('deletes one format state and then removes the final logical book', async () => {
    const repository = new BrowserLibraryRepository();
    const epubBytes = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 22])], {
      type: 'application/epub+zip',
    });
    const pdfBytes = new Blob(['%PDF-1.4 delete'], {
      type: 'application/pdf',
    });
    const epub = await repository.importBook(source('keep.epub', epubBytes));
    const pdf = await repository.importBook(source('delete.pdf', pdfBytes));
    const logical = await repository.findLogicalBookByVariant(epub.id);
    const pdfLogical = await repository.findLogicalBookByVariant(pdf.id);
    assertPresent(logical);
    assertPresent(pdfLogical);
    await repository.associate(
      logical.id,
      pdfLogical.id,
      mutation('associate:delete'),
    );
    await repository.saveProgress(progressDocument(pdf.id, 'delete', 0.7));

    await repository.deleteVariant(logical.id, pdf.id, mutation('delete:pdf'));

    await expect(repository.getBook(pdf.id)).resolves.toBeNull();
    await expect(repository.getProgress(pdf.id)).resolves.toBeNull();
    await expect(repository.getLogicalBook(logical.id)).resolves.toMatchObject({
      variants: { epub: epub.id },
    });

    await repository.deleteVariant(logical.id, null, mutation('delete:book'));
    await expect(repository.getLogicalBook(logical.id)).resolves.toBeNull();
    await expect(repository.getBook(epub.id)).resolves.toBeNull();
  });

  it('persists and resolves a membership reconciliation atomically', async () => {
    const repository = new BrowserLibraryRepository();
    const epubBytes = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 23])], {
      type: 'application/epub+zip',
    });
    const pdfBytes = new Blob(['%PDF-1.4 reconcile'], {
      type: 'application/pdf',
    });
    const epub = await repository.importBook(source('review.epub', epubBytes));
    const pdf = await repository.importBook(source('review.pdf', pdfBytes));
    const epubLogical = await repository.findLogicalBookByVariant(epub.id);
    const pdfLogical = await repository.findLogicalBookByVariant(pdf.id);
    assertPresent(epubLogical);
    assertPresent(pdfLogical);
    const reconciliation = {
      schemaVersion: 1 as const,
      conflictId: 'membership:review',
      status: 'open' as const,
      conflictingChangeIds: ['change:left', 'change:right'],
      affectedVariantIds: [epub.id, pdf.id].sort(),
      acceptedMembership: [
        {
          logicalBookId: epubLogical.id,
          format: 'epub' as const,
          variantId: epub.id,
        },
        {
          logicalBookId: epubLogical.id,
          format: 'pdf' as const,
          variantId: pdf.id,
        },
      ],
      rejectedMembership: [
        {
          logicalBookId: pdfLogical.id,
          format: 'epub' as const,
          variantId: epub.id,
        },
        {
          logicalBookId: pdfLogical.id,
          format: 'pdf' as const,
          variantId: pdf.id,
        },
      ],
      detectedAt: '2026-07-31T12:00:00.000Z',
    };
    await repository.replaceLogicalBookState(
      [epubLogical, pdfLogical],
      [],
      [reconciliation],
    );

    await expect(
      repository.listOpenMembershipReconciliations(),
    ).resolves.toEqual([reconciliation]);
    await repository.reconcileMembership(
      reconciliation.conflictId,
      { kind: 'accept-rejected', logicalBookId: pdfLogical.id },
      mutation('reconcile:accept'),
    );

    await expect(
      repository.listOpenMembershipReconciliations(),
    ).resolves.toEqual([]);
    await expect(repository.getLogicalLibrarySnapshot()).resolves.toMatchObject(
      {
        reconciliations: [
          expect.objectContaining({
            conflictId: reconciliation.conflictId,
            status: 'resolved',
            resolvedByChangeId: 'reconcile:accept',
          }),
        ],
      },
    );
  });
});

function controlledBinaryStorage(
  storage: 'opfs' | 'indexeddb',
  opened: Blob | null | (() => Blob | null),
): PublicationBinaryStorage {
  return {
    save: vi.fn(async (request) => {
      if (storage === 'opfs') {
        return {
          schemaVersion: 2 as const,
          storage,
          bookId: request.bookId,
          fileName: request.fileName,
          mediaType: request.mediaType,
          size: request.blob.size,
          opfsFileName: `${request.bookId.slice(7)}.${request.format}`,
        };
      }
      return {
        schemaVersion: 2 as const,
        storage,
        bookId: request.bookId,
        fileName: request.fileName,
        mediaType: request.mediaType,
        size: request.blob.size,
        bytes: await testBlobBytes(request.blob),
      };
    }),
    open: vi.fn(async () => (typeof opened === 'function' ? opened() : opened)),
    migrate: vi.fn(async (stored) => stored),
    remove: vi.fn(async () => undefined),
  };
}

function testBlobBytes(value: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () =>
      resolve(reader.result as ArrayBuffer),
    );
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsArrayBuffer(value);
  });
}

describe('BrowserLibraryRepository publication covers', () => {
  it('stores derived artwork without marking an import as opened', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 cover persistence fixture'], {
      type: 'application/pdf',
    });
    const source = {
      name: 'cover-persistence.pdf',
      mediaType: 'application/pdf',
      size: publication.size,
      open: async () => publication,
    };
    const imported = await repository.importBook(source);
    const cover = new Blob(['cover pixels'], { type: 'image/png' });

    const enriched = await repository.updateMetadata(imported.id, {
      title: 'Durable cover',
      authors: ['Omnia'],
      language: 'en',
      publisher: 'Omnia Press',
      identifier: 'urn:omnia:durable-cover',
      cover,
    });

    expect(enriched).toMatchObject({
      title: 'Durable cover',
      authors: ['Omnia'],
      language: 'en',
      publisher: 'Omnia Press',
      identifier: 'urn:omnia:durable-cover',
      coverState: 'available',
    });
    expect(enriched.lastOpenedAt).toBeUndefined();
    await expect(repository.getBookCover(imported.id)).resolves.not.toBeNull();

    const opened = await repository.updateMetadata(
      imported.id,
      { title: enriched.title, authors: enriched.authors },
      { markOpened: true },
    );
    expect(opened.lastOpenedAt).toBeDefined();
    expect(opened.coverState).toBe('available');
  });

  it('deletes cached artwork with its publication', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 cover deletion fixture'], {
      type: 'application/pdf',
    });
    const imported = await repository.importBook({
      name: 'cover-deletion.pdf',
      mediaType: 'application/pdf',
      size: publication.size,
      open: async () => publication,
    });
    await repository.updateMetadata(imported.id, {
      title: imported.title,
      authors: [],
      cover: new Blob(['cover'], { type: 'image/png' }),
    });

    await repository.removeBook(imported.id);

    await expect(repository.getBookCover(imported.id)).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository progress document cache', () => {
  it('persists every device document and removes them with the publication', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 progress cache fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'progress-cache.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const deviceA = progressDocument(book.id, 'device-a', 0.75);
    const deviceB = progressDocument(book.id, 'device-b', 0.4);

    await repository.saveProgressDocument(deviceA);
    await repository.saveProgressDocument(deviceB);

    await expect(
      new BrowserLibraryRepository().listProgressDocuments(book.id),
    ).resolves.toEqual([deviceA, deviceB]);

    await repository.removeBook(book.id);

    await expect(repository.listProgressDocuments(book.id)).resolves.toEqual(
      [],
    );
  });
});

describe('BrowserLibraryRepository bookmarks', () => {
  it('persists active bookmarks and hides synchronized tombstones', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 bookmark fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'bookmark-fixture.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const bookmark: PublicationBookmark = {
      schemaVersion: 1,
      id: '5eb34fdb-e3e9-4396-af78-c6b2af0a9a4b',
      bookId: book.id,
      format: book.format,
      deviceId: 'repository-test',
      locator: {
        href: '',
        type: 'application/pdf',
        title: 'Page 2',
        locations: { fragments: ['page=2'], position: 2 },
      },
      label: 'Page 2',
      createdAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:00.000Z',
    };

    await repository.saveBookmark(bookmark);
    await expect(repository.getBookmark(bookmark.id)).resolves.toEqual(
      bookmark,
    );
    await expect(repository.listBookmarks(book.id)).resolves.toEqual([
      bookmark,
    ]);

    const tombstone: PublicationBookmark = {
      ...bookmark,
      updatedAt: '2026-07-25T09:00:00.000Z',
      deletedAt: '2026-07-25T09:00:00.000Z',
    };
    await repository.saveBookmark(tombstone);
    await expect(repository.listBookmarks(book.id)).resolves.toEqual([]);
    await expect(repository.listBookmarks(book.id, true)).resolves.toEqual([
      tombstone,
    ]);

    await repository.removeBook(book.id);
    await expect(repository.getBookmark(bookmark.id)).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository annotations', () => {
  it('persists active annotations, hides tombstones, and removes book state', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 annotation fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'annotation-fixture.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const annotation: PublicationAnnotation = {
      schemaVersion: 1,
      id: 'bd74c3bb-f5de-48dd-a6be-b80c55a79258',
      bookId: book.id,
      format: book.format,
      deviceId: 'repository-test',
      locator: {
        href: '',
        type: 'application/pdf',
        title: 'Page 2',
        locations: {
          fragments: ['pdf-text=2:7:22'],
          position: 2,
        },
        text: { highlight: 'important words' },
      },
      color: 'yellow',
      note: 'Remember this.',
      createdAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:00.000Z',
    };

    await repository.saveAnnotation(annotation);
    await expect(repository.getAnnotation(annotation.id)).resolves.toEqual(
      annotation,
    );
    await expect(repository.listAnnotations(book.id)).resolves.toEqual([
      annotation,
    ]);

    const tombstone: PublicationAnnotation = {
      ...annotation,
      updatedAt: '2026-07-25T09:00:00.000Z',
      deletedAt: '2026-07-25T09:00:00.000Z',
    };
    await repository.saveAnnotation(tombstone);
    await expect(repository.listAnnotations(book.id)).resolves.toEqual([]);
    await expect(repository.listAnnotations(book.id, true)).resolves.toEqual([
      tombstone,
    ]);

    await repository.removeBook(book.id);
    await expect(repository.getAnnotation(annotation.id)).resolves.toBeNull();
  });
});

describe('BrowserLibraryRepository binary recovery', () => {
  it('repairs missing local bytes when the same edition is imported again', async () => {
    const bookId = `sha256:${'f'.repeat(64)}`;
    let persisted: Blob | null = null;
    const binaryStorage = {
      save: vi.fn(async (request) => {
        persisted = request.blob;
        return {
          schemaVersion: 2 as const,
          storage: 'opfs' as const,
          bookId: request.bookId,
          fileName: request.fileName,
          mediaType: request.mediaType,
          size: request.blob.size,
          opfsFileName: `${'f'.repeat(64)}.pdf`,
        };
      }),
      open: vi.fn(async () => persisted),
      migrate: vi.fn(async (stored) => stored),
      remove: vi.fn(async () => undefined),
    } satisfies PublicationBinaryStorage;
    const repository = new BrowserLibraryRepository(
      binaryStorage,
      async () => bookId,
    );
    const publication = new Blob(['repairable publication'], {
      type: 'application/pdf',
    });
    const source = {
      name: 'repairable.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    };

    const imported = await repository.importBook(source);
    const logical = await repository.findLogicalBookByVariant(imported.id);
    assertPresent(logical);
    await deleteRawLibraryRecord('logicalBooks', logical.id);
    persisted = null;
    const repaired = await repository.importBook(source);

    expect(repaired).toEqual(imported);
    expect(binaryStorage.save).toHaveBeenCalledTimes(2);
    await expect(
      repository.findLogicalBookByVariant(bookId),
    ).resolves.toMatchObject({ variants: { pdf: bookId } });
    await expect(repository.getBookSource(bookId)).resolves.toMatchObject({
      size: publication.size,
    });
  });
});

describe('BrowserLibraryRepository integrity recovery', () => {
  it('quarantines malformed active records without hiding healthy books', async () => {
    const repository = new BrowserLibraryRepository();
    const publication = new Blob(['%PDF-1.4 integrity fixture'], {
      type: 'application/pdf',
    });
    const book = await repository.importBook({
      name: 'integrity-fixture.pdf',
      mediaType: publication.type,
      size: publication.size,
      open: async () => publication,
    });
    const corruptBookId = `sha256:${'c'.repeat(64)}`;
    await putRawLibraryRecords([
      {
        storeName: 'books',
        value: {
          id: corruptBookId,
          format: 'executable',
          title: 'Corrupt metadata',
        },
      },
      {
        storeName: 'binaries',
        value: {
          schemaVersion: 2,
          storage: 'opfs',
          bookId: book.id,
          fileName: book.fileName,
          mediaType: book.mediaType,
          size: -1,
          opfsFileName: 'outside-library.pdf',
        },
      },
      {
        storeName: 'covers',
        value: {
          bookId: book.id,
          mediaType: 'image/png',
          bytes: 'not binary data',
        },
      },
      {
        storeName: 'progress',
        value: {
          schemaVersion: 1,
          bookId: book.id,
          format: book.format,
          deviceId: 'corrupt-progress',
          locator: {
            href: '',
            type: 'application/pdf',
            locations: { position: 0 },
          },
          furthestTotalProgression: 2,
          updatedAt: 'not-a-date',
          appVersion: '1.0.0',
        },
      },
      {
        storeName: 'progressDocuments',
        value: {
          schemaVersion: 1,
          bookId: book.id,
          format: book.format,
          deviceId: 'corrupt-progress-document',
          locator: {
            href: '',
            type: 'application/pdf',
            locations: { position: 0 },
          },
          furthestTotalProgression: 2,
          updatedAt: 'not-a-date',
          appVersion: '1.0.0',
        },
      },
      {
        storeName: 'bookmarks',
        value: {
          id: 'corrupt-bookmark',
          bookId: book.id,
          format: book.format,
        },
      },
      {
        storeName: 'annotations',
        value: {
          id: 'corrupt-annotation',
          bookId: book.id,
          format: book.format,
        },
      },
      {
        storeName: 'preferences',
        value: {
          ...DEFAULT_EPUB_READER_PREFERENCES,
          theme: 'neon',
        },
      },
    ]);

    await expect(repository.listBooks()).resolves.toContainEqual(book);
    await expect(repository.getBook(corruptBookId)).resolves.toBeNull();
    await expect(repository.getBookSource(book.id)).resolves.toBeNull();
    await expect(repository.getBookCover(book.id)).resolves.toBeNull();
    await expect(repository.getProgress(book.id)).resolves.toBeNull();
    await expect(repository.listProgressDocuments(book.id)).resolves.toEqual(
      [],
    );
    await expect(repository.listBookmarks(book.id)).resolves.toEqual([]);
    await expect(repository.listAnnotations(book.id)).resolves.toEqual([]);
    await expect(repository.getReaderPreferences('epub')).resolves.toBeNull();

    const quarantined = await repository.listQuarantinedRecords();
    const recoveredStores = new Set(
      quarantined
        .filter((record) =>
          [
            corruptBookId,
            book.id,
            `${book.id},corrupt-progress-document`,
            'corrupt-bookmark',
            'corrupt-annotation',
            'epub',
          ].includes(String(record.recordKey)),
        )
        .map((record) => record.storeName),
    );
    expect(recoveredStores).toEqual(
      new Set([
        'books',
        'binaries',
        'covers',
        'progress',
        'progressDocuments',
        'bookmarks',
        'annotations',
        'preferences',
      ]),
    );
    expect(
      quarantined.find((record) => record.recordKey === 'epub')?.value,
    ).toMatchObject({ theme: 'neon' });
  });

  it('rejects malformed records before they reach IndexedDB', async () => {
    const repository = new BrowserLibraryRepository();

    await expect(
      repository.saveReaderPreferences({
        ...DEFAULT_EPUB_READER_PREFERENCES,
        marginPercent: 100,
      }),
    ).rejects.toThrow('preferences are invalid');
    await expect(
      repository.saveProgress({
        schemaVersion: 1,
        bookId: `sha256:${'d'.repeat(64)}`,
        format: 'pdf',
        deviceId: 'invalid-write',
        locator: {
          href: '',
          type: 'application/pdf',
          locations: { position: 0 },
        },
        furthestTotalProgression: -1,
        updatedAt: '2026-07-25T08:00:00.000Z',
        appVersion: '1.0.0',
      }),
    ).rejects.toThrow('progress record is invalid');
    await expect(
      repository.saveProgressDocument({
        schemaVersion: 1,
        bookId: `sha256:${'d'.repeat(64)}`,
        format: 'pdf',
        deviceId: 'invalid-document',
        locator: {
          href: '',
          type: 'application/pdf',
          locations: { position: 0 },
        },
        furthestTotalProgression: -1,
        updatedAt: '2026-07-25T08:00:00.000Z',
        appVersion: '1.0.0',
      }),
    ).rejects.toThrow('Progress document is invalid');
  });
});

function progressDocument(
  bookId: string,
  deviceId: string,
  totalProgression: number,
): ReadingProgress {
  return {
    schemaVersion: 1,
    bookId,
    format: 'pdf',
    deviceId,
    locator: {
      href: '',
      type: 'application/pdf',
      locations: {
        position: Math.max(1, Math.round(totalProgression * 10)),
        totalProgression,
      },
    },
    furthestTotalProgression: totalProgression,
    updatedAt:
      deviceId === 'device-a'
        ? '2026-07-25T08:00:00.000Z'
        : '2026-07-25T09:00:00.000Z',
    appVersion: '1.0.0',
  };
}

async function putRawLibraryRecords(
  records: readonly { storeName: string; value: unknown }[],
  databaseName = 'omnia-reader',
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Unable to open the test library')),
    );
  });
  const transaction = database.transaction(
    [...new Set(records.map((record) => record.storeName))],
    'readwrite',
  );
  for (const record of records) {
    transaction.objectStore(record.storeName).put(record.value);
  }
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('Unable to seed corrupt records')),
    );
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('Unable to seed corrupt records')),
    );
  });
  database.close();
}

async function deleteRawLibraryRecord(
  storeName: string,
  key: IDBValidKey,
  databaseName = 'omnia-reader',
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () => reject(transaction.error));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
}

function blob(content: string): Blob {
  return {
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as Blob;
}

function source(name: string, bytes: Blob) {
  return {
    name,
    mediaType: bytes.type,
    size: bytes.size,
    open: async () => bytes,
  };
}

function bookRecord(
  id: string,
  format: 'epub' | 'pdf',
  bytes: Blob,
  fileName = `candidate.${format}`,
): BookRecord {
  return {
    id,
    format,
    fileName,
    mediaType: format === 'epub' ? 'application/epub+zip' : 'application/pdf',
    size: bytes.size,
    title: 'Candidate',
    authors: [],
    importedAt: '2026-07-31T08:00:00.000Z',
  };
}

function mutation(changeId: string): LogicalMutationIdentity {
  return {
    changeId,
    parents: [],
    createdAt: '2026-07-31T08:00:00.000Z',
    deviceId: 'test-device',
    appVersion: '0.1.0',
  };
}

function testObjectPath(book: BookRecord): string {
  const digest = book.id.slice('sha256:'.length);
  const stem = book.fileName.replace(/\.(epub|pdf)$/i, '');
  return `.omnia-reader/library/${stem}--${digest.slice(0, 12)}/${book.fileName}`;
}

function assertPresent<T>(
  value: T | null | undefined,
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error('Expected the test fixture value to be present');
  }
}
