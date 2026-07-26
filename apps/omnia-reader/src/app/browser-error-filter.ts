const RESIZE_OBSERVER_DELIVERY_MESSAGES = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
]);

/**
 * Keeps browser ResizeObserver delivery diagnostics out of Angular's
 * application error channel. These events report deferred resize
 * notifications rather than an exception thrown by application code.
 */
export function installBenignBrowserErrorFilter(
  target: Window = globalThis.window,
): () => void {
  const handleError: EventListener = (event) => {
    if (
      !(event instanceof ErrorEvent) ||
      !RESIZE_OBSERVER_DELIVERY_MESSAGES.has(event.message)
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  target.addEventListener('error', handleError, true);
  return () => target.removeEventListener('error', handleError, true);
}
