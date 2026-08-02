export function blobReadableStream(
  blob: Blob,
  readErrorMessage: string,
): ReadableStream<Uint8Array> {
  if (typeof blob.stream === 'function') {
    return blob.stream();
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        new Uint8Array(await blobArrayBuffer(blob, readErrorMessage)),
      );
      controller.close();
    },
  });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function blobArrayBuffer(
  blob: Blob,
  readErrorMessage: string,
): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error(readErrorMessage));
      }
    });
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error(readErrorMessage)),
    );
    reader.readAsArrayBuffer(blob);
  });
}
