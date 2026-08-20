import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { MANAGEMENT_BRANCHES } from './management-branches.mjs';
import { assertManagementWorkload } from './management-workload.mjs';

const IMPORTED_AT = '2026-08-20T00:00:00.000Z';
const LIBRARY_DATABASE = 'omnia-reader';
const LIBRARY_VERSION = 9;
const SYNC_DATABASE = 'omnia-reader-sync';
const SYNC_VERSION = 1;
const BRANCH_SAMPLES = 20;

export async function createPerformanceEpubTemplate() {
  const archive = new JSZip();
  const date = new Date('2026-08-20T00:00:00.000Z');
  const options = { date, compression: 'STORE', createFolders: false };
  archive.file('mimetype', 'application/epub+zip', options);
  archive.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    options,
  );
  archive.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:omnia:performance-template</dc:identifier>
    <dc:title>Omnia Performance Template</dc:title>
    <dc:creator>Omnia Performance Suite</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-08-20T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="chapter"/></spine>
</package>`,
    options,
  );
  archive.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Contents</title></head>
<body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
<ol><li><a href="chapter.xhtml">Chapter One</a></li></ol></nav></body></html>`,
    options,
  );
  archive.file(
    'OEBPS/chapter.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head>
<body><h1>Chapter One</h1><p>Deterministic Omnia performance publication.</p></body></html>`,
    options,
  );
  return archive.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'STORE',
    platform: 'UNIX',
  });
}

export function createManagementSeedBatch(
  workloadInput,
  epubTemplate,
  start,
  count,
) {
  const workload = assertManagementWorkload(workloadInput);
  return createSeedBatch(workload, epubTemplate, start, count);
}

export async function seedManagementDataset(page, workloadInput, options = {}) {
  const workload = assertManagementWorkload(workloadInput);
  if (!page || typeof page.evaluate !== 'function') {
    throw new TypeError('A Playwright page is required to seed the dataset');
  }
  const batchSize = options.batchSize ?? 50;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError(
      'Dataset seed batches must contain 1 through 100 books',
    );
  }
  await assertSeedDatabases(page);
  const template = await createPerformanceEpubTemplate();
  for (let start = 0; start < workload.items.length; start += batchSize) {
    const batch = createSeedBatch(
      workload,
      template,
      start,
      Math.min(batchSize, workload.items.length - start),
    );
    await writeSeedBatch(page, batch);
  }
  const summary = await readSeedSummary(page, workload.workloadDigest);
  const expected = {
    workloadDigest: workload.workloadDigest,
    logicalBooks: workload.logicalBooks,
    exactVariants: workload.exactVariants,
    logicalChangeHistory: workload.logicalChangeHistory,
  };
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new Error(
      `Seeded management dataset does not match its contract: ${JSON.stringify(summary)}`,
    );
  }
  return summary;
}

export async function prepareManagementBranchDataset(page, workloadInput) {
  const workload = assertManagementWorkload(workloadInput);
  if (!page || typeof page.evaluate !== 'function') {
    throw new TypeError('A Playwright page is required to prepare branch data');
  }
  const template = await createPerformanceEpubTemplate();
  const fixtures = {};
  const activeBranches = MANAGEMENT_BRANCHES.filter(
    ({ action }) => action !== 'restore',
  );
  for (const [branchIndex, branch] of activeBranches.entries()) {
    const start = branchIndex * BRANCH_SAMPLES;
    const batch = createSeedBatch(workload, template, start, BRANCH_SAMPLES);
    fixtures[branch.id] = batch.logicalBooks.map((logicalBook, index) => ({
      ordinal: start + index,
      title: logicalBook.title,
      logicalBookId: logicalBook.id,
      logicalBook,
      epub: {
        record: batch.books[index * 2],
        binary: batch.binaries[index * 2],
      },
      pdf: {
        record: batch.books[index * 2 + 1],
        binary: batch.binaries[index * 2 + 1],
      },
    }));
  }
  for (const branch of MANAGEMENT_BRANCHES.filter(
    ({ action }) => action === 'restore',
  )) {
    fixtures[branch.id] = Array.from({ length: BRANCH_SAMPLES }, () => ({
      ordinal: null,
    }));
  }

  await page.evaluate(
    async ({ databaseName, databaseVersion, importedAt, fixtures }) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, databaseVersion);
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });
      try {
        const transaction = database.transaction(
          ['books', 'binaries', 'logicalBooks', 'logicalBookReconciliations'],
          'readwrite',
        );
        const completion = new Promise((resolve, reject) => {
          transaction.addEventListener('complete', () => resolve());
          transaction.addEventListener('error', () =>
            reject(transaction.error),
          );
          transaction.addEventListener('abort', () =>
            reject(transaction.error),
          );
        });
        const books = transaction.objectStore('books');
        const binaries = transaction.objectStore('binaries');
        const logicalBooks = transaction.objectStore('logicalBooks');
        const reconciliations = transaction.objectStore(
          'logicalBookReconciliations',
        );
        for (const [branchId, entries] of Object.entries(fixtures)) {
          for (const entry of entries) {
            if (entry.ordinal === null) continue;
            if (branchId.startsWith('add-local-')) {
              logicalBooks.put({
                ...entry.logicalBook,
                variants: { epub: entry.epub.id },
              });
              books.delete(entry.pdf.id);
              binaries.delete(entry.pdf.id);
            }
            if (branchId.startsWith('associate-')) {
              logicalBooks.put({
                ...entry.logicalBook,
                variants: { epub: entry.epub.id },
              });
              logicalBooks.add({
                schemaVersion: 1,
                id: `logical:sha256:${entry.pdf.id.slice('sha256:'.length)}`,
                title: entry.pdf.title,
                authors: entry.pdf.authors,
                ...(entry.pdf.language ? { language: entry.pdf.language } : {}),
                ...(entry.pdf.identifier
                  ? { identifier: entry.pdf.identifier }
                  : {}),
                importedAt: entry.pdf.importedAt,
                updatedAt: entry.pdf.importedAt,
                coverState: entry.pdf.coverState ?? 'unavailable',
                variants: { pdf: entry.pdf.id },
              });
            }
            if (branchId.startsWith('reconcile-')) {
              const affectedVariantIds = [entry.epub.id, entry.pdf.id].sort();
              reconciliations.add({
                schemaVersion: 1,
                conflictId: `conflict:performance:${String(entry.ordinal).padStart(4, '0')}`,
                status: 'open',
                conflictingChangeIds: [
                  `change:accepted:${String(entry.ordinal).padStart(4, '0')}`,
                  `change:rejected:${String(entry.ordinal).padStart(4, '0')}`,
                ],
                affectedVariantIds,
                acceptedMembership: [
                  {
                    logicalBookId: entry.logicalBook.id,
                    format: 'epub',
                    variantId: entry.epub.id,
                  },
                  {
                    logicalBookId: entry.logicalBook.id,
                    format: 'pdf',
                    variantId: entry.pdf.id,
                  },
                ],
                rejectedMembership: [
                  {
                    logicalBookId: entry.logicalBook.id,
                    format: 'epub',
                    variantId: entry.epub.id,
                  },
                  {
                    logicalBookId: `logical:sha256:${entry.pdf.id.slice('sha256:'.length)}`,
                    format: 'pdf',
                    variantId: entry.pdf.id,
                  },
                ],
                detectedAt: new Date(
                  Date.parse(importedAt) + entry.ordinal,
                ).toISOString(),
              });
            }
            if (branchId.startsWith('replace-')) {
              binaries.delete(entry.epub.id);
            }
          }
        }
        await completion;
      } finally {
        database.close();
      }
    },
    {
      databaseName: LIBRARY_DATABASE,
      databaseVersion: LIBRARY_VERSION,
      importedAt: IMPORTED_AT,
      fixtures: Object.fromEntries(
        Object.entries(fixtures).map(([branchId, entries]) => [
          branchId,
          entries.map((entry) =>
            entry.ordinal === null
              ? entry
              : {
                  ordinal: entry.ordinal,
                  logicalBook: workload.items[entry.ordinal]
                    ? createSeedBatch(workload, template, entry.ordinal, 1)
                        .logicalBooks[0]
                    : null,
                  epub: entry.epub.record,
                  pdf: entry.pdf.record,
                },
          ),
        ]),
      ),
    },
  );
  return fixtures;
}

export async function createManagementSampleFixture(workloadInput, ordinal) {
  const workload = assertManagementWorkload(workloadInput);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 1_000) {
    throw new RangeError('Invalid management sample fixture ordinal');
  }
  const template = await createPerformanceEpubTemplate();
  const batch = createSeedBatch(workload, template, ordinal, 1);
  const logicalBook = batch.logicalBooks[0];
  return {
    ordinal,
    title: logicalBook.title,
    logicalBookId: logicalBook.id,
    logicalBook,
    epub: { record: batch.books[0], binary: batch.binaries[0] },
    pdf: { record: batch.books[1], binary: batch.binaries[1] },
  };
}

function createSeedBatch(workload, epubTemplate, start, count) {
  if (
    !Buffer.isBuffer(epubTemplate) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    start < 0 ||
    count < 1 ||
    start + count > workload.items.length
  ) {
    throw new RangeError('Invalid deterministic management seed batch');
  }
  const books = [];
  const binaries = [];
  const logicalBooks = [];
  const history = [];
  for (const item of workload.items.slice(start, start + count)) {
    const epubBytes = epubWithComment(epubTemplate, item.epub.contentSeed);
    const pdfBytes = createPdfFixture(item.title, item.pdf.contentSeed);
    const epub = publication(item, item.epub, epubBytes);
    const pdf = publication(item, item.pdf, pdfBytes);
    books.push(epub.record, pdf.record);
    binaries.push(epub.binary, pdf.binary);
    const logicalBook = {
      schemaVersion: 1,
      id: item.logicalBookId,
      title: item.title,
      authors: ['Omnia Performance Suite'],
      language: 'en',
      identifier: `urn:omnia:performance:${item.ordinal}`,
      importedAt: IMPORTED_AT,
      updatedAt: IMPORTED_AT,
      coverState: 'unavailable',
      variants: { epub: epub.record.id, pdf: pdf.record.id },
    };
    logicalBooks.push(logicalBook);
    if (item.historyDepth === 1) history.push(historyEntry(item, logicalBook));
  }
  return { books, binaries, logicalBooks, history };
}

function publication(item, descriptor, bytes) {
  const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const record = {
    id,
    format: descriptor.format,
    fileName: descriptor.fileName,
    mediaType: descriptor.mediaType,
    size: bytes.byteLength,
    title: item.title,
    authors: ['Omnia Performance Suite'],
    language: 'en',
    identifier: `urn:omnia:performance:${item.ordinal}:${descriptor.format}`,
    importedAt: IMPORTED_AT,
    coverState: 'unavailable',
  };
  return {
    record,
    binary: {
      schemaVersion: 2,
      storage: 'indexeddb',
      bookId: id,
      fileName: descriptor.fileName,
      mediaType: descriptor.mediaType,
      size: bytes.byteLength,
      bytesBase64: bytes.toString('base64'),
    },
  };
}

function historyEntry(item, logicalBook) {
  const changeId = `change:performance:${String(item.ordinal).padStart(4, '0')}`;
  const createdAt = new Date(
    Date.parse(IMPORTED_AT) + item.ordinal,
  ).toISOString();
  const change = {
    schemaVersion: 1,
    changeId,
    kind: 'metadata',
    parents: [],
    resultingBooks: [logicalBook],
    removedLogicalBookIds: [],
    variantEffects: [],
    preferenceEffects: [],
    resolvesConflictIds: [],
    createdAt,
    deviceId: 'performance-driver',
    appVersion: '0.0.0',
  };
  return {
    operation: {
      id: `operation:performance:${String(item.ordinal).padStart(4, '0')}`,
      entity: 'logical-book-change',
      entityId: changeId,
      operation: 'upsert',
      revision: 1,
      createdAt,
      payload: change,
    },
    revision: { entityKey: `logical-book-change:${changeId}`, revision: 1 },
  };
}

function epubWithComment(template, contentSeed) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = template.lastIndexOf(signature);
  if (eocd < 0 || eocd + 22 > template.byteLength) {
    throw new Error(
      'Performance EPUB template has no canonical ZIP terminator',
    );
  }
  const currentLength = template.readUInt16LE(eocd + 20);
  if (eocd + 22 + currentLength !== template.byteLength) {
    throw new Error('Performance EPUB template has a malformed ZIP comment');
  }
  const comment = Buffer.from(contentSeed, 'utf8');
  if (comment.byteLength > 65_535) {
    throw new RangeError(
      'Performance EPUB identity exceeds the ZIP comment bound',
    );
  }
  const result = Buffer.concat([template.subarray(0, eocd + 22), comment]);
  result.writeUInt16LE(comment.byteLength, eocd + 20);
  return result;
}

function createPdfFixture(title, contentSeed) {
  const page = `BT /F1 18 Tf 72 720 Td (${pdfString(title)}) Tj ET\n% ${contentSeed}`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${pdfString(title)}) /Author (Omnia Performance Suite) >>`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(content);
}

