import {
  keyboardNavigationDirection,
  keyboardReaderCommand,
  selectionHasText,
  startTouchEventNavigationGesture,
  startTouchNavigationGesture,
  touchEventNavigationDirection,
  touchNavigationDirection,
  wheelNavigationDirection,
  wheelZoomDirection,
} from './reader-navigation';

describe('keyboardReaderCommand', () => {
  it('maps the reader command palette without intercepting page keys', () => {
    expect(keyboardReaderCommand(keyboardEvent('t'))).toBe('toc');
    expect(keyboardReaderCommand(keyboardEvent('/'))).toBe('search');
    expect(keyboardReaderCommand(keyboardEvent('m'))).toBe('toggle-bookmark');
    expect(keyboardReaderCommand(keyboardEvent('b'))).toBe('bookmarks');
    expect(keyboardReaderCommand(keyboardEvent('a'))).toBe('annotations');
    expect(keyboardReaderCommand(keyboardEvent('o'))).toBe('settings');
    expect(keyboardReaderCommand(keyboardEvent('f'))).toBe('fullscreen');
    expect(
      keyboardReaderCommand({ ...keyboardEvent('?'), shiftKey: true }),
    ).toBe('shortcuts');
    expect(
      keyboardReaderCommand({ ...keyboardEvent('/'), shiftKey: true }),
    ).toBe('shortcuts');
    expect(keyboardReaderCommand(keyboardEvent('ArrowRight'))).toBeNull();
  });

  it('supports platform search and leaves editing or unrelated modifiers alone', () => {
    expect(
      keyboardReaderCommand({ ...keyboardEvent('f'), ctrlKey: true }),
    ).toBe('search');
    expect(
      keyboardReaderCommand({ ...keyboardEvent('F'), metaKey: true }),
    ).toBe('search');
    expect(
      keyboardReaderCommand({ ...keyboardEvent('f'), altKey: true }),
    ).toBeNull();
    expect(
      keyboardReaderCommand({ ...keyboardEvent('m'), repeat: true }),
    ).toBeNull();
    expect(
      keyboardReaderCommand({
        ...keyboardEvent('a'),
        target: document.createElement('textarea'),
      }),
    ).toBeNull();
  });

  it('allows Escape to dismiss reader UI even when an editor has focus', () => {
    expect(
      keyboardReaderCommand({
        ...keyboardEvent('Escape'),
        target: document.createElement('input'),
      }),
    ).toBe('dismiss');
  });
});

