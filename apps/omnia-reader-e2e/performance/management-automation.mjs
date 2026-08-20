import { isAbsolute } from 'node:path';
import {
  EvidenceValidationError,
  assertExactKeys,
  assertRecord,
  assertSafeInteger,
  assertString,
} from './performance-contract.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const MAXIMUM_SCRIPT_BYTES = 64 * 1024;
const MAXIMUM_ARGUMENT_BYTES = 64 * 1024;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export async function connectExternalTauriAutomation(options) {
  assertRecord(options, 'options');
  assertExactKeys(
    options,
    [
      'endpoint',
      'applicationPath',
      ...(Object.hasOwn(options, 'request') ? ['request'] : []),
    ],
    'options',
  );
  const endpoint = assertLoopbackEndpoint(options.endpoint);
  const applicationPath = assertString(
    options.applicationPath,
    1,
    4_096,
    'options.applicationPath',
  );
  if (!isAbsolute(applicationPath)) {
    throw new EvidenceValidationError(
      'must be an absolute application path',
      'options.applicationPath',
    );
  }
  const request = options.request ?? createWebDriverRequest(endpoint);
  if (typeof request !== 'function') {
    throw new EvidenceValidationError('must be a function', 'options.request');
  }

  const session = assertBoundedResponse(
    await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'wry',
          'tauri:options': { application: applicationPath },
        },
        firstMatch: [{}],
      },
    }),
  );
  assertRecord(session, 'webdriver.session');
  const sessionId = assertString(
    session.sessionId,
    1,
    256,
    'webdriver.sessionId',
  );
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new EvidenceValidationError(
      'contains unsafe characters',
      'webdriver.sessionId',
    );
  }
  assertRecord(session.capabilities, 'webdriver.capabilities');
  if (session.capabilities.browserName !== 'wry') {
    await request('DELETE', `/session/${encodeURIComponent(sessionId)}`).catch(
      () => undefined,
    );
    throw new EvidenceValidationError(
      'external session must report browserName wry',
      'webdriver.capabilities.browserName',
    );
  }
  const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
  try {
    await boundedRequest(request, 'POST', `${sessionPath}/timeouts`, {
      implicit: 0,
      pageLoad: REQUEST_TIMEOUT_MS,
      script: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    await request('DELETE', sessionPath).catch(() => undefined);
    throw error;
  }
  let closePromise;

  const automation = {
    endpoint,
    sessionId,
    capabilities: session.capabilities,
    async execute(script, args = []) {
      assertBoundedText(script, MAXIMUM_SCRIPT_BYTES, 'script');
      assertBoundedJson(args, MAXIMUM_ARGUMENT_BYTES, 'arguments');
      return boundedRequest(request, 'POST', `${sessionPath}/execute/sync`, {
        script,
        args,
      });
    },
    async find(selector) {
      assertBoundedText(selector, 4_096, 'selector');
      const element = await boundedRequest(
        request,
        'POST',
        `${sessionPath}/element`,
        { using: 'css selector', value: selector },
      );
      assertRecord(element, 'webdriver.element');
      return assertString(element[ELEMENT_KEY], 1, 256, 'webdriver.element.id');
    },
    async click(selector) {
      const elementId = await automation.find(selector);
      await boundedRequest(
        request,
        'POST',
        `${sessionPath}/element/${encodeURIComponent(elementId)}/click`,
        {},
      );
    },
    async fill(selector, value) {
      assertBoundedText(value, 16_384, 'value');
      const elementId = await automation.find(selector);
      const elementPath = `${sessionPath}/element/${encodeURIComponent(elementId)}`;
      await boundedRequest(request, 'POST', `${elementPath}/clear`, {});
      await boundedRequest(request, 'POST', `${elementPath}/value`, {
        text: value,
        value: [...value],
      });
    },
    async waitForScript(script, args, waitOptions) {
      assertRecord(waitOptions, 'waitOptions');
      assertExactKeys(waitOptions, ['timeoutMs', 'description'], 'waitOptions');
      assertSafeInteger(
        waitOptions.timeoutMs,
        1,
        60_000,
        'waitOptions.timeoutMs',
      );
      const description = assertString(
        waitOptions.description,
        1,
        512,
        'waitOptions.description',
      );
      const deadline = Date.now() + waitOptions.timeoutMs;
      let lastError;
      do {
        try {
          const value = await automation.execute(script, args);
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        await delay(25);
      } while (Date.now() < deadline);
      throw new Error(
        `${description} was not observed within ${waitOptions.timeoutMs}ms${lastError ? `: ${boundedMessage(lastError)}` : ''}`,
      );
    },
    async assertLibraryReady() {
      return automation.waitForScript(
        `return document.readyState === 'complete' &&
          window.location.href === 'tauri://localhost/library' &&
          Boolean(window.__TAURI_INTERNALS__) &&
          document.querySelector('h1')?.textContent?.trim() === 'Library';`,
        [],
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          description: 'packaged library route',
        },
      );
    },
    async close() {
      closePromise ??= boundedRequest(request, 'DELETE', sessionPath);
      return closePromise;
    },
  };
  return automation;
}

export function createWebDriverRequest(endpointInput) {
  const endpoint = assertLoopbackEndpoint(endpointInput);
  return async (method, path, body) => {
    if (!['GET', 'POST', 'DELETE'].includes(method)) {
      throw new EvidenceValidationError(
        'must be GET, POST, or DELETE',
        'webdriver.method',
      );
    }
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > 4_096
    ) {
      throw new EvidenceValidationError(
        'must be one bounded absolute command path',
        'webdriver.path',
      );
    }
    if (body !== undefined) {
      assertBoundedJson(body, MAXIMUM_ARGUMENT_BYTES, 'webdriver.body');
    }
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseText = await readBoundedResponse(response);
    let payload;
    try {
      payload = responseText ? JSON.parse(responseText) : { value: null };
    } catch (error) {
      throw new Error('WebDriver returned invalid JSON', { cause: error });
    }
    if (!response.ok || payload.value?.error) {
      const details = payload.value ?? payload;
      throw new Error(
        `${method} ${path} failed with HTTP ${response.status}: ${details.error ?? 'WebDriver error'}: ${String(details.message ?? responseText).slice(0, 2_048)}`,
      );
    }
    return assertBoundedResponse(payload.value);
  };
}

