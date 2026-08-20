import { expect, test, type CDPSession, type Page } from '@playwright/test';
import {
  createLargeEpubFixture,
  createLargePdfFixture,
} from './publication-fixtures';

const MAX_IMPORT_MS = 20_000;
const MAX_OPEN_MS = 15_000;
const MAX_LONG_TASK_MS = 1_000;
const MAX_TOTAL_LONG_TASK_MS = 4_000;
const MAX_RETAINED_HEAP_BYTES = 48 * 1024 * 1024;
const MAX_BACKUP_CHUNK_BYTES = 1024 * 1024;

interface StreamingSaveProbe {
  pickerCalls: number;
  suggestedName: string;
  writeCount: number;
  totalBytes: number;
  maxChunkBytes: number;
  closed: boolean;
  aborted: boolean;
  objectUrlCalls: number;
}

// This gate is opt-in because it intentionally uses larger generated
// publications, serial execution, Chromium's DevTools protocol, and hard
// latency/memory budgets.
// eslint-disable-next-line playwright/no-skipped-test
test.skip(
  process.env['PERFORMANCE_E2E'] !== '1',
  'Run the large-publication performance gate with PERFORMANCE_E2E=1',
);

test.beforeEach(async ({ browserName, page }) => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(
    browserName !== 'chromium',
    'Post-GC heap metrics require Chromium DevTools Protocol',
  );
  await installLongTaskObserver(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
});

test('keeps a 180-page PDF virtualized and releases its reader resources', async ({
  page,
}) => {
  const fixture = createLargePdfFixture();
  const session = await performanceSession(page);
  try {
    const importMs = await importPublication(
      page,
      'omnia-large-fixture.pdf',
      'application/pdf',
      fixture,
      'Omnia Large PDF Fixture',
    );
    expect(importMs).toBeLessThan(MAX_IMPORT_MS);
    const baselineHeap = await collectedHeapSize(session);
    await resetLongTasks(page);

    const openStarted = performance.now();
    await openLibraryFormat(page, 'Omnia Large PDF Fixture', 'pdf');
    await expect(
      page.locator('.pdfViewer .page[data-page-number="1"] canvas'),
    ).toBeVisible({ timeout: MAX_OPEN_MS });
    expect(performance.now() - openStarted).toBeLessThan(MAX_OPEN_MS);
    await expect(page.getByTestId('reader-page-status')).toHaveText(
      'Page 1 of 180',
    );

    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('reader-page-status')).toHaveText(
      'Page 2 of 180',
    );
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('reader-page-status')).toHaveText(
      'Page 3 of 180',
    );
    expect(await page.locator('.pdfViewer canvas').count()).toBeLessThanOrEqual(
      6,
    );

    await assertLongTaskBudget(page);
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.pdfViewer canvas')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="publication-viewport"]'),
    ).toHaveCount(0);
    await assertRetainedHeapBudget(session, baselineHeap);
  } finally {
    await session.detach();
  }
});

test('keeps an 80-chapter EPUB incremental and releases its reader resources', async ({
  page,
}) => {
  const fixture = await createLargeEpubFixture();
  expect(fixture.byteLength).toBeGreaterThan(750_000);
  const session = await performanceSession(page);
  try {
    const importMs = await importPublication(
      page,
      'omnia-large-fixture.epub',
      'application/epub+zip',
      fixture,
      'Omnia Large EPUB Fixture',
    );
    expect(importMs).toBeLessThan(MAX_IMPORT_MS);
    const baselineHeap = await collectedHeapSize(session);
    await resetLongTasks(page);

    const openStarted = performance.now();
    await openLibraryFormat(page, 'Omnia Large EPUB Fixture', 'epub');
    const viewport = page.getByTestId('publication-viewport');
    await expect(
      viewport.frameLocator('iframe').getByRole('heading', {
        name: 'Chapter 1',
      }),
    ).toBeVisible({ timeout: MAX_OPEN_MS });
    expect(performance.now() - openStarted).toBeLessThan(MAX_OPEN_MS);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    expect(await viewport.locator('iframe').count()).toBeLessThanOrEqual(2);
    await expect(
      viewport
        .frameLocator('iframe')
        .getByRole('heading', { name: 'Chapter 80' }),
    ).toHaveCount(0);

    await assertLongTaskBudget(page);
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="publication-viewport"]'),
    ).toHaveCount(0);
    await assertRetainedHeapBudget(session, baselineHeap);
  } finally {
    await session.detach();
  }
});

