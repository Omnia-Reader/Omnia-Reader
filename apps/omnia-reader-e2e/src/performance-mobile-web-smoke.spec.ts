import { writeFile } from 'node:fs/promises';
import { chromium, expect, test, type Page } from '@playwright/test';
import { canonicalStringify } from '../performance/performance-contract.mjs';

test('reaches the built app through the owned mobile Chrome CDP session', async () => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PERFORMANCE_MOBILE_WEB_SMOKE'] !== '1',
    'Run through the qualified performance-mobile-web smoke launcher',
  );
  test.setTimeout(120_000);
  const cdpEndpoint = requiredLoopbackOrigin('PERFORMANCE_MOBILE_CDP_ENDPOINT');
  const applicationUrl = requiredLoopbackOrigin(
    'PERFORMANCE_MOBILE_APPLICATION_URL',
  );
  const resultPath = requiredEnvironmentValue(
    'PERFORMANCE_MOBILE_SMOKE_RESULT',
  );
  const profileSetId = requiredEnvironmentValue(
    'PERFORMANCE_MOBILE_PROFILE_SET_ID',
  );
  const profileSetDigest = requiredEnvironmentValue(
    'PERFORMANCE_MOBILE_PROFILE_SET_DIGEST',
  );

  const browser = await chromium.connectOverCDP(cdpEndpoint);
  let page: Page | undefined;
  try {
    page = await singleMobileContextPage(browser);
    await page.goto(applicationUrl);
    await expect(
      page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();
    await writeFile(
      resultPath,
      `${canonicalStringify({
        schemaVersion: 1,
        status: 'SMOKE_PASS',
        profileSetId,
        profileSetDigest,
        profileId: 'mobile-web-v2',
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } finally {
    await page?.close().catch(() => undefined);
  }
});

async function singleMobileContextPage(
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>,
): Promise<Page> {
  const contexts = browser.contexts();
  if (contexts.length !== 1) {
    throw new Error('Mobile Chrome must expose exactly one CDP context');
  }
  return contexts[0].newPage();
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackOrigin(name: string): string {
  const value = requiredEnvironmentValue(name);
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be one loopback HTTP origin`);
  }
  return url.origin;
}
