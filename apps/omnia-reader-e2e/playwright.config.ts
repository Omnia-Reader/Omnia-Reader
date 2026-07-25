import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

// For CI, you may want to set BASE_URL to the deployed application.
const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';
const chromiumExecutablePath =
  process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
const webkitExecutablePath = process.env['PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH'];

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  // Reader journeys intentionally perform CPU- and memory-heavy, stateful
  // import/open/reopen flows. A single worker keeps PDF.js, EPUB iframes, and
  // browser startup from starving one another on two-core CI and developer
  // hosts; parallelism made otherwise passing setup hooks time out.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // PDF.js canvas work and EPUB iframe population can exceed Playwright's
  // five-second assertion default in WebKit when the full browser matrix is
  // running. Keep the assertion budget below the test deadline so a genuine
  // renderer stall still fails with a focused locator error.
  expect: {
    timeout: 20_000,
  },
  webServer: {
    command:
      'node tools/serve-built-app.mjs dist/apps/omnia-reader/browser 4200',
    cwd: workspaceRoot,
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
  },
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumExecutablePath
          ? { executablePath: chromiumExecutablePath }
          : undefined,
      },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        launchOptions: webkitExecutablePath
          ? { executablePath: webkitExecutablePath }
          : undefined,
      },
    },

    // Uncomment for mobile browsers support
    /* {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    }, */

    // Uncomment for branded browsers
    /* {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    } */
  ],
});
