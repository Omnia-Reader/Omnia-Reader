import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';

export const SYNC_EVIDENCE_TARGET_KINDS = Object.freeze([
  'trace',
  'ipc',
  'log',
  'report',
  'redirect',
  'evidence',
  'synchronized-record',
]);

const MAX_CANARIES = 32;
const MIN_CANARY_BYTES = 16;
const MAX_CANARY_BYTES = 4096;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const SAFE_CANARY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function canariesFromEnvironment(serialized) {
  let values;
  try {
    values = JSON.parse(serialized);
  } catch {
    throw new Error('OMNIA_SYNC_SECRET_CANARIES must be a JSON object.');
  }
  assertPlainRecord(
    values,
    'OMNIA_SYNC_SECRET_CANARIES must be a JSON object.',
  );
  return validateCanaries(
    Object.entries(values).map(([id, value]) => ({ id, value })),
  );
}

export async function scanSyncEvidence({ root, canaries }) {
  assert(
    typeof root === 'string' && root.length > 0,
    'A synchronization evidence root is required.',
  );
  const checkedCanaries = validateCanaries(canaries);
  const absoluteRoot = resolve(root);
  const rootStats = await lstat(absoluteRoot).catch(() => null);
  assert(rootStats, 'Synchronization evidence root is missing.');
  assert(
    !rootStats.isSymbolicLink(),
    'Evidence symbolic links are not allowed.',
  );
  assert(
    rootStats.isDirectory(),
    'Synchronization evidence root must be a directory.',
  );

  const detections = [];
  const targets = [];
  const archiveBudget = { entries: 0, bytes: 0 };
  let scannedBytes = 0;
  let scannedFiles = 0;

  for (const kind of SYNC_EVIDENCE_TARGET_KINDS) {
    const targetRoot = join(absoluteRoot, kind);
    const targetStats = await lstat(targetRoot).catch(() => null);
    assert(targetStats, `The required ${kind} target is missing.`);
    assert(
      !targetStats.isSymbolicLink(),
      `Evidence symbolic links are not allowed in ${kind}.`,
    );
    assert(
      targetStats.isDirectory(),
      `The required ${kind} target must be a directory.`,
    );
    const files = await walkFiles(targetRoot, kind);
    assert(files.length > 0, `The required ${kind} target contains no files.`);
    let targetBytes = 0;
    for (const file of files) {
      assert(
        file.bytes <= MAX_FILE_BYTES,
        `${kind} contains a file larger than ${MAX_FILE_BYTES} bytes.`,
      );
      assert(
        scannedBytes + file.bytes <= MAX_TOTAL_BYTES,
        `Synchronization evidence exceeds ${MAX_TOTAL_BYTES} bytes.`,
      );
      const contents = await readFile(file.path);
      scannedBytes += contents.byteLength;
      targetBytes += contents.byteLength;
      scannedFiles += 1;
      const fileId = createHash('sha256')
        .update(`${kind}\u0000${file.relativePath}`)
        .digest('hex')
        .slice(0, 16);
      scanContents(contents, kind, fileId, checkedCanaries, detections);
      if (isZip(contents)) {
        const entries = await readZipEntries(
          contents,
          kind,
          file.relativePath,
          archiveBudget,
        );
        for (const entry of entries) {
          scanContents(
            entry.contents,
            kind,
            entry.fileId,
            checkedCanaries,
            detections,
          );
        }
      }
    }
    targets.push({ kind, files: files.length, bytes: targetBytes });
  }

  detections.sort(
    (left, right) =>
      SYNC_EVIDENCE_TARGET_KINDS.indexOf(left.target) -
        SYNC_EVIDENCE_TARGET_KINDS.indexOf(right.target) ||
      left.fileId.localeCompare(right.fileId) ||
      left.canaryId.localeCompare(right.canaryId),
  );
  const detectedCanaries = new Set(detections.map(({ canaryId }) => canaryId));
  return {
    schemaVersion: 1,
    result: detections.length === 0 ? 'passed' : 'failed',
    scannedFiles,
    scannedBytes,
    scannedArchiveEntries: archiveBudget.entries,
    expandedArchiveBytes: archiveBudget.bytes,
    targets,
    canaries: checkedCanaries.map(({ id }) => ({
      id,
      present: detectedCanaries.has(id),
    })),
    detections,
  };
}

function scanContents(contents, target, fileId, canaries, detections) {
  for (const canary of canaries) {
    const encoding = matchingEncoding(contents, canary.value);
    if (encoding) {
      detections.push({
        canaryId: canary.id,
        target,
        fileId,
        encoding,
      });
    }
  }
}

function isZip(contents) {
  return (
    contents.byteLength >= 4 &&
    contents[0] === 0x50 &&
    contents[1] === 0x4b &&
    (contents[2] === 0x03 || contents[2] === 0x05 || contents[2] === 0x07) &&
    (contents[3] === 0x04 || contents[3] === 0x06 || contents[3] === 0x08)
  );
}

