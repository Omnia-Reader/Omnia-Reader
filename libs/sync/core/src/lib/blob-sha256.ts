const FALLBACK_CHUNK_SIZE = 2 * 1024 * 1024;

export async function blobSha256(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const { createSHA256 } = await import('hash-wasm');
  throwIfAborted(signal);
  const hasher = await createSHA256();
  hasher.init();

  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    const cancelRead = () => void reader.cancel(signal?.reason);
    signal?.addEventListener('abort', cancelRead, { once: true });
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) {
          break;
        }
        hasher.update(value);
      }
    } finally {
      signal?.removeEventListener('abort', cancelRead);
      reader.releaseLock();
    }
  } else {
    for (let offset = 0; offset < blob.size; offset += FALLBACK_CHUNK_SIZE) {
      throwIfAborted(signal);
      const bytes = await blobBytes(
        blob.slice(offset, offset + FALLBACK_CHUNK_SIZE),
      );
      throwIfAborted(signal);
      hasher.update(new Uint8Array(bytes));
    }
  }

  return hasher.digest('hex');
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () =>
      resolve(reader.result as ArrayBuffer),
    );
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read synchronized book')),
    );
    reader.readAsArrayBuffer(blob);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Synchronization was cancelled', 'AbortError');
}
