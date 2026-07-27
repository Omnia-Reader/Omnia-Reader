import { blobSha256 } from './blob-sha256';

describe('blobSha256', () => {
  it('hashes a Blob incrementally without requesting one full ArrayBuffer', async () => {
    const bytes = new TextEncoder().encode('omnia reader');
    const arrayBuffer = vi.fn(() =>
      Promise.reject(new Error('full Blob buffering is not allowed')),
    );
    const publication = {
      size: bytes.byteLength,
      arrayBuffer,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 5));
            controller.enqueue(bytes.subarray(5));
            controller.close();
          },
        }),
    } as unknown as Blob;

    await expect(blobSha256(publication)).resolves.toBe(
      'b7c28a1f49be67fc3fc26d7f33a39fe7caaf5e96ffc687037c436bfb452235a3',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('stops before hashing when cancellation was already requested', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(
      blobSha256(new Blob(['publication']), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
