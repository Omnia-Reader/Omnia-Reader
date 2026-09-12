import type { BookSyncManifest } from './book-sync-manifest';
import { isBookRecord } from '@omnia-reader/reader/domain';
import {
  bookManifestPath,
  bookObjectPath,
  isBookSyncManifest,
} from './book-sync-manifest';
import type {
  LibrarySyncTransport,
  RemoteSyncEntry,
} from './library-sync-transport';
import { SyncConflictError } from './library-sync-transport';
import { PREVIOUS_SYNC_ROOT, SYNC_ROOT } from './library-sync-manifest';
import { blobSha256 } from './blob-sha256';
import type {
  SyncWorkerOptions,
  SyncWorkerResult,
} from './library-sync-coordinator';

const PREVIOUS_BOOKS_ROOT = `${PREVIOUS_SYNC_ROOT}/books`;
const SUPPORTED_CURRENT_DOCUMENT =
  /^(?:manifest\.json|README\.md|(?:library|progress|bookmarks|annotations|logical-books|\.deletions)\/.+\.(?:json|md))$/;
const SUPPORTED_CURRENT_OBJECT = /^library\/.+\.(?:epub|pdf)$/i;

interface MigrationTarget {
  source: RemoteSyncEntry;
  path: string;
  content?: string;
}

export class SyncRootReconciliationService {
  private previousEntries: readonly RemoteSyncEntry[] = [];

  constructor(private readonly remote: LibrarySyncTransport) {}

  async prepare(options: SyncWorkerOptions = {}): Promise<SyncWorkerResult> {
    if (!this.remote.listEntries) {
      throw new Error(
        'The synchronization provider cannot reconcile the previous sync root',
      );
    }
    throwIfAborted(options.signal);
    const previousEntries = await this.remote.listEntries(PREVIOUS_SYNC_ROOT);
    validatePreviousInventory(previousEntries);
    this.previousEntries = previousEntries;
    let pushed = 0;
    for (const entry of this.previousEntries) {
      throwIfAborted(options.signal);
      const target = await this.target(entry);
      if (!target) continue;
      if (entry.kind === 'document') {
        pushed += await this.migrateDocument(target);
      } else {
        pushed += await this.migrateObject(target, options);
      }
    }
    return { pulled: 0, pushed, conflicts: 0, rejected: 0 };
  }

  async cleanup(options: SyncWorkerOptions = {}): Promise<SyncWorkerResult> {
    if (!this.remote.deleteEntries && !this.remote.deleteEntry) {
      throw new Error(
        'The synchronization provider cannot remove previous sync entries',
      );
    }
    const entries = [...this.previousEntries].sort((left, right) =>
      right.path.localeCompare(left.path),
    );
    const requests = entries.map((entry) => ({
      path: entry.path,
      expectedRevision: entry.revision,
    }));
    if (requests.length === 0) {
      return { pulled: 0, pushed: 0, conflicts: 0, rejected: 0 };
    }
    throwIfAborted(options.signal);
    if (this.remote.deleteEntries) {
      await this.remote.deleteEntries(requests);
    } else {
      for (const request of requests) {
        throwIfAborted(options.signal);
        await this.remote.deleteEntry?.(request);
      }
    }
    this.previousEntries = [];
    return {
      pulled: 0,
      pushed: requests.length,
      conflicts: 0,
      rejected: 0,
    };
  }

  private async target(
    entry: RemoteSyncEntry,
  ): Promise<MigrationTarget | null> {
    if (
      entry.path !== PREVIOUS_SYNC_ROOT &&
      !entry.path.startsWith(`${PREVIOUS_SYNC_ROOT}/`)
    ) {
      throw new TypeError('Provider inventory escaped the previous sync root');
    }
    if (entry.path.startsWith(`${PREVIOUS_BOOKS_ROOT}/`)) {
      return this.legacyBookTarget(entry);
    }
    const relative = entry.path.slice(PREVIOUS_SYNC_ROOT.length + 1);
    const supported =
      entry.kind === 'document'
        ? SUPPORTED_CURRENT_DOCUMENT.test(relative)
        : SUPPORTED_CURRENT_OBJECT.test(relative);
    return supported
      ? { source: entry, path: `${SYNC_ROOT}/${relative}` }
      : null;
  }

  private async legacyBookTarget(
    entry: RemoteSyncEntry,
  ): Promise<MigrationTarget | null> {
    const directory = entry.path.slice(0, entry.path.lastIndexOf('/'));
    const manifestDocument = await this.remote.read(`${directory}/book.json`);
    if (!manifestDocument) {
      throw new TypeError('Previous sync book manifest is unavailable');
    }
    const manifest = parsePreviousBookManifest(
      manifestDocument.content,
      directory,
    );
    if (!manifest) {
      throw new TypeError('Previous sync book manifest is invalid');
    }
    if (entry.path.endsWith('/book.json') && entry.kind === 'document') {
      const content = `${JSON.stringify(manifest, null, 2)}\n`;
      return {
        source: entry,
        path: bookManifestPath(manifest),
        content,
      };
    }
    if (
      entry.kind === 'object' &&
      entry.path === `${directory}/publication.${manifest.format}`
    ) {
      return { source: entry, path: bookObjectPath(manifest) };
    }
    return null;
  }

