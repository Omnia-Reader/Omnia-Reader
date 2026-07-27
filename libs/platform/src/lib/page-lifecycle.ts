export function registerPageBackgroundListener(
  callback: () => void,
): () => void {
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      callback();
    }
  };
  const onPageHide = () => callback();

  document.addEventListener('visibilitychange', onVisibilityChange);
  globalThis.addEventListener('pagehide', onPageHide);

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    globalThis.removeEventListener('pagehide', onPageHide);
  };
}
