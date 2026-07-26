import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  NATIVE_EPUB_FIXTURE,
  NATIVE_PDF_FIXTURE,
  NATIVE_PROFILE_DIRECTORIES,
  prepareNativeFixtures,
} from './native-publication-fixtures.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const ARROW_RIGHT = '\uE014';
const ARROW_UP = '\uE013';
const PORT = 44_000 + (process.pid % 10_000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const nativeBinary = resolve(
  'src-tauri',
  'target',
  'debug',
  process.platform === 'win32' ? 'omnia-reader.exe' : 'omnia-reader',
);

async function main() {
  await prepareNativeFixtures();

  const app = startNativeApp(NATIVE_PDF_FIXTURE);
  let driver;

  try {
    await waitForServer(app, 60_000);
    driver = await NativeWebDriver.connect();
    await driver.setTimeouts();

    await verifyStartupPdfJourney(driver);
    await verifySingleInstanceEpubJourney(driver);
    await verifyBookDeepLinkJourney(driver);

    console.log(
      'Native E2E passed: startup open-with, single-instance forwarding, PDF/EPUB rendering, deep-link reopening, and keyboard/button navigation.',
    );
  } catch (error) {
    const screenshotPath = join(
      tmpdir(),
      'omnia-reader-native-e2e-failure.png',
    );
    const pageDiagnostic = driver
      ? await driver
          .execute(
            `
            return {
              url: location.href,
              stylesheets: Array.from(document.styleSheets, (sheet) => sheet.href),
              styleLinks: Array.from(
                document.querySelectorAll('link[rel="stylesheet"]'),
                (link) => ({
                  href: link.href,
                  loaded: link.sheet !== null
                })
              ),
              viewportPosition: document.querySelector(
                '[data-testid="publication-viewport"]'
              )
                ? getComputedStyle(
                    document.querySelector(
                      '[data-testid="publication-viewport"]'
                    )
                  ).position
                : null,
              epubFrames: Array.from(
                document.querySelectorAll(
                  '[data-testid="publication-viewport"] iframe'
                ),
                (frame) => ({
                  src: frame.getAttribute('src'),
                  srcdocLength: frame.getAttribute('srcdoc')?.length ?? 0,
                  sandbox: frame.getAttribute('sandbox'),
                  readyState: frame.contentDocument?.readyState ?? null,
                  bodyText: frame.contentDocument?.body?.innerText?.slice(0, 500)
                    ?? null
                })
              ),
              bodyText: document.body?.innerText?.slice(0, 2_000)
            };
          `,
          )
          .catch(() => undefined)
      : undefined;
    if (driver) {
      await driver.saveScreenshot(screenshotPath).catch(() => undefined);
    }
    const nativeLog = app.output.trim();
    const diagnostic = [
      error instanceof Error ? error.stack : String(error),
      pageDiagnostic
        ? `\nPage diagnostic:\n${JSON.stringify(pageDiagnostic, null, 2)}`
        : '',
      nativeLog ? `\nNative application output:\n${nativeLog}` : '',
      driver ? `\nFailure screenshot: ${screenshotPath}` : '',
    ].join('');
    throw new Error(diagnostic, { cause: error });
  } finally {
    await driver?.close().catch(() => undefined);
    await stopProcess(app.child);
  }
}

async function verifyStartupPdfJourney(driver) {
  await driver.waitForExactText('Omnia Native PDF Fixture', 30_000);

  await driver.waitForElement(
    '.pdfViewer .page[data-page-number="1"] canvas',
    30_000,
  );
  await driver.waitForExactText('Page 1 of 2');

  await driver.key(ARROW_RIGHT);
  await driver.waitForExactText('Page 2 of 2');

  await driver.key(ARROW_UP);
  await driver.waitForExactText('Page 1 of 2');
  console.log('✓ startup PDF open-with and keyboard navigation');
}

async function verifySingleInstanceEpubJourney(driver) {
  await forwardArgumentToRunningInstance(NATIVE_EPUB_FIXTURE);
  await driver.waitForExactText('Omnia Native EPUB Fixture', 30_000);
  await verifyEpubChapter(driver, 'Native Chapter One');

  await driver.key(ARROW_RIGHT);
  await verifyEpubChapter(driver, 'Native Chapter Two');

  await driver.key(ARROW_UP);
  await verifyEpubChapter(driver, 'Native Chapter One');
  console.log('✓ single-instance EPUB forwarding, rendering, and navigation');
}

async function verifyBookDeepLinkJourney(driver) {
  const pdfBookId = createHash('sha256')
    .update(await readFile(NATIVE_PDF_FIXTURE))
    .digest('hex');
  await forwardArgumentToRunningInstance(`omnia-reader://reader/${pdfBookId}`);
  await driver.waitForExactText('Omnia Native PDF Fixture', 30_000);
  await driver.waitForElement(
    '.pdfViewer .page[data-page-number="1"] canvas',
    30_000,
  );
  await driver.waitForExactText('Page 1 of 2');
  console.log('✓ exact-edition deep link reopened the existing PDF');
}

async function verifyEpubChapter(driver, expectedHeading) {
  await driver.waitForElement(
    '[data-testid="publication-viewport"] iframe',
    30_000,
  );
  await driver.waitForScript(
    `
      const frame = document.querySelector(
        '[data-testid="publication-viewport"] iframe'
      );
      return frame?.contentDocument?.querySelector('h1')
        ?.textContent?.trim() === arguments[0];
    `,
    [expectedHeading],
    30_000,
    `EPUB heading ${JSON.stringify(expectedHeading)}`,
  );
}

function startNativeApp(publicationPath) {
  let output = '';
  const child = spawn(nativeBinary, [publicationPath], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      XDG_CACHE_HOME: NATIVE_PROFILE_DIRECTORIES.cache,
      XDG_CONFIG_HOME: NATIVE_PROFILE_DIRECTORIES.config,
      XDG_DATA_HOME: NATIVE_PROFILE_DIRECTORIES.data,
      GSETTINGS_BACKEND: 'memory',
      TAURI_WEBDRIVER_PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return {
    child,
    get output() {
      return output;
    },
  };
}

async function waitForServer(app, timeout) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) {
      throw new Error(
        `Native application exited before WebDriver started with code ${app.child.exitCode}.\n${app.output}`,
      );
    }
    try {
      const response = await fetch(`${SERVER_URL}/status`);
      if (response.ok) {
        return;
      }
      lastError = new Error(
        `WebDriver status returned HTTP ${response.status}`,
      );
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(
    `Embedded WebDriver did not start within ${timeout}ms: ${String(lastError)}`,
  );
}

async function forwardArgumentToRunningInstance(argument) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(nativeBinary, [argument], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        XDG_CACHE_HOME: NATIVE_PROFILE_DIRECTORIES.cache,
        XDG_CONFIG_HOME: NATIVE_PROFILE_DIRECTORIES.config,
        XDG_DATA_HOME: NATIVE_PROFILE_DIRECTORIES.data,
        GSETTINGS_BACKEND: 'memory',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error('The second native instance did not exit after forwarding'),
      );
    }, 20_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `The second native instance exited with ${code ?? signal}: ${output}`,
        ),
      );
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

