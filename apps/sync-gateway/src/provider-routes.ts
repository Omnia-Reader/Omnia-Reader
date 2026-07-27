import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthorizationHttpError,
  GatewayHttpError,
  type DocumentWriteRequest,
  type SyncGatewayAdapter,
  type SyncProviderKind,
  supportsCredentialAuthorization,
  supportsDestinationCreation,
} from './gateway-contract.js';
import {
  logicalSyncPath,
  requireSameOriginFormSubmission,
  requireSameOriginMutation,
  safeReturnPath,
} from './security.js';

interface ProviderRouteOptions {
  kind: SyncProviderKind;
  adapter: SyncGatewayAdapter;
  secureCookies: boolean;
  maxPublicationBytes: number;
}

interface ProviderNames {
  destinationsPath: string;
  destinationsKey: string;
  selectionPath: string;
  documentListPath: string;
  documentListKey: string;
  documentPath: string;
  objectPath: string;
}

const NAMES: Record<SyncProviderKind, ProviderNames> = {
  github: {
    destinationsPath: '/repositories',
    destinationsKey: 'repositories',
    selectionPath: '/repository',
    documentListPath: '/files',
    documentListKey: 'files',
    documentPath: '/file',
    objectPath: '/lfs/object',
  },
  mega: {
    destinationsPath: '/folders',
    destinationsKey: 'folders',
    selectionPath: '/folder',
    documentListPath: '/documents',
    documentListKey: 'documents',
    documentPath: '/document',
    objectPath: '/object',
  },
};

