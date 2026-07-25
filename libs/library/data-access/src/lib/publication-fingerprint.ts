const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FALLBACK_CHUNK_SIZE = 2 * 1024 * 1024;
const HASH_WORKER_STALL_TIMEOUT_MS = 10_000;

interface HashWorkerResponse {
  digest?: string;
  error?: string;
  progress?: number;
}

export type PublicationHashWorkerFactory = () => Worker;

export async function publicationFingerprint(
  blob: Blob,
  workerFactory: PublicationHashWorkerFactory = createHashWorker,
  workerStallTimeoutMs = HASH_WORKER_STALL_TIMEOUT_MS,
): Promise<string> {
  try {
    const digest = await hashInWorker(
      blob,
      workerFactory,
      workerStallTimeoutMs,
    );
    return `sha256:${digest}`;
  } catch {
    return `sha256:${await hashIncrementally(blob)}`;
  }
}

async function hashInWorker(
  blob: Blob,
  workerFactory: PublicationHashWorkerFactory,
  stallTimeoutMs: number,
): Promise<string> {
  const worker = workerFactory();
  try {
    return await new Promise<string>((resolve, reject) => {
      let stallTimeout: ReturnType<typeof setTimeout>;
      const rejectStalledWorker = () =>
        reject(new Error('Publication hash worker stalled'));
      const refreshStallTimeout = () => {
        clearTimeout(stallTimeout);
        stallTimeout = setTimeout(rejectStalledWorker, stallTimeoutMs);
      };
      refreshStallTimeout();
      worker.addEventListener(
        'message',
        (event: MessageEvent<HashWorkerResponse>) => {
          if (Number.isFinite(event.data.progress)) {
            refreshStallTimeout();
            return;
          }
          clearTimeout(stallTimeout);
          const digest = event.data.digest;
          if (digest && HASH_PATTERN.test(digest)) {
            resolve(digest);
          } else {
            reject(
              new Error(event.data.error || 'Publication hash worker failed'),
            );
          }
        },
      );
      worker.addEventListener(
        'error',
        () => {
          clearTimeout(stallTimeout);
          reject(new Error('Publication hash worker failed'));
        },
        { once: true },
      );
      worker.postMessage(blob);
    });
  } finally {
    worker.terminate();
  }
}

async function hashIncrementally(blob: Blob): Promise<string> {
  const { createSHA256 } = await import('hash-wasm');
  const hasher = await createSHA256();
  hasher.init();

  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        hasher.update(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (Number.isFinite(blob.size)) {
    for (let offset = 0; offset < blob.size; offset += FALLBACK_CHUNK_SIZE) {
      const bytes = await blobBytes(
        blob.slice(offset, offset + FALLBACK_CHUNK_SIZE),
      );
      hasher.update(new Uint8Array(bytes));
    }
  } else {
    hasher.update(new Uint8Array(await blobBytes(blob)));
  }

  return hasher.digest('hex');
}

function createHashWorker(): Worker {
  return new Worker(new URL('./publication-hash.worker', import.meta.url), {
    type: 'module',
    name: 'omnia-publication-hash',
  });
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
      reject(reader.error ?? new Error('Unable to read publication bytes')),
    );
    reader.readAsArrayBuffer(blob);
  });
}
