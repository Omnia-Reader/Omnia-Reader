import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const LIVE_GITHUB_CONTROL_OPERATIONS = Object.freeze([
  'prepare',
  'restart-gateway',
  'interrupt-lfs-once',
  'force-conflict-once',
  'expire-provider-token',
  'revoke-authorization',
  'remove-repository-access',
  'restore-repository-access',
  'inject-provider-error-once',
  'throttle-once',
  'inspect',
  'cleanup',
]);

const controlOperations = new Set(LIVE_GITHUB_CONTROL_OPERATIONS);
const githubCookieDomain = /^(?:\.)?github\.com$/;

export class LiveGitHubConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveGitHubConfigurationError';
  }
}

export function readLiveGitHubConfiguration(environment = process.env) {
  if (environment['LIVE_GITHUB_SYNC_E2E'] !== '1') return null;
  if (environment['LIVE_GITHUB_PROTECTED_RUNNER'] !== '1') {
    throw configurationError(
      'LIVE_GITHUB_PROTECTED_RUNNER=1 is required for the live GitHub journey',
    );
  }

  const baseUrl = required(environment, 'BASE_URL');
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw configurationError('BASE_URL must be an absolute HTTPS URL');
  }
  if (
    parsedBaseUrl.protocol !== 'https:' ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.pathname !== '/' ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash ||
    parsedBaseUrl.hostname.endsWith('.invalid') ||
    parsedBaseUrl.hostname === 'localhost' ||
    parsedBaseUrl.hostname === '127.0.0.1'
  ) {
    throw configurationError(
      'BASE_URL must identify the credentialed production-shaped HTTPS deployment',
    );
  }

  const authStatePath = required(environment, 'LIVE_GITHUB_AUTH_STATE');
  const controlDriverPath = required(environment, 'LIVE_GITHUB_CONTROL_DRIVER');
  if (!isAbsolute(authStatePath) || !isAbsolute(controlDriverPath)) {
    throw configurationError(
      'LIVE_GITHUB_AUTH_STATE and LIVE_GITHUB_CONTROL_DRIVER must be absolute paths',
    );
  }

  const runId = required(environment, 'LIVE_GITHUB_RUN_ID');
  if (!/^[a-z0-9](?:[a-z0-9-]{6,38}[a-z0-9])$/.test(runId)) {
    throw configurationError(
      'LIVE_GITHUB_RUN_ID must be 8-40 lowercase letters, numbers, or interior hyphens',
    );
  }
  const repositoryName = `omnia-reader-live-${runId}`;
  if (repositoryName.length > 100) {
    throw configurationError(
      'LIVE_GITHUB_RUN_ID produces an invalid repository name',
    );
  }

  const secretCanary = required(environment, 'LIVE_GITHUB_SECRET_CANARY');
  if (secretCanary.length < 20 || secretCanary.length > 256) {
    throw configurationError(
      'LIVE_GITHUB_SECRET_CANARY must contain 20-256 characters',
    );
  }

  const throttleAvailable = required(
    environment,
    'LIVE_GITHUB_THROTTLE_AVAILABLE',
  );
  if (throttleAvailable !== '0' && throttleAvailable !== '1') {
    throw configurationError(
      'LIVE_GITHUB_THROTTLE_AVAILABLE must be exactly 0 or 1',
    );
  }

  return Object.freeze({
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, ''),
    authStatePath,
    controlDriverPath,
    runId,
    repositoryName,
    secretCanary,
    throttleAvailable: throttleAvailable === '1',
  });
}

export async function readProtectedGitHubStorageState(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw configurationError(
      'LIVE_GITHUB_AUTH_STATE must be readable Playwright storage state JSON',
    );
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.cookies) ||
    !Array.isArray(value.origins) ||
    !value.cookies.every(isGitHubCookie) ||
    !value.origins.every(isGitHubOrigin)
  ) {
    throw configurationError(
      'LIVE_GITHUB_AUTH_STATE may contain authenticated github.com state only',
    );
  }
  if (value.cookies.length === 0) {
    throw configurationError(
      'LIVE_GITHUB_AUTH_STATE does not contain an authenticated GitHub cookie',
    );
  }
  return value;
}

export async function invokeLiveGitHubControl(
  configuration,
  operation,
  options = {},
) {
  if (!controlOperations.has(operation)) {
    throw new TypeError(
      `Unsupported live GitHub control operation: ${operation}`,
    );
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      configuration.controlDriverPath,
      [
        '--operation',
        operation,
        '--run-id',
        configuration.runId,
        '--repository',
        configuration.repositoryName,
      ],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: process.env,
      },
    ));
  } catch {
    throw new Error(`Live GitHub control operation failed: ${operation}`);
  }

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Live GitHub control operation returned invalid JSON: ${operation}`,
    );
  }
  if (
    !isRecord(result) ||
    result.schemaVersion !== 1 ||
    result.operation !== operation ||
    result.runId !== configuration.runId ||
    result.repository !== configuration.repositoryName ||
    (result.outcome !== 'ok' && result.outcome !== 'unavailable')
  ) {
    throw new Error(
      `Live GitHub control operation returned an invalid envelope: ${operation}`,
    );
  }
  if (result.outcome === 'unavailable' && !options.allowUnavailable) {
    throw new Error(
      `Required live GitHub control is unavailable: ${operation}`,
    );
  }
  return result;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw configurationError(`${name} is required`);
  }
  return value;
}

function isGitHubCookie(cookie) {
  return (
    isRecord(cookie) &&
    typeof cookie.name === 'string' &&
    cookie.name.length > 0 &&
    typeof cookie.value === 'string' &&
    githubCookieDomain.test(cookie.domain) &&
    typeof cookie.path === 'string' &&
    cookie.path.startsWith('/')
  );
}

function isGitHubOrigin(origin) {
  if (!isRecord(origin) || !Array.isArray(origin.localStorage)) return false;
  try {
    const url = new URL(origin.origin);
    return (
      url.origin === 'https://github.com' &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      origin.origin === 'https://github.com'
    );
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configurationError(message) {
  return new LiveGitHubConfigurationError(message);
}
