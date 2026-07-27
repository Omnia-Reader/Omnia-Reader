import {
  PublicationAnnotation,
  isPublicationAnnotation,
  preferredAnnotation,
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

  it('requires selected text and a supported color', () => {
    expect(
      isPublicationAnnotation({
        ...ANNOTATION,
        locator: { ...ANNOTATION.locator, text: undefined },
      }),
    ).toBe(false);
    expect(isPublicationAnnotation({ ...ANNOTATION, color: 'orange' })).toBe(
      false,
    );
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
