/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */
/* eslint-disable playwright/no-conditional-in-test -- Live ownership and cleanup branches are the behavior under test. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fileConstants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import test from 'node:test';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const MAXIMUM_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_DIAGNOSTIC_BYTES = 32 * 1024;
const SERVER_WAIT_MS = 10_000;
const SESSION_WAIT_MS = 30_000;

const configuration = liveConfiguration();

test(
  'external WebDriver controls one exact unmodified release artifact',
  {
    skip: configuration.skipReason,
    timeout: 60_000,
  },
  async (context) => {
    const applicationBefore = await exactExecutableIdentity(
      configuration.application,
      'release application',
    );
    assert.deepEqual(
      await executablePids(configuration.application),
      [],
      'Refusing to attach while another exact release application is running',
    );
    await exactExecutableIdentity(configuration.tauriDriver, 'tauri-driver');
    await exactExecutableIdentity(
      configuration.nativeDriver,
      'native WebDriver',
    );

    const endpoint = `http://127.0.0.1:${configuration.port}`;
    assert.equal(
      await endpointAvailable(endpoint),
      false,
      `Refusing to use an existing WebDriver endpoint at ${endpoint}`,
    );

    const diagnostics = boundedDiagnostics();
    const driver = spawn(
      configuration.tauriDriver,
      [
        '--port',
        String(configuration.port),
        '--native-port',
        String(configuration.nativePort),
        '--native-driver',
        configuration.nativeDriver,
      ],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    driver.stdout.on('data', diagnostics.append);
    driver.stderr.on('data', diagnostics.append);

    let failure;
    let sessionId;
    try {
      await waitForEndpoint(endpoint, driver);
      const session = await webdriverRequest(endpoint, 'POST', '/session', {
        capabilities: {
          alwaysMatch: {
            browserName: 'wry',
            'tauri:options': { application: configuration.application },
          },
          firstMatch: [{}],
        },
      });
      sessionId = session.sessionId;
      assert.match(sessionId, /^[0-9a-f-]{16,}$/i);
      assert.equal(session.capabilities?.browserName, 'wry');

      const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
      await webdriverRequest(endpoint, 'POST', `${sessionPath}/timeouts`, {
        implicit: 0,
        pageLoad: SESSION_WAIT_MS,
        script: SESSION_WAIT_MS,
      });

      const page = await waitForScript(
        endpoint,
        sessionPath,
        `return document.readyState === 'complete' &&
          window.location.href === 'tauri://localhost/library' &&
          Boolean(window.__TAURI_INTERNALS__) &&
          document.querySelector('h1')?.textContent?.trim() === 'Library';`,
        SESSION_WAIT_MS,
        'the packaged library route',
      );
      assert.equal(page, true);
      const applicationPids = await executablePids(configuration.application);
      assert.equal(
        applicationPids.length,
        1,
        `Expected one exact release application process, found ${applicationPids.length}`,
      );

      const element = await waitForElement(
        endpoint,
        sessionPath,
        '#library-search',
        SESSION_WAIT_MS,
      );
      const elementId = element[ELEMENT_KEY];
      assert.ok(elementId, 'WebDriver did not return the search element id');
      const searchText = 'external-driver-spike';
      await webdriverRequest(
        endpoint,
        'POST',
        `${sessionPath}/element/${encodeURIComponent(elementId)}/value`,
        { text: searchText, value: [...searchText] },
      );

      const semanticResult = await waitForScript(
        endpoint,
        sessionPath,
        `const search = document.querySelector('#library-search');
         const empty = [...document.querySelectorAll('h2')]
           .some((heading) => heading.textContent?.trim() === 'No books found');
         return search?.value === arguments[0] && empty;`,
        SESSION_WAIT_MS,
        'the labelled library search action',
        [searchText],
      );
      assert.equal(semanticResult, true);

      const applicationAfter = await exactExecutableIdentity(
        configuration.application,
        'release application',
      );
      assert.deepEqual(
        applicationAfter,
        applicationBefore,
        'The release application changed while external WebDriver controlled it',
      );
      context.diagnostic(
        `controlled ${configuration.application} as pid ${applicationPids[0]} (${applicationBefore.size} bytes, sha256:${applicationBefore.sha256})`,
      );
    } catch (error) {
      failure = new Error(
        `${error instanceof Error ? error.message : String(error)}\nOwned driver diagnostics:\n${diagnostics.value()}`,
        { cause: error },
      );
    } finally {
      const cleanupErrors = [];
      if (sessionId) {
        await webdriverRequest(
          endpoint,
          'DELETE',
          `/session/${encodeURIComponent(sessionId)}`,
        ).catch((error) => cleanupErrors.push(error));
      }
      await terminateOwnedProcess(driver).catch((error) =>
        cleanupErrors.push(error),
      );
      await waitForCleanup(endpoint, configuration.application).catch((error) =>
        cleanupErrors.push(error),
      );
      if (cleanupErrors.length > 0) {
        const cleanupFailure = new AggregateError(
          cleanupErrors,
          'Owned packaged-desktop spike cleanup failed',
        );
        failure = failure
          ? new AggregateError(
              [failure, cleanupFailure],
              'Packaged-desktop spike and cleanup failed',
            )
          : cleanupFailure;
      }
    }
    if (failure) throw failure;
  },
);

function liveConfiguration() {
  const application = process.env['OMNIA_PACKAGED_DESKTOP_APPLICATION'];
  const tauriDriver = process.env['OMNIA_TAURI_DRIVER'];
  const nativeDriver = process.env['OMNIA_WEBKIT_WEBDRIVER'];
  const missing = [
    ['OMNIA_PACKAGED_DESKTOP_APPLICATION', application],
    ['OMNIA_TAURI_DRIVER', tauriDriver],
    ['OMNIA_WEBKIT_WEBDRIVER', nativeDriver],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  const skipReason =
    process.platform !== 'linux'
      ? 'external Tauri WebDriver spike is supported only on Linux'
      : missing.length > 0
        ? `UNVERIFIED: set explicit live paths: ${missing.join(', ')}`
        : undefined;

  return {
    application,
    tauriDriver,
    nativeDriver,
    port: boundedPort(process.env['OMNIA_TAURI_DRIVER_PORT'], 4444),
    nativePort: boundedPort(process.env['OMNIA_WEBKIT_WEBDRIVER_PORT'], 4445),
    skipReason,
  };
}

function boundedPort(value, fallback) {
  const port = value === undefined ? fallback : Number(value);
  assert.ok(
    Number.isSafeInteger(port) && port >= 1024 && port <= 65_535,
    `Invalid unprivileged TCP port: ${String(value)}`,
  );
  return port;
}

async function exactExecutableIdentity(path, label) {
  assert.equal(typeof path, 'string', `${label} path is required`);
  assert.ok(isAbsolute(path), `${label} path must be absolute`);
  const pathBefore = await lstat(path);
  assert.ok(pathBefore.isFile(), `${label} must be a regular file`);
  assert.equal(
    await realpath(path),
    path,
    `${label} must not be a symbolic link`,
  );
  const handle = await open(
    path,
    fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
  );
  const hash = createHash('sha256');
  let metadata;
  try {
    metadata = await handle.stat();
    assert.ok(metadata.isFile(), `${label} must be a regular file`);
    assert.ok(metadata.mode & 0o111, `${label} must be executable`);
    assert.ok(
      metadata.size > 0 && metadata.size <= MAXIMUM_ARTIFACT_BYTES,
      `${label} size is outside the bounded range`,
    );
    assert.equal(metadata.dev, pathBefore.dev, `${label} device changed`);
    assert.equal(metadata.ino, pathBefore.ino, `${label} inode changed`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  const pathAfter = await lstat(path);
  assert.equal(pathAfter.dev, metadata.dev, `${label} device changed`);
  assert.equal(pathAfter.ino, metadata.ino, `${label} inode changed`);
  assert.equal(pathAfter.size, metadata.size, `${label} size changed`);
  assert.equal(pathAfter.mtimeMs, metadata.mtimeMs, `${label} changed`);
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
    sha256: hash.digest('hex'),
  };
}

async function waitForEndpoint(endpoint, child) {
  const deadline = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`tauri-driver exited before startup (${child.exitCode})`);
    }
    if (await endpointAvailable(endpoint)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for owned tauri-driver at ${endpoint}`);
}

async function endpointAvailable(endpoint) {
  try {
    const response = await fetch(`${endpoint}/status`, {
      signal: AbortSignal.timeout(250),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForScript(
  endpoint,
  sessionPath,
  script,
  timeoutMs,
  description,
  args = [],
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await webdriverRequest(
        endpoint,
        'POST',
        `${sessionPath}/execute/sync`,
        { script, args },
      );
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${description} was not observed within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function waitForElement(endpoint, sessionPath, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await webdriverRequest(
        endpoint,
        'POST',
        `${sessionPath}/element`,
        { using: 'css selector', value: selector },
      );
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Element ${JSON.stringify(selector)} was not found within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function webdriverRequest(endpoint, method, path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(SESSION_WAIT_MS),
  });
  const responseText = await response.text();
  const payload = responseText ? JSON.parse(responseText) : { value: null };
  if (!response.ok || payload.value?.error) {
    const details = payload.value ?? payload;
    throw new Error(
      `${method} ${path} failed with HTTP ${response.status}: ${details.error ?? 'WebDriver error'}: ${details.message ?? responseText}`,
    );
  }
  return payload.value;
}

async function terminateOwnedProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (exited) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000).then(() => {
      throw new Error('Owned tauri-driver did not exit after SIGKILL');
    }),
  ]);
}

async function waitForCleanup(endpoint, application) {
  const deadline = Date.now() + 5_000;
  do {
    if (
      !(await endpointAvailable(endpoint)) &&
      (await executablePids(application)).length === 0
    ) {
      return;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(
    `Owned cleanup left endpoint=${await endpointAvailable(endpoint)} applicationPids=${JSON.stringify(await executablePids(application))}`,
  );
}

async function executablePids(executable) {
  const entries = await readdir('/proc');
  assert.ok(entries.length <= 65_536, 'Process table exceeds the bounded scan');
  const pids = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await readlink(`/proc/${entry}/exe`)) === executable) {
        pids.push(Number(entry));
      }
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !['EACCES', 'ENOENT', 'EPERM'].includes(error.code)
      ) {
        throw error;
      }
    }
  }
  return pids.sort((left, right) => left - right);
}

function boundedDiagnostics() {
  let output = '';
  return {
    append(chunk) {
      output = `${output}${String(chunk)}`.slice(-MAXIMUM_DIAGNOSTIC_BYTES);
    },
    value() {
      return output.trim() || '(no output)';
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
