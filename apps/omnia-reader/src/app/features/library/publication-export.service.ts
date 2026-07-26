import { inject, Injectable } from '@angular/core';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { BookRecord } from '@omnia-reader/reader/domain';

export type PublicationExportResult = 'saved' | 'cancelled';

@Injectable({ providedIn: 'root' })
export class PublicationExportService {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly platform = inject(PLATFORM_PORT);

  async exportPublication(book: BookRecord): Promise<PublicationExportResult> {
    const source = await this.repository.getBookSource(book.id);
    if (!source) {
      throw new Error('The original publication file is no longer available');
    }

    const destination = this.platform.supportsStreamingFileSave
      ? await this.platform.createFileSave({
          suggestedName: book.fileName,
          mediaType: book.mediaType,
          extensions: [book.format],
        })
      : null;
    if (this.platform.supportsStreamingFileSave && !destination) {
      return 'cancelled';
    }

    const opened = await source.open();
    const blob =
      opened instanceof Blob
        ? opened
        : new Blob([opened], { type: book.mediaType });
    if (blob.size !== book.size) {
      throw new Error('The stored publication failed its size validation');
    }

    if (destination) {
      await blobReadableStream(blob).pipeTo(destination.writable);
    } else {
      downloadBlob(blob, book.fileName);
    }
    return 'saved';
  }
}

function blobReadableStream(blob: Blob): ReadableStream<Uint8Array> {
  if (typeof blob.stream === 'function') {
    return blob.stream();
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array(await blobArrayBuffer(blob)));
      controller.close();
    },
  });
}

function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read the stored publication'));
      }
    });
    reader.addEventListener('error', () =>
      reject(
        reader.error ?? new Error('Unable to read the stored publication'),
      ),
    );
    reader.readAsArrayBuffer(blob);
  });
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
