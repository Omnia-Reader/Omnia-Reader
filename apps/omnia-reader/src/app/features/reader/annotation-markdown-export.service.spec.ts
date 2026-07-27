import { TestBed } from '@angular/core/testing';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import {
  BookRecord,
  PlatformPort,
  PublicationAnnotation,
} from '@omnia-reader/reader/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnnotationMarkdownExportService,
  annotationMarkdownFileName,
  serializeAnnotationsAsMarkdown,
} from './annotation-markdown-export.service';

const BOOK: BookRecord = {
  id: `sha256:${'a'.repeat(64)}`,
  format: 'pdf',
  fileName: 'source.pdf',
  mediaType: 'application/pdf',
  size: 100,
  title: 'Reader: Notes / Research',
  authors: ['Ada *Reader*'],
  importedAt: '2026-07-27T00:00:00.000Z',
};

const ANNOTATION: PublicationAnnotation = {
  schemaVersion: 1,
  id: 'annotation-1',
  bookId: BOOK.id,
  format: 'pdf',
  deviceId: 'test-device',
  locator: {
    href: '',
    type: 'application/pdf',
    title: 'Page 4',
    locations: { position: 4 },
    text: { highlight: '<script>evidence</script>\nsecond line' },
  },
  color: 'blue',
  style: 'underline',
  note: '# Revisit *carefully*',
  createdAt: '2026-07-27T08:00:00.000Z',
  updatedAt: '2026-07-27T08:00:00.000Z',
};

describe('AnnotationMarkdownExportService', () => {
  const platform = {
    kind: 'web',
    supportsStreamingFileSave: true,
    createFileSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        AnnotationMarkdownExportService,
        {
          provide: PLATFORM_PORT,
          useValue: platform as unknown as PlatformPort,
        },
      ],
    });
  });

  it('streams a safe, deterministic Markdown document to the selected host destination', async () => {
    const written: Uint8Array[] = [];
    platform.createFileSave.mockResolvedValue({
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk.slice());
        },
      }),
    });
    const service = TestBed.inject(AnnotationMarkdownExportService);

    await expect(
      service.exportAnnotations(BOOK, [ANNOTATION]),
    ).resolves.toEqual({
      status: 'saved',
      fileName: 'Reader- Notes - Research-highlights-and-notes.md',
      annotationCount: 1,
    });

    expect(platform.createFileSave).toHaveBeenCalledWith({
      suggestedName: 'Reader- Notes - Research-highlights-and-notes.md',
      mediaType: 'text/markdown',
      extensions: ['md'],
    });
    const markdown = new TextDecoder().decode(
      Buffer.concat(written.map((chunk) => Buffer.from(chunk))),
    );
    expect(markdown).toContain(
      '# Highlights and notes — Reader: Notes / Research',
    );
    expect(markdown).toContain('**Author:** Ada \\*Reader\\*');
    expect(markdown).toContain('**Underline · Blue**');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('> \\# Revisit \\*carefully\\*');
  });

  it('returns cancellation without creating export bytes', async () => {
    platform.createFileSave.mockResolvedValue(null);
    const service = TestBed.inject(AnnotationMarkdownExportService);

    await expect(
      service.exportAnnotations(BOOK, [ANNOTATION]),
    ).resolves.toEqual({
      status: 'cancelled',
      fileName: 'Reader- Notes - Research-highlights-and-notes.md',
      annotationCount: 1,
    });
  });

  it('filters foreign and deleted records and rejects an empty export', async () => {
    const service = TestBed.inject(AnnotationMarkdownExportService);
    await expect(
      service.exportAnnotations(BOOK, [
        { ...ANNOTATION, bookId: `sha256:${'b'.repeat(64)}` },
        {
          ...ANNOTATION,
          id: 'annotation-deleted',
          deletedAt: '2026-07-27T09:00:00.000Z',
        },
      ]),
    ).rejects.toThrow('There are no annotations to export');
    expect(platform.createFileSave).not.toHaveBeenCalled();
  });
});

describe('annotation Markdown serialization', () => {
  it('uses a portable bounded file name and preserves the requested order', () => {
    expect(annotationMarkdownFileName(BOOK)).toBe(
      'Reader- Notes - Research-highlights-and-notes.md',
    );
    const later = {
      ...ANNOTATION,
      id: 'annotation-2',
      locator: {
        ...ANNOTATION.locator,
        title: 'Page 9',
        text: { highlight: 'Later quote' },
      },
    };

    const markdown = serializeAnnotationsAsMarkdown(BOOK, [later, ANNOTATION]);

    expect(markdown.indexOf('Page 9')).toBeLessThan(markdown.indexOf('Page 4'));
    expect(markdown).toContain('**Annotations:** 2');
    expect(markdown.endsWith('\n')).toBe(true);
  });
});