function pdfString(value) {
  return value.replace(/[\\()]/g, (character) => `\\${character}`);
}

async function assertSeedDatabases(page) {
  await page.evaluate(
    async ({ libraryName, libraryVersion, syncName, syncVersion }) => {
      const open = (name, version, allowCreate) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name, version);
          request.addEventListener('upgradeneeded', () => {
            if (!allowCreate) {
              request.transaction.abort();
              return;
            }
            const database = request.result;
            if (!database.objectStoreNames.contains('operations')) {
              database.createObjectStore('operations', { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains('revisions')) {
              database.createObjectStore('revisions', {
                keyPath: 'entityKey',
              });
            }
          });
          request.addEventListener('success', () => resolve(request.result));
          request.addEventListener('error', () =>
            reject(
              request.error ??
                new Error(`Required IndexedDB database ${name} is unavailable`),
            ),
          );
        });
      const count = (database, storeName) =>
        new Promise((resolve, reject) => {
          const request = database
            .transaction(storeName, 'readonly')
            .objectStore(storeName)
            .count();
          request.addEventListener('success', () => resolve(request.result));
          request.addEventListener('error', () => reject(request.error));
        });
      const library = await open(libraryName, libraryVersion, false);
      const sync = await open(syncName, syncVersion, true);
      try {
        for (const storeName of ['books', 'binaries', 'logicalBooks']) {
          if (!library.objectStoreNames.contains(storeName)) {
            throw new Error(`Library database is missing ${storeName}`);
          }
        }
        for (const storeName of ['operations', 'revisions']) {
          if (!sync.objectStoreNames.contains(storeName)) {
            throw new Error(`Sync database is missing ${storeName}`);
          }
        }
        const counts = await Promise.all([
          count(library, 'books'),
          count(library, 'binaries'),
          count(library, 'logicalBooks'),
          count(sync, 'operations'),
          count(sync, 'revisions'),
        ]);
        if (counts.some((value) => value !== 0)) {
          throw new Error(
            'Management dataset seeding requires empty test databases',
          );
        }
      } finally {
        library.close();
        sync.close();
      }
    },
    {
      libraryName: LIBRARY_DATABASE,
      libraryVersion: LIBRARY_VERSION,
      syncName: SYNC_DATABASE,
      syncVersion: SYNC_VERSION,
    },
  );
}

