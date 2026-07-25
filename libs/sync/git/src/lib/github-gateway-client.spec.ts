import { describe, expect, it, vi } from 'vitest';
import { GitConflictError } from './git-repository-transport';
import {
  GitHubGatewayClient,
  GitHubGatewayProtocolError,
} from './github-gateway-client';

describe('GitHubGatewayClient', () => {
  it('loads the authenticated session through an HttpOnly-cookie request', async () => {
    const fetcher = mockFetch(
      jsonResponse({
        authenticated: true,
        user: { id: 7, login: 'reader', avatarUrl: '' },
        repository: {
          id: 11,
          fullName: 'reader/progress',
          private: true,
          defaultBranch: 'main',
          canPush: true,
        },
      }),
    );
    const client = new GitHubGatewayClient({ fetcher });

    await expect(client.session()).resolves.toMatchObject({
      authenticated: true,
      user: { login: 'reader' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/sync/github/session',
      expect.objectContaining({ credentials: 'include', method: 'GET' }),
    );
  });

  it('redirects only to a local return path', () => {
    const redirect = vi.fn();
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(jsonResponse({})),
      redirect,
      currentPath: () => 'https://attacker.invalid/',
    });

    client.beginAuthorization();

    expect(redirect).toHaveBeenCalledWith(
      '/api/sync/github/auth/start?returnTo=%2Fsettings%2Fsync',
    );
  });

  it('lists and selects writable repositories with CSRF protection', async () => {
    const fetcher = sequenceFetch(
      jsonResponse({
        repositories: [
          {
            id: 11,
            fullName: 'reader/progress',
            private: true,
            defaultBranch: 'main',
            canPush: true,
          },
        ],
      }),
      jsonResponse({
        authenticated: true,
        user: { id: 7, login: 'reader', avatarUrl: '' },
        repository: {
          id: 11,
          fullName: 'reader/progress',
          private: true,
          defaultBranch: 'main',
          canPush: true,
        },
      }),
    );
    const client = new GitHubGatewayClient({ fetcher });

    await expect(client.repositories()).resolves.toHaveLength(1);
    await expect(client.selectRepository(11)).resolves.toMatchObject({
      authenticated: true,
      repository: { id: 11 },
    });

    const selectionInit = fetcher.mock.calls[1]?.[1];
    const headers = new Headers(selectionInit?.headers);
    expect(selectionInit?.method).toBe('PUT');
    expect(selectionInit?.credentials).toBe('include');
    expect(headers.get('X-Omnia-CSRF')).toBe('1');
    expect(selectionInit?.body).toBe('{"repositoryId":11}');
  });

  it('implements list, missing-file reads, and optimistic writes', async () => {
    const file = {
      path: '.omnia-reader/v1/progress/book/device.json',
      content: '{}\n',
      revision: 'abc123',
    };
    const fetcher = sequenceFetch(
      jsonResponse({ files: [file] }),
      new Response(null, { status: 404 }),
      jsonResponse(file),
    );
    const client = new GitHubGatewayClient({ fetcher });

    await expect(client.list('.omnia-reader/v1/progress')).resolves.toEqual([
      file,
    ]);
    await expect(client.read(file.path)).resolves.toBeNull();
    await expect(
      client.write({
        path: file.path,
        content: file.content,
        expectedRevision: 'old',
        message: 'Update progress',
      }),
    ).resolves.toEqual(file);

    expect(fetcher.mock.calls[0]?.[0]).toContain(
      'prefix=.omnia-reader%2Fv1%2Fprogress',
    );
    const writeHeaders = new Headers(fetcher.mock.calls[2]?.[1]?.headers);
    expect(writeHeaders.get('X-Omnia-CSRF')).toBe('1');
  });

  it('maps HTTP 409 writes to the sync coordinator conflict type', async () => {
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(new Response(null, { status: 409 })),
    });

    await expect(
      client.write({ path: 'p', content: 'c', message: 'm' }),
    ).rejects.toBeInstanceOf(GitConflictError);
  });

  it('declares and uploads Git LFS publication objects through the gateway', async () => {
    const object = {
      path: '.omnia-reader/v1/books/id/publication.pdf',
      revision: 'lfs-object',
      size: 3,
      sha256: 'a'.repeat(64),
    };
    const fetcher = sequenceFetch(jsonResponse(object), jsonResponse(object));
    const client = new GitHubGatewayClient({ fetcher });

    await expect(client.headObject(object.path)).resolves.toEqual(object);
    await expect(
      client.uploadObject({
        path: object.path,
        content: new Blob(['pdf']),
        size: object.size,
        sha256: object.sha256,
        mediaType: 'application/pdf',
      }),
    ).resolves.toEqual(object);

    expect(fetcher.mock.calls[0]?.[0]).toContain('/lfs/object/metadata?path=');
    const uploadInit = fetcher.mock.calls[1]?.[1];
    const headers = new Headers(uploadInit?.headers);
    expect(uploadInit?.method).toBe('PUT');
    expect(headers.get('X-Omnia-SHA256')).toBe(object.sha256);
    expect(headers.get('X-Omnia-Size')).toBe('3');
    expect(headers.get('X-Omnia-CSRF')).toBe('1');
  });

  it('rejects malformed gateway documents instead of trusting them', async () => {
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(jsonResponse({ files: [{ path: '../escape' }] })),
    });

    await expect(client.list('.omnia-reader')).rejects.toBeInstanceOf(
      GitHubGatewayProtocolError,
    );
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
