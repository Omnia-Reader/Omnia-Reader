import {
  mergeReaderPreferenceSyncStates,
  parseReaderPreferenceSyncState,
  serializeReaderPreferenceSyncState,
  type ReaderPreferenceSyncState,
} from './reader-preference-sync-state';

describe('reader preference synchronization state', () => {
  const theme = {
    value: 'dark' as const,
    revision: 2,
    deviceId: 'device-a',
    changeId: 'change-theme',
  };
  const fontSize = {
    value: 125,
    revision: 1,
    deviceId: 'device-b',
    changeId: 'change-font-size',
  };

  it('serializes valid state in canonical field order', () => {
    const state: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: { fontSizePercent: fontSize, theme },
      pdf: {
        rotation: {
          value: 90,
          revision: 3,
          deviceId: 'device-a',
          changeId: 'change-rotation',
        },
      },
    };

    expect(serializeReaderPreferenceSyncState(state)).toBe(
      '{"schemaVersion":1,"epub":{"theme":{"value":"dark","revision":2,"deviceId":"device-a","changeId":"change-theme"},"fontSizePercent":{"value":125,"revision":1,"deviceId":"device-b","changeId":"change-font-size"}},"pdf":{"rotation":{"value":90,"revision":3,"deviceId":"device-a","changeId":"change-rotation"}}}',
    );
  });

  it('round-trips every portable EPUB and PDF field', () => {
    const register = <Value>(value: Value, changeId: string) => ({
      value,
      revision: 1,
      deviceId: 'device-a',
      changeId,
    });
    const state: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: {
        theme: register('sepia', 'theme'),
        fontFamily: register('sans-serif', 'font-family'),
        fontSizePercent: register(140, 'font-size'),
        lineHeight: register(1.8, 'line-height'),
        paragraphSpacingRem: register(1.25, 'paragraph-spacing'),
        marginPercent: register(8, 'margin'),
        maxLineWidthRem: register(52, 'line-width'),
        flow: register('paginated', 'flow'),
        spread: register('none', 'spread'),
      },
      pdf: {
        zoomMode: register('custom', 'zoom-mode'),
        zoomPercent: register(175, 'zoom-percent'),
        rotation: register(270, 'rotation'),
      },
    };

    expect(
      parseReaderPreferenceSyncState(serializeReaderPreferenceSyncState(state)),
    ).toEqual(state);
  });

  it('merges different fields independently', () => {
    const left: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: { theme },
      pdf: {},
    };
    const right: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: { fontSizePercent: fontSize },
      pdf: {},
    };

    expect(mergeReaderPreferenceSyncStates(left, right)).toEqual({
      schemaVersion: 1,
      epub: { theme, fontSizePercent: fontSize },
      pdf: {},
    });
  });

  it('resolves the same field identically regardless of merge order', () => {
    const left: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: {
        theme: {
          value: 'sepia',
          revision: 4,
          deviceId: 'device-a',
          changeId: 'change-a',
        },
      },
      pdf: {},
    };
    const right: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: {
        theme: {
          value: 'dark',
          revision: 4,
          deviceId: 'device-b',
          changeId: 'change-b',
        },
      },
      pdf: {},
    };

    const forward = mergeReaderPreferenceSyncStates(left, right);
    const reverse = mergeReaderPreferenceSyncStates(right, left);
    expect(forward).toEqual(reverse);
    expect(forward.epub.theme).toEqual(right.epub.theme);
  });

  it('uses immutable change identity as the final conflict tie-breaker', () => {
    const left: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: {
        flow: {
          value: 'paginated',
          revision: 7,
          deviceId: 'device-a',
          changeId: 'change-a',
        },
      },
      pdf: {},
    };
    const right: ReaderPreferenceSyncState = {
      schemaVersion: 1,
      epub: {
        flow: {
          value: 'scrolled',
          revision: 7,
          deviceId: 'device-a',
          changeId: 'change-b',
        },
      },
      pdf: {},
    };

    expect(mergeReaderPreferenceSyncStates(left, right).epub.flow).toEqual(
      right.epub.flow,
    );
    expect(mergeReaderPreferenceSyncStates(right, left).epub.flow).toEqual(
      right.epub.flow,
    );
  });

  it.each([
    '{"schemaVersion":2,"epub":{},"pdf":{}}',
    '{"schemaVersion":1,"epub":{"unknown":{"value":1,"revision":1,"deviceId":"device-a","changeId":"change-a"}},"pdf":{}}',
    '{"schemaVersion":1,"epub":{"theme":{"value":"blue","revision":1,"deviceId":"device-a","changeId":"change-a"}},"pdf":{}}',
    '{"schemaVersion":1,"epub":{"theme":{"value":"dark","revision":-1,"deviceId":"device-a","changeId":"change-a"}},"pdf":{}}',
    '{"schemaVersion":1,"epub":{"theme":{"value":"dark","revision":1,"deviceId":"device-a","changeId":"change-a"},"theme":{"value":"sepia","revision":2,"deviceId":"device-b","changeId":"change-b"}},"pdf":{}}',
  ])('rejects invalid or ambiguous documents', (document) => {
    expect(() => parseReaderPreferenceSyncState(document)).toThrow(
      'Reader preference synchronization state is invalid',
    );
  });

  it('rejects oversized documents before parsing', () => {
    expect(() =>
      parseReaderPreferenceSyncState(
        `{"schemaVersion":1,"epub":{},"pdf":{},"padding":"${'x'.repeat(70_000)}"}`,
      ),
    ).toThrow('Reader preference synchronization state is too large');
  });
});