export async function registerProviderRoutes(
  app: FastifyInstance,
  options: ProviderRouteOptions,
): Promise<void> {
  const names = NAMES[options.kind];
  const cookieName = `omnia_sync_${options.kind}`;

  app.get('/session', async (request, reply) => {
    const sessionId = session(request, reply, cookieName, options);
    return options.adapter.session(sessionId);
  });

  app.get<{ Querystring: { returnTo?: string } }>(
    '/auth/start',
    async (request, reply) => {
      const sessionId = session(request, reply, cookieName, options);
      authorizationHeaders(reply);
      const target = await options.adapter.authorizationUrl(
        sessionId,
        safeReturnPath(request.query.returnTo),
      );
      return reply.redirect(target);
    },
  );

  if (supportsCredentialAuthorization(options.adapter)) {
    const credentialAdapter = options.adapter;
    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/auth/login',
      async (request, reply) => {
        const sessionId = session(request, reply, cookieName, options);
        const parameters = boundedStringRecord(request.query);
        const page = await credentialAdapter.credentialAuthorizationPage(
          sessionId,
          parameters,
        );
        authorizationHeaders(reply);
        return reply
          .type('text/html; charset=utf-8')
          .send(loginPage(page, options.kind));
      },
    );

    app.post('/auth/login', async (request, reply) => {
      requireSameOriginFormSubmission(request);
      const sessionId = session(request, reply, cookieName, options);
      const replacementSessionId = randomUUID();
      const parameters = boundedStringRecord(request.body);
      try {
        const returnTo = await credentialAdapter.completeAuthorization(
          sessionId,
          replacementSessionId,
          parameters,
        );
        setSessionCookie(reply, cookieName, replacementSessionId, options);
        return reply.redirect(safeReturnPath(returnTo), 303);
      } catch (error) {
        if (!(error instanceof GatewayHttpError)) {
          throw error;
        }
        const page = await credentialAdapter.credentialAuthorizationPage(
          sessionId,
          parameters,
        );
        authorizationHeaders(reply);
        return reply
          .code(error.statusCode)
          .type('text/html; charset=utf-8')
          .send(
            loginPage(page, options.kind, authorizationError(error.statusCode)),
          );
      }
    });
  }

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/auth/callback',
    async (request, reply) => {
      const sessionId = session(request, reply, cookieName, options);
      const replacementSessionId = randomUUID();
      const parameters = Object.fromEntries(
        Object.entries(request.query).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && entry[1].length <= 4096,
        ),
      );
      authorizationHeaders(reply);
      try {
        const returnTo = await options.adapter.completeAuthorization(
          sessionId,
          replacementSessionId,
          parameters,
        );
        setSessionCookie(reply, cookieName, replacementSessionId, options);
        return reply.redirect(safeReturnPath(returnTo));
      } catch (error) {
        if (!(error instanceof GatewayHttpError)) {
          throw error;
        }
        clearSessionCookie(reply, cookieName, options);
        const outcome =
          error instanceof AuthorizationHttpError ? error.outcome : 'failed';
        return reply.redirect(
          `/settings/sync?syncAuth=${options.kind}-${outcome}`,
          303,
        );
      }
    },
  );

  app.delete('/session', async (request, reply) => {
    requireSameOriginMutation(request);
    const sessionId = session(request, reply, cookieName, options);
    await options.adapter.disconnect(sessionId);
    reply.clearCookie(cookieName, {
      path: `/api/sync/${options.kind}`,
    });
    return reply.code(204).send();
  });

  app.get(names.destinationsPath, async (request, reply) => {
    const sessionId = session(request, reply, cookieName, options);
    return {
      [names.destinationsKey]: await options.adapter.destinations(sessionId),
    };
  });

  app.put(names.selectionPath, async (request, reply) => {
    requireSameOriginMutation(request);
    const sessionId = session(request, reply, cookieName, options);
    return options.adapter.selectDestination(sessionId, request.body);
  });

  if (supportsDestinationCreation(options.adapter)) {
    const destinationAdapter = options.adapter;
    app.post(names.selectionPath, async (request, reply) => {
      requireSameOriginMutation(request);
      const sessionId = session(request, reply, cookieName, options);
      return destinationAdapter.createDestination(sessionId, request.body);
    });
  }

  app.get<{ Querystring: { prefix?: string } }>(
    names.documentListPath,
    async (request, reply) => {
      const prefix = logicalSyncPath(request.query.prefix);
      const sessionId = session(request, reply, cookieName, options);
      return {
        [names.documentListKey]: await options.adapter.listDocuments(
          sessionId,
          prefix,
        ),
      };
    },
  );

  app.get<{ Querystring: { path?: string; optional?: string } }>(
    names.documentPath,
    async (request, reply) => {
      const path = logicalSyncPath(request.query.path);
      const optional = optionalLookup(request.query.optional);
      const sessionId = session(request, reply, cookieName, options);
      const document = await options.adapter.readDocument(sessionId, path);
      if (document) {
        return document;
      }
      return optional
        ? reply.header('Cache-Control', 'no-store').code(204).send()
        : reply.code(404).send({ message: 'Document not found' });
    },
  );

  app.put(names.documentPath, async (request, reply) => {
    requireSameOriginMutation(request);
    const write = documentWrite(request.body);
    const sessionId = session(request, reply, cookieName, options);
    return options.adapter.writeDocument(sessionId, write);
  });

  app.delete<{
    Querystring: {
      path?: string;
      expectedRevision?: string;
      message?: string;
    };
  }>(names.documentPath, async (request, reply) => {
    requireSameOriginMutation(request);
    const path = logicalSyncPath(request.query.path);
    const expectedRevision = optionalRevision(request.query.expectedRevision);
    const message = documentMessage(request.query.message);
    const sessionId = session(request, reply, cookieName, options);
    await options.adapter.deleteDocument(sessionId, {
      path,
      message,
      ...(expectedRevision ? { expectedRevision } : {}),
    });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { path?: string; optional?: string } }>(
    `${names.objectPath}/metadata`,
    async (request, reply) => {
      const path = logicalSyncPath(request.query.path);
      const optional = optionalLookup(request.query.optional);
      const sessionId = session(request, reply, cookieName, options);
      const object = await options.adapter.headObject(sessionId, path);
      if (object) {
        return object;
      }
      return optional
        ? reply.header('Cache-Control', 'no-store').code(204).send()
        : reply.code(404).send({ message: 'Object not found' });
    },
  );

  app.get<{ Querystring: { path?: string } }>(
    names.objectPath,
    async (request, reply) => {
      const path = logicalSyncPath(request.query.path);
      const sessionId = session(request, reply, cookieName, options);
      const download = await options.adapter.downloadObject(sessionId, path);
      if (!download) {
        return reply.code(404).send({ message: 'Object not found' });
      }
      reply.type(download.mediaType);
      reply.header('Content-Length', download.metadata.size);
      reply.header('X-Omnia-SHA256', download.metadata.sha256);
      return reply.send(download.content);
    },
  );

  app.put<{ Querystring: { path?: string } }>(
    names.objectPath,
    async (request, reply) => {
      requireSameOriginMutation(request);
      const path = logicalSyncPath(request.query.path);
      const mediaType = publicationMediaType(request.headers['content-type']);
      if (
        (mediaType === 'application/pdf' && !path.endsWith('.pdf')) ||
        (mediaType === 'application/epub+zip' && !path.endsWith('.epub'))
      ) {
        throw new GatewayHttpError(
          400,
          'Publication path and media type do not match',
        );
      }
      const size = publicationSize(
        request.headers['x-omnia-size'],
        options.maxPublicationBytes,
      );
      const sha256 = publicationDigest(request.headers['x-omnia-sha256']);
      const contentLength = request.headers['content-length'];
      if (contentLength !== undefined && Number(contentLength) !== size) {
        throw new GatewayHttpError(
          400,
          'Content length does not match the declared publication size',
        );
      }
      const content = request.body;
      if (!isReadable(content)) {
        throw new GatewayHttpError(400, 'A publication body is required');
      }
      const sessionId = session(request, reply, cookieName, options);
      return options.adapter.uploadObject(sessionId, {
        path,
        mediaType,
        size,
        sha256,
        content,
      });
    },
  );

  app.delete<{
    Querystring: { path?: string; expectedRevision?: string };
  }>(names.objectPath, async (request, reply) => {
    requireSameOriginMutation(request);
    const path = logicalSyncPath(request.query.path);
    const expectedRevision = optionalRevision(request.query.expectedRevision);
    const sessionId = session(request, reply, cookieName, options);
    await options.adapter.deleteObject(sessionId, {
      path,
      ...(expectedRevision ? { expectedRevision } : {}),
    });
    return reply.code(204).send();
  });
}

function boundedStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length <= 64 &&
        typeof entry[1] === 'string' &&
        entry[1].length <= 4096,
    ),
  );
}

function optionalRevision(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0 || value.length > 1024 || value.includes('\0')) {
    throw new GatewayHttpError(400, 'The expected object revision is invalid');
  }
  return value;
}

function optionalLookup(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (value !== 'true') {
    throw new GatewayHttpError(400, 'Invalid optional lookup marker');
  }
  return true;
}

function authorizationHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header(
    'Content-Security-Policy',
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

function loginPage(
  page: {
    provider: string;
    state: string;
    accountLabel: string;
    passwordLabel: string;
    supportsMultiFactorCode: boolean;
  },
  kind: SyncProviderKind,
  error = '',
): string {
  const provider = escapeHtml(page.provider);
  const errorMarkup = error ? `<p role="alert">${escapeHtml(error)}</p>` : '';
  const multiFactorField = page.supportsMultiFactorCode
    ? `<p><label>Two-factor code (if enabled)<br><input name="multiFactorCode" inputmode="numeric" autocomplete="one-time-code" maxlength="16"></label></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Connect ${provider} · Omnia Reader</title>
</head>
<body>
  <main>
    <h1>Connect ${provider}</h1>
    <p>Your credentials are used once by the private synchronization gateway and are not stored by Omnia Reader.</p>
    ${errorMarkup}
    <form method="post" action="/api/sync/${kind}/auth/login">
      <input type="hidden" name="state" value="${escapeHtml(page.state)}">
      <p><label>${escapeHtml(page.accountLabel)}<br><input type="email" name="email" autocomplete="username" maxlength="320" required autofocus></label></p>
      <p><label>${escapeHtml(page.passwordLabel)}<br><input type="password" name="password" autocomplete="current-password" maxlength="1024" required></label></p>
      ${multiFactorField}
      <button type="submit">Connect ${provider}</button>
    </form>
  </main>
</body>
</html>`;
}

function authorizationError(statusCode: number): string {
  if (statusCode === 429) {
    return 'MEGA is temporarily rate limiting sign-in. Please try again later.';
  }
  if (statusCode >= 500) {
    return 'The MEGA connection service is temporarily unavailable.';
  }
  return 'The account, password, or two-factor code was not accepted.';
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as const
      )[character as '&' | '<' | '>' | '"' | "'"],
  );
}

function session(
  request: FastifyRequest,
  reply: FastifyReply,
  cookieName: string,
  options: ProviderRouteOptions,
): string {
  const existing = request.cookies[cookieName];
  if (
    existing &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      existing,
    )
  ) {
    return existing;
  }
  const created = randomUUID();
  setSessionCookie(reply, cookieName, created, options);
  return created;
}

function setSessionCookie(
  reply: FastifyReply,
  cookieName: string,
  value: string,
  options: ProviderRouteOptions,
): void {
  reply.setCookie(cookieName, value, {
    path: `/api/sync/${options.kind}`,
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: 'lax',
    maxAge: 60 * 60 * 12,
  });
}

function clearSessionCookie(
  reply: FastifyReply,
  cookieName: string,
  options: ProviderRouteOptions,
): void {
  reply.clearCookie(cookieName, {
    path: `/api/sync/${options.kind}`,
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: 'lax',
  });
}

function documentWrite(value: unknown): DocumentWriteRequest {
  if (!isRecord(value)) {
    throw new GatewayHttpError(400, 'Invalid document write request');
  }
  const path = logicalSyncPath(value['path']);
  const content = value['content'];
  const message = value['message'];
  const expectedRevision = value['expectedRevision'];
  if (
    typeof content !== 'string' ||
    content.length > 2 * 1024 * 1024 ||
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > 512 ||
    (expectedRevision !== undefined &&
      (typeof expectedRevision !== 'string' ||
        expectedRevision.length === 0 ||
        expectedRevision.length > 512))
  ) {
    throw new GatewayHttpError(400, 'Invalid document write request');
  }
  return {
    path,
    content,
    message,
    ...(typeof expectedRevision === 'string' ? { expectedRevision } : {}),
  };
}

function documentMessage(value: string | undefined): string {
  if (!value || value.length > 512 || value.includes('\0')) {
    throw new GatewayHttpError(400, 'Invalid document deletion message');
  }
  return value;
}

function publicationMediaType(
  value: string | undefined,
): 'application/epub+zip' | 'application/pdf' {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'application/epub+zip' || mediaType === 'application/pdf') {
    return mediaType;
  }
  throw new GatewayHttpError(400, 'Unsupported publication media type');
}

function publicationSize(value: unknown, maximum: number): number {
  const size =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) {
    throw new GatewayHttpError(400, 'Invalid publication size');
  }
  return size;
}

function publicationDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new GatewayHttpError(400, 'Invalid publication SHA-256');
  }
  return value;
}

function isReadable(value: unknown): value is Readable {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
