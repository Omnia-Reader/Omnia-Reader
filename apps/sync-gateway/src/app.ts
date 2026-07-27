import cookie from '@fastify/cookie';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  GatewayHttpError,
  type SyncGatewayAdapter,
} from './gateway-contract.js';
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookOptions,
} from './github-webhook.js';
import { registerProviderRoutes } from './provider-routes.js';

export interface SyncGatewayOptions {
  github: SyncGatewayAdapter;
  githubWebhook?: GitHubWebhookOptions;
  mega: SyncGatewayAdapter;
  logger?: boolean;
  secureCookies?: boolean;
  maxPublicationBytes?: number;
}

export function buildSyncGateway(options: SyncGatewayOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
  });
  const secureCookies = options.secureCookies ?? true;
  const maxPublicationBytes =
    options.maxPublicationBytes ?? 2 * 1024 * 1024 * 1024;

  app.register(cookie, { hook: 'onRequest' });
  app.addContentTypeParser(
    ['application/epub+zip', 'application/pdf'],
    (request, payload, done) => {
      void request;
      done(null, payload);
    },
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (request, body, done) => {
      void request;
      try {
        const parameters = new URLSearchParams(
          typeof body === 'string' ? body : body.toString('utf8'),
        );
        const value: Record<string, string> = {};
        for (const key of parameters.keys()) {
          const values = parameters.getAll(key);
          if (values.length !== 1 || key.length === 0 || key.length > 64) {
            throw new Error('Invalid form body');
          }
          value[key] = values[0] ?? '';
        }
        done(null, value);
      } catch (error) {
        done(error as Error);
      }
    },
  );

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'omnia-reader-sync-gateway',
  }));

  const githubWebhook = options.githubWebhook;
  if (githubWebhook) {
    app.register((instance) =>
      registerGitHubWebhookRoutes(instance, githubWebhook),
    );
  }
  app.register(
    (instance) =>
      registerProviderRoutes(instance, {
        kind: 'github',
        adapter: options.github,
        secureCookies,
        maxPublicationBytes,
      }),
    { prefix: '/api/sync/github' },
  );
  app.register(
    (instance) =>
      registerProviderRoutes(instance, {
        kind: 'mega',
        adapter: options.mega,
        secureCookies,
        maxPublicationBytes,
      }),
    { prefix: '/api/sync/mega' },
  );

  app.setErrorHandler(
    (error: FastifyError | GatewayHttpError, request, reply) => {
      void request;
      if (error instanceof GatewayHttpError) {
        const response = reply.code(error.statusCode);
        if (error.retryAfterSeconds !== undefined) {
          response.header('Retry-After', String(error.retryAfterSeconds));
        }
        return response.send({ message: error.message });
      }
      if (
        error.statusCode &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      ) {
        return reply
          .code(error.statusCode)
          .send({ message: 'Malformed synchronization request' });
      }
      app.log.error(error);
      return reply
        .code(500)
        .send({ message: 'Synchronization gateway request failed' });
    },
  );

  return app;
}