class NativeWebDriver {
  constructor(sessionId) {
    this.sessionId = sessionId;
  }

  static async connect() {
    const value = await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {},
        firstMatch: [{}],
      },
    });
    assert.ok(value.sessionId, 'WebDriver did not return a session identifier');
    return new NativeWebDriver(value.sessionId);
  }

  async setTimeouts() {
    await this.command('POST', '/timeouts', {
      implicit: 0,
      pageLoad: 30_000,
      script: 30_000,
    });
  }

  async waitForElement(selector, timeout = 20_000, using = 'css selector') {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const element = await this.find(selector, using);
        if (await this.displayed(element)) {
          return element;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(
      `Element ${JSON.stringify(selector)} was not displayed within ${timeout}ms${lastError ? `: ${String(lastError)}` : ''}`,
    );
  }

  async waitForExactText(text, timeout = 30_000) {
    return this.waitForElement(
      `//*[normalize-space()=${xpathLiteral(text)}]`,
      timeout,
      'xpath',
    );
  }

  async waitForScript(script, args, timeout, description) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (await this.execute(script, args)) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(
      `${description} was not observed within ${timeout}ms${lastError ? `: ${String(lastError)}` : ''}`,
    );
  }

  async find(selector, using = 'css selector') {
    const value = await this.command('POST', '/element', {
      using,
      value: selector,
    });
    const elementId = value?.[ELEMENT_KEY];
    assert.ok(elementId, `No WebDriver element id for ${selector}`);
    return elementId;
  }

  async displayed(elementId) {
    return this.command(
      'GET',
      `/element/${encodeURIComponent(elementId)}/displayed`,
    );
  }

  async text(elementId) {
    return this.command(
      'GET',
      `/element/${encodeURIComponent(elementId)}/text`,
    );
  }

  async click(elementId) {
    await this.command(
      'POST',
      `/element/${encodeURIComponent(elementId)}/click`,
      {},
    );
  }

  async key(value) {
    await this.command('POST', '/actions', {
      actions: [
        {
          type: 'key',
          id: 'native-keyboard',
          actions: [
            { type: 'keyDown', value },
            { type: 'keyUp', value },
          ],
        },
      ],
    });
    await this.command('DELETE', '/actions');
  }

  async saveScreenshot(path) {
    const value = await this.command('GET', '/screenshot');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(value, 'base64'));
  }

  execute(script, args = []) {
    return this.command('POST', '/execute/sync', { script, args });
  }

  async close() {
    await request('DELETE', `/session/${encodeURIComponent(this.sessionId)}`);
  }

  command(method, path, body) {
    return request(
      method,
      `/session/${encodeURIComponent(this.sessionId)}${path}`,
      body,
    );
  }
}

async function request(method, path, body) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseText = await response.text();
  const payload = responseText ? JSON.parse(responseText) : { value: null };
  if (!response.ok || payload.value?.error) {
    const error = payload.value ?? payload;
    throw new Error(
      `${method} ${path} failed with HTTP ${response.status}: ${error.error ?? 'WebDriver error'}: ${error.message ?? responseText}`,
    );
  }
  return payload.value;
}

function xpathLiteral(value) {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(`, "'", `)})`;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

await main();
