/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import {
  PageMeasurementError,
  assertPageMeasurementSpec,
  isPageMeasurementError,
  measurePageAction,
} from './page-measurement.mjs';

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

test('measures activation through painted acknowledgement and final state', async () => {
  await page.setContent(`
    <button id="activate">Start</button>
    <p id="status" data-state="idle">Idle</p>
    <script>
      document.querySelector('#activate').addEventListener('click', () => {
        const status = document.querySelector('#status');
        status.dataset.state = 'busy';
        status.textContent = 'Working';
        setTimeout(() => {
          status.dataset.state = 'done';
          status.textContent = 'Complete';
        }, 25);
      });
    </script>
  `);

  const result = await measurePageAction(page, measurementSpec(), () =>
    page.locator('#activate').click(),
  );

  assert.equal(result.activationEvent, 'click');
  assert.ok(result.acknowledgementMs >= 0);
  assert.ok(result.finalResultMs >= result.acknowledgementMs);
  assert.ok(result.finalResultMs < 2_000);
});

test('waits for a semantic state to become visible and paint eligible', async () => {
  await page.setContent(`
    <button id="activate">Start</button>
    <p id="ack" data-state="busy" hidden>Working</p>
    <p id="final" data-state="done" hidden>Complete</p>
    <script>
      document.querySelector('#activate').addEventListener('click', () => {
        requestAnimationFrame(() => {
          document.querySelector('#ack').hidden = false;
          setTimeout(() => {
            document.querySelector('#final').hidden = false;
          }, 20);
        });
      });
    </script>
  `);

  const result = await measurePageAction(
    page,
    {
      activation: { event: 'click', selector: '#activate' },
      acknowledgement: { selector: '#ack[data-state="busy"]' },
      finalState: { selector: '#final[data-state="done"]' },
      timeoutMs: 2_000,
    },
    () => page.locator('#activate').click(),
  );

  assert.ok(result.acknowledgementMs > 0);
  assert.ok(result.finalResultMs >= result.acknowledgementMs);
});

test('captures change activation from a detached file-picker input', async () => {
  await page.setContent(`
    <button id="activate">Choose file</button>
    <p id="status" data-state="idle">Idle</p>
    <script>
      document.querySelector('#activate').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.addEventListener('change', () => {
          const status = document.querySelector('#status');
          status.dataset.state = 'busy';
          setTimeout(() => { status.dataset.state = 'done'; }, 25);
        });
        input.click();
      });
    </script>
  `);
  const chooserPromise = page.waitForEvent('filechooser');
  const resultPromise = measurePageAction(
    page,
    {
      activation: { event: 'change', selector: 'input[type="file"]' },
      acknowledgement: { selector: '#status[data-state="busy"]' },
      finalState: { selector: '#status[data-state="done"]' },
      timeoutMs: 2_000,
    },
    async () => {
      await page.locator('#activate').click();
      const chooser = await chooserPromise;
      await chooser.setFiles({
        name: 'detached.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('detached picker'),
      });
    },
  );

  const result = await resultPromise;
  assert.equal(result.activationEvent, 'change');
  assert.ok(result.finalResultMs >= result.acknowledgementMs);
});

test('removes detached file-picker listeners when change never fires', async () => {
  await page.setContent(`
    <button id="activate">Choose file</button>
    <p id="status" data-state="idle">Idle</p>
    <script>
      window.detachedListenerCounts = { added: 0, removed: 0 };
      document.querySelector('#activate').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        const nativeAdd = input.addEventListener.bind(input);
        const nativeRemove = input.removeEventListener.bind(input);
        input.addEventListener = (...args) => {
          window.detachedListenerCounts.added += 1;
          nativeAdd(...args);
        };
        input.removeEventListener = (...args) => {
          window.detachedListenerCounts.removed += 1;
          nativeRemove(...args);
        };
        input.click();
      });
    </script>
  `);
  const chooserPromise = page.waitForEvent('filechooser');
  await assert.rejects(
    measurePageAction(
      page,
      {
        activation: { event: 'change', selector: 'input[type="file"]' },
        acknowledgement: { selector: '#status[data-state="busy"]' },
        finalState: { selector: '#status[data-state="done"]' },
        timeoutMs: 100,
      },
      async () => {
        await page.locator('#activate').click();
        await chooserPromise;
      },
    ),
    (error) =>
      error instanceof PageMeasurementError &&
      /timed out before activation/.test(error.message),
  );
  assert.deepEqual(await page.evaluate(() => window.detachedListenerCounts), {
    added: 1,
    removed: 1,
  });
});

