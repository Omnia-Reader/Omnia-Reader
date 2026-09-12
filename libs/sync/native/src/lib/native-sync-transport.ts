import {
  DocumentDeleteRequest,
  DocumentWriteRequest,
  LibrarySyncTransport,
  ObjectDeleteRequest,
  ObjectDownloadOptions,
  ObjectUploadRequest,
  RemoteDocument,
  RemoteObject,
  RemoteSyncEntry,
  RemoteSyncEntryDeleteRequest,
  SyncConflictError,
} from '@omnia-reader/sync/core';

export type NativeSyncProvider = 'git' | 'mega';

export type NativeSyncCommand =
  | 'sync_broker_status'
  | 'sync_destination_revision'
  | 'sync_list_documents'
  | 'sync_list_entries'
  | 'sync_delete_entries'
  | 'sync_delete_entry'
  | 'sync_read_document'
  | 'sync_write_document'
  | 'sync_delete_document'
  | 'sync_head_object'
  | 'sync_download_begin'
  | 'sync_download_chunk'
  | 'sync_download_finish'
  | 'sync_upload_begin'
  | 'sync_upload_chunk'
  | 'sync_upload_finish'
  | 'sync_delete_object'
  | 'sync_cancel_request'
  | 'sync_teardown';

export type NativeSyncInvoke = (
  command: NativeSyncCommand,
  body: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
) => Promise<unknown>;

export interface NativeSyncTransportOptions {
  provider: NativeSyncProvider;
  gatewayOrigin?: string;
  invoke?: NativeSyncInvoke;
  allowInsecureLoopback?: boolean;
  chunkBytes?: number;
  maxDocumentBytes?: number;
  maxListBytes?: number;
  maxObjectBytes?: number;
}

export type NativeSyncErrorCode =
  | 'authentication-required'
  | 'cancelled'
  | 'conflict'
  | 'invalid-response'
  | 'origin-mismatch'
  | 'permission-denied'
  | 'rate-limited'
  | 'redirect-denied'
  | 'transport-unavailable';

export class NativeSyncTransportError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    readonly code: NativeSyncErrorCode,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(errorMessage(code));
    this.name = 'NativeSyncTransportError';
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

interface TransferStart {
  transferId: string;
  size?: number;
  mediaType?: string;
}

interface DownloadChunk {
  bytes: number[];
  done: boolean;
}

const DEFAULT_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LIST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LIST_ENTRIES = 50_000;
const MAX_DELETE_ENTRIES = 10_000;
const TRANSFER_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_ID_HEADER = 'X-Omnia-Sync-Request-Id';
const PROVIDER_HEADER = 'X-Omnia-Sync-Provider';
const TRANSFER_ID_HEADER = 'X-Omnia-Sync-Transfer-Id';
const OFFSET_HEADER = 'X-Omnia-Sync-Offset';

/**
 * Packaged-host implementation of the provider-neutral synchronization
 * transport. The webview can select only an enumerated operation and provider;
 * URL construction, cookies, redirects, headers, and reusable authority remain
 * inside the native broker.
 */
export class NativeSyncTransport implements LibrarySyncTransport {
  private readonly invokeNative: NativeSyncInvoke;
  private readonly gatewayOrigin: string | null;
  private readonly chunkBytes: number;
  private readonly maxDocumentBytes: number;
  private readonly maxListBytes: number;
  private readonly maxObjectBytes: number;
  private readonly activeRequests = new Map<string, (reason: Error) => void>();
  private readyPromise: Promise<void> | null = null;
  private disposed = false;
  private requestSequence = 0;

  constructor(private readonly options: NativeSyncTransportOptions) {
    this.gatewayOrigin = options.gatewayOrigin
      ? exactGatewayOrigin(
          options.gatewayOrigin,
          options.allowInsecureLoopback ?? false,
        )
      : null;
    this.invokeNative = options.invoke ?? invokeTauri;
    this.chunkBytes = boundedInteger(
      options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
      16 * 1024,
      8 * 1024 * 1024,
      'Native synchronization chunk size',
    );
    this.maxDocumentBytes = boundedInteger(
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      1024,
      16 * 1024 * 1024,
      'Native synchronization document limit',
    );
    this.maxListBytes = boundedInteger(
      options.maxListBytes ?? DEFAULT_MAX_LIST_BYTES,
      this.maxDocumentBytes,
      64 * 1024 * 1024,
      'Native synchronization list limit',
    );
    this.maxObjectBytes = boundedInteger(
      options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES,
      this.chunkBytes,
      DEFAULT_MAX_OBJECT_BYTES,
      'Native synchronization object limit',
    );
  }