async function writeSeedBatch(page, batch) {
  await page.evaluate(
    async ({ libraryName, libraryVersion, syncName, syncVersion, batch }) => {
      const open = (name, version) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name, version);
          request.addEventListener('success', () => resolve(request.result));
          request.addEventListener('error', () => reject(request.error));
        });
      const complete = (transaction) =>
        new Promise((resolve, reject) => {
          transaction.addEventListener('complete', () => resolve());
          transaction.addEventListener('error', () =>
            reject(transaction.error),
          );
          transaction.addEventListener('abort', () =>
            reject(transaction.error),
          );
        });
      const decode = (value) => {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes.buffer;
      };
      const library = await open(libraryName, libraryVersion);
      const sync = await open(syncName, syncVersion);
      try {
        const libraryTransaction = library.transaction(
          ['books', 'binaries', 'logicalBooks'],
          'readwrite',
        );
        const books = libraryTransaction.objectStore('books');
        const binaries = libraryTransaction.objectStore('binaries');
        const logicalBooks = libraryTransaction.objectStore('logicalBooks');
        batch.books.forEach((book) => books.add(book));
        batch.binaries.forEach(({ bytesBase64, ...binary }) =>
          binaries.add({ ...binary, bytes: decode(bytesBase64) }),
        );
        batch.logicalBooks.forEach((logicalBook) =>
          logicalBooks.add(logicalBook),
        );
        await complete(libraryTransaction);

        if (batch.history.length > 0) {
          const syncTransaction = sync.transaction(
            ['operations', 'revisions'],
            'readwrite',
          );
          const operations = syncTransaction.objectStore('operations');
          const revisions = syncTransaction.objectStore('revisions');
          batch.history.forEach((entry) => {
            operations.add(entry.operation);
            revisions.add(entry.revision);
          });
          await complete(syncTransaction);
        }
      } finally {
        library.close();
        sync.close();
      }
    },
    {
      libraryName: LIBRARY_DATABASE,
      libraryVersion: LIBRARY_VERSION,
      syncName: SYNC_DATABASE,
      syncVersion: SYNC_VERSION,
      batch,
    },
  );
}