test('streams a large PDF and EPUB backup without assembling a final browser blob', async ({
  page,
}) => {
  const pdfFixture = createLargePdfFixture();
  const epubFixture = await createLargeEpubFixture();
  await importPublication(
    page,
    'omnia-large-backup.pdf',
    'application/pdf',
    pdfFixture,
    'Omnia Large PDF Fixture',
  );
  await importPublication(
    page,
    'omnia-large-backup.epub',
    'application/epub+zip',
    epubFixture,
    'Omnia Large EPUB Fixture',
  );
  await installStreamingSaveProbe(page);

  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Export backup' }).click();
  await expect(
    page.getByText('Backup saved with 2 publications.', { exact: true }),
  ).toBeVisible({ timeout: MAX_IMPORT_MS });

  const probe = await streamingSaveProbe(page);
  expect(probe.pickerCalls).toBe(1);
  expect(probe.suggestedName).toMatch(
    /^omnia-reader-backup-\d{4}-\d{2}-\d{2}\.omnia-backup$/,
  );
  expect(probe.writeCount).toBeGreaterThan(2);
  expect(probe.totalBytes).toBeGreaterThan(750_000);
  expect(probe.maxChunkBytes).toBeLessThanOrEqual(MAX_BACKUP_CHUNK_BYTES);
  expect(probe.closed).toBe(true);
  expect(probe.aborted).toBe(false);
  expect(probe.objectUrlCalls).toBe(0);
});

async function openLibraryFormat(
  page: Page,
  title: string,
  format: 'epub' | 'pdf',
): Promise<void> {
  await page
    .getByTestId('library-book')
    .filter({ hasText: title })
    .getByRole('button', {
      name: new RegExp(`^${format.toUpperCase()}\\b`),
    })
    .click();
}

async function importPublication(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
  expectedTitle: string,
): Promise<number> {
  const started = performance.now();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType, buffer });
  await expect(page.getByText(expectedTitle, { exact: true })).toBeVisible({
    timeout: MAX_IMPORT_MS,
  });
  return performance.now() - started;
}

async function installStreamingSaveProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: StreamingSaveProbe = {
      pickerCalls: 0,
      suggestedName: '',
      writeCount: 0,
      totalBytes: 0,
      maxChunkBytes: 0,
      closed: false,
      aborted: false,
      objectUrlCalls: 0,
    };
    const target = window as unknown as Record<string, unknown>;
    target['__omniaStreamingSave'] = probe;
    target['showSaveFilePicker'] = async (options?: {
      suggestedName?: string;
    }) => {
      probe.pickerCalls += 1;
      probe.suggestedName = options?.suggestedName ?? '';
      return {
        createWritable: async () =>
          new WritableStream<Uint8Array>({
            write(chunk) {
              probe.writeCount += 1;
              probe.totalBytes += chunk.byteLength;
              probe.maxChunkBytes = Math.max(
                probe.maxChunkBytes,
                chunk.byteLength,
              );
            },
            close() {
              probe.closed = true;
            },
            abort() {
              probe.aborted = true;
            },
          }),
      };
    };
    const createObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      if (
        object instanceof Blob &&
        object.type === 'application/vnd.omnia-reader.backup+zip'
      ) {
        probe.objectUrlCalls += 1;
      }
      return createObjectUrl(object);
    };
  });
}

async function streamingSaveProbe(page: Page): Promise<StreamingSaveProbe> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __omniaStreamingSave: StreamingSaveProbe;
        }
      ).__omniaStreamingSave,
  );
}

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const measurement = window as Window & {
      __omniaLongTasks?: number[];
    };
    measurement.__omniaLongTasks = [];
    new PerformanceObserver((entries) => {
      measurement.__omniaLongTasks?.push(
        ...entries.getEntries().map((entry) => entry.duration),
      );
    }).observe({ type: 'longtask', buffered: true });
  });
}

async function resetLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const measurement = window as Window & {
      __omniaLongTasks?: number[];
    };
    measurement.__omniaLongTasks = [];
  });
}

async function assertLongTaskBudget(page: Page): Promise<void> {
  const tasks = await page.evaluate(
    () =>
      (window as Window & { __omniaLongTasks?: number[] }).__omniaLongTasks ??
      [],
  );
  expect(Math.max(0, ...tasks)).toBeLessThan(MAX_LONG_TASK_MS);
  expect(tasks.reduce((total, duration) => total + duration, 0)).toBeLessThan(
    MAX_TOTAL_LONG_TASK_MS,
  );
}

async function performanceSession(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  return session;
}

async function collectedHeapSize(session: CDPSession): Promise<number> {
  await session.send('HeapProfiler.collectGarbage');
  const { metrics } = await session.send('Performance.getMetrics');
  return metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value ?? 0;
}

async function assertRetainedHeapBudget(
  session: CDPSession,
  baselineHeap: number,
): Promise<void> {
  const retainedHeap = await collectedHeapSize(session);
  expect(Math.max(0, retainedHeap - baselineHeap)).toBeLessThan(
    MAX_RETAINED_HEAP_BYTES,
  );
}
