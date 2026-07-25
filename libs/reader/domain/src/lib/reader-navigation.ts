export type PublicationReadingDirection = 'ltr' | 'rtl';
export type ReaderNavigationDirection = 'previous' | 'next';

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
  return null;
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
