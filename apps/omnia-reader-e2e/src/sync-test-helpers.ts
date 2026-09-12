import { expect, type Page } from '@playwright/test';
import { isExpectedPublicationSecurityConsoleMessage } from './browser-failure-helpers';

export async function selectSyncProvider(
  page: Page,
  providerButtonName: RegExp,
): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Library sync', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: providerButtonName }).click();
  await expect(
    page.getByRole('button', { name: 'Sync books and progress' }),
  ).toBeEnabled();
}

export async function importSyncPublication(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
  expectedTitle: string,
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType, buffer });
  await expect(page.getByText(expectedTitle, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
}

export function monitorSyncBrowserFailures(page: Page): () => string[] {
  const consoleFailures: string[] = [];
  const pageFailures: string[] = [];
  const expectedGatewayFailures: number[] = [];
  page.on('response', (response) => {
    if (response.status() < 400) {
      return;
    }
    if (response.url().includes('/api/sync/')) {
      expectedGatewayFailures.push(response.status());
      return;
    }
    pageFailures.push(`response: ${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleFailures.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageFailures.push(`page: ${error.message}`));
  return () => {
    const observedGatewayFailures = [...expectedGatewayFailures];
    return [
      ...consoleFailures
        .filter(
          (failure) =>
            !isExpectedPublicationSecurityConsoleMessage(failure) &&
            !isExpectedGatewayFailure(failure, observedGatewayFailures),
        )
        .map((failure) => `console: ${failure}`),
      ...pageFailures,
    ];
  };
}

function isExpectedGatewayFailure(
  consoleFailure: string,
  expectedFailures: number[],
): boolean {
  const match = consoleFailure.match(
    /^Failed to load resource: the server responded with a status of (\d+)/,
  );
  const status = match ? Number(match[1]) : null;
  const expected = expectedFailures.some(
    (expectedStatus) => status === null || expectedStatus === status,
  );
  return (
    expected &&
    (status !== null || consoleFailure === 'Failed to load resource')
  );
}
