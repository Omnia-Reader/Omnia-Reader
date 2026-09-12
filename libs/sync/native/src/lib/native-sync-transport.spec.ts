import { SyncConflictError } from '@omnia-reader/sync/core';
import { vi } from 'vitest';
import {
  NativeSyncCommand,
  NativeSyncInvoke,
  NativeSyncTransport,
  NativeSyncTransportError,
  parseNativeSyncBrokerStatus,
} from './native-sync-transport';

const ORIGIN = 'https://sync.reader.test';
const PATH = '.omnia-reader/manifest.json';

function brokerStatus(gatewayOrigin = ORIGIN) {
  return {
    gatewayOrigin,
    persistenceMode: 'session-only' as const,
    persistenceVersion: null,
    restartRequiresReauthentication: true as const,
  };
}

describe('NativeSyncTransport', () => {
  it('accepts only the exact broker origin and sends enumerated typed operations', async () => {
    const invoke = nativeInvoke({
      sync_broker_status: brokerStatus(),
      sync_read_document: {
        path: PATH,
        content: '{}',
        revision: 'revision-1',
      },
    });
    const transport = createTransport(invoke);

    await expect(transport.read(PATH)).resolves.toEqual({
      path: PATH,
      content: '{}',
      revision: 'revision-1',
    });

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'sync_broker_status',
      'sync_read_document',
    ]);
    const operation = invoke.mock.calls[1]?.[1];
    expect(operation).toMatchObject({ provider: 'git', path: PATH });
    expect(operation).not.toHaveProperty('url');
    expect(operation).not.toHaveProperty('method');
    expect(operation).not.toHaveProperty('headers');

    const mismatched = createTransport(
      nativeInvoke({
        sync_broker_status: brokerStatus('https://other.test'),
      }),
    );
    await expect(mismatched.read(PATH)).rejects.toMatchObject({
      code: 'origin-mismatch',
    });
  });

  it('rejects insecure, credentialed, and non-origin gateway values', () => {
    for (const origin of [
      'http://sync.reader.test',
      'https://user:secret@sync.reader.test',
      'https://sync.reader.test/path',
      'https://sync.reader.test#fragment',
    ]) {
      expect(
        () =>
          new NativeSyncTransport({
            provider: 'git',
            gatewayOrigin: origin,
            invoke: nativeInvoke({}),
          }),
      ).toThrow('gateway origin is invalid');
    }
  });

  it('accepts only internally consistent protected or session-only status', () => {
    expect(parseNativeSyncBrokerStatus(brokerStatus(), false)).toEqual(
      brokerStatus(),
    );
    expect(
      parseNativeSyncBrokerStatus(
        {
          gatewayOrigin: ORIGIN,
          persistenceMode: 'protected',
          persistenceVersion: 1,
          restartRequiresReauthentication: false,
        },
        false,
      ),
    ).toMatchObject({
      persistenceMode: 'protected',
      persistenceVersion: 1,
      restartRequiresReauthentication: false,
    });
    expect(() =>
      parseNativeSyncBrokerStatus(
        {
          ...brokerStatus(),
          persistenceMode: 'protected',
          persistenceVersion: null,
        },
        false,
      ),
    ).toThrow('unsafe response');
    expect(() =>
      parseNativeSyncBrokerStatus(
        brokerStatus('https://user:secret@sync.reader.test'),
        false,
      ),
    ).toThrow('unsafe response');
  });

  it('bounds document lists and downloaded chunks before returning them', async () => {
    const oversizedList = createTransport(
      nativeInvoke({
        sync_broker_status: brokerStatus(),
        sync_list_documents: [
          {
            path: PATH,
            content: 'x'.repeat(1025),
            revision: 'revision-1',
          },
        ],
      }),
      { maxDocumentBytes: 1024 },
    );
    await expect(oversizedList.list('.omnia-reader')).rejects.toMatchObject({
      code: 'invalid-response',
    });

    const oversizedChunk = createTransport(
      nativeInvoke({
        sync_broker_status: brokerStatus(),
        sync_download_begin: {
          transferId: 'transfer-12345678',
          size: 16_385,
          mediaType: 'application/pdf',
        },
        sync_download_chunk: {
          bytes: new Array(16_385).fill(1),
          done: true,
        },
      }),
      { chunkBytes: 16_384 },
    );
    await expect(
      oversizedChunk.downloadObject('.omnia-reader/library/book.pdf'),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('chunks uploads and reports monotonic progress without exposing a URL', async () => {
    const content = new Blob([new Uint8Array(40_000).fill(7)]);
    const progress: number[] = [];
    const invoke = nativeInvoke({
      sync_broker_status: brokerStatus(),
      sync_upload_begin: { transferId: 'transfer-12345678' },
      sync_upload_chunk: undefined,
      sync_upload_finish: {
        path: '.omnia-reader/library/book.pdf',
        revision: 'revision-1',
        size: content.size,
        sha256: 'a'.repeat(64),
      },
    });
    const transport = createTransport(invoke, { chunkBytes: 16_384 });

    await transport.uploadObject({
      path: '.omnia-reader/library/book.pdf',
      content,
      size: content.size,
      sha256: 'a'.repeat(64),
      mediaType: 'application/pdf',
      onProgress: (value) => progress.push(value.transferredBytes),
    });

    expect(progress).toEqual([0, 16_384, 32_768, 40_000]);
    const chunks = invoke.mock.calls.filter(
      ([command]) => command === 'sync_upload_chunk',
    );
    expect(chunks).toHaveLength(3);
    expect(
      chunks.map(([, value]) =>
        value instanceof Uint8Array ? value.byteLength : -1,
      ),
    ).toEqual([16_384, 16_384, 7_232]);
    expect(chunks[0]?.[2]?.headers).toEqual({
      'X-Omnia-Sync-Request-Id': 'webview-1',
      'X-Omnia-Sync-Provider': 'git',
      'X-Omnia-Sync-Transfer-Id': 'transfer-12345678',
      'X-Omnia-Sync-Offset': '0',
    });
    expect(
      invoke.mock.calls.some(
        ([, value]) => !(value instanceof Uint8Array) && 'url' in value,
      ),
    ).toBe(false);
  });

  it('maps conflicts and redirect failures without leaking native detail', async () => {
    const invoke = vi.fn<NativeSyncInvoke>(async (command) => {
      if (command === 'sync_broker_status') {
        return brokerStatus();
      }
      throw {
        code:
          command === 'sync_write_document' ? 'conflict' : 'redirect-denied',
        message: 'provider cookie secret-canary',
      };
    });
    const transport = createTransport(invoke);

    await expect(
      transport.write({ path: PATH, content: '{}', message: 'write' }),
    ).rejects.toBeInstanceOf(SyncConflictError);
    await expect(transport.read(PATH)).rejects.toMatchObject({
      code: 'redirect-denied',
      message: 'The synchronization service returned an unsafe response.',
    });
    await expect(transport.read(PATH)).rejects.not.toThrow('secret-canary');
  });

  it('cancels an active request from AbortSignal and remains reusable', async () => {
    let releaseRevision: (value: unknown) => void = () => undefined;
    const pendingRevision = new Promise<unknown>((resolve) => {
      releaseRevision = resolve;
    });
    let revisionAttempt = 0;
    const invoke = vi.fn<NativeSyncInvoke>(async (command) => {
      if (command === 'sync_broker_status') {
        return brokerStatus();
      }
      if (command === 'sync_destination_revision') {
        revisionAttempt += 1;
        return revisionAttempt === 1 ? pendingRevision : 'revision-2';
      }
      return undefined;
    });
    const transport = createTransport(invoke);
    const controller = new AbortController();
    const revision = transport.destinationRevision({
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sync_destination_revision',
        expect.objectContaining({ provider: 'git' }),
        undefined,
      ),
    );

    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(revision).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === 'sync_cancel_request',
      ),
    ).not.toHaveLength(0);
    await expect(transport.destinationRevision()).resolves.toBe('revision-2');

    releaseRevision('late-revision');
    await transport.dispose();
  });

  it('cancels active work and tears down once without accepting new requests', async () => {
    let releaseRead: (value: unknown) => void = () => undefined;
    const pendingRead = new Promise<unknown>((resolve) => {
      releaseRead = resolve;
    });
    const invoke = vi.fn<NativeSyncInvoke>(async (command) => {
      if (command === 'sync_broker_status') {
        return brokerStatus();
      }
      if (command === 'sync_read_document') {
        return pendingRead;
      }
      return undefined;
    });
    const transport = createTransport(invoke);
    const read = transport.read(PATH);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sync_read_document',
        expect.objectContaining({ path: PATH }),
        undefined,
      ),
    );

    await transport.dispose();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke.mock.calls.map(([command]) => command)).toContain(
      'sync_cancel_request',
    );
    expect(
      invoke.mock.calls.filter(([command]) => command === 'sync_teardown'),
    ).toHaveLength(1);
    await transport.dispose();
    await expect(transport.read(PATH)).rejects.toBeInstanceOf(
      NativeSyncTransportError,
    );

    releaseRead({ path: PATH, content: '{}', revision: 'late' });
  });
});

function createTransport(
  invoke: ReturnType<typeof vi.fn<NativeSyncInvoke>>,
  limits: Partial<
    Pick<
      ConstructorParameters<typeof NativeSyncTransport>[0],
      'chunkBytes' | 'maxDocumentBytes'
    >
  > = {},
): NativeSyncTransport {
  return new NativeSyncTransport({
    provider: 'git',
    gatewayOrigin: ORIGIN,
    invoke,
    ...limits,
  });
}

function nativeInvoke(
  responses: Partial<Record<NativeSyncCommand, unknown>>,
): ReturnType<typeof vi.fn<NativeSyncInvoke>> {
  return vi.fn<NativeSyncInvoke>(async (command) => responses[command]);
}