  async destinationRevision(
    options: Pick<ObjectDownloadOptions, 'signal'> = {},
  ): Promise<string | null> {
    const value = await this.execute<unknown>(
      'sync_destination_revision',
      {},
      options.signal,
    );
    if (value !== null && !isBoundedString(value, 1024)) {
      throw invalidResponse();
    }
    return value as string | null;
  }

  async list(prefix: string): Promise<readonly RemoteDocument[]> {
    assertPathPrefix(prefix);
    const value = await this.execute<unknown>('sync_list_documents', {
      prefix,
    });
    if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
      throw invalidResponse();
    }
    let bytes = 0;
    const documents = value.map((item) => {
      const document = parseDocument(item, this.maxDocumentBytes);
      bytes +=
        byteLength(document.path) +
        byteLength(document.content) +
        byteLength(document.revision);
      if (
        bytes > this.maxListBytes ||
        !pathWithinPrefix(document.path, prefix)
      ) {
        throw invalidResponse();
      }
      return document;
    });
    return documents;
  }

  async listEntries(prefix: string): Promise<readonly RemoteSyncEntry[]> {
    assertPathPrefix(prefix);
    const value = await this.execute<unknown>('sync_list_entries', { prefix });
    if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
      throw invalidResponse();
    }
    let bytes = 0;
    return value.map((item) => {
      const entry = parseEntry(item);
      bytes += byteLength(entry.path) + byteLength(entry.revision);
      if (bytes > this.maxListBytes || !pathWithinPrefix(entry.path, prefix)) {
        throw invalidResponse();
      }
      return entry;
    });
  }

  async deleteEntries(
    requests: readonly RemoteSyncEntryDeleteRequest[],
  ): Promise<void> {
    if (requests.length > MAX_DELETE_ENTRIES) {
      throw new TypeError('Too many native synchronization deletions');
    }
    requests.forEach(assertEntryDelete);
    if (
      requests.reduce(
        (bytes, request) =>
          bytes +
          byteLength(request.path) +
          byteLength(request.expectedRevision),
        0,
      ) > this.maxListBytes
    ) {
      throw new TypeError('Native synchronization deletions are too large');
    }
    await this.execute('sync_delete_entries', { requests });
  }

  async deleteEntry(request: RemoteSyncEntryDeleteRequest): Promise<void> {
    assertEntryDelete(request);
    await this.execute('sync_delete_entry', { request });
  }

  async read(path: string): Promise<RemoteDocument | null> {
    assertPath(path);
    const value = await this.execute<unknown>('sync_read_document', { path });
    if (value === null) {
      return null;
    }
    const document = parseDocument(value, this.maxDocumentBytes);
    if (document.path !== path) {
      throw invalidResponse();
    }
    return document;
  }

  async write(request: DocumentWriteRequest): Promise<RemoteDocument> {
    assertDocumentWrite(request, this.maxDocumentBytes);
    const document = parseDocument(
      await this.execute('sync_write_document', { request }),
      this.maxDocumentBytes,
    );
    if (
      document.path !== request.path ||
      document.content !== request.content
    ) {
      throw invalidResponse();
    }
    return document;
  }

  async deleteDocument(request: DocumentDeleteRequest): Promise<void> {
    assertDocumentDelete(request);
    await this.execute('sync_delete_document', { request });
  }

  async headObject(path: string): Promise<RemoteObject | null> {
    assertPath(path);
    const value = await this.execute<unknown>('sync_head_object', { path });
    if (value === null) {
      return null;
    }
    const object = parseObject(value, this.maxObjectBytes);
    if (object.path !== path) {
      throw invalidResponse();
    }
    return object;
  }

  async downloadObject(
    path: string,
    options: ObjectDownloadOptions = {},
  ): Promise<Blob> {
    assertPath(path);
    if (options.expectedSize !== undefined) {
      assertSize(options.expectedSize, this.maxObjectBytes);
    }
    return this.withRequest(options.signal, async (requestId) => {
      const start = parseTransferStart(
        await this.invokeBroker('sync_download_begin', {
          requestId,
          provider: this.options.provider,
          path,
          expectedSize: options.expectedSize,
        }),
        true,
        this.maxObjectBytes,
      );
      const totalBytes = start.size as number;
      if (
        options.expectedSize !== undefined &&
        totalBytes !== options.expectedSize
      ) {
        throw invalidResponse();
      }
      const chunks: ArrayBuffer[] = [];
      let transferredBytes = 0;
      options.onProgress?.({
        direction: 'download',
        path,
        transferredBytes,
        totalBytes,
      });
      while (transferredBytes < totalBytes) {
        const chunk = parseDownloadChunk(
          await this.invokeBroker('sync_download_chunk', {
            requestId,
            provider: this.options.provider,
            transferId: start.transferId,
            offset: transferredBytes,
            maxBytes: this.chunkBytes,
          }),
          this.chunkBytes,
        );
        if (chunk.bytes.length === 0) {
          throw invalidResponse();
        }
        transferredBytes += chunk.bytes.length;
        if (transferredBytes > totalBytes) {
          throw invalidResponse();
        }
        chunks.push(Uint8Array.from(chunk.bytes).buffer as ArrayBuffer);
        options.onProgress?.({
          direction: 'download',
          path,
          transferredBytes,
          totalBytes,
        });
        if (chunk.done !== (transferredBytes === totalBytes)) {
          throw invalidResponse();
        }
      }
      await this.invokeBroker('sync_download_finish', {
        requestId,
        provider: this.options.provider,
        transferId: start.transferId,
      });
      return new Blob(chunks, { type: start.mediaType });
    });
  }

  async uploadObject(request: ObjectUploadRequest): Promise<RemoteObject> {
    assertUpload(request, this.maxObjectBytes);
    return this.withRequest(request.signal, async (requestId) => {
      const start = parseTransferStart(
        await this.invokeBroker('sync_upload_begin', {
          requestId,
          provider: this.options.provider,
          path: request.path,
          size: request.size,
          sha256: request.sha256,
          mediaType: request.mediaType,
        }),
        false,
        this.maxObjectBytes,
      );
      let transferredBytes = 0;
      request.onProgress?.({
        direction: 'upload',
        path: request.path,
        transferredBytes,
        totalBytes: request.size,
      });
      while (transferredBytes < request.size) {
        const end = Math.min(transferredBytes + this.chunkBytes, request.size);
        const bytes = await blobBytes(
          request.content.slice(transferredBytes, end),
        );
        await this.invokeBroker('sync_upload_chunk', bytes, {
          headers: {
            [REQUEST_ID_HEADER]: requestId,
            [PROVIDER_HEADER]: this.options.provider,
            [TRANSFER_ID_HEADER]: start.transferId,
            [OFFSET_HEADER]: String(transferredBytes),
          },
        });
        transferredBytes = end;
        request.onProgress?.({
          direction: 'upload',
          path: request.path,
          transferredBytes,
          totalBytes: request.size,
        });
      }
      const object = parseObject(
        await this.invokeBroker('sync_upload_finish', {
          requestId,
          provider: this.options.provider,
          transferId: start.transferId,
        }),
        this.maxObjectBytes,
      );
      if (
        object.path !== request.path ||
        object.size !== request.size ||
        object.sha256 !== request.sha256
      ) {
        throw invalidResponse();
      }
      return object;
    });
  }

  async deleteObject(request: ObjectDeleteRequest): Promise<void> {
    assertPath(request.path);
    if (
      request.expectedRevision !== undefined &&
      !isBoundedString(request.expectedRevision, 1024)
    ) {
      throw new TypeError('The native synchronization revision is invalid');
    }
    await this.execute('sync_delete_object', { request });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const requests = [...this.activeRequests.values()];
    requests.forEach((cancel) =>
      cancel(
        new DOMException('Synchronization transport closed', 'AbortError'),
      ),
    );
    this.activeRequests.clear();
    await this.invokeNative('sync_teardown', {});
  }

  private async execute<T>(
    command: Exclude<
      NativeSyncCommand,
      | 'sync_broker_status'
      | 'sync_cancel_request'
      | 'sync_teardown'
      | 'sync_download_begin'
      | 'sync_download_chunk'
      | 'sync_download_finish'
      | 'sync_upload_begin'
      | 'sync_upload_chunk'
      | 'sync_upload_finish'
    >,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withRequest(signal, (requestId) =>
      this.invokeBroker<T>(command, {
        requestId,
        provider: this.options.provider,
        ...arguments_,
      }),
    );
  }

  private async withRequest<T>(
    signal: AbortSignal | undefined,
    operation: (requestId: string) => Promise<T>,
  ): Promise<T> {
    this.assertActive();
    throwIfAborted(signal);
    await this.ready();
    this.assertActive();
    throwIfAborted(signal);
    const requestId = `webview-${++this.requestSequence}`;
    let rejectCancellation: (error: unknown) => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    let cancelRequested = false;
    const cancel = (reason: Error) => {
      if (!cancelRequested) {
        cancelRequested = true;
        void this.invokeNative('sync_cancel_request', { requestId }).catch(
          () => undefined,
        );
      }
      rejectCancellation(reason);
    };
    const onAbort = () => cancel(abortError(signal));
    this.activeRequests.set(requestId, cancel);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([operation(requestId), cancellation]);
    } catch (error) {
      if (!cancelRequested) {
        cancelRequested = true;
        void this.invokeNative('sync_cancel_request', { requestId }).catch(
          () => undefined,
        );
      }
      throw mapNativeError(error, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeRequests.delete(requestId);
    }
  }

  private async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.invokeNative('sync_broker_status', {})
        .then((value) => {
          if (!isRecord(value) || typeof value['gatewayOrigin'] !== 'string') {
            throw invalidResponse();
          }
          const brokerOrigin = exactGatewayOrigin(
            value['gatewayOrigin'],
            this.options.allowInsecureLoopback ?? false,
          );
          if (this.gatewayOrigin && brokerOrigin !== this.gatewayOrigin) {
            throw new NativeSyncTransportError('origin-mismatch');
          }
        })
        .catch((error) => {
          throw mapNativeError(error);
        });
    }
    await this.readyPromise;
  }

  private invokeBroker<T>(
    command: NativeSyncCommand,
    body: Record<string, unknown> | Uint8Array,
    options?: { headers: Record<string, string> },
  ): Promise<T> {
    this.assertActive();
    return this.invokeNative(command, body, options) as Promise<T>;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new NativeSyncTransportError('transport-unavailable');
    }
  }
}

