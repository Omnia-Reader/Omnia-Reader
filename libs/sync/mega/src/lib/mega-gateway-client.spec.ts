import { SyncConflictError } from '@omnia-reader/sync/core';
import { describe, expect, it, vi } from 'vitest';
import {
  MegaGatewayClient,
  MegaGatewayProtocolError,
} from './mega-gateway-client';

const folder = {
  handle: 'node-handle',
  name: 'Omnia Reader',
  path: '/Omnia Reader',
  canWrite: true,
};

describe('MegaGatewayClient', () => {
  it('loads a server-side MEGA session without exposing reusable credentials', async () => {
    const fetcher = mockFetch(
      jsonResponse({
        authenticated: true,
        account: 'reader@example.test',
        folder,
      }),
    );
    const client = new MegaGatewayClient({ fetcher });

    await expect(client.session()).resolves.toMatchObject({
      authenticated: true,
      account: 'reader@example.test',
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/sync/mega/session',
      expect.objectContaining({ credentials: 'include', method: 'GET' }),
    );
  });

  it('uses a gateway-owned authorization page and rejects open redirects', () => {
    const redirect = vi.fn();
    const client = new MegaGatewayClient({
      fetcher: mockFetch(jsonResponse({})),
      redirect,
      currentPath: () => '//attacker.invalid',
    });

    client.beginAuthorization();

    expect(redirect).toHaveBeenCalledWith(
      '/api/sync/mega/auth/start?returnTo=%2Fsettings%2Fsync',
    );
  });

  it('lists folders and protects folder selection with a CSRF header', async () => {
    const fetcher = sequenceFetch(
      jsonResponse({ folders: [folder] }),
      jsonResponse({
        authenticated: true,
        account: 'reader@example.test',
        folder,
      }),
    );
    const client = new MegaGatewayClient({ fetcher });

    await expect(client.folders()).resolves.toEqual([folder]);
    await expect(client.selectFolder(folder.handle)).resolves.toMatchObject({
      authenticated: true,
      folder,
    });

    const init = fetcher.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get('X-Omnia-CSRF')).toBe('1');
    expect(init?.body).toBe('{"handle":"node-handle"}');
  });

  it('uploads an immutable publication with declared hash and size', async () => {
    const object = {
      path: '.omnia-reader/v1/books/id/publication.epub',
      revision: 'node-version',
      size: 3,
      sha256: 'a'.repeat(64),
    };
    const fetcher = mockFetch(jsonResponse(object));
    const client = new MegaGatewayClient({ fetcher });

    await expect(
      client.uploadObject({
        path: object.path,
        content: new Blob(['abc']),
        size: object.size,
        sha256: object.sha256,
        mediaType: 'application/epub+zip',
      }),
    ).resolves.toEqual(object);

    const init = fetcher.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Omnia-SHA256')).toBe(object.sha256);
    expect(headers.get('X-Omnia-Size')).toBe('3');
    expect(headers.get('X-Omnia-CSRF')).toBe('1');
  });

  it('maps duplicate-revision conflicts and rejects malformed nodes', async () => {
    const conflictClient = new MegaGatewayClient({
      fetcher: mockFetch(new Response(null, { status: 409 })),
    });
    await expect(
      conflictClient.write({ path: 'p', content: 'c', message: 'm' }),
    ).rejects.toBeInstanceOf(SyncConflictError);

    const malformedClient = new MegaGatewayClient({
      fetcher: mockFetch(
        jsonResponse({ folders: [{ name: 'missing handle' }] }),
      ),
    });
    await expect(malformedClient.folders()).rejects.toBeInstanceOf(
      MegaGatewayProtocolError,
    );
  });

  it('revision-deletes a publication object with CSRF protection', async () => {
    const fetcher = mockFetch(new Response(null, { status: 204 }));
    const client = new MegaGatewayClient({ fetcher });
    const path = '.omnia-reader/v1/books/id/publication.epub';

    await client.deleteObject({
      path,
      expectedRevision: 'node-revision',
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain('/object?');
    expect(url).toContain(`path=${encodeURIComponent(path)}`);
    expect(url).toContain('expectedRevision=node-revision');
    expect(init?.method).toBe('DELETE');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('X-Omnia-CSRF')).toBe('1');
  });

  it('treats a missing object as deleted and maps revision conflicts', async () => {
    const missingClient = new MegaGatewayClient({
      fetcher: mockFetch(new Response(null, { status: 404 })),
    });
    await expect(
      missingClient.deleteObject({ path: 'publication.epub' }),
    ).resolves.toBeUndefined();

    const conflictClient = new MegaGatewayClient({
      fetcher: mockFetch(new Response(null, { status: 409 })),
    });
    await expect(
      conflictClient.deleteObject({
        path: 'publication.epub',
        expectedRevision: 'stale',
      }),
    ).rejects.toBeInstanceOf(SyncConflictError);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(response: Response) {
  return vi.fn<typeof fetch>(() => Promise.resolve(response));
}

function sequenceFetch(...responses: Response[]) {
  return vi.fn<typeof fetch>(() => {
    const response = responses.shift();
    if (!response) {
      throw new Error('Unexpected fetch');
    }
    return Promise.resolve(response);
  });
}