test('fails closed on missing activation, acknowledgement, or final state', async () => {
  await page.setContent('<button id="activate">No state change</button>');

  await assert.rejects(
    measurePageAction(page, { ...measurementSpec(), timeoutMs: 100 }, () =>
      page.locator('#activate').click(),
    ),
    (error) =>
      error instanceof PageMeasurementError &&
      /timed out before acknowledgement and final state/.test(error.message),
  );

  await assert.rejects(
    measurePageAction(page, { ...measurementSpec(), timeoutMs: 100 }, () =>
      Promise.resolve(),
    ),
    (error) =>
      error instanceof PageMeasurementError &&
      /timed out before activation/.test(error.message),
  );
});

test('page timeout wins over a blocked Playwright activation', async () => {
  await page.setContent('<button id="activate">Available control</button>');
  const started = Date.now();
  await assert.rejects(
    measurePageAction(page, { ...measurementSpec(), timeoutMs: 100 }, () =>
      page.locator('#never-exists').click({ timeout: 2_000 }),
    ),
    (error) =>
      error instanceof PageMeasurementError &&
      /timed out before activation/.test(error.message),
  );
  assert.ok(Date.now() - started < 1_000);
});

test('cleans page observers after success, timeout, and activation failure', async () => {
  await page.setContent(`
    <button id="activate">Start</button>
    <p id="status" data-state="idle">Idle</p>
    <script>
      document.querySelector('#activate').addEventListener('click', () => {
        const status = document.querySelector('#status');
        status.dataset.state = 'busy';
        setTimeout(() => { status.dataset.state = 'done'; }, 25);
      });
    </script>
  `);
  await measurePageAction(page, measurementSpec(), () =>
    page.locator('#activate').click(),
  );
  assert.equal(await measurementStateExists(), false);

  await page.setContent('<button id="activate">No state change</button>');
  await assert.rejects(
    measurePageAction(page, { ...measurementSpec(), timeoutMs: 100 }, () =>
      page.locator('#activate').click(),
    ),
    PageMeasurementError,
  );
  assert.equal(await measurementStateExists(), false);

  await assert.rejects(
    measurePageAction(page, measurementSpec(), () => {
      throw new Error('activation failed');
    }),
    /activation failed/,
  );
  assert.equal(await measurementStateExists(), false);
});

test('rejects unsafe, unknown, or out-of-bound measurement specs', () => {
  const valid = measurementSpec();
  assert.equal(assertPageMeasurementSpec(valid), valid);
  for (const candidate of [
    { ...measurementSpec(), unknown: true },
    { ...measurementSpec(), timeoutMs: 0 },
    { ...measurementSpec(), timeoutMs: 60_001 },
    {
      ...measurementSpec(),
      activation: { event: 'mouseover', selector: '#activate' },
    },
    {
      ...measurementSpec(),
      acknowledgement: { selector: `#${'a'.repeat(2_048)}` },
    },
    {
      ...measurementSpec(),
      finalState: { selector: '#final\0' },
    },
  ]) {
    assert.throws(() => assertPageMeasurementSpec(candidate));
  }
});

test('recognizes page measurement failures through bounded diagnostic causes', () => {
  const failure = new PageMeasurementError('missing acknowledgement');
  assert.equal(isPageMeasurementError(failure), true);
  assert.equal(
    isPageMeasurementError(
      new Error('branch diagnostic', {
        cause: new Error('adapter diagnostic', { cause: failure }),
      }),
    ),
    true,
  );
  assert.equal(isPageMeasurementError(new Error('wrong result')), false);

  const cyclic = new Error('cyclic diagnostic');
  cyclic.cause = cyclic;
  assert.equal(isPageMeasurementError(cyclic), false);
});

function measurementSpec() {
  return {
    activation: { event: 'click', selector: '#activate' },
    acknowledgement: { selector: '#status[data-state="busy"]' },
    finalState: { selector: '#status[data-state="done"]' },
    timeoutMs: 2_000,
  };
}

async function measurementStateExists() {
  return page.evaluate(() => Object.hasOwn(window, '__omniaPageMeasurementV1'));
}