function parseDocument(value: unknown, maxBytes: number): RemoteDocument {
  if (
    !isRecord(value) ||
    !isPath(value['path']) ||
    !isBoundedString(value['content'], maxBytes) ||
    !isBoundedString(value['revision'], 1024)
  ) {
    throw invalidResponse();
  }
  return {
    path: value['path'],
    content: value['content'],
    revision: value['revision'],
  };
}

function parseEntry(value: unknown): RemoteSyncEntry {
  if (
    !isRecord(value) ||
    !isPath(value['path']) ||
    !isBoundedString(value['revision'], 1024) ||
    (value['kind'] !== 'document' && value['kind'] !== 'object')
  ) {
    throw invalidResponse();
  }
  return {
    path: value['path'],
    revision: value['revision'],
    kind: value['kind'],
  };
}

function parseObject(value: unknown, maxBytes: number): RemoteObject {
  if (
    !isRecord(value) ||
    !isPath(value['path']) ||
    !isBoundedString(value['revision'], 1024) ||
    !isSize(value['size'], maxBytes) ||
    typeof value['sha256'] !== 'string' ||
    !SHA256_PATTERN.test(value['sha256'])
  ) {
    throw invalidResponse();
  }
  return {
    path: value['path'],
    revision: value['revision'],
    size: value['size'],
    sha256: value['sha256'],
  };
}

