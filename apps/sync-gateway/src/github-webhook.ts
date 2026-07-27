import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { GatewayHttpError } from './gateway-contract.js';
import type { GitHubAuthorizationRevocationStore } from './github-authorization-revocations.js';

export interface GitHubWebhookOptions {
  secret: string;
  revocations: GitHubAuthorizationRevocationStore;
}

const MAX_WEBHOOK_BYTES = 256 * 1024;

export async function registerGitHubWebhookRoutes(
  app: FastifyInstance,
  options: GitHubWebhookOptions,
): Promise<void> {
  assertWebhookSecret(options.secret);
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    done(null, payload);
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: MAX_WEBHOOK_BYTES },
    (request, body, done) => {
      void request;
      done(null, body);
    },
  );

  app.post('/api/sync/github/webhook', async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new GatewayHttpError(400, 'GitHub webhook payload is invalid');
    }
    verifySignature(
      options.secret,
      body,
      singleHeader(request.headers['x-hub-signature-256']),
    );

    const event = requiredHeader(
      request.headers['x-github-event'],
      'GitHub webhook event is invalid',
    );
    if (event !== 'github_app_authorization') {
      return reply.code(204).send();
    }

    const deliveryId = requiredHeader(
      request.headers['x-github-delivery'],
      'GitHub webhook delivery ID is invalid',
    );
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new GatewayHttpError(400, 'GitHub webhook payload is invalid');
    }
    if (
      !isRecord(payload) ||
      payload['action'] !== 'revoked' ||
      !isRecord(payload['sender']) ||
      !Number.isSafeInteger(payload['sender']['id']) ||
      (payload['sender']['id'] as number) <= 0
    ) {
      throw new GatewayHttpError(400, 'GitHub webhook payload is invalid');
    }

    await options.revocations.revoke(
      payload['sender']['id'] as number,
      deliveryId,
    );
    return reply.code(204).send();
  });
}

function verifySignature(
  secret: string,
  body: Buffer,
  signature: string | undefined,
): void {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    throw new GatewayHttpError(401, 'GitHub webhook signature is invalid');
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');
  if (
    received.byteLength !== expected.byteLength ||
    !timingSafeEqual(received, expected)
  ) {
    throw new GatewayHttpError(401, 'GitHub webhook signature is invalid');
  }
}

function requiredHeader(
  value: string | string[] | undefined,
  message: string,
): string {
  const header = singleHeader(value);
  if (!header || header.length > 128 || !/^[a-z0-9._:-]+$/i.test(header)) {
    throw new GatewayHttpError(400, message);
  }
  return header;
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function assertWebhookSecret(secret: string): void {
  const size = Buffer.byteLength(secret, 'utf8');
  if (size < 32 || size > 1024 || secret.includes('\0')) {
    throw new TypeError('The GitHub webhook secret is invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