describe('keyboardNavigationDirection', () => {
  it('maps horizontal arrows using the publication reading direction', () => {
    expect(directionEvent('ArrowLeft', 'ltr')).toBe('previous');
    expect(directionEvent('ArrowRight', 'ltr')).toBe('next');
    expect(directionEvent('ArrowLeft', 'rtl')).toBe('next');
    expect(directionEvent('ArrowRight', 'rtl')).toBe('previous');
  });

  it('maps vertical arrows using conventional scroll direction', () => {
    expect(directionEvent('ArrowUp', 'ltr')).toBe('previous');
    expect(directionEvent('ArrowDown', 'ltr')).toBe('next');
    expect(directionEvent('ArrowUp', 'rtl')).toBe('previous');
    expect(directionEvent('ArrowDown', 'rtl')).toBe('next');
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

describe('wheelNavigationDirection', () => {
  it('maps vertical wheel movement using conventional scroll direction', () => {
    expect(wheelDirection(-120)).toBe('previous');
    expect(wheelDirection(120)).toBe('next');
  });

  it('does not intercept horizontal, modified, handled, or editing input', () => {
    expect(wheelDirection(20, 40)).toBeNull();
    expect(
      wheelNavigationDirection({
        ...wheelEvent(120),
        ctrlKey: true,
      }),
    ).toBeNull();
    expect(
      wheelNavigationDirection({
        ...wheelEvent(120),
        defaultPrevented: true,
      }),
    ).toBeNull();
    expect(
      wheelDirection(120, 0, document.createElement('textarea')),
    ).toBeNull();
  });
});

describe('wheelZoomDirection', () => {
  it('maps Ctrl with vertical wheel movement to conventional zoom direction', () => {
    expect(wheelZoomDirection({ ...wheelEvent(-120), ctrlKey: true })).toBe(
      'in',
    );
    expect(wheelZoomDirection({ ...wheelEvent(120), ctrlKey: true })).toBe(
      'out',
    );
  });

  it('does not intercept unmodified, horizontal, handled, or editing input', () => {
    expect(wheelZoomDirection(wheelEvent(-120))).toBeNull();
    expect(
      wheelZoomDirection({
        ...wheelEvent(-120, 240),
        ctrlKey: true,
      }),
    ).toBeNull();
    expect(
      wheelZoomDirection({
        ...wheelEvent(-120),
        ctrlKey: true,
        defaultPrevented: true,
      }),
    ).toBeNull();
    expect(
      wheelZoomDirection({
        ...wheelEvent(-120),
        ctrlKey: true,
        target: document.createElement('input'),
      }),
    ).toBeNull();
  });
});

describe('touchNavigationDirection', () => {
  it('maps horizontal swipes using the publication reading direction', () => {
    expect(swipeDirection(180, 80, 'ltr')).toBe('next');
    expect(swipeDirection(80, 180, 'ltr')).toBe('previous');
    expect(swipeDirection(180, 80, 'rtl')).toBe('previous');
    expect(swipeDirection(80, 180, 'rtl')).toBe('next');
  });

  it('ignores short, vertical, slow, handled, and mismatched gestures', () => {
    expect(swipeDirection(120, 80)).toBeNull();
    expect(swipeDirection(180, 100, 'ltr', 220)).toBeNull();
    expect(swipeDirection(180, 80, 'ltr', 0, 1_201)).toBeNull();
    expect(
      touchNavigationDirection(
        requireGesture(touchPointerEvent({ clientX: 180 })),
        touchPointerEvent({
          clientX: 80,
          defaultPrevented: true,
          timeStamp: 200,
        }),
      ),
    ).toBeNull();
    expect(
      touchNavigationDirection(
        requireGesture(touchPointerEvent({ clientX: 180 })),
        touchPointerEvent({
          clientX: 80,
          pointerId: 2,
          timeStamp: 200,
        }),
      ),
    ).toBeNull();
  });

  it('only starts for an unhandled primary touch outside controls', () => {
    expect(
      startTouchNavigationGesture(touchPointerEvent({ pointerType: 'mouse' })),
    ).toBeNull();
    expect(
      startTouchNavigationGesture(touchPointerEvent({ isPrimary: false })),
    ).toBeNull();
    expect(
      startTouchNavigationGesture(
        touchPointerEvent({ defaultPrevented: true }),
      ),
    ).toBeNull();

    for (const target of [
      document.createElement('a'),
      document.createElement('button'),
      document.createElement('input'),
      annotationTarget(),
    ]) {
      expect(
        startTouchNavigationGesture(touchPointerEvent({ target })),
      ).toBeNull();
    }
  });
});

describe('selectionHasText', () => {
  it('only reports a non-collapsed, non-empty selection', () => {
    expect(selectionHasText(null)).toBe(false);
    expect(
      selectionHasText({ isCollapsed: true, toString: () => 'selected' }),
    ).toBe(false);
    expect(
      selectionHasText({ isCollapsed: false, toString: () => '   ' }),
    ).toBe(false);
    expect(
      selectionHasText({ isCollapsed: false, toString: () => 'selected' }),
    ).toBe(true);
  });
});

describe('touch-event navigation fallback', () => {
  it('maps a single changed touch through the shared swipe rules', () => {
    const gesture = startTouchEventNavigationGesture({
      defaultPrevented: false,
      target: null,
      timeStamp: 0,
      touches: touchList(touchPoint(1, 180, 80)),
    });
    if (!gesture) {
      throw new Error('Expected a touch-event navigation gesture');
    }
    expect(
      touchEventNavigationDirection(
        gesture,
        {
          changedTouches: touchList(touchPoint(1, 70, 84)),
          defaultPrevented: false,
          timeStamp: 200,
        },
        'ltr',
      ),
    ).toBe('next');
  });

  it('ignores multitouch starts and unrelated changed touches', () => {
    expect(
      startTouchEventNavigationGesture({
        defaultPrevented: false,
        target: null,
        timeStamp: 0,
        touches: touchList(touchPoint(1, 180, 80), touchPoint(2, 200, 80)),
      }),
    ).toBeNull();
    const gesture = requireGesture(
      touchPointerEvent({ clientX: 180, clientY: 80 }),
    );
    expect(
      touchEventNavigationDirection(gesture, {
        changedTouches: touchList(touchPoint(2, 70, 84)),
        defaultPrevented: false,
        timeStamp: 200,
      }),
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
    repeat: false,
    shiftKey: false,
    target: null,
  };
}

function wheelDirection(
  deltaY: number,
  deltaX = 0,
  target: EventTarget | null = null,
) {
  return wheelNavigationDirection({
    ...wheelEvent(deltaY, deltaX),
    target,
  });
}

function wheelEvent(deltaY: number, deltaX = 0) {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    deltaX,
    deltaY,
    metaKey: false,
    shiftKey: false,
    target: null,
  };
}

function swipeDirection(
  startX: number,
  endX: number,
  readingDirection: 'ltr' | 'rtl' = 'ltr',
  endY = 0,
  duration = 200,
) {
  const gesture = requireGesture(
    touchPointerEvent({ clientX: startX, timeStamp: 0 }),
  );
  return touchNavigationDirection(
    gesture,
    touchPointerEvent({
      clientX: endX,
      clientY: endY,
      timeStamp: duration,
    }),
    readingDirection,
  );
}

function touchPointerEvent(
  overrides: Partial<
    Pick<
      PointerEvent,
      | 'button'
      | 'clientX'
      | 'clientY'
      | 'defaultPrevented'
      | 'isPrimary'
      | 'pointerId'
      | 'pointerType'
      | 'target'
      | 'timeStamp'
    >
  > = {},
) {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'touch',
    target: null,
    timeStamp: 0,
    ...overrides,
  };
}

function requireGesture(event: ReturnType<typeof touchPointerEvent>) {
  const gesture = startTouchNavigationGesture(event);
  if (!gesture) {
    throw new Error('Expected a touch navigation gesture');
  }
  return gesture;
}

function annotationTarget(): HTMLElement {
  const target = document.createElement('span');
  target.dataset['omniaAnnotationId'] = 'annotation';
  return target;
}

function touchPoint(
  identifier: number,
  clientX: number,
  clientY: number,
): Touch {
  return { identifier, clientX, clientY } as Touch;
}

function touchList(...touches: Touch[]): TouchList {
  return Object.assign(touches, {
    item: (index: number) => touches[index] ?? null,
  }) as unknown as TouchList;
}
