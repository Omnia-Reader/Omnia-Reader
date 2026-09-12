import { BlockList, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 1024 * 1024;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._+/-]{0,127}$/;
const PROVIDERS = new Set(['github', 'mega', 'none']);
const OPERATIONS = new Set([
  'health',
  'readiness',
  'session',
  'authorization',
  'destination',
  'revision',
  'document',
  'entry',
  'object',
  'webhook',
  'native-handoff',
  'other',
]);
const OUTCOMES = new Set(['success', 'client-error', 'server-error']);
const EVENTS = new Set(['renewal', 'throttle', 'cancellation', 'recovery']);
const ALERTS = new Set([
  'sync-error-ratio',
  'sync-latency-p95',
  'sync-readiness',
]);
const METRIC_CONTRACT = new Map([
  [
    'omnia_sync_requests_total',
    { labels: ['provider', 'operation', 'outcome'] },
  ],
  [
    'omnia_sync_request_duration_ms_sum',
    { labels: ['provider', 'operation', 'outcome'] },
  ],
  [
    'omnia_sync_request_duration_ms_count',
    { labels: ['provider', 'operation', 'outcome'] },
  ],
  ['omnia_sync_events_total', { labels: ['provider', 'event'] }],
  ['omnia_sync_readiness', { labels: [] }],
  ['omnia_sync_readiness_failures_total', { labels: [] }],
  ['omnia_sync_alert', { labels: ['alert'] }],
]);
const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

export function assertPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Public smoke URL must be an absolute HTTPS origin.');
  }
  assert(url.protocol === 'https:', 'Public smoke URL must use HTTPS.');
  assert(
    !url.username && !url.password,
    'Public smoke URL must not embed credentials.',
  );
  assert(
    !url.search && !url.hash,
    'Public smoke URL must not include a query or fragment.',
  );
  assert(
    url.pathname === '/' || url.pathname === '',
    'Public smoke URL must be an origin without a path.',
  );
  assert(
    !isPrivateHostname(url.hostname),
    'Public smoke URL must not use a loopback or private host.',
  );
  return url.origin;
}

export function assertPublicAddress(value) {
  assert(
    typeof value === 'string' && isIP(value) !== 0,
    'Public smoke endpoint did not expose a valid remote IP address.',
  );
  assert(
    !isNonPublicIp(value),
    'Public smoke endpoint resolved to a non-public IP address.',
  );
  return value;
}

export function assertSecurityHeaders(headerText, { https = false } = {}) {
  assertBoundedText(headerText, 'HTTP headers');
  const headers = parseFinalHeaderBlock(headerText);
  const contentSecurityPolicy = requiredHeader(
    headers,
    'content-security-policy',
  );
  assert(
    /(?:^|;)\s*frame-ancestors\s+'none'(?:\s*;|$)/i.test(contentSecurityPolicy),
    'Content-Security-Policy must deny frame ancestors.',
  );
  assertHeader(headers, 'x-frame-options', 'DENY');
  assertHeader(headers, 'x-content-type-options', 'nosniff');
  assertHeader(headers, 'referrer-policy', 'no-referrer');
  assertHeader(headers, 'cross-origin-resource-policy', 'same-origin');
  const permissionsPolicy = requiredHeader(headers, 'permissions-policy');
  for (const permission of [
    'camera=()',
    'microphone=()',
    'payment=()',
    'usb=()',
  ]) {
    assert(
      permissionsPolicy.includes(permission),
      `Permissions-Policy must include ${permission}.`,
    );
  }
  if (https) {
    const hsts = requiredHeader(headers, 'strict-transport-security');
    const maxAge = hsts.match(/(?:^|;)\s*max-age=(\d+)/i);
    assert(
      maxAge && Number(maxAge[1]) > 0,
      'HTTPS must include a positive HSTS max-age.',
    );
  }
}

export function assertGatewayProbe(input, expectedStatus) {
  const value = parseJsonObject(input, 'Gateway probe');
  assertExactKeys(value, ['service', 'status'], 'Gateway probe');
  assert(
    value.service === 'omnia-reader-sync-gateway',
    'Gateway probe returned an unexpected service.',
  );
  assert(
    value.status === expectedStatus,
    `Gateway probe did not report ${expectedStatus}.`,
  );
}

