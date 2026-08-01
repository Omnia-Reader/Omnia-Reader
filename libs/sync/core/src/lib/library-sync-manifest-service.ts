import type {
  LibrarySyncTransport,
  RemoteDocument,
} from './library-sync-transport';
import { SyncConflictError } from './library-sync-transport';
import type { SyncWorker, SyncWorkerResult } from './library-sync-coordinator';
import {
  createLibrarySyncManifest,
  isLegacyLibrarySyncManifest,
  isLibrarySyncManifest,
  SYNC_MANIFEST_PATH,
} from './library-sync-manifest';

export interface LibraryManifestSyncOptions {
  maxConflictRetries?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export class LibrarySyncManifestCompatibilityError extends Error {
  constructor(
    message = 'The selected sync destination uses an unsupported Omnia Reader schema',
  ) {
    super(message);
    this.name = 'LibrarySyncManifestCompatibilityError';
  }
}

const DEFAULT_MAX_CONFLICT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;

export class LibrarySyncManifestService implements SyncWorker {
  private readonly maxConflictRetries: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private activeSync: Promise<SyncWorkerResult> | null = null;

  constructor(
    private readonly remote: LibrarySyncTransport,
    options: LibraryManifestSyncOptions = {},
  ) {
    this.maxConflictRetries =
      options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.wait = options.wait ?? wait;
  }

  synchronize(): Promise<SyncWorkerResult> {
    if (!this.activeSync) {
      this.activeSync = this.runSynchronization().finally(() => {
        this.activeSync = null;
      });
    }
    return this.activeSync;
  }

  private async runSynchronization(): Promise<SyncWorkerResult> {
    let conflicts = 0;
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.remote.read(SYNC_MANIFEST_PATH);
      if (current) {
        const schema = parseManifest(current);
        if (schema === 'current') {
          return { pulled: 0, pushed: 0, conflicts, rejected: 0 };
        }
        try {
          const upgraded = await this.remote.write({
            path: SYNC_MANIFEST_PATH,
            content: serializeManifest(),
            expectedRevision: current.revision,
            message: 'Upgrade Omnia Reader logical-book synchronization schema',
          });
          assertCompatibleManifest(upgraded);
          return { pulled: 0, pushed: 1, conflicts, rejected: 0 };
        } catch (error) {
          if (
            !(error instanceof SyncConflictError) ||
            attempt >= this.maxConflictRetries
          ) {
            throw error;
          }
          conflicts += 1;
          await this.wait(this.retryDelayMs * 2 ** attempt);
          continue;
        }
      }

      try {
        const created = await this.remote.write({
          path: SYNC_MANIFEST_PATH,
          content: serializeManifest(),
          message: 'Initialize Omnia Reader synchronization schema',
        });
        assertCompatibleManifest(created);
        return { pulled: 0, pushed: 1, conflicts, rejected: 0 };
      } catch (error) {
        if (
          !(error instanceof SyncConflictError) ||
          attempt >= this.maxConflictRetries
        ) {
          throw error;
        }
        conflicts += 1;
        await this.wait(this.retryDelayMs * 2 ** attempt);
      }
    }
  }
}

function assertCompatibleManifest(document: RemoteDocument): void {
  if (parseManifest(document) !== 'current') {
    throw new LibrarySyncManifestCompatibilityError();
  }
}

function parseManifest(document: RemoteDocument): 'current' | 'legacy' {
  if (document.path !== SYNC_MANIFEST_PATH) {
    throw new LibrarySyncManifestCompatibilityError(
      'The sync provider returned the root schema from an unexpected path',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(document.content);
  } catch {
    throw new LibrarySyncManifestCompatibilityError();
  }
  if (isLibrarySyncManifest(value)) return 'current';
  if (isLegacyLibrarySyncManifest(value)) return 'legacy';
  throw new LibrarySyncManifestCompatibilityError();
}

function serializeManifest(): string {
  return `${JSON.stringify(createLibrarySyncManifest(), null, 2)}\n`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