async function boundedRequest(request, method, path, body) {
  return assertBoundedResponse(await request(method, path, body));
}

async function readBoundedResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAXIMUM_RESPONSE_BYTES) {
    throw new EvidenceValidationError(
      'WebDriver response exceeds the size bound',
      'webdriver.response',
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new EvidenceValidationError(
        'WebDriver response exceeds the size bound',
        'webdriver.response',
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function assertBoundedResponse(value) {
  assertBoundedJson(value, MAXIMUM_RESPONSE_BYTES, 'response');
  return value;
}

function assertBoundedJson(value, maximumBytes, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new EvidenceValidationError(
      `${label} must be JSON serializable: ${boundedMessage(error)}`,
      label,
    );
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized) > maximumBytes
  ) {
    throw new EvidenceValidationError(`${label} exceeds the size bound`, label);
  }
}

function assertBoundedText(value, maximumBytes, label) {
  assertString(value, 0, maximumBytes, label);
  if (Buffer.byteLength(value) > maximumBytes) {
    throw new EvidenceValidationError(`${label} exceeds the size bound`, label);
  }
}

function assertLoopbackEndpoint(value) {
  const endpoint = new URL(assertString(value, 1, 2_048, 'endpoint'));
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new EvidenceValidationError(
      'must be one explicit HTTP loopback endpoint',
      'endpoint',
    );
  }
  return endpoint.origin;
}

function boundedMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_048,
  );
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
