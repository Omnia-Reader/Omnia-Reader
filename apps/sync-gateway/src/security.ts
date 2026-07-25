import type { FastifyRequest } from 'fastify';
import { GatewayHttpError } from './gateway-contract.js';

const SYNC_ROOT = '.omnia-reader/v1';
const MAX_PATH_LENGTH = 2048;

export function requireSameOriginMutation(request: FastifyRequest): void {
  if (request.headers['x-omnia-csrf'] !== '1') {
    throw new GatewayHttpError(403, 'Missing synchronization CSRF header');
  }
  requireSameOrigin(request);
}

export function requireSameOriginFormSubmission(request: FastifyRequest): void {
  requireSameOrigin(request);
}

function requireSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) {
    throw new GatewayHttpError(403, 'A same-origin request is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new GatewayHttpError(403, 'A same-origin request is required');
  }
  if (
    parsed.host !== host ||
    parsed.protocol !== `${request.protocol}:` ||
    !['http:', 'https:'].includes(parsed.protocol)
  ) {
    throw new GatewayHttpError(403, 'Cross-origin requests are not allowed');
  }

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') {
    throw new GatewayHttpError(403, 'Cross-site requests are not allowed');
  }
}

export function logicalSyncPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('%')
  ) {
    throw new GatewayHttpError(400, 'Invalid synchronization path');
  }

  const segments = value.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    (value !== SYNC_ROOT && !value.startsWith(`${SYNC_ROOT}/`))
  ) {
    throw new GatewayHttpError(400, 'Invalid synchronization path');
  }
  return value;
}

export function safeReturnPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\0')
  ) {
    return '/settings/sync';
  }
  return value;
}
