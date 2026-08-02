import {
  LibrarySyncCoordinator,
  SyncWorker,
  SyncWorkerResult,
} from './library-sync-coordinator';

describe('LibrarySyncCoordinator', () => {
  it('restores publication variants before applying logical membership', async () => {
    const order: string[] = [];
    const worker = (name: string, result: SyncWorkerResult): SyncWorker => ({
      synchronize: async () => {
        order.push(name);
        return result;
      },
    });
    const coordinator = new LibrarySyncCoordinator({
      schema: worker('schema', {
        pulled: 0,
        pushed: 1,
        conflicts: 1,
        rejected: 0,
      }),
      books: worker('books', {
        pulled: 1,
        pushed: 2,
        conflicts: 0,
        rejected: 1,
      }),
      logicalBooks: worker('logical-books', {
        pulled: 2,
        pushed: 1,
        conflicts: 0,
        rejected: 0,
      }),
      progress: worker('progress', {
        pulled: 3,
        pushed: 4,
        conflicts: 1,
        rejected: 0,
      }),
      bookmarks: worker('bookmarks', {
        pulled: 5,
        pushed: 6,
        conflicts: 2,
        rejected: 3,
      }),
      annotations: worker('annotations', {
        pulled: 7,
        pushed: 8,
        conflicts: 3,
        rejected: 4,
      }),
    });

    await expect(coordinator.synchronize()).resolves.toEqual({
      pulled: 18,
      pushed: 22,
      conflicts: 7,
      rejected: 8,
      schemaPulled: 0,
      schemaPushed: 1,
      booksPulled: 1,
      booksPushed: 2,
      logicalBooksPulled: 2,
      logicalBooksPushed: 1,
      progressPulled: 3,
      progressPushed: 4,
      bookmarksPulled: 5,
      bookmarksPushed: 6,
      annotationsPulled: 7,
      annotationsPushed: 8,
    });
    expect(order).toEqual([
      'schema',
      'books',
      'logical-books',
      'progress',
      'bookmarks',
      'annotations',
    ]);
  });

  it('does not mutate child documents when the root schema is incompatible', async () => {
    const child = vi.fn<SyncWorker['synchronize']>();
    const coordinator = new LibrarySyncCoordinator({
      schema: {
        synchronize: async () => {
          throw new Error('Unsupported sync schema');
        },
      },
      books: { synchronize: child },
      progress: { synchronize: child },
    });

    await expect(coordinator.synchronize()).rejects.toThrow(
      'Unsupported sync schema',
    );
    expect(child).not.toHaveBeenCalled();
  });

  it('runs independent progress, bookmark, and annotation workers concurrently', async () => {
    const started: string[] = [];
    let release = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = (): SyncWorker => ({
      synchronize: async () => ({
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        rejected: 0,
      }),
    });
    const trailing = (name: string): SyncWorker => ({
      synchronize: async () => {
        started.push(name);
        await wait;
        return { pulled: 0, pushed: 0, conflicts: 0, rejected: 0 };
      },
    });
    const coordinator = new LibrarySyncCoordinator({
      schema: completed(),
      books: completed(),
      logicalBooks: completed(),
      progress: trailing('progress'),
      bookmarks: trailing('bookmarks'),
      annotations: trailing('annotations'),
    });

    const synchronization = coordinator.synchronize();
    await vi.waitFor(() => {
      expect(started).toEqual(['progress', 'bookmarks', 'annotations']);
    });
    release();

    await expect(synchronization).resolves.toMatchObject({ rejected: 0 });
  });

  it('propagates transfer controls and stops before the next worker after cancellation', async () => {
    const controller = new AbortController();
    const books = vi.fn<SyncWorker['synchronize']>();
    const onTransferProgress = vi.fn();
    const coordinator = new LibrarySyncCoordinator({
      schema: {
        synchronize: async (options) => {
          expect(options).toMatchObject({
            signal: controller.signal,
            onTransferProgress,
          });
          controller.abort(
            new DOMException('Synchronization cancelled', 'AbortError'),
          );
          return { pulled: 0, pushed: 0, conflicts: 0, rejected: 0 };
        },
      },
      books: { synchronize: books },
      progress: { synchronize: vi.fn() },
    });

    await expect(
      coordinator.synchronize({
        signal: controller.signal,
        onTransferProgress,
      }),
    ).rejects.toThrow(/cancel/i);
    expect(books).not.toHaveBeenCalled();
  });
});
