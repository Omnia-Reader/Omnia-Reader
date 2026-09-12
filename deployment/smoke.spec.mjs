import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertPublicAddress,
  assertGatewayProbe,
  assertGracefulShutdown,
  assertImageIdentity,
  assertPublicHttpsUrl,
  assertSecurityHeaders,
  assertSyncMetrics,
} from './smoke-contract.mjs';

const imageId = `sha256:${'a'.repeat(64)}`;

test('public deployment smoke accepts only credential-free HTTPS origins', () => {
  assert.equal(
    assertPublicHttpsUrl('https://reader.example/'),
    'https://reader.example',
  );
  assert.throws(() => assertPublicHttpsUrl('http://reader.example'), /HTTPS/);
  assert.throws(
    () => assertPublicHttpsUrl('https://user:secret@reader.example'),
    /credentials/,
  );
  assert.throws(
    () => assertPublicHttpsUrl('https://reader.example/sync'),
    /without a path/,
  );
  assert.throws(
    () => assertPublicHttpsUrl('https://127.0.0.1'),
    /loopback or private/,
  );
  assert.equal(
    assertPublicHttpsUrl('https://fca.example'),
    'https://fca.example',
  );
});

test('public deployment smoke verifies the connected address is globally routable', () => {
  assert.equal(assertPublicAddress('93.184.216.34'), '93.184.216.34');
  assert.equal(
    assertPublicAddress('2606:4700:4700::1111'),
    '2606:4700:4700::1111',
  );
  assert.equal(
    assertPublicAddress('::ffff:93.184.216.34'),
    '::ffff:93.184.216.34',
  );
  for (const address of [
    '10.0.0.1',
    '100.64.0.1',
    '192.0.2.1',
    '2001:db8::1',
    '::ffff:192.168.1.1',
  ]) {
    assert.throws(() => assertPublicAddress(address), /non-public/);
  }
});

test('security headers require the complete HTTPS edge policy', () => {
  const headers = responseHeaders({
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  assert.doesNotThrow(() => assertSecurityHeaders(headers, { https: true }));
  assert.throws(
    () =>
      assertSecurityHeaders(
        headers.replace('Strict-Transport-Security', 'Removed-Header'),
        { https: true },
      ),
    /strict-transport-security/,
  );
  assert.throws(
    () =>
      assertSecurityHeaders(headers.replace('max-age=31536000', 'max-age=0'), {
        https: true,
      }),
    /positive HSTS/,
  );
});

test('readiness probes accept only exact sanitized states', () => {
  assert.doesNotThrow(() =>
    assertGatewayProbe(
      JSON.stringify({ status: 'ok', service: 'omnia-reader-sync-gateway' }),
      'ok',
    ),
  );
  assert.doesNotThrow(() =>
    assertGatewayProbe(
      JSON.stringify({
        status: 'unavailable',
        service: 'omnia-reader-sync-gateway',
      }),
      'unavailable',
    ),
  );
  assert.throws(
    () =>
      assertGatewayProbe(
        JSON.stringify({
          status: 'unavailable',
          service: 'omnia-reader-sync-gateway',
          error: 'redis://user:secret@internal',
        }),
        'unavailable',
      ),
    /unexpected fields/,
  );
});

test('image identity binds immutable ID, release, and revision', () => {
  const identity = JSON.stringify({
    imageId,
    version: '0.2.0-rc.1',
    revision: 'abc1234',
  });
  assert.equal(
    assertImageIdentity(identity, {
      imageId,
      version: '0.2.0-rc.1',
      revision: 'abc1234',
    }),
    imageId,
  );
  assert.throws(
    () =>
      assertImageIdentity(identity, {
        imageId: `sha256:${'b'.repeat(64)}`,
        version: '0.2.0-rc.1',
        revision: 'abc1234',
      }),
    /image ID mismatch/,
  );
});

test('telemetry accepts only fixed low-cardinality labels and injected alerts', () => {
  assert.doesNotThrow(() =>
    assertSyncMetrics(validMetrics(), { expectLatencyAlert: true }),
  );
  assert.throws(
    () =>
      assertSyncMetrics(
        `${validMetrics()}omnia_sync_requests_total{provider="github",operation="object",outcome="success",repository="private"} 1\n`,
      ),
    /forbidden value|unsupported labels/,
  );
  assert.throws(
    () => assertSyncMetrics(`${validMetrics()}# token=secret\n`),
    /forbidden value/,
  );
});

test('telemetry proves Redis readiness failure and recovery without details', () => {
  const metrics = `${validMetrics()}omnia_sync_events_total{provider="none",event="recovery"} 1\n`;
  assert.doesNotThrow(() =>
    assertSyncMetrics(metrics, {
      expectLatencyAlert: true,
      expectRecovery: true,
    }),
  );
  assert.throws(
    () => assertSyncMetrics(validMetrics(), { expectRecovery: true }),
    /events_total/,
  );
});

test('graceful shutdown rejects forced or OOM exits', () => {
  assert.doesNotThrow(() =>
    assertGracefulShutdown(
      JSON.stringify({ running: false, oomKilled: false, exitCode: 0 }),
    ),
  );
  assert.throws(
    () =>
      assertGracefulShutdown(
        JSON.stringify({ running: false, oomKilled: false, exitCode: 137 }),
      ),
    /gracefully/,
  );
});

test('container smoke wires bounded probes and every strict deployment gate', async () => {
  const script = await readFile(new URL('./smoke.sh', import.meta.url), 'utf8');
  for (const contract of [
    '--connect-timeout',
    '--max-time',
    'OMNIA_SMOKE_PUBLIC_BASE_URL',
    'OMNIA_SMOKE_REDIS_CONTROL_DRIVER',
    'OMNIA_SMOKE_BUILD',
    '--expect-latency-alert',
    '--expect-recovery',
    'assert_container_identity',
    'assert_graceful_shutdown',
  ]) {
    assert.match(script, new RegExp(contract.replaceAll('-', '\\-')));
  }
});

test('container smoke rejects unbounded timeouts before invoking Docker', () => {
  const result = spawnSync('bash', ['deployment/smoke.sh'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNIA_SMOKE_REQUEST_TIMEOUT_SECONDS: '301',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /integer from 1 through 300/);
  assert.doesNotMatch(result.stdout + result.stderr, /Building|docker compose/);
});

test('strict smoke rejects missing deployment evidence before invoking Docker', () => {
  const result = spawnSync('bash', ['deployment/smoke.sh'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNIA_SMOKE_STRICT: '1',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OMNIA_SMOKE_PUBLIC_BASE_URL/);
  assert.doesNotMatch(result.stdout + result.stderr, /Building|docker compose/);
});

function validMetrics() {
  return [
    '# TYPE omnia_sync_requests_total counter',
    'omnia_sync_requests_total{provider="github",operation="session",outcome="success"} 2',
    'omnia_sync_request_duration_ms_sum{provider="github",operation="session",outcome="success"} 25',
    'omnia_sync_request_duration_ms_count{provider="github",operation="session",outcome="success"} 2',
    'omnia_sync_readiness 1',
    'omnia_sync_readiness_failures_total 1',
    'omnia_sync_alert{alert="sync-error-ratio"} 0',
    'omnia_sync_alert{alert="sync-latency-p95"} 1',
    'omnia_sync_alert{alert="sync-readiness"} 0',
    '',
  ].join('\n');
}

function responseHeaders(headers) {
  return [
    'HTTP/2 200',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n');
}
