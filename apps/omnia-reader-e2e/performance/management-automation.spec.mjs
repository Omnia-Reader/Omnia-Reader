/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */
/* eslint-disable playwright/no-conditional-in-test -- Protocol fixtures route deterministic command variants. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { connectExternalTauriAutomation } from './management-automation.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

test('drives semantic controls through one bounded external Tauri session', async () => {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/session') {
      return {
        sessionId: 'session-1',
        capabilities: {
          browserName: 'wry',
          browserVersion: '0.55.1',
          platformName: 'linux',
        },
      };
    }
    if (path.endsWith('/element')) return { [ELEMENT_KEY]: 'element-1' };
    if (path.endsWith('/execute/sync')) return true;
    return null;
  };

  const automation = await connectExternalTauriAutomation({
    endpoint: 'http://127.0.0.1:4444',
    applicationPath: '/owned/omnia-reader.AppImage',
    request,
  });
  await automation.assertLibraryReady();
  await automation.fill('#library-search', 'external-driver-spike');
  assert.equal(
    await automation.waitForScript(
      'return document.querySelector(arguments[0])?.value === arguments[1]',
      ['#library-search', 'external-driver-spike'],
      { timeoutMs: 100, description: 'search result' },
    ),
    true,
  );
  await automation.close();
  await automation.close();

  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/session',
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: 'wry',
          'tauri:options': { application: '/owned/omnia-reader.AppImage' },
        },
        firstMatch: [{}],
      },
    },
  });
  assert.equal(
    calls.filter(
      ({ method, path }) =>
        method === 'DELETE' && path === '/session/session-1',
    ).length,
    1,
  );
});

test('rejects non-loopback endpoints and unsafe application paths', async () => {
  for (const options of [
    {
      endpoint: 'http://example.com:4444',
      applicationPath: '/owned/omnia-reader.AppImage',
    },
    {
      endpoint: 'http://127.0.0.1:4444',
      applicationPath: 'relative.AppImage',
    },
  ]) {
    await assert.rejects(
      connectExternalTauriAutomation({
        ...options,
        request: async () => assert.fail('request must not run'),
      }),
      /loopback|absolute/,
    );
  }
});

test('closes a created session when capability or timeout setup fails', async () => {
  for (const failure of ['capability', 'timeouts']) {
    const deletes = [];
    await assert.rejects(
      connectExternalTauriAutomation({
        endpoint: 'http://127.0.0.1:4444',
        applicationPath: '/owned/omnia-reader.AppImage',
        request: async (method, path) => {
          if (method === 'DELETE') {
            deletes.push(path);
            return null;
          }
          if (path === '/session') {
            return {
              sessionId: 'session-1',
              capabilities: {
                browserName: failure === 'capability' ? 'chrome' : 'wry',
              },
            };
          }
          throw new Error('timeout setup failed');
        },
      }),
      /browserName wry|timeout setup failed/,
    );
    assert.deepEqual(deletes, ['/session/session-1']);
  }
});

test('bounds selectors, scripts, arguments, responses, and waits', async () => {
  let response = {
    sessionId: 'session-1',
    capabilities: { browserName: 'wry' },
  };
  const automation = await connectExternalTauriAutomation({
    endpoint: 'http://127.0.0.1:4444',
    applicationPath: '/owned/omnia-reader.AppImage',
    request: async () => response,
  });
  await assert.rejects(automation.find('x'.repeat(4_097)), /selector/);
  await assert.rejects(automation.execute('x'.repeat(65_537)), /script/);
  await assert.rejects(
    automation.execute('return arguments[0]', ['x'.repeat(65_537)]),
    /arguments/,
  );
  response = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(automation.execute('return true'), /response/);
  await assert.rejects(
    automation.waitForScript('return false', [], {
      timeoutMs: 0,
      description: 'invalid wait',
    }),
    /timeout/,
  );
});

test('times out a semantic wait without leaking unbounded diagnostics', async () => {
  const automation = await connectExternalTauriAutomation({
    endpoint: 'http://127.0.0.1:4444',
    applicationPath: '/owned/omnia-reader.AppImage',
    request: async (method, path) =>
      path === '/session'
        ? { sessionId: 'session-1', capabilities: { browserName: 'wry' } }
        : false,
  });
  await assert.rejects(
    automation.waitForScript('return false', [], {
      timeoutMs: 25,
      description: 'bounded semantic state',
    }),
    /bounded semantic state.*25ms/,
  );
});
