import { writeFile } from 'node:fs/promises';
import { chromium, expect, test, type Page } from '@playwright/test';
import {
  canonicalStringify,
  readJsonFile,
} from '../performance/performance-contract.mjs';
import { runPerformanceManagementWorkload } from './performance-management-runner';

test('writes the complete qualified mobile Chrome management result', async () => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    process.env['PERFORMANCE_MOBILE_WEB'] !== '1',
    'Run through the qualified performance-mobile-web launcher',
  );
  test.setTimeout(4 * 60 * 60 * 1_000);

  const profilePath = requiredEnvironmentValue(
    'PERFORMANCE_MOBILE_PROFILE_SET',
  );
  const environmentPath = requiredEnvironmentValue(
    'PERFORMANCE_MOBILE_ENVIRONMENT',
  );
  const workloadPath = requiredEnvironmentValue('PERFORMANCE_MOBILE_WORKLOAD');
  const rawResultPath = requiredEnvironmentValue(
    'PERFORMANCE_MOBILE_RAW_RESULT',
  );
  const cdpEndpoint = requiredLoopbackUrl('PERFORMANCE_MOBILE_CDP_ENDPOINT');
  const applicationUrl = requiredLoopbackUrl(
    'PERFORMANCE_MOBILE_APPLICATION_URL',
  );
  const [profileSet, environment, workload] = await Promise.all([
    readJsonFile(profilePath),
    readJsonFile(environmentPath),
    readJsonFile(workloadPath),
  ]);

  const browser = await chromium.connectOverCDP(cdpEndpoint);
  let page: Page | undefined;
  try {
    page = await singleMobileContextPage(browser);
    const result = await runPerformanceManagementWorkload({
      page,
      profileSet,
      environment,
      workload,
      applicationUrl,
      captureSamplingIdentity: (measurementPage) =>
        captureMobilePageIdentity(
          measurementPage,
          browser.version(),
          environment,
        ),
      command:
        'npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 performance-mobile-web.spec.ts',
    });
    expect(result).toBeDefined();
    await writeFile(rawResultPath, `${canonicalStringify(result)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } finally {
    await page?.close().catch(() => undefined);
    // Do not call browser.close(): the owning driver must recapture the exact
    // Chrome runtime after sampling before it terminates the emulator.
  }
});

async function captureMobilePageIdentity(
  page: Page,
  browserVersion: string,
  environment: {
    profileId?: unknown;
    values?: Record<string, unknown>;
  },
) {
  if (environment.profileId !== 'mobile-web-v2' || !environment.values) {
    throw new Error('The measurement requires a mobile-web-v2 environment');
  }
  const expectedVersion = environment.values['runtime.chromeVersion'];
  if (browserVersion !== expectedVersion) {
    throw new Error('CDP browser version changed before sampling');
  }
  const screen = await page.evaluate(() => ({
    width: window.screen.width,
    height: window.screen.height,
    deviceScaleFactor: window.devicePixelRatio,
  }));
  const expectedDensity = environment.values['environment.densityDpi'];
  const expectedWidth = environment.values['environment.viewportWidth'];
  const expectedHeight = environment.values['environment.viewportHeight'];
  if (
    typeof expectedDensity !== 'number' ||
    typeof expectedWidth !== 'number' ||
    typeof expectedHeight !== 'number' ||
    screen.deviceScaleFactor !== expectedDensity / 160 ||
    Math.round(screen.width * screen.deviceScaleFactor) !== expectedWidth ||
    Math.round(screen.height * screen.deviceScaleFactor) !== expectedHeight
  ) {
    throw new Error('Mobile page viewport or density changed before sampling');
  }
  return structuredClone(environment);
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function singleMobileContextPage(
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>,
): Promise<Page> {
  const contexts = browser.contexts();
  if (contexts.length !== 1) {
    throw new Error('Mobile Chrome must expose exactly one CDP context');
  }
  return contexts[0].newPage();
}

function requiredLoopbackUrl(name: string): string {
  const value = requiredEnvironmentValue(name);
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be one loopback HTTP origin`);
  }
  return url.origin;
}
