import { Injectable, inject } from '@angular/core';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { ReaderEngineRegistry } from '@omnia-reader/reader/core';
import {
  BookRecord,
  PublicationPasswordRequiredError,
  ReaderEngine,
} from '@omnia-reader/reader/domain';

const MAX_COVER_WIDTH = 640;
const MAX_COVER_HEIGHT = 960;
const MAX_COVER_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_UNNORMALIZED_COVER_BYTES = 4 * 1024 * 1024;
const SAFE_RASTER_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Injectable({ providedIn: 'root' })
export class PublicationEnrichmentService {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly engines = inject(ReaderEngineRegistry);

  async enrich(book: BookRecord): Promise<BookRecord> {
    try {
      return await this.extract(book);
    } catch {
      // Metadata and artwork are an enhancement; the imported binary remains usable.
      return book;
    }
  }

  async validateAndEnrich(book: BookRecord): Promise<BookRecord> {
    try {
      return await this.extract(book);
    } catch (error) {
      if (!(error instanceof PublicationPasswordRequiredError)) {
        throw error;
      }
      return this.repository.updateMetadata(
        book.id,
        {
          title: book.title,
          authors: book.authors,
        },
        { markCoverUnavailable: true },
      );
    }
  }

  private async extract(book: BookRecord): Promise<BookRecord> {
    if (book.coverState === 'unavailable') {
      return book;
    }
    if (
      book.coverState === 'available' &&
      (await this.repository.getBookCover(book.id))
    ) {
      return book;
    }

    const source = await this.repository.getBookSource(book.id);
    if (!source) {
      return book;
    }

    let engine: ReaderEngine | null = null;
    try {
      engine = await this.engines.create(book.format);
      const metadata = await engine.open(source);
      let cover: Blob | undefined;
      try {
        const extractedCover =
          metadata.cover ??
          (book.format === 'pdf' ? await renderPdfCover(engine) : undefined);
        cover = extractedCover
          ? await normalizeCover(extractedCover)
          : undefined;
      } catch {
        // A valid publication remains importable when optional cover
        // extraction or normalization is unsupported by the current host.
      }
      return await this.repository.updateMetadata(
        book.id,
        {
          ...metadata,
          cover,
        },
        { markCoverUnavailable: !cover },
      );
    } finally {
      void engine?.close().catch(() => undefined);
    }
  }
}

async function renderPdfCover(engine: ReaderEngine): Promise<Blob | undefined> {
  const navigation = engine.pageNavigation?.();
  if (!navigation || navigation.pageCount < 1) {
    return undefined;
  }

  const canvas = globalThis.document.createElement('canvas');
  await navigation.renderThumbnail(1, canvas, 360);
  return canvasToBlob(canvas);
}

async function normalizeCover(cover: Blob): Promise<Blob | undefined> {
  if (cover.size === 0 || cover.size > MAX_COVER_INPUT_BYTES) {
    return undefined;
  }

  const mediaType = cover.type.toLowerCase().split(';', 1)[0];
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(cover);
      try {
        const scale = Math.min(
          1,
          MAX_COVER_WIDTH / bitmap.width,
          MAX_COVER_HEIGHT / bitmap.height,
        );
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          return undefined;
        }
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return await canvasToBlob(canvas);
      } finally {
        bitmap.close();
      }
    } catch {
      // Older webviews can still persist already-safe, reasonably sized raster data.
    }
  }

  if (mediaType === 'image/svg+xml') {
    return rasterizeSvgCover(cover);
  }

  return SAFE_RASTER_TYPES.has(mediaType) &&
    cover.size <= MAX_UNNORMALIZED_COVER_BYTES
    ? cover
    : undefined;
}

async function rasterizeSvgCover(cover: Blob): Promise<Blob | undefined> {
  const url = URL.createObjectURL(cover);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const scale = Math.min(
      1,
      MAX_COVER_WIDTH / image.naturalWidth,
      MAX_COVER_HEIGHT / image.naturalHeight,
    );
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      return undefined;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
): Promise<Blob | undefined> {
  const webp = await encodeCanvas(canvas, 'image/webp', 0.86);
  return webp ?? (await encodeCanvas(canvas, 'image/png'));
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  mediaType: string,
  quality?: number,
): Promise<Blob | undefined> {
  if (typeof canvas.toBlob !== 'function') {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? undefined), mediaType, quality);
  });
}