async function readZipEntries(contents, kind, archivePath, budget) {
  let archive;
  try {
    archive = await JSZip.loadAsync(contents, { checkCRC32: true });
  } catch {
    throw new Error(`${kind} contains an invalid ZIP artifact.`);
  }
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => left.name.localeCompare(right.name));
  assert(
    budget.entries + entries.length <= MAX_ARCHIVE_ENTRIES,
    `Synchronization evidence archives exceed ${MAX_ARCHIVE_ENTRIES} entries.`,
  );

  const result = [];
  for (const entry of entries) {
    const originalName = entry.unsafeOriginalName ?? entry.name;
    assertSafeArchivePath(originalName, kind);
    const declaredBytes = entry._data?.uncompressedSize;
    assert(
      Number.isSafeInteger(declaredBytes) &&
        declaredBytes >= 0 &&
        declaredBytes <= MAX_ARCHIVE_ENTRY_BYTES,
      `${kind} contains an archive entry with an invalid or oversized declared length.`,
    );
    assert(
      budget.bytes + declaredBytes <= MAX_EXPANDED_BYTES,
      `Synchronization evidence archives exceed ${MAX_EXPANDED_BYTES} expanded bytes.`,
    );
    const entryContents = await entry.async('nodebuffer');
    assert(
      entryContents.byteLength === declaredBytes,
      `${kind} contains an archive entry with a mismatched expanded length.`,
    );
    budget.entries += 1;
    budget.bytes += entryContents.byteLength;
    result.push({
      fileId: createHash('sha256')
        .update(`${kind}\u0000${archivePath}\u0000${entry.name}`)
        .digest('hex')
        .slice(0, 16),
      contents: entryContents,
    });
  }
  return result;
}

function assertSafeArchivePath(path, kind) {
  assert(
    typeof path === 'string' &&
      path.length > 0 &&
      path.length <= 1024 &&
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((segment) => segment === '.' || segment === '..'),
    `${kind} contains an unsafe archive entry path.`,
  );
}

function validateCanaries(canaries) {
  assert(
    Array.isArray(canaries) &&
      canaries.length > 0 &&
      canaries.length <= MAX_CANARIES,
    `Provide between 1 and ${MAX_CANARIES} secret canaries.`,
  );
  const ids = new Set();
  const values = new Set();
  return canaries
    .map((canary, index) => {
      assertPlainRecord(canary, `Canary ${index} must be an object.`);
      assert(
        Object.keys(canary).length === 2 &&
          Object.hasOwn(canary, 'id') &&
          Object.hasOwn(canary, 'value'),
        `Canary ${index} must contain only id and value.`,
      );
      assert(
        typeof canary.id === 'string' && SAFE_CANARY_ID.test(canary.id),
        `Canary ${index} has an invalid identifier.`,
      );
      assert(!ids.has(canary.id), `Canary id ${canary.id} is duplicated.`);
      ids.add(canary.id);
      const byteLength =
        typeof canary.value === 'string'
          ? Buffer.byteLength(canary.value, 'utf8')
          : 0;
      assert(
        byteLength >= MIN_CANARY_BYTES,
        `Canary ${canary.id} must contain at least ${MIN_CANARY_BYTES} UTF-8 bytes.`,
      );
      assert(
        byteLength <= MAX_CANARY_BYTES,
        `Canary ${canary.id} exceeds ${MAX_CANARY_BYTES} UTF-8 bytes.`,
      );
      assert(
        !values.has(canary.value),
        `Canary ${canary.id} duplicates another canary value.`,
      );
      values.add(canary.value);
      return { id: canary.id, value: canary.value };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function matchingEncoding(contents, value) {
  for (const variant of encodedVariants(value)) {
    if (contents.indexOf(variant.bytes) !== -1) return variant.encoding;
  }
  return null;
}

function encodedVariants(value) {
  const percentEncoded = encodeURIComponent(value);
  const lowerPercentEncoded = percentEncoded.replace(/%[0-9A-F]{2}/g, (match) =>
    match.toLowerCase(),
  );
  const formEncoded = percentEncoded.replaceAll('%20', '+');
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  const variants = [
    { encoding: 'literal', value },
    { encoding: 'percent-encoded', value: percentEncoded },
    { encoding: 'percent-encoded', value: lowerPercentEncoded },
    { encoding: 'form-encoded', value: formEncoded },
    { encoding: 'base64', value: base64 },
    {
      encoding: 'base64url',
      value: base64
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, ''),
    },
  ];
  const seen = new Set();
  return variants.flatMap((variant) => {
    const bytes = Buffer.from(variant.value, 'utf8');
    const key = bytes.toString('hex');
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ encoding: variant.encoding, bytes }];
  });
}

async function walkFiles(directory, kind, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stats = await lstat(path);
    assert(
      !stats.isSymbolicLink(),
      `Evidence symbolic links are not allowed in ${kind}.`,
    );
    if (stats.isDirectory()) {
      files.push(...(await walkFiles(path, kind, relativePath)));
    } else {
      assert(
        stats.isFile(),
        `${kind} contains an unsupported filesystem entry.`,
      );
      files.push({
        path,
        relativePath: normalizePath(relativePath),
        bytes: stats.size,
      });
    }
  }
  return files;
}

function normalizePath(value) {
  return value.split(sep).join('/');
}

function assertPlainRecord(value, message) {
  assert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
    message,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [root, ...extra] = process.argv.slice(2);
  assert(
    root && extra.length === 0,
    'Usage: scan-sync-evidence.mjs <evidence-root>',
  );
  const serializedCanaries = process.env['OMNIA_SYNC_SECRET_CANARIES'];
  delete process.env['OMNIA_SYNC_SECRET_CANARIES'];
  assert(
    serializedCanaries,
    'OMNIA_SYNC_SECRET_CANARIES must provide protected canary values.',
  );
  const result = await scanSyncEvidence({
    root,
    canaries: canariesFromEnvironment(serializedCanaries),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.result !== 'passed') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
