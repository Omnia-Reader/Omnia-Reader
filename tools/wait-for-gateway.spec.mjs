import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { waitForGateway } from './wait-for-gateway.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('waits through unavailable responses until the gateway is ready', async (t) => {
  let requests = 0;
  const origin = await fixture(t, (request, response) => {
    assert.equal(request.url, '/readyz');
    requests++;
    response.writeHead(requests < 3 ? 503 : 200);
    response.end(
      JSON.stringify({
        status: requests < 3 ? 'unavailable' : 'ok',
        service: 'omnia-reader-sync-gateway',
      }),
    );
  });
  await waitForGateway(origin, { timeoutMs: 2000, intervalMs: 10 });
  assert.equal(requests, 3);
});

test('does not accept an unrelated healthy HTTP server', async (t) => {
  const origin = await fixture(t, (_, response) =>
    response.end('{"status":"ok","service":"other"}'),
  );
  await assert.rejects(
    waitForGateway(origin, { timeoutMs: 100, intervalMs: 10 }),
    /not ready.*Check/s,
  );
});

test('bounds a server that never returns a response', async (t) => {
  const origin = await fixture(t, () => {});
  await assert.rejects(
    waitForGateway(origin, { timeoutMs: 100, intervalMs: 10 }),
    /not ready/,
  );
});

test('reports connection refusal with the target address', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    waitForGateway(origin, { timeoutMs: 100, intervalMs: 10 }),
    { message: new RegExp(origin) },
  );
});
