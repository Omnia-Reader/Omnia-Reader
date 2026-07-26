import { TestBed } from '@angular/core/testing';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import {
  BookRecord,
  LibraryRepository,
  PlatformPort,
} from '@omnia-reader/reader/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicationExportService } from './publication-export.service';

describe('PublicationExportService', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 exact publication');
  const book: BookRecord = {
    id: `sha256:${'a'.repeat(64)}`,
    format: 'pdf',
    fileName: 'portable-reader.pdf',
    mediaType: 'application/pdf',
    size: bytes.byteLength,
    title: 'Portable reader',
    authors: [],
    importedAt: '2026-07-26T00:00:00.000Z',
  };
  const source = {
    name: book.fileName,
    mediaType: book.mediaType,
    size: book.size,
    open: vi.fn(),
  };
  const repository = {
    getBookSource: vi.fn(),
  };
  const platform = {
    kind: 'web',
    supportsStreamingFileSave: false,
    createFileSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    source.open.mockResolvedValue(
      new Blob([bytes], { type: 'application/pdf' }),
    );
    repository.getBookSource.mockResolvedValue(source);
    platform.supportsStreamingFileSave = false;
    platform.createFileSave.mockResolvedValue(null);
    TestBed.configureTestingModule({
      providers: [
        PublicationExportService,
        {
          provide: LIBRARY_REPOSITORY,
          useValue: repository as unknown as LibraryRepository,
        },
        {
          provide: PLATFORM_PORT,
          useValue: platform as unknown as PlatformPort,
        },
      ],
    });
  });

  it('downloads the exact publication with its original file name', async () => {
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:publication-export');
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const createElement = vi.spyOn(document, 'createElement');
    const service = TestBed.inject(PublicationExportService);

    await expect(service.exportPublication(book)).resolves.toBe('saved');

    expect(repository.getBookSource).toHaveBeenCalledWith(book.id);
    expect(source.open).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        size: bytes.byteLength,
        type: 'application/pdf',
      }),
    );
    const anchor = createElement.mock.results
      .map((result) => result.value)
      .find((element): element is HTMLAnchorElement => element.matches?.('a'));
    expect(anchor?.download).toBe('portable-reader.pdf');
    expect(click).toHaveBeenCalledOnce();
    createElement.mockRestore();
    click.mockRestore();
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
  });

  it('streams bytes to a platform destination without a browser download', async () => {
    platform.supportsStreamingFileSave = true;
    const written: Uint8Array[] = [];
    platform.createFileSave.mockResolvedValue({
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk.slice());
        },
      }),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const service = TestBed.inject(PublicationExportService);

    await expect(service.exportPublication(book)).resolves.toBe('saved');

    expect(platform.createFileSave).toHaveBeenCalledWith({
      suggestedName: 'portable-reader.pdf',
      mediaType: 'application/pdf',
      extensions: ['pdf'],
    });
    expect(Buffer.concat(written.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(bytes),
    );
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('does not read publication bytes when the save picker is cancelled', async () => {
    platform.supportsStreamingFileSave = true;
    platform.createFileSave.mockResolvedValue(null);
    const service = TestBed.inject(PublicationExportService);

    await expect(service.exportPublication(book)).resolves.toBe('cancelled');

    expect(source.open).not.toHaveBeenCalled();
  });

  it('refuses to export missing or truncated publication bytes', async () => {
    const service = TestBed.inject(PublicationExportService);
    repository.getBookSource.mockResolvedValueOnce(null);

    await expect(service.exportPublication(book)).rejects.toThrow(
      'The original publication file is no longer available',
    );

    source.open.mockResolvedValueOnce(new Blob(['short']));
    await expect(service.exportPublication(book)).rejects.toThrow(
      'The stored publication failed its size validation',
    );
  });
});
