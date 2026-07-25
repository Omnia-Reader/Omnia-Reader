import { Readable } from 'node:stream';
import { HttpMegaSdkBridge } from './mega-sdk-bridge.js';

describe('HttpMegaSdkBridge', () => {
  it('authenticates the private bridge and validates a dumped SDK session', async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('https://bridge.example/v1/sessions');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(
          'Bearer private-bridge-token',
        );
        expect(JSON.parse(init?.body as string)).toEqual({
          email: 'reader@example.com',
          password: 'secret',
          multiFactorCode: '123456',
        });
        return Response.json({
          account: 'reader@example.com',
          session: 'dumped-sdk-session',
        });
      },
    );
    const bridge = createBridge(fetcher);

    await expect(
      bridge.login({
        email: 'reader@example.com',
        password: 'secret',
        multiFactorCode: '123456',
      }),
    ).resolves.toEqual({
      account: 'reader@example.com',
      session: 'dumped-sdk-session',
    });
  });

  it('encodes the reusable SDK session only in the private request header', async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/v1/files');
        expect(url.searchParams.get('rootHandle')).toBe('folder-handle');
        expect(url.searchParams.get('prefix')).toBe(
          '.omnia-reader/v1/progress',
        );
        const headers = new Headers(init?.headers);
        expect(
          Buffer.from(
            headers.get('x-omnia-mega-session') as string,
            'base64url',
          ).toString('utf8'),
        ).toBe('sdk-session');
        expect(String(input)).not.toContain('sdk-session');
        return Response.json({ files: [] });
      },
    );
    const bridge = createBridge(fetcher);

    await expect(
      bridge.files('sdk-session', 'folder-handle', '.omnia-reader/v1/progress'),
    ).resolves.toEqual([]);
  });

  it('streams file downloads from the bridge', async () => {
    const bytes = Buffer.from('publication bytes');
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/files/node-handle');
      expect(url.searchParams.get('rootHandle')).toBe('root-handle');
      return new Response(bytes);
    });
    const bridge = createBridge(fetcher);

    const content = await bridge.downloadFile(
      'sdk-session',
      'root-handle',
      'node-handle',
    );
    await expect(readAll(content)).resolves.toEqual(bytes);
  });

  it('confines file removal to the selected root', async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/v1/files/node-handle');
        expect(url.searchParams.get('rootHandle')).toBe('root-handle');
        expect(init?.method).toBe('DELETE');
        return new Response(null, { status: 204 });
      },
    );
    const bridge = createBridge(fetcher);

    await expect(
      bridge.removeFile('sdk-session', 'root-handle', 'node-handle'),
    ).resolves.toBeUndefined();
  });

  it('maps actionable SDK quota and session error codes', async () => {
    const storage = createBridge(
      vi.fn(async () =>
        Response.json(
          { code: 'STORAGE_QUOTA' },
          { status: 507, statusText: 'Insufficient Storage' },
        ),
      ),
    );
    await expect(storage.folders('session')).rejects.toMatchObject({
      statusCode: 507,
      message: 'The MEGA storage quota is exhausted',
    });

    const expired = createBridge(
      vi.fn(async () =>
        Response.json(
          { code: 'SESSION_EXPIRED' },
          { status: 401, statusText: 'Unauthorized' },
        ),
      ),
    );
    await expect(expired.folders('session')).rejects.toMatchObject({
      statusCode: 401,
      message: 'The MEGA session has expired',
    });
  });
});

function createBridge(fetcher: typeof fetch): HttpMegaSdkBridge {
  return new HttpMegaSdkBridge({
    baseUrl: 'https://bridge.example',
    token: 'private-bridge-token',
    fetcher,
  });
}

async function readAll(content: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
