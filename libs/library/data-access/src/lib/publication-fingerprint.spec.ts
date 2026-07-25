import { publicationFingerprint } from './publication-fingerprint';

describe('publicationFingerprint worker boundary', () => {
  it('delegates hashing to a disposable worker when workers are available', async () => {
    const digest = 'e'.repeat(64);
    const worker = new FakeHashWorker({ digest });
    const publication = new Blob(['worker bytes']);

    await expect(
      publicationFingerprint(publication, () => worker as unknown as Worker),
    ).resolves.toBe(`sha256:${digest}`);

    expect(worker.postMessage).toHaveBeenCalledWith(publication);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('falls back to incremental hashing if the worker cannot start', async () => {
    const publication = {
      arrayBuffer: async () =>
        new TextEncoder().encode('same edition').buffer as ArrayBuffer,
    } as Blob;

    const fingerprint = await publicationFingerprint(publication, () => {
      throw new Error('Worker unavailable');
    });

    expect(fingerprint).toBe(
      'sha256:76b68241ed496b1e2371b0a3bc4200c87a50d8de8b1ec5e58d34a95a65cb51cb',
    );
  });

  it('falls back instead of hanging when a worker stops responding', async () => {
    const worker = new FakeHashWorker();
    const publication = new Blob(['same edition']);

    const fingerprint = publicationFingerprint(
      publication,
      () => worker as unknown as Worker,
      1,
    );

    await expect(fingerprint).resolves.toBe(
      'sha256:76b68241ed496b1e2371b0a3bc4200c87a50d8de8b1ec5e58d34a95a65cb51cb',
    );
    expect(worker.terminate).toHaveBeenCalled();
  });
});

class FakeHashWorker {
  readonly postMessage = vi.fn(() => {
    queueMicrotask(() => {
      this.messageListener?.({
        data: this.response,
      } as MessageEvent<{ digest?: string; error?: string }>);
    });
  });
  readonly terminate = vi.fn();
  private messageListener:
    | ((event: MessageEvent<{ digest?: string; error?: string }>) => void)
    | null = null;

  constructor(
    private readonly response?: { digest?: string; error?: string },
  ) {}

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (this.response && type === 'message' && typeof listener === 'function') {
      this.messageListener = listener as (
        event: MessageEvent<{ digest?: string; error?: string }>,
      ) => void;
    }
  }
}
