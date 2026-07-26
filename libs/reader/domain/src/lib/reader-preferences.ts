import type { PublicationFormat } from './publication';

export type ReaderTheme = 'light' | 'sepia' | 'dark';
export type EpubFontFamily = 'serif' | 'sans-serif';
export type EpubFlow = 'auto' | 'paginated' | 'scrolled';
export type EpubSpread = 'none' | 'auto';
export type PdfZoomMode = 'fit-width' | 'fit-page' | 'custom';
export type PdfRotation = 0 | 90 | 180 | 270;

export interface EpubReaderPreferences {
  format: 'epub';
  theme: ReaderTheme;
  fontFamily: EpubFontFamily;
  fontSizePercent: number;
  lineHeight: number;
  paragraphSpacingRem: number;
  marginPercent: number;
  maxLineWidthRem: number;
  flow: EpubFlow;
  spread: EpubSpread;
}

export interface PdfReaderPreferences {
  format: 'pdf';
  zoomMode: PdfZoomMode;
  zoomPercent: number;
  rotation: PdfRotation;
}

export type ReaderPreferences = EpubReaderPreferences | PdfReaderPreferences;

export const DEFAULT_EPUB_READER_PREFERENCES: Readonly<EpubReaderPreferences> =
  {
    format: 'epub',
    theme: 'light',
    fontFamily: 'serif',
    fontSizePercent: 100,
    lineHeight: 1.55,
    paragraphSpacingRem: 0.75,
    marginPercent: 5,
    maxLineWidthRem: 44,
    flow: 'auto',
    spread: 'auto',
  };

export const DEFAULT_PDF_READER_PREFERENCES: Readonly<PdfReaderPreferences> = {
  format: 'pdf',
  zoomMode: 'fit-width',
  zoomPercent: 100,
  rotation: 0,
};

export function defaultReaderPreferences(
  format: PublicationFormat,
): ReaderPreferences {
  return format === 'epub'
    ? { ...DEFAULT_EPUB_READER_PREFERENCES }
    : { ...DEFAULT_PDF_READER_PREFERENCES };
}
