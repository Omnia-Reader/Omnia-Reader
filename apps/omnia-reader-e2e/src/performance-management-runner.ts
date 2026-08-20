import { expect, type Page } from '@playwright/test';
import {
  createManagementSampleFixture,
  prepareManagementBranchDataset,
  seedManagementDataset,
} from '../performance/management-dataset.mjs';
import { isPageMeasurementError } from '../performance/page-measurement.mjs';
import { runPrimaryManagementMeasurement } from '../performance/primary-management-run.mjs';
import {
  createManagementRestoreBackup,
  runManagementBranchSample,
} from './management-branch-driver';
import { runManagementDistributionSample } from './management-distribution-driver';

interface ManagementRunnerOptions {
  page: Page;
  profileSet: unknown;
  environment: unknown;
  workload: unknown;
  captureSamplingIdentity: (page: Page) => Promise<unknown>;
  applicationUrl: string;
  command: string;
}

export async function runPerformanceManagementWorkload({
  page,
  profileSet,
  environment,
  workload,
  captureSamplingIdentity,
  applicationUrl,
  command,
}: ManagementRunnerOptions) {
  const consoleErrors: string[] = [];
  let missingAcknowledgements = 0;
  let wrongResults = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await installOverlapCounter(page);

  await page.goto(applicationUrl);
  await seedManagementDataset(page, workload);
  const fixtures = await prepareManagementBranchDataset(page, workload);
  const distributionFixture = await createManagementSampleFixture(
    workload,
    900,
  );
  const backup = await createManagementRestoreBackup(
    fixtures['detach-failure'][0],
  );
  await page.reload();
  await expect(page.getByTestId('library-book')).toHaveCount(1_040, {
    timeout: 60_000,
  });
  const samplingIdentity = await captureSamplingIdentity(page);

  const counted = async <Result>(operation: () => Promise<Result>) => {
    try {
      return await operation();
    } catch (error) {
      const missingAcknowledgement = isPageMeasurementError(error);
      missingAcknowledgements += Number(missingAcknowledgement);
      wrongResults += Number(!missingAcknowledgement);
      throw error;
    }
  };
  return runPrimaryManagementMeasurement({
    profileSet,
    environment,
    workload,
    samplingIdentity,
    command,
    runBranchSample: ({ branch, sampleIndex }) =>
      counted(() =>
        runManagementBranchSample(
          page,
          branch,
          fixtures[branch.id][sampleIndex],
          backup,
        ),
      ),
    runDistributionSample: ({ distribution }) =>
      counted(() =>
        runManagementDistributionSample(
          page,
          distribution,
          distributionFixture,
        ),
      ),
    readCounters: async () => ({
      consoleErrors: consoleErrors.length,
      missingAcknowledgements,
      overlappingEngines: await readOverlapCounter(page),
      wrongResults,
    }),
  });
}

async function installOverlapCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storageKey = 'omnia.performance.overlapping-engines';
    const start = () => {
      let overlapping = false;
      const inspect = () => {
        const current =
          document.querySelector(
            '[data-testid="publication-viewport"] iframe',
          ) !== null && document.querySelector('.pdfViewer canvas') !== null;
        if (current && !overlapping) {
          const count = Number(sessionStorage.getItem(storageKey) ?? '0');
          sessionStorage.setItem(storageKey, String(count + 1));
        }
        overlapping = current;
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      inspect();
    };
    if (document.documentElement) start();
    else addEventListener('DOMContentLoaded', start, { once: true });
  });
}

function readOverlapCounter(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(
      sessionStorage.getItem('omnia.performance.overlapping-engines') ?? '0',
    ),
  );
}
