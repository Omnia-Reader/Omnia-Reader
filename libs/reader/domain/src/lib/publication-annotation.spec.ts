import {
  PublicationAnnotation,
  annotationDecorations,
  annotationHasStyle,
  isPublicationAnnotationColor,
  isPublicationAnnotation,
  preferredAnnotation,
  publicationAnnotationColorHex,
  publicationAnnotationColorLabel,
} from './publication-annotation';

const ANNOTATION: PublicationAnnotation = {
  schemaVersion: 1,
  id: 'b3f32088-1619-4571-8430-a5e14f11748e',
  bookId: `sha256:${'a'.repeat(64)}`,
  format: 'pdf',
  deviceId: 'device-a',
  locator: {
    href: '',
    type: 'application/pdf',
    title: 'Page 4',
    locations: {
      fragments: ['pdf-text=4:12:31'],
      position: 4,
      totalProgression: 0.3,
    },
    text: {
      before: 'The words before ',
      highlight: 'selected quotation',
      after: ' and the words after.',
    },
  },
  color: 'yellow',
  note: 'Review this argument.',
  createdAt: '2026-07-25T08:00:00.000Z',
  updatedAt: '2026-07-25T08:00:00.000Z',
};

describe('PublicationAnnotation', () => {
  it('accepts a bounded, versioned text annotation', () => {
    expect(isPublicationAnnotation(ANNOTATION)).toBe(true);
  });

  it('accepts every decoration style while keeping legacy highlights valid', () => {
    expect(isPublicationAnnotation({ ...ANNOTATION, style: undefined })).toBe(
      true,
    );
    for (const style of ['highlight', 'underline', 'strikethrough'] as const) {
      expect(isPublicationAnnotation({ ...ANNOTATION, style })).toBe(true);
    }
    expect(
      isPublicationAnnotation({ ...ANNOTATION, style: 'double-underline' }),
    ).toBe(false);
  });

  it('supports independent visual layers and note-only annotations', () => {
    const layered: PublicationAnnotation = {
      ...ANNOTATION,
      decorations: [
        { style: 'highlight', color: 'yellow' },
        { style: 'underline', color: 'blue' },
        { style: 'strikethrough', color: 'pink' },
      ],
    };

    expect(isPublicationAnnotation(layered)).toBe(true);
    expect(annotationDecorations(layered)).toEqual(layered.decorations);
    expect(annotationHasStyle(layered, 'highlight')).toBe(true);
    expect(annotationHasStyle(layered, 'underline')).toBe(true);
    expect(annotationHasStyle(layered, 'strikethrough')).toBe(true);
    expect(
      isPublicationAnnotation({ ...ANNOTATION, decorations: [], note: 'Note' }),
    ).toBe(true);
    expect(
      isPublicationAnnotation({
        ...ANNOTATION,
        decorations: [],
        note: undefined,
      }),
    ).toBe(false);
  });

  it('rejects duplicate or malformed visual layers', () => {
    expect(
      isPublicationAnnotation({
        ...ANNOTATION,
        decorations: [
          { style: 'underline', color: 'blue' },
          { style: 'underline', color: 'pink' },
        ],
      }),
    ).toBe(false);
    expect(
      isPublicationAnnotation({
        ...ANNOTATION,
        decorations: [{ style: 'outline', color: 'blue' }],
      }),
    ).toBe(false);
  });

  it('normalizes a legacy record to one decoration', () => {
    expect(annotationDecorations(ANNOTATION)).toEqual([
      { style: 'highlight', color: 'yellow' },
    ]);
    expect(
      annotationDecorations({
        ...ANNOTATION,
        style: 'underline',
        color: 'pink',
      }),
    ).toEqual([{ style: 'underline', color: 'pink' }]);
  });

  it('requires selected text and a supported preset or custom color', () => {
    expect(
      isPublicationAnnotation({
        ...ANNOTATION,
        locator: { ...ANNOTATION.locator, text: undefined },
      }),
    ).toBe(false);
    expect(isPublicationAnnotation({ ...ANNOTATION, color: 'orange' })).toBe(
      true,
    );
    expect(isPublicationAnnotation({ ...ANNOTATION, color: '#12aBcF' })).toBe(
      true,
    );
    expect(isPublicationAnnotation({ ...ANNOTATION, color: '#123' })).toBe(
      false,
    );
    expect(
      isPublicationAnnotation({ ...ANNOTATION, color: 'transparent' }),
    ).toBe(false);
    expect(isPublicationAnnotationColor('#a855f7')).toBe(true);
    expect(publicationAnnotationColorHex('purple')).toBe('#CC79A7');
    expect(publicationAnnotationColorHex('sky-blue')).toBe('#56B4E9');
    expect(publicationAnnotationColorHex('brown')).toBe('#8C564B');
    expect(publicationAnnotationColorHex('gray')).toBe('#7F7F7F');
    expect(publicationAnnotationColorLabel('bluish-green')).toBe(
      'Bluish green',
    );
    expect(isPublicationAnnotationColor('pink')).toBe(true);
    expect(publicationAnnotationColorHex('#12aBcF')).toBe('#12abcf');
  });

  it('requires a canonical tombstone matching the update timestamp', () => {
    expect(
      isPublicationAnnotation({
        ...ANNOTATION,
        deletedAt: '2026-07-25T09:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      isPublicationAnnotation({
        ...ANNOTATION,
        updatedAt: '2026-07-25T09:00:00.000Z',
        deletedAt: '2026-07-25T09:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('merges same-time concurrent edits deterministically', () => {
    const competing = {
      ...ANNOTATION,
      color: 'pink' as const,
      note: 'A competing edit.',
    };
    const preferred = preferredAnnotation(ANNOTATION, competing);

    expect(preferredAnnotation(competing, ANNOTATION)).toBe(preferred);
  });
});
