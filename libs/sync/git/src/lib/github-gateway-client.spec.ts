import { BrowserObjectUploadRequester } from '@omnia-reader/sync/core';
import { describe, expect, it, vi } from 'vitest';
import { GitConflictError } from './git-repository-transport';
import {
  GitHubGatewayClient,
  GitHubGatewayError,
  GitHubGatewayProtocolError,
} from './github-gateway-client';

const INSTALLATION_URL =
  'https://github.test/apps/omnia-reader/installations/new';

describe('GitHubGatewayClient', () => {
  it('loads the authenticated session through an HttpOnly-cookie request', async () => {
    const fetcher = mockFetch(
      jsonResponse({
        configured: true,
        authenticated: true,
        installationUrl: INSTALLATION_URL,
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

  it('preflights configuration and redirects only to a local return path', async () => {
    const redirect = vi.fn();
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(
        jsonResponse({
          configured: true,
          authenticated: false,
          installationUrl: INSTALLATION_URL,
        }),
      ),
      redirect,
      currentPath: () => 'https://attacker.invalid/',
    });

    await client.beginAuthorization();

    expect(redirect).toHaveBeenCalledWith(
      '/api/sync/github/auth/start?returnTo=%2Fsettings%2Fsync',
    );
  });

  it('keeps the user in the app when GitHub App credentials are absent', async () => {
    const redirect = vi.fn();
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(
        jsonResponse({ configured: false, authenticated: false }),
      ),
      redirect,
    });

    await expect(client.beginAuthorization('/settings/sync')).rejects.toEqual(
      expect.objectContaining<Partial<GitHubGatewayError>>({
        status: 503,
        message:
          'GitHub App authentication is not configured on this sync gateway',
      }),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not redirect when the local sync gateway is unavailable', async () => {
    const redirect = vi.fn();
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(new Response(null, { status: 500 })),
      redirect,
    });

    await expect(client.beginAuthorization('/settings/sync')).rejects.toEqual(
      expect.objectContaining<Partial<GitHubGatewayError>>({
        status: 500,
      }),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it('rejects an unsafe installation URL returned by the gateway', async () => {
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(
        jsonResponse({
          configured: true,
          authenticated: false,
          installationUrl: 'javascript:alert(1)',
        }),
      ),
    });

    await expect(client.session()).rejects.toBeInstanceOf(
      GitHubGatewayProtocolError,
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
        configured: true,
        authenticated: true,
        installationUrl: INSTALLATION_URL,
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

  it('creates a private repository through the session gateway', async () => {
    const repository = {
      id: 12,
      fullName: 'reader/omnia-reader-library',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    };
    const fetcher = mockFetch(
      jsonResponse({
        repository,
        selected: true,
        session: {
          configured: true,
          authenticated: true,
          installationUrl: INSTALLATION_URL,
          user: { id: 7, login: 'reader', avatarUrl: '' },
          repository,
        },
        installationSettingsUrl: null,
      }),
    );
    const client = new GitHubGatewayClient({ fetcher });

    await expect(
      client.createRepository(' omnia-reader-library '),
    ).resolves.toMatchObject({
      repository: { id: 12 },
      selected: true,
      session: { authenticated: true, repository: { id: 12 } },
    });

    const init = fetcher.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"name":"omnia-reader-library"}');
    expect(headers.get('X-Omnia-CSRF')).toBe('1');
  });

  it('preserves a repository permission denial for actionable UI recovery', async () => {
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(
        jsonResponse(
          { message: 'Resource not accessible by integration' },
          403,
        ),
      ),
    });

    await expect(
      client.createRepository('omnia-reader-library'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitHubGatewayError>>({
        status: 403,
        message: 'Resource not accessible by integration',
      }),
    );
  });

  it('preserves a bounded gateway retry delay for GitHub rate limits', async () => {
    const client = new GitHubGatewayClient({
      fetcher: mockFetch(
        jsonResponse(
          { message: 'GitHub is temporarily rate limiting synchronization' },
          429,
          { 'Retry-After': '120' },
        ),
      ),
    });

    await expect(client.repositories()).rejects.toEqual(
      expect.objectContaining<Partial<GitHubGatewayError>>({
        status: 429,
        retryAfterSeconds: 120,
        message: 'GitHub is temporarily rate limiting synchronization',
      }),
    );
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

  it('revision-deletes a document with a bounded commit message', async () => {
    const fetcher = mockFetch(new Response(null, { status: 204 }));
    const client = new GitHubGatewayClient({ fetcher });
    const path = '.omnia-reader/v1/library/A--aaaaaaaaaaaa/book.json';

    await client.deleteDocument({
      path,
      expectedRevision: 'document-revision',
      message: 'Delete A',
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain('/file?');
    expect(url).toContain(`path=${encodeURIComponent(path)}`);
    expect(url).toContain('expectedRevision=document-revision');
    expect(url).toContain('message=Delete+A');
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('X-Omnia-CSRF')).toBe('1');
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

  it('streams publication bytes with upload and download progress', async () => {
    const object = {
      path: '.omnia-reader/v1/books/id/publication.pdf',
      revision: 'lfs-object',
      size: 3,
      sha256: 'a'.repeat(64),
    };
    const uploadProgress: number[] = [];
    const uploadRequester = vi.fn<BrowserObjectUploadRequester>(
      async (_url, _headers, request) => {
        request.onProgress?.({
          direction: 'upload',
          path: request.path,
          transferredBytes: 0,
          totalBytes: request.size,
        });
        request.onProgress?.({
          direction: 'upload',
          path: request.path,
          transferredBytes: request.size,
          totalBytes: request.size,
        });
        return jsonResponse(object);
      },
    );
    const uploadClient = new GitHubGatewayClient({ uploadRequester });

    await uploadClient.uploadObject({
      path: object.path,
      content: new Blob(['pdf']),
      size: object.size,
      sha256: object.sha256,
      mediaType: 'application/pdf',
      onProgress: (progress) => uploadProgress.push(progress.transferredBytes),
    });

    expect(uploadProgress[0]).toBe(0);
    expect(uploadProgress[uploadProgress.length - 1]).toBe(3);
    const uploadHeaders = uploadRequester.mock.calls[0]?.[1];
    expect(uploadHeaders?.get('X-Omnia-CSRF')).toBe('1');
    expect(uploadHeaders?.get('X-Omnia-SHA256')).toBe(object.sha256);

    const downloadProgress: number[] = [];
    const downloadClient = new GitHubGatewayClient({
      fetcher: mockFetch(
        new Response('pdf', {
          headers: {
            'Content-Length': '3',
            'Content-Type': 'application/pdf',
          },
        }),
      ),
    });
    const downloaded = await downloadClient.downloadObject(object.path, {
      expectedSize: object.size,
      onProgress: (progress) =>
        downloadProgress.push(progress.transferredBytes),
    });

    await expect(blobText(downloaded)).resolves.toBe('pdf');
    expect(downloadProgress[0]).toBe(0);
    expect(downloadProgress[downloadProgress.length - 1]).toBe(3);
  });

  it('revision-deletes a Git LFS pointer with CSRF protection', async () => {
    const fetcher = mockFetch(new Response(null, { status: 204 }));
    const client = new GitHubGatewayClient({ fetcher });
    const path = '.omnia-reader/v1/books/id/publication.pdf';

    await client.deleteObject({
      path,
      expectedRevision: 'pointer-revision',
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain('/lfs/object?');
    expect(url).toContain(`path=${encodeURIComponent(path)}`);
    expect(url).toContain('expectedRevision=pointer-revision');
    expect(init?.method).toBe('DELETE');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('X-Omnia-CSRF')).toBe('1');
  });

  it('treats missing object deletion as complete and maps revision conflicts', async () => {
    const missingClient = new GitHubGatewayClient({
      fetcher: mockFetch(new Response(null, { status: 404 })),
    });
    await expect(
      missingClient.deleteObject({ path: 'publication.pdf' }),
    ).resolves.toBeUndefined();

    const conflictClient = new GitHubGatewayClient({
      fetcher: mockFetch(new Response(null, { status: 409 })),
    });
    await expect(
      conflictClient.deleteObject({
        path: 'publication.pdf',
        expectedRevision: 'stale',
      }),
    ).rejects.toBeInstanceOf(GitConflictError);
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

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}
