import { expect, test } from '@playwright/test';
import { collectNativeFailureDiagnostics } from './native/native-failure-diagnostics.mjs';

test('captures the original screenshot and inspects the page without bootstrapping again', async ({
  page,
}, testInfo) => {
  let moduleRequests = 0;
  await page.route('https://diagnostic.test/**', (route) => {
    if (route.request().url().includes('main.js')) {
      moduleRequests++;
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'document.body.dataset.boots = String(Number(document.body.dataset.boots || 0) + 1);',
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<html><body><p>Original failure</p><script type="module" src="/main.js"></script></body></html>',
    });
  });
  await page.goto('https://diagnostic.test/');
  await expect(page.locator('body')).toHaveAttribute('data-boots', '1');
  const originalHtml = await page.content();
  const events: string[] = [];
  const diagnostic = await collectNativeFailureDiagnostics(
    {
      saveScreenshot: async (path: string) => {
        events.push('screenshot');
        return page.screenshot({ path });
      },
      execute: async (script: string) => {
        events.push('inspect');
        return page.evaluate((source) => {
          const originalError = console.error;
          const result = new Function(source)();
          if (console.error !== originalError)
            throw new Error('Console was replaced');
          return result;
        }, script);
      },
    },
    testInfo.outputPath('native-failure.png'),
  );
  expect(events).toEqual(['screenshot', 'inspect']);
  expect(diagnostic.bodyText).toContain('Original failure');
  expect(moduleRequests).toBe(1);
  expect(await page.content()).toBe(originalHtml);
});

test('diagnostic failures do not replace the original failure', async () => {
  const events: string[] = [];
  const result = await collectNativeFailureDiagnostics(
    {
      saveScreenshot: async () => {
        events.push('screenshot');
        throw new Error('No screenshot');
      },
      execute: async () => {
        events.push('inspect');
        throw new Error('Page gone');
      },
    },
    'unused.png',
  );
  expect(result).toBeUndefined();
  expect(events).toEqual(['screenshot', 'inspect']);
});