  private async migrateDocument(target: MigrationTarget): Promise<number> {
    const source = target.content
      ? null
      : await this.remote.read(target.source.path);
    const content = target.content ?? normalizeDocument(source?.content);
    if (content === null) {
      throw new Error(
        `Previous sync document is unavailable: ${target.source.path}`,
      );
    }
    const current = await this.remote.read(target.path);
    if (current) {
      if (current.content !== content) {
        throw new SyncConflictError(
          `Current sync document conflicts with previous data: ${target.path}`,
        );
      }
      return 0;
    }
    const written = await this.remote.write({
      path: target.path,
      content,
      message: 'Migrate Omnia Reader synchronization data from v1',
    });
    if (written.content !== content) {
      throw new Error(
        `Migrated sync document could not be verified: ${target.path}`,
      );
    }
    return 1;
  }

  private async migrateObject(
    target: MigrationTarget,
    options: SyncWorkerOptions,
  ): Promise<number> {
    const source = await this.remote.headObject(target.source.path);
    if (!source) {
      throw new Error(
        `Previous sync object is unavailable: ${target.source.path}`,
      );
    }
    const current = await this.remote.headObject(target.path);
    if (current) {
      if (current.size !== source.size || current.sha256 !== source.sha256) {
        throw new SyncConflictError(
          `Current sync object conflicts with previous data: ${target.path}`,
        );
      }
      return 0;
    }
    const content = await this.remote.downloadObject(target.source.path, {
      signal: options.signal,
      expectedSize: source.size,
      onProgress: options.onTransferProgress,
    });
    if (
      content.size !== source.size ||
      (await blobSha256(content, options.signal)) !== source.sha256
    ) {
      throw new Error('Previous sync object failed integrity verification');
    }
    const uploaded = await this.remote.uploadObject({
      path: target.path,
      content,
      size: source.size,
      sha256: source.sha256,
      mediaType: target.path.toLowerCase().endsWith('.pdf')
        ? 'application/pdf'
        : 'application/epub+zip',
      signal: options.signal,
      onProgress: options.onTransferProgress,
    });
    if (uploaded.size !== source.size || uploaded.sha256 !== source.sha256) {
      throw new Error(
        `Migrated sync object could not be verified: ${target.path}`,
      );
    }
    return 1;
  }
}

function validatePreviousInventory(entries: readonly RemoteSyncEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (
      !isCanonicalPath(entry.path) ||
      (entry.path !== PREVIOUS_SYNC_ROOT &&
        !entry.path.startsWith(`${PREVIOUS_SYNC_ROOT}/`))
    ) {
      throw new TypeError('Provider inventory escaped the previous sync root');
    }
    if (paths.has(entry.path)) {
      throw new TypeError('Provider inventory contains duplicate paths');
    }
    paths.add(entry.path);
  }
}

function isCanonicalPath(path: string): boolean {
  return (
    !path.includes('\\') &&
    path
      .split('/')
      .every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function parsePreviousBookManifest(
  content: string,
  directory: string,
): BookSyncManifest | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value)) return null;
    const bookId = typeof value['bookId'] === 'string' ? value['bookId'] : '';
    const digest = /^sha256:([a-f0-9]{64})$/.exec(bookId)?.[1];
    const format =
      value['format'] === 'pdf'
        ? 'pdf'
        : value['format'] === 'epub'
          ? 'epub'
          : null;
    const directoryName = directory.slice(directory.lastIndexOf('/') + 1);
    if (
      !digest ||
      !format ||
      ![digest, encodeURIComponent(bookId)].includes(directoryName) ||
      value['objectPath'] !== `${directory}/publication.${format}`
    ) {
      return null;
    }
    const candidate = {
      ...value,
      objectPath: bookObjectPath({
        bookId,
        format,
        fileName:
          typeof value['fileName'] === 'string' ? value['fileName'] : '',
      }),
    };
    return isBookSyncManifest(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function normalizeDocument(content: string | undefined): string | null {
  if (content === undefined) return null;
  try {
    const value: unknown = JSON.parse(content);
    return `${JSON.stringify(rewriteOwnedPaths(value), null, 2)}\n`;
  } catch {
    return content.split(`${PREVIOUS_SYNC_ROOT}/`).join(`${SYNC_ROOT}/`);
  }
}

function rewriteOwnedPaths(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith(`${PREVIOUS_SYNC_ROOT}/`)
      ? `${SYNC_ROOT}/${value.slice(PREVIOUS_SYNC_ROOT.length + 1)}`
      : value;
  }
  if (Array.isArray(value)) return value.map(rewriteOwnedPaths);
  if (isRecord(value)) {
    if (
      value['operation'] === 'upsert' &&
      isBookRecord(value['variant']) &&
      typeof value['objectPath'] === 'string' &&
      value['objectPath'].startsWith(`${PREVIOUS_SYNC_ROOT}/`)
    ) {
      return {
        ...Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            key,
            rewriteOwnedPaths(child),
          ]),
        ),
        objectPath: bookObjectPath(value['variant']),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        rewriteOwnedPaths(child),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
