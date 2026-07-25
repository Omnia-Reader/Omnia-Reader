import {
  detectPublicationFormat,
  PublicationFormat,
} from '@omnia-reader/reader/domain';

export function inferPublicationFormat(
  name: string,
  mediaType: string,
): PublicationFormat {
  const format = detectPublicationFormat(name, mediaType);
  if (format) {
    return format;
  }

  throw new UnsupportedPublicationError(name, mediaType);
}

export class UnsupportedPublicationError extends Error {
  constructor(name: string, mediaType: string) {
    super(`Unsupported publication "${name}" (${mediaType || 'unknown type'})`);
    this.name = 'UnsupportedPublicationError';
  }
}