export function assertImageIdentity(input, expected) {
  const value = parseJsonObject(input, 'Container image identity');
  assertExactKeys(
    value,
    ['imageId', 'revision', 'version'],
    'Container image identity',
  );
  assert(
    typeof value.imageId === 'string' && IMAGE_ID.test(value.imageId),
    'Container image identity must be an immutable sha256 ID.',
  );
  assertSafeIdentity(expected.version, 'Expected image version');
  assertSafeIdentity(expected.revision, 'Expected image revision');
  assert(
    value.version === expected.version,
    'Container image version label mismatch.',
  );
  assert(
    value.revision === expected.revision,
    'Container image revision label mismatch.',
  );
  if (expected.imageId !== undefined) {
    assert(
      IMAGE_ID.test(expected.imageId),
      'Expected container image ID must be an immutable sha256 ID.',
    );
    assert(value.imageId === expected.imageId, 'Container image ID mismatch.');
  }
  return value.imageId;
}

export function assertGracefulShutdown(input) {
  const value = parseJsonObject(input, 'Container shutdown state');
  assertExactKeys(
    value,
    ['exitCode', 'oomKilled', 'running'],
    'Container shutdown state',
  );
  assert(value.running === false, 'Container is still running after shutdown.');
  assert(value.oomKilled === false, 'Container was OOM-killed.');
  assert(value.exitCode === 0, 'Container did not exit gracefully.');
}

export function assertSyncMetrics(
  input,
  { expectLatencyAlert = false, expectRecovery = false } = {},
) {
  assertBoundedText(input, 'Synchronization metrics');
  for (const forbidden of [
    'account',
    'authorization:',
    'password',
    'publication',
    'redis://',
    'rediss://',
    'repository',
    'secret',
    'session=',
    'token',
  ]) {
    assert(
      !input.toLowerCase().includes(forbidden),
      'Synchronization metrics contain a forbidden value.',
    );
  }

  const samples = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(
      /^([a-z][a-z0-9_]*)(?:\{([^{}]*)\})? (-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)$/i,
    );
    assert(match, 'Synchronization metrics contain an invalid sample.');
    const [, name, labelText = '', rawValue] = match;
    const contract = METRIC_CONTRACT.get(name);
    assert(
      contract,
      `Synchronization metrics contain unsupported metric ${name}.`,
    );
    const labels = parseLabels(labelText);
    assert(
      [...labels.keys()].sort().join(',') ===
        [...contract.labels].sort().join(','),
      `Synchronization metric ${name} has unsupported labels.`,
    );
    validateMetricLabels(labels);
    const value = Number(rawValue);
    assert(
      Number.isFinite(value) && value >= 0,
      'Synchronization metric value is invalid.',
    );
    samples.push({ name, labels, value });
  }

  assert(
    samples.some(({ name }) => name === 'omnia_sync_requests_total'),
    'Synchronization request metrics are missing.',
  );
  assert(
    sampleValue(samples, 'omnia_sync_readiness') === 1,
    'Synchronization readiness metric is not healthy.',
  );
  if (expectLatencyAlert) {
    assert(
      sampleValue(samples, 'omnia_sync_alert', {
        alert: 'sync-latency-p95',
      }) === 1,
      'Injected synchronization latency alert did not fire.',
    );
  }
  if (expectRecovery) {
    assert(
      sampleValue(samples, 'omnia_sync_readiness_failures_total') > 0,
      'Synchronization readiness failure was not recorded.',
    );
    assert(
      sampleValue(samples, 'omnia_sync_events_total', {
        provider: 'none',
        event: 'recovery',
      }) > 0,
      'Synchronization readiness recovery was not recorded.',
    );
  }
}

function validateMetricLabels(labels) {
  if (labels.has('provider')) {
    assert(
      PROVIDERS.has(labels.get('provider')),
      'Unsupported provider metric label.',
    );
  }
  if (labels.has('operation')) {
    assert(
      OPERATIONS.has(labels.get('operation')),
      'Unsupported operation metric label.',
    );
  }
  if (labels.has('outcome')) {
    assert(
      OUTCOMES.has(labels.get('outcome')),
      'Unsupported outcome metric label.',
    );
  }
  if (labels.has('event')) {
    assert(EVENTS.has(labels.get('event')), 'Unsupported event metric label.');
  }
  if (labels.has('alert')) {
    assert(ALERTS.has(labels.get('alert')), 'Unsupported alert metric label.');
  }
}