function parseTransferStart(
  value: unknown,
  download: boolean,
  maxBytes: number,
): TransferStart {
  if (
    !isRecord(value) ||
    typeof value['transferId'] !== 'string' ||
    !TRANSFER_ID_PATTERN.test(value['transferId']) ||
    (download &&
      (!isSize(value['size'], maxBytes) ||
        !isBoundedString(value['mediaType'], 128)))
  ) {
    throw invalidResponse();
  }
  return {
    transferId: value['transferId'],
    ...(download
      ? {
          size: value['size'] as number,
          mediaType: value['mediaType'] as string,
        }
      : {}),
  };
}

function parseDownloadChunk(value: unknown, maxBytes: number): DownloadChunk {
  if (
    !isRecord(value) ||
    typeof value['done'] !== 'boolean' ||
    !Array.isArray(value['bytes']) ||
    value['bytes'].length > maxBytes ||
    !value['bytes'].every(
      (byte) => Number.isSafeInteger(byte) && byte >= 0 && byte <= 255,
    )
  ) {
    throw invalidResponse();
  }
  return { bytes: value['bytes'] as number[], done: value['done'] };
}

function assertDocumentWrite(
  request: DocumentWriteRequest,
  maxBytes: number,
): void {
  assertPath(request.path);
  if (
    !isBoundedString(request.content, maxBytes) ||
    !isBoundedString(request.message, 512) ||
    (request.expectedRevision !== undefined &&
      !isBoundedString(request.expectedRevision, 1024))
  ) {
    throw new TypeError('The native synchronization document is invalid');
  }
}

