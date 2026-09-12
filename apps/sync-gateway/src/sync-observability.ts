import type { FastifyInstance, FastifyRequest } from 'fastify';

export type SyncMetricProvider = 'github' | 'mega' | 'none';
export type SyncMetricOperation =
  | 'health'
  | 'readiness'
  | 'session'
  | 'authorization'
  | 'destination'
  | 'revision'
  | 'document'
  | 'entry'
  | 'object'
  | 'webhook'
  | 'native-handoff'
  | 'other';
export type SyncMetricOutcome = 'success' | 'client-error' | 'server-error';
export type SyncMetricEvent =
  | 'renewal'
  | 'throttle'
  | 'cancellation'
  | 'recovery';

export interface SyncAlertThresholds {
  minimumRequests: number;
  maximumFailureRatio: number;
  maximumP95LatencyMs: number;
  maximumReadinessFailures: number;
}

const DEFAULT_ALERT_THRESHOLDS: SyncAlertThresholds = {
  minimumRequests: 20,
  maximumFailureRatio: 0.05,
  maximumP95LatencyMs: 2_000,
  maximumReadinessFailures: 0,
};
const MAX_DURATION_SAMPLES = 4_096;
const PROVIDERS = new Set<SyncMetricProvider>(['github', 'mega', 'none']);
const OPERATIONS = new Set<SyncMetricOperation>([
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
const OUTCOMES = new Set<SyncMetricOutcome>([
  'success',
  'client-error',
  'server-error',
]);
const EVENTS = new Set<SyncMetricEvent>([
  'renewal',
  'throttle',
  'cancellation',
  'recovery',
]);

interface RequestMetric {
  provider: SyncMetricProvider;
  operation: SyncMetricOperation;
  outcome: SyncMetricOutcome;
  count: number;
  durationSumMs: number;
}

interface EventMetric {
  provider: SyncMetricProvider;
  event: SyncMetricEvent;
  count: number;
}

export class SyncObservability {
  private readonly requests = new Map<string, RequestMetric>();
  private readonly events = new Map<string, EventMetric>();
  private readonly durationSamples: number[] = [];
  private readiness = true;
  private readinessFailures = 0;
  private consecutiveReadinessFailures = 0;

  constructor(
    private readonly thresholds: SyncAlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  ) {
    validateThresholds(thresholds);
  }

  recordRequest(
    provider: SyncMetricProvider,
    operation: SyncMetricOperation,
    outcome: SyncMetricOutcome,
    durationMs: number,
  ): void {
    assertLabel(PROVIDERS, provider, 'provider');
    assertLabel(OPERATIONS, operation, 'operation');
    assertLabel(OUTCOMES, outcome, 'outcome');
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('Invalid synchronization request duration');
    }
    const normalizedDuration = Math.round(durationMs * 1_000) / 1_000;
    const key = `${provider}:${operation}:${outcome}`;
    const metric = this.requests.get(key) ?? {
      provider,
      operation,
      outcome,
      count: 0,
      durationSumMs: 0,
    };
    metric.count += 1;
    metric.durationSumMs += normalizedDuration;
    this.requests.set(key, metric);
    this.durationSamples.push(normalizedDuration);
    if (this.durationSamples.length > MAX_DURATION_SAMPLES) {
      this.durationSamples.shift();
    }
  }

  recordEvent(provider: SyncMetricProvider, event: SyncMetricEvent): void {
    assertLabel(PROVIDERS, provider, 'provider');
    assertLabel(EVENTS, event, 'event');
    const key = `${provider}:${event}`;
    const metric = this.events.get(key) ?? {
      provider,
      event,
      count: 0,
    };
    metric.count += 1;
    this.events.set(key, metric);
  }

  recordReadiness(available: boolean): void {
    if (!available) {
      this.readinessFailures += 1;
      this.consecutiveReadinessFailures += 1;
    } else if (!this.readiness) {
      this.recordEvent('none', 'recovery');
      this.consecutiveReadinessFailures = 0;
    } else {
      this.consecutiveReadinessFailures = 0;
    }
    this.readiness = available;
  }

  activeAlerts(): string[] {
    const requestMetrics = [...this.requests.values()];
    const requestCount = requestMetrics.reduce(
      (total, metric) => total + metric.count,
      0,
    );
    const failureCount = requestMetrics
      .filter((metric) => metric.outcome === 'server-error')
      .reduce((total, metric) => total + metric.count, 0);
    const alerts: string[] = [];
    if (
      requestCount >= this.thresholds.minimumRequests &&
      failureCount / requestCount > this.thresholds.maximumFailureRatio
    ) {
      alerts.push('sync-error-ratio');
    }
    if (
      requestCount >= this.thresholds.minimumRequests &&
      percentile95(this.durationSamples) > this.thresholds.maximumP95LatencyMs
    ) {
      alerts.push('sync-latency-p95');
    }
    if (
      !this.readiness ||
      this.consecutiveReadinessFailures >
        this.thresholds.maximumReadinessFailures
    ) {
      alerts.push('sync-readiness');
    }
    return alerts;
  }

  renderPrometheus(): string {
    const lines = [
      '# TYPE omnia_sync_requests_total counter',
      '# TYPE omnia_sync_request_duration_ms_sum counter',
      '# TYPE omnia_sync_request_duration_ms_count counter',
    ];
    for (const metric of sortedValues(this.requests)) {
      const labels = requestLabels(metric);
      lines.push(`omnia_sync_requests_total{${labels}} ${metric.count}`);
      lines.push(
        `omnia_sync_request_duration_ms_sum{${labels}} ${formatNumber(metric.durationSumMs)}`,
      );
      lines.push(
        `omnia_sync_request_duration_ms_count{${labels}} ${metric.count}`,
      );
    }
    lines.push('# TYPE omnia_sync_events_total counter');
    for (const metric of sortedValues(this.events)) {
      lines.push(
        `omnia_sync_events_total{provider="${metric.provider}",event="${metric.event}"} ${metric.count}`,
      );
    }
    lines.push('# TYPE omnia_sync_readiness gauge');
    lines.push(`omnia_sync_readiness ${this.readiness ? 1 : 0}`);
    lines.push('# TYPE omnia_sync_readiness_failures_total counter');
    lines.push(`omnia_sync_readiness_failures_total ${this.readinessFailures}`);
    lines.push('# TYPE omnia_sync_alert gauge');
    const activeAlerts = new Set(this.activeAlerts());
    for (const alert of [
      'sync-error-ratio',
      'sync-latency-p95',
      'sync-readiness',
    ]) {
      lines.push(
        `omnia_sync_alert{alert="${alert}"} ${activeAlerts.has(alert) ? 1 : 0}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

export function syncAlertThresholdsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): SyncAlertThresholds {
  const thresholds = {
    minimumRequests: integerEnvironmentValue(
      environment,
      'OMNIA_SYNC_ALERT_MIN_REQUESTS',
      DEFAULT_ALERT_THRESHOLDS.minimumRequests,
    ),
    maximumFailureRatio: ratioEnvironmentValue(
      environment,
      'OMNIA_SYNC_ALERT_MAX_FAILURE_RATIO',
      DEFAULT_ALERT_THRESHOLDS.maximumFailureRatio,
    ),
    maximumP95LatencyMs: numberEnvironmentValue(
      environment,
      'OMNIA_SYNC_ALERT_MAX_P95_MS',
      DEFAULT_ALERT_THRESHOLDS.maximumP95LatencyMs,
    ),
    maximumReadinessFailures: integerEnvironmentValue(
      environment,
      'OMNIA_SYNC_ALERT_MAX_READINESS_FAILURES',
      DEFAULT_ALERT_THRESHOLDS.maximumReadinessFailures,
    ),
  };
  validateThresholds(thresholds);
  return thresholds;
}

export function registerSyncObservability(
  app: FastifyInstance,
  observability: SyncObservability,
): void {
  const requestStartTimes = new WeakMap<FastifyRequest['raw'], bigint>();
  const abortHandlers = new WeakMap<FastifyRequest['raw'], () => void>();

  app.addHook('onRequest', async (request) => {
    if (!isMetricsRequest(request.url)) {
      requestStartTimes.set(request.raw, process.hrtime.bigint());
      const recordCancellation = () => {
        const route = request.routeOptions.url ?? request.url;
        observability.recordEvent(
          classifyRoute(route).provider,
          'cancellation',
        );
      };
      abortHandlers.set(request.raw, recordCancellation);
      request.raw.once('aborted', recordCancellation);
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    if (isMetricsRequest(request.url)) return;
    const abortHandler = abortHandlers.get(request.raw);
    if (abortHandler) request.raw.off('aborted', abortHandler);
    abortHandlers.delete(request.raw);
    const start = requestStartTimes.get(request.raw);
    requestStartTimes.delete(request.raw);
    const durationMs = start
      ? Number(process.hrtime.bigint() - start) / 1_000_000
      : 0;
    const route = request.routeOptions.url ?? request.url;
    const { provider, operation } = classifyRoute(route);
    const outcome = outcomeFromStatus(reply.statusCode);
    observability.recordRequest(provider, operation, outcome, durationMs);
    if (reply.statusCode === 429) {
      observability.recordEvent(provider, 'throttle');
    }
    if (
      outcome === 'success' &&
      ((request.method === 'POST' &&
        request.url.split('?')[0]?.endsWith('/auth/login')) ||
        (request.method === 'GET' &&
          request.url.split('?')[0]?.endsWith('/auth/callback')))
    ) {
      observability.recordEvent(provider, 'renewal');
    }
  });
  app.get('/metrics', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(observability.renderPrometheus()),
  );
}

function isMetricsRequest(url: string): boolean {
  return url.split('?')[0] === '/metrics';
}

function classifyRoute(route: string): {
  provider: SyncMetricProvider;
  operation: SyncMetricOperation;
} {
  if (route === '/healthz') return { provider: 'none', operation: 'health' };
  if (route === '/readyz') {
    return { provider: 'none', operation: 'readiness' };
  }
  const provider = route.includes('/github/')
    ? 'github'
    : route.includes('/mega/')
      ? 'mega'
      : 'none';
  if (route.includes('/webhook')) return { provider, operation: 'webhook' };
  if (route.includes('/native')) {
    return { provider, operation: 'native-handoff' };
  }
  for (const operation of [
    'session',
    'authorization',
    'destination',
    'revision',
    'document',
    'entry',
    'object',
  ] as const) {
    if (route.includes(`/${operation}`)) return { provider, operation };
  }
  return { provider, operation: 'other' };
}

function outcomeFromStatus(statusCode: number): SyncMetricOutcome {
  if (statusCode >= 500) return 'server-error';
  if (statusCode >= 400) return 'client-error';
  return 'success';
}

function validateThresholds(thresholds: SyncAlertThresholds): void {
  if (
    !Number.isSafeInteger(thresholds.minimumRequests) ||
    thresholds.minimumRequests < 1
  ) {
    throw new Error('Invalid synchronization minimum request threshold');
  }
  if (
    !Number.isFinite(thresholds.maximumFailureRatio) ||
    thresholds.maximumFailureRatio < 0 ||
    thresholds.maximumFailureRatio > 1
  ) {
    throw new Error('Invalid synchronization failure ratio threshold');
  }
  if (
    !Number.isFinite(thresholds.maximumP95LatencyMs) ||
    thresholds.maximumP95LatencyMs <= 0
  ) {
    throw new Error('Invalid synchronization latency threshold');
  }
  if (
    !Number.isSafeInteger(thresholds.maximumReadinessFailures) ||
    thresholds.maximumReadinessFailures < 0
  ) {
    throw new Error('Invalid synchronization readiness failure threshold');
  }
}

function assertLabel<T extends string>(
  values: Set<T>,
  value: T,
  label: string,
): void {
  if (!values.has(value)) {
    throw new Error(`Unsupported synchronization ${label} label`);
  }
}

function integerEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function numberEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function ratioEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function sortedValues<T>(values: Map<string, T>): T[] {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function requestLabels(metric: RequestMetric): string {
  return `provider="${metric.provider}",operation="${metric.operation}",outcome="${metric.outcome}"`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(3)));
}
