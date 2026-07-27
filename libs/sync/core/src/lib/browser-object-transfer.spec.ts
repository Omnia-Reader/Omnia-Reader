import { describe, expect, it, vi } from 'vitest';
import {
  browserObjectDownloadBlob,
  browserObjectUploadRequest,
} from './browser-object-transfer';
import { ObjectTransferProgress } from './library-sync-transport';

describe('browser object transfers', () => {
  it('reports native upload bytes while preserving the publication blob', async () => {
    const progress: ObjectTransferProgress[] = [];
    const xhr = new FakeUploadRequest();
    const content = new Blob(['reader']);
    const responsePromise = browserObjectUploadRequest(
      '/api/sync/github/lfs/object',
      new Headers({ 'X-Omnia-CSRF': '1' }),
      {
        path: '.omnia-reader/v1/books/id/publication.pdf',
        content,
        size: 6,
        sha256: 'a'.repeat(64),
        mediaType: 'application/pdf',
        onProgress: (update) => progress.push(update),
      },
      () => xhr as unknown as XMLHttpRequest,
    );
    xhr.reportProgress(3);
    xhr.complete();
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(xhr.body).toBe(content);
    expect(xhr.headers.get('X-Omnia-CSRF')).toBe('1');
    expect(xhr.withCredentials).toBe(true);
    expect(progress[0]).toMatchObject({
      direction: 'upload',
      transferredBytes: 0,
      totalBytes: 6,
    });
    expect(progress[progress.length - 1]).toMatchObject({
      direction: 'upload',
      transferredBytes: 6,
      totalBytes: 6,
    });
  });

  it('reports streamed download bytes without exposing intermediate copies', async () => {
    const progress: ObjectTransferProgress[] = [];
    const path = '.omnia-reader/v1/books/id/publication.epub';
    const response = new Response('epub', {
      headers: {
        'Content-Length': '4',
        'Content-Type': 'application/epub+zip',
      },
    });

    const blob = await browserObjectDownloadBlob(response, path, {
      expectedSize: 4,
      onProgress: (update) => progress.push(update),
    });

    await expect(blobText(blob)).resolves.toBe('epub');
    expect(blob.type).toBe('application/epub+zip');
    expect(progress[0]).toMatchObject({
      direction: 'download',
      transferredBytes: 0,
      totalBytes: 4,
    });
    expect(progress[progress.length - 1]).toMatchObject({
      direction: 'download',
      transferredBytes: 4,
      totalBytes: 4,
    });
  });

  it('fails fast when a transfer has already been cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled by reader', 'AbortError'));

    expect(() =>
      browserObjectUploadRequest('/api/sync/github/lfs/object', new Headers(), {
        path: 'publication.pdf',
        content: new Blob(['pdf']),
        size: 3,
        sha256: 'a'.repeat(64),
        mediaType: 'application/pdf',
        signal: controller.signal,
      }),
    ).toThrow(/cancel/i);
    await expect(
      browserObjectDownloadBlob(
        new Response(new Blob(['pdf'])),
        'publication.pdf',
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancel/i);
  });

  it('aborts an in-flight native upload when cancellation is requested', async () => {
    const controller = new AbortController();
    const xhr = new FakeUploadRequest();
    const response = browserObjectUploadRequest(
      '/api/sync/github/lfs/object',
      new Headers(),
      {
        path: 'publication.pdf',
        content: new Blob(['pdf']),
        size: 3,
        sha256: 'a'.repeat(64),
        mediaType: 'application/pdf',
        signal: controller.signal,
      },
      () => xhr as unknown as XMLHttpRequest,
    );

    controller.abort(new DOMException('Cancelled by reader', 'AbortError'));

    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.aborted).toBe(true);
  });

  it('isolates progress observers from a valid transfer', async () => {
    const observer = vi.fn(() => {
      throw new Error('UI observer failed');
    });
    const xhr = new FakeUploadRequest();
    const responsePromise = browserObjectUploadRequest(
      '/api/sync/github/lfs/object',
      new Headers(),
      {
        path: 'publication.pdf',
        content: new Blob(['pdf']),
        size: 3,
        sha256: 'a'.repeat(64),
        mediaType: 'application/pdf',
        onProgress: observer,
      },
      () => xhr as unknown as XMLHttpRequest,
    );
    xhr.reportProgress(3);
    xhr.complete();

    await expect(responsePromise).resolves.toMatchObject({ ok: true });
    expect(observer).toHaveBeenCalled();
  });
});

class FakeUploadRequest extends EventTarget {
  readonly upload = new EventTarget();
  readonly headers = new Headers();
  status = 200;
  statusText = 'OK';
  responseText = '{}';
  withCredentials = false;
  aborted = false;
  body: Document | XMLHttpRequestBodyInit | null = null;

  open(): void {
    // The helper owns the fixed PUT method and same-origin URL.
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\n';
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }

  reportProgress(loaded: number): void {
    const event = Object.assign(new Event('progress'), {
      lengthComputable: true,
      loaded,
      total: 6,
    });
    this.upload.dispatchEvent(event);
  }

  complete(): void {
    this.dispatchEvent(new Event('load'));
  }
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}