function assertDocumentDelete(request: DocumentDeleteRequest): void {
  assertPath(request.path);
  if (
    !isBoundedString(request.message, 512) ||
    (request.expectedRevision !== undefined &&
      !isBoundedString(request.expectedRevision, 1024))
  ) {
    throw new TypeError('The native synchronization deletion is invalid');
  }
}

function assertEntryDelete(request: RemoteSyncEntryDeleteRequest): void {
  assertPath(request.path);
  if (!isBoundedString(request.expectedRevision, 1024)) {
    throw new TypeError('The native synchronization deletion is invalid');
  }
}

function assertUpload(request: ObjectUploadRequest, maxBytes: number): void {
  assertPath(request.path);
  assertSize(request.size, maxBytes);
  if (
    request.content.size !== request.size ||
    !SHA256_PATTERN.test(request.sha256) ||
    !isBoundedString(request.mediaType, 128)
  ) {
    throw new TypeError('The native synchronization upload is invalid');
  }
}

function assertSize(value: number, maximum: number): void {
  if (!isSize(value, maximum)) {
    throw new TypeError('The native synchronization object size is invalid');
  }
}

function isSize(value: unknown, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function assertPathPrefix(value: string): void {
  if (value !== '.omnia-reader' && !isPath(value)) {
    throw new TypeError('The native synchronization path is invalid');
  }
}

function assertPath(value: string): void {
  if (!isPath(value)) {
    throw new TypeError('The native synchronization path is invalid');
  }
}

function isPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1024 &&
    value.startsWith('.omnia-reader/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').includes('..')
  );
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isBoundedString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    byteLength(value) <= maximumBytes
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactGatewayOrigin(
  value: string,
  allowInsecureLoopback: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('The native synchronization gateway origin is invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' &&
      !(allowInsecureLoopback && url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value !== url.origin
  ) {
    throw new TypeError('The native synchronization gateway origin is invalid');
  }
  return url.origin;
}

function mapNativeError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) {
    return abortError(signal);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return error;
  }
  if (isRecord(error) && error['name'] === 'AbortError') {
    return error as unknown as Error;
  }
  if (
    error instanceof SyncConflictError ||
    error instanceof NativeSyncTransportError
  ) {
    return error;
  }
  if (isRecord(error) && typeof error['code'] === 'string') {
    if (error['code'] === 'conflict') {
      return new SyncConflictError();
    }
    if (error['code'] === 'cancelled') {
      return new DOMException('Synchronization was cancelled', 'AbortError');
    }
    if (isNativeErrorCode(error['code'])) {
      const retryAfterSeconds = boundedRetryAfter(error['retryAfterSeconds']);
      return new NativeSyncTransportError(error['code'], {
        ...(error['code'] === 'rate-limited' ? { status: 429 } : {}),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    }
  }
  return new NativeSyncTransportError('transport-unavailable');
}

function isNativeErrorCode(value: string): value is NativeSyncErrorCode {
  return [
    'authentication-required',
    'invalid-response',
    'origin-mismatch',
    'permission-denied',
    'rate-limited',
    'redirect-denied',
    'transport-unavailable',
  ].includes(value);
}

function boundedRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 86_400
    ? value
    : undefined;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Synchronization was cancelled', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function invalidResponse(): NativeSyncTransportError {
  return new NativeSyncTransportError('invalid-response');
}

function errorMessage(code: NativeSyncErrorCode): string {
  switch (code) {
    case 'authentication-required':
      return 'Reconnect the synchronization provider to continue.';
    case 'cancelled':
      return 'Synchronization was cancelled.';
    case 'conflict':
      return 'The synchronization destination changed. Retry synchronization.';
    case 'permission-denied':
      return 'Synchronization permission is unavailable. Review the selected destination.';
    case 'rate-limited':
      return 'The synchronization provider is temporarily unavailable. Automatic synchronization will retry.';
    case 'origin-mismatch':
      return 'The packaged synchronization service identity does not match this application.';
    case 'redirect-denied':
    case 'invalid-response':
      return 'The synchronization service returned an unsafe response.';
    case 'transport-unavailable':
      return 'Packaged synchronization is unavailable.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(invalidResponse());
        return;
      }
      resolve(new Uint8Array(reader.result));
    });
    reader.addEventListener('error', () =>
      reject(new NativeSyncTransportError('transport-unavailable')),
    );
    reader.readAsArrayBuffer(blob);
  });
}

async function invokeTauri(
  command: NativeSyncCommand,
  body: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<unknown>(command, body, options);
}