async function readSeedSummary(page, workloadDigest) {
  return page.evaluate(
    async ({
      libraryName,
      libraryVersion,
      syncName,
      syncVersion,
      workloadDigest,
    }) => {
      const open = (name, version) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name, version);
          request.addEventListener('success', () => resolve(request.result));
          request.addEventListener('error', () => reject(request.error));
        });
      const count = (database, storeName) =>
        new Promise((resolve, reject) => {
          const request = database
            .transaction(storeName, 'readonly')
            .objectStore(storeName)
            .count();
          request.addEventListener('success', () => resolve(request.result));
          request.addEventListener('error', () => reject(request.error));
        });
      const library = await open(libraryName, libraryVersion);
      const sync = await open(syncName, syncVersion);
      try {
        const [logicalBooks, exactVariants, logicalChangeHistory] =
          await Promise.all([
            count(library, 'logicalBooks'),
            count(library, 'books'),
            count(sync, 'operations'),
          ]);
        return {
          workloadDigest,
          logicalBooks,
          exactVariants,
          logicalChangeHistory,
        };
      } finally {
        library.close();
        sync.close();
      }
    },
    {
      libraryName: LIBRARY_DATABASE,
      libraryVersion: LIBRARY_VERSION,
      syncName: SYNC_DATABASE,
      syncVersion: SYNC_VERSION,
      workloadDigest,
    },
  );
}
