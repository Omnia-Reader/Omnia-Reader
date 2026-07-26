export type PublicationReadingDirection = 'ltr' | 'rtl';
export type ReaderNavigationDirection = 'previous' | 'next';
export type ReaderZoomDirection = 'in' | 'out';

export interface TouchNavigationGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startedAt: number;
}

const MINIMUM_SWIPE_DISTANCE_PX = 48;
const HORIZONTAL_SWIPE_DOMINANCE = 1.25;
const MAXIMUM_SWIPE_DURATION_MS = 1_200;

export function keyboardNavigationDirection(
  event: Pick<
    KeyboardEvent,
    | 'altKey'
    | 'ctrlKey'
    | 'defaultPrevented'
    | 'key'
    | 'metaKey'
    | 'shiftKey'
    | 'target'
  >,
  readingDirection: PublicationReadingDirection = 'ltr',
): ReaderNavigationDirection | null {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableTarget(event.target)
  ) {
    return null;
  }

  if (event.key === 'ArrowLeft') {
    return readingDirection === 'rtl' ? 'next' : 'previous';
  }
  if (event.key === 'ArrowRight') {
    return readingDirection === 'rtl' ? 'previous' : 'next';
  }
  if (event.key === 'ArrowUp') {
    return 'previous';
  }
  if (event.key === 'ArrowDown') {
    return 'next';
  }
  return null;
}

export function wheelNavigationDirection(
  event: Pick<
    WheelEvent,
    | 'altKey'
    | 'ctrlKey'
    | 'defaultPrevented'
    | 'deltaX'
    | 'deltaY'
    | 'metaKey'
    | 'shiftKey'
    | 'target'
  >,
): ReaderNavigationDirection | null {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableTarget(event.target) ||
    event.deltaY === 0 ||
    Math.abs(event.deltaX) > Math.abs(event.deltaY)
  ) {
    return null;
  }

  return event.deltaY > 0 ? 'next' : 'previous';
}

export function wheelZoomDirection(
  event: Pick<
    WheelEvent,
    | 'altKey'
    | 'ctrlKey'
    | 'defaultPrevented'
    | 'deltaX'
    | 'deltaY'
    | 'metaKey'
    | 'shiftKey'
    | 'target'
  >,
): ReaderZoomDirection | null {
  if (
    event.defaultPrevented ||
    event.altKey ||
    !event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableTarget(event.target) ||
    event.deltaY === 0 ||
    Math.abs(event.deltaX) > Math.abs(event.deltaY)
  ) {
    return null;
  }

  return event.deltaY < 0 ? 'in' : 'out';
}

export function startTouchNavigationGesture(
  event: Pick<
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
  >,
): TouchNavigationGesture | null {
  if (
    event.defaultPrevented ||
    event.pointerType !== 'touch' ||
    !event.isPrimary ||
    event.button !== 0 ||
    isTouchNavigationControl(event.target)
  ) {
    return null;
  }

  return {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startedAt: event.timeStamp,
  };
}

export function startTouchEventNavigationGesture(
  event: Pick<
    TouchEvent,
    'defaultPrevented' | 'target' | 'timeStamp' | 'touches'
  >,
): TouchNavigationGesture | null {
  if (event.touches.length !== 1) {
    return null;
  }
  const touch = event.touches[0];
  return startTouchNavigationGesture({
    button: 0,
    clientX: touch.clientX,
    clientY: touch.clientY,
    defaultPrevented: event.defaultPrevented,
    isPrimary: true,
    pointerId: touch.identifier,
    pointerType: 'touch',
    target: event.target,
    timeStamp: event.timeStamp,
  });
}

export function touchNavigationDirection(
  gesture: TouchNavigationGesture,
  event: Pick<
    PointerEvent,
    | 'clientX'
    | 'clientY'
    | 'defaultPrevented'
    | 'pointerId'
    | 'pointerType'
    | 'timeStamp'
  >,
  readingDirection: PublicationReadingDirection = 'ltr',
): ReaderNavigationDirection | null {
  const horizontalDistance = event.clientX - gesture.startX;
  const verticalDistance = event.clientY - gesture.startY;
  const duration = event.timeStamp - gesture.startedAt;
  if (
    event.defaultPrevented ||
    event.pointerType !== 'touch' ||
    event.pointerId !== gesture.pointerId ||
    duration < 0 ||
    duration > MAXIMUM_SWIPE_DURATION_MS ||
    Math.abs(horizontalDistance) < MINIMUM_SWIPE_DISTANCE_PX ||
    Math.abs(horizontalDistance) <
      Math.abs(verticalDistance) * HORIZONTAL_SWIPE_DOMINANCE
  ) {
    return null;
  }

  const physicalDirection = horizontalDistance < 0 ? 'next' : 'previous';
  if (readingDirection === 'ltr') {
    return physicalDirection;
  }
  return physicalDirection === 'next' ? 'previous' : 'next';
}

export function touchEventNavigationDirection(
  gesture: TouchNavigationGesture,
  event: Pick<TouchEvent, 'changedTouches' | 'defaultPrevented' | 'timeStamp'>,
  readingDirection: PublicationReadingDirection = 'ltr',
): ReaderNavigationDirection | null {
  let touch: Touch | null = null;
  for (let index = 0; index < event.changedTouches.length; index += 1) {
    const candidate = event.changedTouches.item(index);
    if (candidate?.identifier === gesture.pointerId) {
      touch = candidate;
      break;
    }
  }
  if (!touch) {
    return null;
  }
  return touchNavigationDirection(
    gesture,
    {
      clientX: touch.clientX,
      clientY: touch.clientY,
      defaultPrevented: event.defaultPrevented,
      pointerId: touch.identifier,
      pointerType: 'touch',
      timeStamp: event.timeStamp,
    },
    readingDirection,
  );
}

export function selectionHasText(
  selection: Pick<Selection, 'isCollapsed' | 'toString'> | null | undefined,
): boolean {
  return Boolean(
    selection && !selection.isCollapsed && selection.toString().trim(),
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  const closest = (
    target as {
      closest?: (selector: string) => Element | null;
    } | null
  )?.closest;
  return (
    typeof closest === 'function' &&
    closest.call(
      target,
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ) !== null
  );
}

function isTouchNavigationControl(target: EventTarget | null): boolean {
  const closest = (
    target as {
      closest?: (selector: string) => Element | null;
    } | null
  )?.closest;
  return (
    typeof closest === 'function' &&
    closest.call(
      target,
      [
        'a',
        'button',
        'input',
        'textarea',
        'select',
        'summary',
        'label',
        '[role="button"]',
        '[role="link"]',
        '[contenteditable]:not([contenteditable="false"])',
        '[data-omnia-annotation-id]',
        '[data-annotation-id]',
      ].join(', '),
    ) !== null
  );
}
