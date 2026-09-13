import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function waitForGateway(
  origin,
  { timeoutMs = 60_000, intervalMs = 250 } = {},
) {
  const url = new URL('/readyz', origin);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(Math.min(1000, deadline - performance.now()))),
        ),
      });
      const body = await response.json();
      if (
        response.ok &&
        body?.status === 'ok' &&
        body?.service === 'omnia-reader-sync-gateway'
      )
        return;
    } catch {
      // Connection refusal during compilation and transient readiness failures
      // are expected; the frontend must not start until they have cleared.
    }
    await delay(
      Math.max(0, Math.min(intervalMs, deadline - performance.now())),
    );
  }
  throw new Error(
    `Synchronization gateway is not ready at ${url}. Check the gateway startup output and ensure HOST/PORT match apps/omnia-reader/proxy.conf.json.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const proxy = JSON.parse(
      await readFile(
        new URL('../apps/omnia-reader/proxy.conf.json', import.meta.url),
        'utf8',
      ),
    );
    console.log('Waiting for synchronization gateway readiness...');
    await waitForGateway(proxy['/api/sync'].target);
    console.log('Synchronization gateway ready; starting the reader.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
