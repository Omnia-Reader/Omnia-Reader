import { keyboardNavigationDirection } from './reader-navigation';

describe('keyboardNavigationDirection', () => {
  it('maps horizontal arrows using the publication reading direction', () => {
    expect(directionEvent('ArrowLeft', 'ltr')).toBe('previous');
    expect(directionEvent('ArrowRight', 'ltr')).toBe('next');
    expect(directionEvent('ArrowLeft', 'rtl')).toBe('next');
    expect(directionEvent('ArrowRight', 'rtl')).toBe('previous');
  });

  it('does not intercept editing, selection, modified, or handled input', () => {
    const input = document.createElement('input');
    expect(directionEvent('ArrowRight', 'ltr', input)).toBeNull();
    expect(
      keyboardNavigationDirection(
        {
          ...keyboardEvent('ArrowRight'),
          shiftKey: true,
        },
        'ltr',
      ),
    ).toBeNull();
    expect(
      keyboardNavigationDirection(
        {
          ...keyboardEvent('ArrowRight'),
          defaultPrevented: true,
        },
        'ltr',
      ),
    ).toBeNull();
  });
});

function directionEvent(
  key: string,
  readingDirection: 'ltr' | 'rtl',
  target: EventTarget | null = null,
) {
  return keyboardNavigationDirection(
    {
      ...keyboardEvent(key),
      target,
    },
    readingDirection,
  );
}

function keyboardEvent(key: string) {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    key,
    metaKey: false,
    shiftKey: false,
    target: null,
  };
}
