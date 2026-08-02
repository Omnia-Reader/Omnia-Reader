import { inject, Injectable } from '@angular/core';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { BookRecord } from '@omnia-reader/reader/domain';
import { blobReadableStream, downloadBlob } from '../../browser-file-export';

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
      await blobReadableStream(
        blob,
        'Unable to read the stored publication',
      ).pipeTo(destination.writable);
    } else {
      downloadBlob(blob, book.fileName);
    }
    return 'saved';
  }
}
