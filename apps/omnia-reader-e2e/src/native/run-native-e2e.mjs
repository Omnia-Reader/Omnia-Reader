import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
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
const execFileAsync = promisify(execFile);
const packagedDesktopFile = process.env['OMNIA_NATIVE_DESKTOP_FILE'];
const useDesktopActivation = packagedDesktopFile !== undefined;
const nativeBinary = process.env['OMNIA_NATIVE_BINARY']
  ? resolve(process.env['OMNIA_NATIVE_BINARY'])
  : resolve(
      'src-tauri',
      'target',
      'debug',
      process.platform === 'win32' ? 'omnia-reader.exe' : 'omnia-reader',
    );

async function main() {
  await prepareNativeFixtures();
  if (packagedDesktopFile) {
    await configurePackagedDesktopActivation(packagedDesktopFile);
  }

  let app = startNativeApp(NATIVE_PDF_FIXTURE);
  let driver;

  try {
    await waitForServer(app, 60_000);
    driver = await NativeWebDriver.connect();
    await driver.setTimeouts();

    await verifyStartupPdfJourney(driver);
    await verifySingleInstanceEpubJourney(driver);
    const pdf = await verifyBookDeepLinkJourney(driver);
    await verifyHardTerminationResume(driver, pdf);
    await killProcess(app.child);
    driver = undefined;

    app = startNativeApp(pdf.deepLink);
    await waitForServer(app, 60_000);
    driver = await NativeWebDriver.connect();
    await driver.setTimeouts();
    await verifyRestoredPdfJourney(driver);

    console.log(
      `Native E2E passed: startup open-with, ${
        useDesktopActivation
          ? 'installed desktop activation'
          : 'single-instance forwarding'
      }, PDF/EPUB rendering, deep-link reopening, keyboard/button navigation, and hard-termination progress restoration.`,
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
  const digest = createHash('sha256')
    .update(await readFile(NATIVE_PDF_FIXTURE))
    .digest('hex');
  const bookId = `sha256:${digest}`;
  const deepLink = `omnia-reader://reader/${digest}`;
  await forwardArgumentToRunningInstance(deepLink);
  await driver.waitForExactText('Omnia Native PDF Fixture', 30_000);
  await driver.waitForElement(
    '.pdfViewer .page[data-page-number="1"] canvas',
    30_000,
  );
  await driver.waitForExactText('Page 1 of 2');
  console.log('✓ exact-edition deep link reopened the existing PDF');
  return { bookId, deepLink };
}

async function verifyHardTerminationResume(driver, pdf) {
  await driver.key(ARROW_RIGHT);
  await driver.waitForExactText('Page 2 of 2');
  await driver.waitForAsyncScript(
    `
      const [bookId, expectedPage, done] = arguments;
      const readStore = (databaseName, storeName) =>
        new Promise((resolve, reject) => {
          const openRequest = indexedDB.open(databaseName);
          openRequest.addEventListener('error', () =>
            reject(openRequest.error ?? new Error('Unable to open IndexedDB'))
          );
          openRequest.addEventListener('success', () => {
            const database = openRequest.result;
            const request = database
              .transaction(storeName, 'readonly')
              .objectStore(storeName)
              .getAll();
            request.addEventListener('success', () => {
              database.close();
              resolve(request.result);
            });
            request.addEventListener('error', () => {
              database.close();
              reject(request.error ?? new Error('Unable to read IndexedDB'));
            });
          });
        });

      Promise.all([
        readStore('omnia-reader', 'progress'),
        readStore('omnia-reader-sync', 'operations')
      ]).then(([progressRecords, operations]) => {
        const progress = progressRecords.find(
          (record) => record?.bookId === bookId
        );
        const localPage = progress?.locator?.locations?.position;
        const journaled = operations.some(
          (operation) =>
            operation?.entity === 'progress' &&
            operation?.entityId === bookId &&
            operation?.payload?.locator?.locations?.position === expectedPage
        );
        done(localPage === expectedPage && journaled);
      }, () => done(false));
    `,
    [pdf.bookId, 2],
    30_000,
    'durable PDF page-two progress and sync journal entry',
  );
  console.log('✓ page-two progress and pending sync work are durable');
}

async function verifyRestoredPdfJourney(driver) {
  await driver.waitForExactText('Omnia Native PDF Fixture', 30_000);
  await driver.waitForElement(
    '.pdfViewer .page[data-page-number="2"] canvas',
    30_000,
  );
  await driver.waitForExactText('Page 2 of 2');
  console.log('✓ hard-killed native process restored the exact PDF page');
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
    env: nativeEnvironment({ TAURI_WEBDRIVER_PORT: String(PORT) }),
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
  if (useDesktopActivation) {
    const target = argument.startsWith('omnia-reader:')
      ? argument
      : pathToFileURL(argument).href;
    await execFileAsync('gio', ['open', target], {
      env: nativeEnvironment(),
      timeout: 20_000,
    });
    return;
  }

  await new Promise((resolvePromise, reject) => {
    const child = spawn(nativeBinary, [argument], {
      cwd: resolve('.'),
      env: nativeEnvironment(),
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

async function configurePackagedDesktopActivation(desktopFile) {
  assert.equal(
    process.platform,
    'linux',
    'Packaged desktop activation is Linux-specific',
  );
  const source = resolve(desktopFile);
  const contents = await readFile(source, 'utf8');
  assert.match(contents, /^Exec=omnia-reader %U$/m);
  assert.match(
    contents,
    /^MimeType=application\/epub\+zip;application\/pdf;x-scheme-handler\/omnia-reader;$/m,
  );

  const applicationsDirectory = join(
    NATIVE_PROFILE_DIRECTORIES.data,
    'applications',
  );
  await mkdir(applicationsDirectory, { recursive: true, mode: 0o700 });
  const desktopName = basename(source);
  await copyFile(source, join(applicationsDirectory, desktopName));

  const environment = nativeEnvironment();
  await execFileAsync('update-desktop-database', [applicationsDirectory], {
    env: environment,
  });
  for (const mimeType of [
    'application/epub+zip',
    'application/pdf',
    'x-scheme-handler/omnia-reader',
  ]) {
    await execFileAsync('xdg-mime', ['default', desktopName, mimeType], {
      env: environment,
    });
    const { stdout } = await execFileAsync(
      'xdg-mime',
      ['query', 'default', mimeType],
      { env: environment },
    );
    assert.equal(stdout.trim(), desktopName);
  }
  console.log('✓ packaged Linux desktop MIME and protocol registration');
}

function nativeEnvironment(overrides = {}) {
  return {
    ...process.env,
    PATH: `${dirname(nativeBinary)}:${process.env['PATH'] ?? ''}`,
    XDG_CACHE_HOME: NATIVE_PROFILE_DIRECTORIES.cache,
    XDG_CONFIG_HOME: NATIVE_PROFILE_DIRECTORIES.config,
    XDG_DATA_HOME: NATIVE_PROFILE_DIRECTORIES.data,
    GSETTINGS_BACKEND: 'memory',
    ...overrides,
  };
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

async function killProcess(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(10_000).then(() => {
      throw new Error('Native application did not exit after a hard kill');
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

  async waitForAsyncScript(script, args, timeout, description) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (await this.executeAsync(script, args)) {
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

  executeAsync(script, args = []) {
    return this.command('POST', '/execute/async', { script, args });
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
if (process.env['OMNIA_NATIVE_SYNC_E2E'] === '1') {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['apps/omnia-reader-e2e/src/native/run-native-sync-e2e.mjs'],
    {
      cwd: resolve('.'),
      env: nativeEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}
