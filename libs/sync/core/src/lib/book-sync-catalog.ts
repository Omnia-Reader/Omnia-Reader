import {
  BOOKS_ROOT,
  BookSyncManifest,
  bookManifestPath,
  isBookSyncManifest,
} from './book-sync-manifest';
import { SYNC_ROOT } from './library-sync-manifest';
import {
  LibrarySyncTransport,
  SyncConflictError,
} from './library-sync-transport';

export const BOOK_CATALOG_PATH = `${SYNC_ROOT}/README.md`;

export interface BookSyncCatalogOptions {
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MAX_CONFLICT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 100;

export async function updateBookSyncCatalog(
  remote: LibrarySyncTransport,
  options: BookSyncCatalogOptions = {},
): Promise<void> {
  const manifests = await activeRemoteManifests(remote);
  const content = serializeBookSyncCatalog(manifests);
  const maxConflictRetries =
    options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const waitForRetry = options.wait ?? wait;

  for (let attempt = 0; ; attempt += 1) {
    const current = await remote.read(BOOK_CATALOG_PATH);
    if (current?.content === content) {
      return;
    }
    try {
      await remote.write({
        path: BOOK_CATALOG_PATH,
        content,
        expectedRevision: current?.revision,
        message: 'Update Omnia Reader library catalog',
      });
      return;
    } catch (error) {
      if (
        !(error instanceof SyncConflictError) ||
        attempt >= maxConflictRetries
      ) {
        throw error;
      }
      await waitForRetry(retryDelayMs * 2 ** attempt);
    }
  }
}

export function serializeBookSyncCatalog(
  manifests: readonly BookSyncManifest[],
): string {
  const books = [...manifests].sort(
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.fileName.localeCompare(right.fileName) ||
      left.bookId.localeCompare(right.bookId),
  );
  const lines = [
    '# Omnia Reader library',
    '',
    'This catalog is maintained automatically by Omnia Reader. Publication files remain identified and verified by their SHA-256 digest.',
    '',
  ];
  if (books.length === 0) {
    lines.push(
      '_No books are currently available in this synchronized library._',
    );
  } else {
    lines.push('| Book | Authors | Format | Size |');
    lines.push('| --- | --- | --- | ---: |');
    for (const book of books) {
      const title = markdownText(book.title);
      const authors =
        book.authors.length > 0
          ? book.authors.map(markdownText).join(', ')
          : 'Unknown';
      lines.push(
        `| [${title}](${markdownPath(book.objectPath)}) | ${authors} | ${book.format.toUpperCase()} | ${formatBytes(book.size)} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function activeRemoteManifests(
  remote: LibrarySyncTransport,
): Promise<readonly BookSyncManifest[]> {
  const byBookId = new Map<string, BookSyncManifest>();
  for (const document of await remote.list(BOOKS_ROOT)) {
    if (!document.path.endsWith('/book.json')) {
      continue;
    }
    const manifest = parseManifest(document.content);
    if (!manifest || document.path !== bookManifestPath(manifest)) {
      continue;
    }
    const existing = byBookId.get(manifest.bookId);
    if (
      !existing ||
      manifest.schemaVersion > existing.schemaVersion ||
      manifest.updatedAt > existing.updatedAt
    ) {
      byBookId.set(manifest.bookId, manifest);
    }
  }
  return [...byBookId.values()];
}

function parseManifest(content: string): BookSyncManifest | null {
  try {
    const value: unknown = JSON.parse(content);
    return isBookSyncManifest(value) ? value : null;
  } catch {
    return null;
  }
}

function markdownText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ');
}

function markdownPath(path: string): string {
  const relative = path.startsWith(`${SYNC_ROOT}/`)
    ? path.slice(SYNC_ROOT.length + 1)
    : path;
  return relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
