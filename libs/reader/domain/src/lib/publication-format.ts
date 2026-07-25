import { PublicationFormat } from './publication';

const EPUB_MEDIA_TYPES = new Set([
  'application/epub+zip',
  'application/x-epub+zip',
]);

export function detectPublicationFormat(
  name: string,
  mediaType: string,
): PublicationFormat | null {
  const normalizedName = name.toLowerCase();
  const normalizedMediaType = mediaType.toLowerCase();

  if (
    EPUB_MEDIA_TYPES.has(normalizedMediaType) ||
    normalizedName.endsWith('.epub')
  ) {
    return 'epub';
  }

  if (
    normalizedMediaType === 'application/pdf' ||
    normalizedName.endsWith('.pdf')
  ) {
    return 'pdf';
  }

  return null;
}