function parseLabels(labelText) {
  const labels = new Map();
  if (!labelText) return labels;
  for (const part of labelText.split(',')) {
    const match = part.match(/^([a-z][a-z0-9_]*)="([a-z0-9-]+)"$/);
    assert(match, 'Synchronization metric label is invalid.');
    const [, name, value] = match;
    assert(!labels.has(name), 'Synchronization metric label is duplicated.');
    labels.set(name, value);
  }
  return labels;
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }
  return isIP(normalized) !== 0 && isNonPublicIp(normalized);
}

function isNonPublicIp(value) {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 0) return true;
  if (family === 6 && normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isNonPublicIp(mapped);
    const groups = mapped.split(':');
    if (
      groups.length === 2 &&
      groups.every((group) => /^[a-f0-9]{1,4}$/.test(group))
    ) {
      const bytes = groups.flatMap((group) => {
        const number = Number.parseInt(group, 16);
        return [number >> 8, number & 0xff];
      });
      return isNonPublicIp(bytes.join('.'));
    }
    return true;
  }
  return NON_PUBLIC_ADDRESSES.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

function sampleValue(samples, name, expectedLabels = {}) {
  const matches = samples.filter(
    (sample) =>
      sample.name === name &&
      Object.entries(expectedLabels).every(
        ([label, value]) => sample.labels.get(label) === value,
      ),
  );
  assert(matches.length === 1, `Expected one ${name} metric sample.`);
  return matches[0].value;
}

function parseFinalHeaderBlock(input) {
  const blocks = input.trim().split(/\r?\n\r?\n/);
  const block = [...blocks]
    .reverse()
    .find((candidate) => /^HTTP\//.test(candidate));
  assert(block, 'HTTP response headers are missing.');
  const headers = new Map();
  for (const line of block.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(
      name,
      headers.has(name) ? `${headers.get(name)}, ${value}` : value,
    );
  }
  return headers;
}

function requiredHeader(headers, name) {
  const value = headers.get(name);
  assert(value, `Required HTTP header ${name} is missing.`);
  return value;
}

function assertHeader(headers, name, expected) {
  assert(
    requiredHeader(headers, name).toLowerCase() === expected.toLowerCase(),
    `HTTP header ${name} has an unexpected value.`,
  );
}

function parseJsonObject(input, label) {
  assertBoundedText(input, label);
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object.`,
  );
  return value;
}

function assertExactKeys(value, keys, label) {
  assert(
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    `${label} has unexpected fields.`,
  );
}

function assertSafeIdentity(value, label) {
  assert(
    typeof value === 'string' && SAFE_IDENTITY.test(value),
    `${label} is invalid.`,
  );
}

function assertBoundedText(value, label) {
  assert(typeof value === 'string', `${label} must be text.`);
  assert(Buffer.byteLength(value) <= MAX_INPUT_BYTES, `${label} is too large.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readStandardInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert(size <= MAX_INPUT_BYTES, 'Smoke validation input is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'public-url') {
    process.stdout.write(assertPublicHttpsUrl(args[0] ?? ''));
    return;
  }
  if (command === 'public-address') {
    process.stdout.write(assertPublicAddress(args[0] ?? ''));
    return;
  }
  const input = await readStandardInput();
  if (command === 'headers') {
    assertSecurityHeaders(input, { https: args.includes('--https') });
  } else if (command === 'probe') {
    assertGatewayProbe(input, args[0]);
  } else if (command === 'image') {
    assertImageIdentity(input, {
      version: args[0],
      revision: args[1],
      ...(args[2] ? { imageId: args[2] } : {}),
    });
  } else if (command === 'shutdown') {
    assertGracefulShutdown(input);
  } else if (command === 'metrics') {
    assertSyncMetrics(input, {
      expectLatencyAlert: args.includes('--expect-latency-alert'),
      expectRecovery: args.includes('--expect-recovery'),
    });
  } else {
    throw new Error('Unsupported smoke validation command.');
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Smoke validation failed.',
    );
    process.exitCode = 1;
  });
}
