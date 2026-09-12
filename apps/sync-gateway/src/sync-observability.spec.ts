import { buildSyncGateway } from './app.js';
import {
  SyncObservability,
  syncAlertThresholdsFromEnvironment,
} from './sync-observability.js';
import { UnconfiguredSyncGatewayAdapter } from './unconfigured-adapter.js';

describe('SyncObservability', () => {
  it('renders bounded low-cardinality request and lifecycle metrics', () => {
    const observability = new SyncObservability();
    observability.recordRequest('github', 'object', 'success', 125);
    observability.recordRequest('github', 'object', 'server-error', 250);
    observability.recordEvent('github', 'throttle');
    observability.recordEvent('mega', 'cancellation');
    observability.recordReadiness(false);
    observability.recordReadiness(true);

    const metrics = observability.renderPrometheus();
    expect(metrics).toContain(
      'omnia_sync_requests_total{provider="github",operation="object",outcome="success"} 1',
    );
    expect(metrics).toContain(
      'omnia_sync_request_duration_ms_sum{provider="github",operation="object",outcome="server-error"} 250',
    );
    expect(metrics).toContain(
      'omnia_sync_events_total{provider="github",event="throttle"} 1',
    );
    expect(metrics).toContain('omnia_sync_readiness 1');
    expect(metrics).toContain('omnia_sync_readiness_failures_total 1');
    expect(metrics).toContain(
      'omnia_sync_events_total{provider="none",event="recovery"} 1',
    );
    expect(metrics).not.toContain('account');
    expect(metrics).not.toContain('repository');
    expect(metrics).not.toContain('publication');
    expect(observability.activeAlerts()).toEqual([]);
    expect(() =>
      observability.recordRequest(
        'reader@example.test' as never,
        'object',
        'success',
        1,
      ),
    ).toThrow('Unsupported synchronization provider label');
  });

  it('evaluates injected error, latency, and readiness alert thresholds', () => {
    const observability = new SyncObservability({
      minimumRequests: 4,
      maximumFailureRatio: 0.24,
      maximumP95LatencyMs: 100,
      maximumReadinessFailures: 0,
    });
    observability.recordRequest('github', 'document', 'success', 25);
    observability.recordRequest('github', 'document', 'success', 50);
    observability.recordRequest('github', 'document', 'success', 125);
    observability.recordRequest('github', 'document', 'server-error', 150);
    observability.recordReadiness(false);

    expect(observability.activeAlerts()).toEqual([
      'sync-error-ratio',
      'sync-latency-p95',
      'sync-readiness',
    ]);
    const metrics = observability.renderPrometheus();
    expect(metrics).toContain('omnia_sync_alert{alert="sync-error-ratio"} 1');
    expect(metrics).toContain('omnia_sync_alert{alert="sync-latency-p95"} 1');
    expect(metrics).toContain('omnia_sync_alert{alert="sync-readiness"} 1');
  });

  it('parses bounded alert thresholds and rejects unsafe configuration', () => {
    expect(
      syncAlertThresholdsFromEnvironment({
        OMNIA_SYNC_ALERT_MIN_REQUESTS: '50',
        OMNIA_SYNC_ALERT_MAX_FAILURE_RATIO: '0.02',
        OMNIA_SYNC_ALERT_MAX_P95_MS: '1500',
        OMNIA_SYNC_ALERT_MAX_READINESS_FAILURES: '2',
      }),
    ).toEqual({
      minimumRequests: 50,
      maximumFailureRatio: 0.02,
      maximumP95LatencyMs: 1500,
      maximumReadinessFailures: 2,
    });
    expect(() =>
      syncAlertThresholdsFromEnvironment({
        OMNIA_SYNC_ALERT_MAX_FAILURE_RATIO: '1.1',
      }),
    ).toThrow('OMNIA_SYNC_ALERT_MAX_FAILURE_RATIO');
  });

  it('instruments gateway readiness, recovery, and internal metrics without leaking failures', async () => {
    let ready = false;
    const observability = new SyncObservability();
    const app = buildSyncGateway({
      github: new UnconfiguredSyncGatewayAdapter('GitHub'),
      mega: new UnconfiguredSyncGatewayAdapter('MEGA'),
      readiness: async () => {
        if (!ready) throw new Error('redis://reader:secret@redis.internal/0');
      },
      observability,
      secureCookies: false,
    });

    const unavailable = await app.inject({ method: 'GET', url: '/readyz' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain('redis.internal');
    ready = true;
    expect(
      (await app.inject({ method: 'GET', url: '/readyz' })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/sync/github/session',
        })
      ).statusCode,
    ).toBe(200);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('omnia_sync_readiness 1');
    expect(metrics.body).toContain(
      'omnia_sync_events_total{provider="none",event="recovery"} 1',
    );
    expect(metrics.body).toContain(
      'omnia_sync_requests_total{provider="github",operation="session",outcome="success"} 1',
    );
    expect(metrics.body).not.toContain('redis.internal');
    expect(metrics.body).not.toContain('reader');
    await app.close();
  });
});
