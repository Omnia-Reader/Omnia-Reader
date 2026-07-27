import {
  ObjectDownloadOptions,
  ObjectTransferProgress,
  ObjectTransferProgressListener,
  ObjectUploadRequest,
} from './library-sync-transport';

export type BrowserObjectUploadRequester = (
  url: string,
  headers: Headers,
  request: ObjectUploadRequest,
) => Promise<Response>;

export function browserObjectUploadRequest(
  url: string,
  headers: Headers,
  request: ObjectUploadRequest,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<Response> {
  throwIfTransferAborted(request.signal);
  reportProgress(request.onProgress, {
    direction: 'upload',
    path: request.path,
    transferredBytes: 0,
    totalBytes: request.size,
  });
  return new Promise<Response>((resolve, reject) => {
    const xhr = xhrFactory();
    let settled = false;
    const cleanup = () => {
      xhr.removeEventListener('load', onLoad);
      xhr.removeEventListener('error', onError);
      xhr.removeEventListener('abort', onAbort);
      xhr.upload.removeEventListener('progress', onProgress);
      request.signal?.removeEventListener('abort', abortRequest);
    };
    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      action();
    };
    const onProgress = (event: ProgressEvent) => {
      reportProgress(request.onProgress, {
        direction: 'upload',
        path: request.path,
        transferredBytes: Math.min(request.size, event.loaded),
        totalBytes: request.size,
      });
    };
    const onLoad = () => {
      reportProgress(request.onProgress, {
        direction: 'upload',
        path: request.path,
        transferredBytes: request.size,
        totalBytes: request.size,
      });
      settle(() => {
        const body = [204, 205, 304].includes(xhr.status)
          ? null
          : xhr.responseText;
        resolve(
          new Response(body, {
            status: xhr.status,
            statusText: xhr.statusText,
            headers: responseHeaders(xhr),
          }),
        );
      });
    };
    const onError = () =>
      settle(() =>
        reject(new TypeError('The synchronization gateway is unreachable')),
      );
    const onAbort = () =>
      settle(() => reject(transferAbortError(request.signal)));
    const abortRequest = () => xhr.abort();

    xhr.addEventListener('load', onLoad);
    xhr.addEventListener('error', onError);
    xhr.addEventListener('abort', onAbort);
    xhr.upload.addEventListener('progress', onProgress);
    request.signal?.addEventListener('abort', abortRequest, { once: true });
    try {
      xhr.open('PUT', url, true);
      xhr.withCredentials = true;
      for (const [name, value] of headers) {
        xhr.setRequestHeader(name, value);
      }
      xhr.send(request.content);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

export async function browserObjectDownloadBlob(
  response: Response,
  path: string,
  options: ObjectDownloadOptions = {},
): Promise<Blob> {
  throwIfTransferAborted(options.signal);
  const totalBytes = downloadSize(response, options.expectedSize);
  reportProgress(options.onProgress, {
    direction: 'download',
    path,
    transferredBytes: 0,
    totalBytes,
  });

  if (!response.body || !options.onProgress) {
    const blob = await response.blob();
    throwIfTransferAborted(options.signal);
    reportProgress(options.onProgress, {
      direction: 'download',
      path,
      transferredBytes: blob.size,
      totalBytes: totalBytes || blob.size,
    });
    return blob;
  }

  let transferredBytes = 0;
  const monitored = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        throwIfTransferAborted(options.signal);
        transferredBytes += chunk.byteLength;
        reportProgress(options.onProgress, {
          direction: 'download',
          path,
          transferredBytes,
          totalBytes: totalBytes || transferredBytes,
        });
        controller.enqueue(chunk);
      },
    }),
  );
  const contentType =
    response.headers.get('Content-Type') ?? 'application/octet-stream';
  const blob = await new Response(monitored, {
    headers: { 'Content-Type': contentType },
  }).blob();
  throwIfTransferAborted(options.signal);
  if (transferredBytes !== blob.size || transferredBytes === 0) {
    reportProgress(options.onProgress, {
      direction: 'download',
      path,
      transferredBytes: blob.size,
      totalBytes: totalBytes || blob.size,
    });
  }
  return blob;
}

function responseHeaders(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  for (const line of xhr
    .getAllResponseHeaders()
    .trim()
    .split(/[\r\n]+/)) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers.append(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  return headers;
}

function downloadSize(response: Response, expectedSize?: number): number {
  if (
    Number.isSafeInteger(expectedSize) &&
    expectedSize !== undefined &&
    expectedSize >= 0
  ) {
    return expectedSize;
  }
  const contentLength = response.headers.get('Content-Length');
  const parsed = contentLength === null ? NaN : Number(contentLength);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function reportProgress(
  listener: ObjectTransferProgressListener | undefined,
  progress: ObjectTransferProgress,
): void {
  if (!listener) {
    return;
  }
  try {
    listener(progress);
  } catch {
    // Transfer observers cannot make a valid publication transfer fail.
  }
}

function throwIfTransferAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Synchronization was cancelled', 'AbortError');
}

function transferAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Synchronization was cancelled', 'AbortError');
}
