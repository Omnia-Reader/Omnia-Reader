// Capture the original frame before collecting passive page metadata.
export async function collectNativeFailureDiagnostics(driver, screenshotPath) {
  if (!driver) return undefined;
  await driver.saveScreenshot(screenshotPath).catch(() => undefined);
  return driver.execute(PAGE_DIAGNOSTIC_SCRIPT).catch(() => undefined);
}

const PAGE_DIAGNOSTIC_SCRIPT = `
            return {
              url: location.href,
              readyState: document.readyState,
              documentHtml: document.documentElement?.outerHTML?.slice(0, 4_000),
              scripts: Array.from(document.scripts, (script) => ({
                src: script.src,
                type: script.type,
                noModule: script.noModule
              })),
              resources: performance.getEntriesByType('resource').map((entry) => ({
                name: entry.name,
                initiatorType: entry.initiatorType,
                duration: entry.duration,
                transferSize: entry.transferSize
              })),
              stylesheets: Array.from(document.styleSheets, (sheet) => sheet.href),
              styleLinks: Array.from(
                document.querySelectorAll('link[rel="stylesheet"]'),
                (link) => ({
                  href: link.href,
                  loaded: link.sheet !== null
                })
              ),
              viewportPosition: document.querySelector(
                '[data-testid="publication-viewport"]'
              )
                ? getComputedStyle(
                    document.querySelector(
                      '[data-testid="publication-viewport"]'
                    )
                  ).position
                : null,
              epubFrames: Array.from(
                document.querySelectorAll(
                  '[data-testid="publication-viewport"] iframe'
                ),
                (frame) => ({
                  src: frame.getAttribute('src'),
                  srcdocLength: frame.getAttribute('srcdoc')?.length ?? 0,
                  sandbox: frame.getAttribute('sandbox'),
                  readyState: frame.contentDocument?.readyState ?? null,
                  bodyText: frame.contentDocument?.body?.innerText?.slice(0, 500)
                    ?? null
                })
              ),
              bodyText: document.body?.innerText?.slice(0, 2_000)
            };
          `;
