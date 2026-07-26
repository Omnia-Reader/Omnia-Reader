import { installBenignBrowserErrorFilter } from './browser-error-filter';

describe('installBenignBrowserErrorFilter', () => {
  it('consumes only ResizeObserver delivery diagnostics', () => {
    const downstream = vi.fn();
    const uninstall = installBenignBrowserErrorFilter(globalThis.window);
    globalThis.window.addEventListener('error', downstream);

    const resizeDiagnostic = new ErrorEvent('error', {
      cancelable: true,
      message: 'ResizeObserver loop completed with undelivered notifications.',
    });
    globalThis.window.dispatchEvent(resizeDiagnostic);
    expect(resizeDiagnostic.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();

    const applicationError = new ErrorEvent('error', {
      cancelable: true,
      message: 'Reader rendering failed',
    });
    globalThis.window.dispatchEvent(applicationError);
    expect(applicationError.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledOnce();

    globalThis.window.removeEventListener('error', downstream);
    uninstall();
  });
});
