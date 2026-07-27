import {
  epubLocationEndsSection,
  epubLocationToLocator,
  epubLocationToPageStatus,
} from './epub-locator';

describe('epubLocationToLocator', () => {
  it('maps the nested relocation shape emitted by EPUB.js', () => {
    expect(
      epubLocationToLocator({
        start: {
          href: 'chapter-2.xhtml',
          cfi: 'epubcfi(/6/4!/4/2/1:0)',
          location: 12,
          percentage: 0.42,
          displayed: { page: 2, total: 5 },
        },
      }),
    ).toEqual({
      href: 'chapter-2.xhtml',
      type: 'application/xhtml+xml',
      locations: {
        fragments: ['epubcfi(/6/4!/4/2/1:0)'],
        progression: 0.4,
        position: 12,
        totalProgression: 0.42,
      },
    });
  });

  it('also accepts the flat shape declared by the EPUB.js type package', () => {
    expect(
      epubLocationToLocator({
        href: 'chapter.xhtml',
        cfi: 'epubcfi(/6/2!/4/1:0)',
      }),
    ).toEqual({
      href: 'chapter.xhtml',
      type: 'application/xhtml+xml',
      locations: {
        fragments: ['epubcfi(/6/2!/4/1:0)'],
        progression: undefined,
        position: undefined,
        totalProgression: undefined,
      },
    });
  });

  it('omits EPUB.js zero-based location indexes from the one-based locator contract', () => {
    expect(
      epubLocationToLocator({
        href: 'chapter.xhtml',
        location: 0,
        percentage: 2,
      }),
    ).toMatchObject({
      locations: {
        position: undefined,
        totalProgression: undefined,
      },
    });
  });

  it.each([null, {}, { start: {} }, { href: '' }])(
    'rejects a location without a publication href',
    (location) => {
      expect(epubLocationToLocator(location)).toBeNull();
    },
  );
});

describe('epubLocationToPageStatus', () => {
  it('exposes layout-relative pages for the current spine section', () => {
    expect(
      epubLocationToPageStatus({
        start: {
          href: 'chapter-2.xhtml',
          displayed: { page: 2, total: 5 },
        },
      }),
    ).toEqual({
      current: 2,
      total: 5,
      scope: 'section',
    });
  });

  it.each([
    null,
    {},
    { displayed: {} },
    { displayed: { page: 0, total: 5 } },
    { displayed: { page: 6, total: 5 } },
  ])('rejects invalid or unavailable layout page data', (location) => {
    expect(epubLocationToPageStatus(location)).toBeNull();
  });
});

describe('epubLocationEndsSection', () => {
  it('uses the end of the visible range for a final two-page spread', () => {
    expect(
      epubLocationEndsSection({
        start: { displayed: { page: 9, total: 10 } },
        end: { displayed: { page: 10, total: 10 } },
      }),
    ).toBe(true);
  });

  it('detects when boundary navigation stopped before the final visible page', () => {
    expect(
      epubLocationEndsSection({
        start: { displayed: { page: 8, total: 10 } },
        end: { displayed: { page: 9, total: 10 } },
      }),
    ).toBe(false);
  });
});
