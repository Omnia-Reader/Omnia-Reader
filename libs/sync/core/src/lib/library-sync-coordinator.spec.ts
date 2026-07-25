import {
  LibrarySyncCoordinator,
  SyncWorker,
  SyncWorkerResult,
} from './library-sync-coordinator';

describe('LibrarySyncCoordinator', () => {
  it('validates the schema before books, progress, bookmarks, and annotations', async () => {
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
      pulled: 16,
      pushed: 21,
      conflicts: 7,
      rejected: 8,
      schemaPulled: 0,
      schemaPushed: 1,
      booksPulled: 1,
      booksPushed: 2,
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
});
