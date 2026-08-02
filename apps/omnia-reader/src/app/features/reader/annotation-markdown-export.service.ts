import { inject, Injectable } from '@angular/core';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import {
  annotationDecorations,
  BookRecord,
  PublicationAnnotation,
  PublicationAnnotationColor,
  publicationAnnotationColorLabel,
} from '@omnia-reader/reader/domain';
import { blobReadableStream, downloadBlob } from '../../browser-file-export';

export const ANNOTATION_MARKDOWN_MEDIA_TYPE = 'text/markdown';

export interface AnnotationMarkdownExportResult {
  status: 'saved' | 'cancelled';
  fileName: string;
  annotationCount: number;
}

@Injectable({ providedIn: 'root' })
export class AnnotationMarkdownExportService {
  private readonly platform = inject(PLATFORM_PORT);

  async exportAnnotations(
    book: BookRecord,
    annotations: readonly PublicationAnnotation[],
  ): Promise<AnnotationMarkdownExportResult> {
    const selected = annotations.filter(
      (annotation) =>
        annotation.bookId === book.id &&
        annotation.format === book.format &&
        annotation.deletedAt === undefined,
    );
    if (selected.length === 0) {
      throw new Error('There are no annotations to export');
    }

    const fileName = annotationMarkdownFileName(book);
    const markdown = serializeAnnotationsAsMarkdown(book, selected);
    const blob = new Blob([markdown], {
      type: `${ANNOTATION_MARKDOWN_MEDIA_TYPE};charset=utf-8`,
    });
    const destination = this.platform.supportsStreamingFileSave
      ? await this.platform.createFileSave({
          suggestedName: fileName,
          mediaType: ANNOTATION_MARKDOWN_MEDIA_TYPE,
          extensions: ['md'],
        })
      : null;
    if (this.platform.supportsStreamingFileSave && !destination) {
      return {
        status: 'cancelled',
        fileName,
        annotationCount: selected.length,
      };
    }

    if (destination) {
      await blobReadableStream(
        blob,
        'Unable to prepare the annotations export',
      ).pipeTo(destination.writable);
    } else {
      downloadBlob(blob, fileName);
    }
    return {
      status: 'saved',
      fileName,
      annotationCount: selected.length,
    };
  }
}

export function serializeAnnotationsAsMarkdown(
  book: BookRecord,
  annotations: readonly PublicationAnnotation[],
): string {
  const lines = [`# Highlights and notes — ${escapeMarkdown(book.title)}`, ''];
  if (book.authors.length > 0) {
    lines.push(
      `**${book.authors.length === 1 ? 'Author' : 'Authors'}:** ${book.authors
        .map(escapeMarkdown)
        .join(', ')}`,
      '',
    );
  }
  lines.push(`**Annotations:** ${annotations.length}`, '', '---', '');

  annotations.forEach((annotation, index) => {
    const formats = annotationDecorations(annotation)
      .map(
        (decoration) =>
          `${annotationStyleLabel(decoration.style)} · ${annotationColorLabel(decoration.color)}`,
      )
      .join(' + ');
    lines.push(
      `## ${index + 1}. ${escapeMarkdown(annotationLocation(annotation))}`,
      '',
      `**${formats || 'Note'}**`,
      '',
      ...markdownQuote(
        annotation.locator.text?.highlight?.trim() || 'No quoted text',
      ),
      '',
    );
    if (annotation.note?.trim()) {
      lines.push('**Note**', '', ...markdownQuote(annotation.note.trim()), '');
    }
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

export function annotationMarkdownFileName(book: BookRecord): string {
  const safeTitle = replaceControlCharacters(book.title.normalize('NFKC'))
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 96)
    .trim();
  return `${safeTitle || 'book'}-highlights-and-notes.md`;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
}

function annotationLocation(annotation: PublicationAnnotation): string {
  const title = annotation.locator.title?.trim();
  if (title) {
    return title;
  }
  const position = annotation.locator.locations?.position;
  if (position !== undefined && Number.isFinite(position)) {
    return annotation.format === 'pdf'
      ? `Page ${Math.max(1, Math.trunc(position))}`
      : `Position ${Math.max(1, Math.trunc(position))}`;
  }
  const progression = annotation.locator.locations?.totalProgression;
  if (progression !== undefined && Number.isFinite(progression)) {
    return `${Math.round(Math.min(1, Math.max(0, progression)) * 100)}% of book`;
  }
  return 'Saved location';
}

function annotationStyleLabel(
  style: 'highlight' | 'underline' | 'strikethrough',
): string {
  switch (style) {
    case 'underline':
      return 'Underline';
    case 'strikethrough':
      return 'Strikethrough';
    default:
      return 'Highlight';
  }
}

function markdownQuote(value: string): string[] {
  return value.split(/\r?\n/).map((line) => `> ${escapeMarkdown(line)}`);
}

function escapeMarkdown(value: string): string {
  return escapeHtml(value).replace(/([\\`*_{}[\]()#+|>])/g, '\\$1');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function annotationColorLabel(color: PublicationAnnotationColor): string {
  return publicationAnnotationColorLabel(color);
}
