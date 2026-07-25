/// <reference lib="webworker" />

import { createSHA256 } from 'hash-wasm';

addEventListener('message', async ({ data }: MessageEvent<Blob>) => {
  try {
    postMessage({ progress: 0 });
    const hasher = await createSHA256();
    hasher.init();
    const reader = data.stream().getReader();
    let processedBytes = 0;
    let lastReportedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hasher.update(value);
      processedBytes += value.byteLength;
      if (processedBytes - lastReportedBytes >= 8 * 1024 * 1024) {
        lastReportedBytes = processedBytes;
        postMessage({ progress: processedBytes });
      }
    }
    postMessage({ digest: hasher.digest('hex') });
  } catch (error) {
    postMessage({
      error:
        error instanceof Error
          ? error.message
          : 'Unable to hash publication bytes',
    });
  }
});
