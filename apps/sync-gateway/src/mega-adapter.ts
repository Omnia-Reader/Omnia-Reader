import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  GatewayHttpError,
  type CredentialAuthorizationPage,
  type CredentialSyncGatewayAdapter,
  type DocumentDeleteRequest,
  type DocumentWriteRequest,
  type RemoteDocument,
  type RemoteObject,
  type RemoteObjectDelete,
  type RemoteObjectDownload,
  type RemoteObjectUpload,
  type RemoteSyncEntry,
  type RemoteSyncEntryDelete,
} from './gateway-contract.js';
import type {
  MegaSdkBridge,
  MegaSdkFile,
  MegaSdkFolder,
} from './mega-sdk-bridge.js';
import type { GatewaySessionStore } from './session-store.js';

export interface MegaSessionState {
  authorizationState?: string;
  returnTo?: string;
  sdkSession?: string;
  account?: string;
  folder?: MegaSdkFolder;
}

export interface MegaAdapterOptions {
  loginUrl: string;
  bridge: MegaSdkBridge;
  sessions: GatewaySessionStore<MegaSessionState>;
  randomState?: () => string;
  randomId?: () => string;
}

interface MegaContext {
  state: MegaSessionState;
  sdkSession: string;
  folder: MegaSdkFolder;
}

interface ResolvedDocument {
  node: MegaSdkFile;
  content: string;
  duplicates: readonly MegaSdkFile[];
}

const MAX_REMOTE_DOCUMENTS = 10_000;
const MAX_DUPLICATE_CANDIDATES = 16;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const STAGING_ROOT = '.omnia-reader/.staging';

export class MegaSyncGatewayAdapter implements CredentialSyncGatewayAdapter {
  private readonly loginUrl: string;
  private readonly randomState: () => string;
  private readonly randomId: () => string;

  constructor(private readonly options: MegaAdapterOptions) {
    const loginUrl = new URL(options.loginUrl);
    if (
      loginUrl.protocol !== 'https:' &&
      !(
        loginUrl.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '::1'].includes(loginUrl.hostname)
      )
    ) {
      throw new TypeError('The MEGA login URL must use HTTPS');
    }
    this.loginUrl = loginUrl.toString();
    this.randomState =
      options.randomState ?? (() => randomBytes(32).toString('base64url'));
    this.randomId =
      options.randomId ?? (() => randomBytes(18).toString('base64url'));
  }

  async session(sessionId: string): Promise<unknown> {
    const state = await this.authenticatedState(sessionId, false);
    if (!state) {
      return { authenticated: false };
    }
    const folders = await this.authenticatedBridgeCall(sessionId, state, () =>
      this.options.bridge.folders(state.sdkSession as string),
    );
    const folder = state.folder
      ? folders.find(
          (candidate) =>
            candidate.handle === state.folder?.handle && candidate.canWrite,
        )
      : undefined;
    if (state.folder && !folder) {
      const updated = { ...state, folder: undefined };
      await this.options.sessions.set(sessionId, updated);
      return this.publicSession(updated);
    }
    if (folder && folder.path !== state.folder?.path) {
      const updated = { ...state, folder };
      await this.options.sessions.set(sessionId, updated);
      return this.publicSession(updated);
    }
    return this.publicSession(state);
  }

  async authorizationUrl(sessionId: string, returnTo: string): Promise<string> {
    const authorizationState = this.randomState();
    await this.options.sessions.set(sessionId, {
      authorizationState,
      returnTo,
    });
    const url = new URL(this.loginUrl);
    url.searchParams.set('state', authorizationState);
    return url.toString();
  }

  async credentialAuthorizationPage(
    sessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<CredentialAuthorizationPage> {
    await this.requirePendingAuthorization(sessionId, parameters['state']);
    return {
      provider: 'MEGA',
      state: parameters['state'] as string,
      accountLabel: 'MEGA account email',
      passwordLabel: 'MEGA account password',
      supportsMultiFactorCode: true,
    };
  }

  async completeAuthorization(
    sessionId: string,
    replacementSessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<string> {
    const pending = await this.requirePendingAuthorization(
      sessionId,
      parameters['state'],
    );
    const email = parameters['email']?.trim();
    const password = parameters['password'];
    const multiFactorCode = parameters['multiFactorCode']?.trim();
    if (
      !email ||
      email.length > 320 ||
      !email.includes('@') ||
      !password ||
      password.length > 1024 ||
      (multiFactorCode && !/^\d{6}$/.test(multiFactorCode))
    ) {
      throw new GatewayHttpError(401, 'MEGA authentication was not accepted');
    }
    const login = await this.options.bridge.login({
      email,
      password,
      ...(multiFactorCode ? { multiFactorCode } : {}),
    });
    const authenticated: MegaSessionState = {
      sdkSession: login.session,
      account: login.account,
    };
    await this.options.sessions.move(
      sessionId,
      replacementSessionId,
      authenticated,
    );
    return pending.returnTo ?? '/settings/sync';
  }

  async disconnect(sessionId: string): Promise<void> {
    const state = await this.options.sessions.get(sessionId);
    try {
      if (state?.sdkSession) {
        await this.options.bridge.logout(state.sdkSession);
      }
    } catch {
      // Local deletion is the security boundary if provider logout is unavailable.
    } finally {
      await this.options.sessions.delete(sessionId);
    }
  }

  async destinations(sessionId: string): Promise<readonly unknown[]> {
    const state = await this.requireAuthenticatedState(sessionId);
    return this.authenticatedBridgeCall(sessionId, state, () =>
      this.options.bridge.folders(state.sdkSession as string),
    );
  }

  async selectDestination(
    sessionId: string,
    selection: unknown,
  ): Promise<unknown> {
    if (!isRecord(selection) || !isBoundedString(selection['handle'])) {
      throw new GatewayHttpError(400, 'A valid MEGA folder handle is required');
    }
    const state = await this.requireAuthenticatedState(sessionId);
    const folders = await this.authenticatedBridgeCall(sessionId, state, () =>
      this.options.bridge.folders(state.sdkSession as string),
    );
    const folder = folders.find(
      (candidate) =>
        candidate.handle === selection['handle'] && candidate.canWrite,
    );
    if (!folder) {
      throw new GatewayHttpError(
        403,
        'The selected MEGA folder is not writable',
      );
    }
    const updated = { ...state, folder };
    await this.options.sessions.set(sessionId, updated);
    return this.publicSession(updated);
  }

  async listDocuments(
    sessionId: string,
    prefix: string,
  ): Promise<readonly RemoteDocument[]> {
    const context = await this.context(sessionId);
    const files = await this.files(sessionId, context, prefix);
    const groups = groupByPath(
      files.filter(
        (file) =>
          file.path !== STAGING_ROOT &&
          !file.path.startsWith(`${STAGING_ROOT}/`) &&
          (file.path.endsWith('.json') || file.path.endsWith('.md')) &&
          (file.path === prefix || file.path.startsWith(`${prefix}/`)),
      ),
    );
    if (groups.size > MAX_REMOTE_DOCUMENTS) {
      throw new GatewayHttpError(
        413,
        'The MEGA synchronization document set is too large',
      );
    }
    const documents: RemoteDocument[] = [];
    for (const [path, candidates] of [...groups].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const resolved = await this.resolveDocumentCandidates(
        sessionId,
        context,
        path,
        candidates,
      );
      if (resolved) {
        documents.push({
          path,
          content: resolved.content,
          revision: resolved.node.revision,
        });
      }
    }
    return documents;
  }

  async listEntries(
    sessionId: string,
    prefix: string,
  ): Promise<readonly RemoteSyncEntry[]> {
    const context = await this.context(sessionId);
    const files = await this.files(sessionId, context, prefix);
    return files
      .filter(
        (file) => file.path === prefix || file.path.startsWith(`${prefix}/`),
      )
      .map(
        (file): RemoteSyncEntry => ({
          path: file.path,
          revision: file.revision,
          kind:
            file.path.endsWith('.json') || file.path.endsWith('.md')
              ? 'document'
              : 'object',
        }),
      )
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async deleteEntry(
    sessionId: string,
    request: RemoteSyncEntryDelete,
  ): Promise<void> {
    const context = await this.context(sessionId);
    const candidates = await this.fileCandidates(
      sessionId,
      context,
      request.path,
    );
    if (candidates.length === 0) return;
    if (
      !candidates.some(
        (candidate) => candidate.revision === request.expectedRevision,
      )
    ) {
      throw new GatewayHttpError(409, 'The remote sync entry changed');
    }
    for (const candidate of candidates) {
      await this.authenticatedBridgeCall(sessionId, context.state, () =>
        this.options.bridge.removeFile(
          context.sdkSession,
          context.folder.handle,
          candidate.handle,
        ),
      );
    }
  }

  async deleteEntries(
    sessionId: string,
    requests: readonly RemoteSyncEntryDelete[],
  ): Promise<void> {
    if (requests.length === 0) return;
    const context = await this.context(sessionId);
    const files = await this.files(
      sessionId,
      context,
      commonSyncPathPrefix(requests.map((request) => request.path)),
    );
    const candidatesByPath = new Map<string, MegaSdkFile[]>();
    for (const file of files) {
      const candidates = candidatesByPath.get(file.path) ?? [];
      candidates.push(file);
      candidatesByPath.set(file.path, candidates);
    }
    const expectedByPath = new Map<string, Set<string>>();
    for (const request of requests) {
      const revisions = expectedByPath.get(request.path) ?? new Set();
      revisions.add(request.expectedRevision);
      expectedByPath.set(request.path, revisions);
    }
    const removals: MegaSdkFile[] = [];
    for (const [path, expectedRevisions] of expectedByPath) {
      const candidates = candidatesByPath.get(path) ?? [];
      if (candidates.length === 0) continue;
      const currentRevisions = new Set(
        candidates.map((candidate) => candidate.revision),
      );
      if (
        currentRevisions.size !== expectedRevisions.size ||
        [...currentRevisions].some(
          (revision) => !expectedRevisions.has(revision),
        )
      ) {
        throw new GatewayHttpError(409, 'A remote sync entry changed');
      }
      removals.push(...candidates);
    }
    for (const candidate of removals) {
      await this.authenticatedBridgeCall(sessionId, context.state, () =>
        this.options.bridge.removeFile(
          context.sdkSession,
          context.folder.handle,
          candidate.handle,
        ),
      );
    }
  }

  async readDocument(
    sessionId: string,
    path: string,
  ): Promise<RemoteDocument | null> {
    const context = await this.context(sessionId);
    const resolved = await this.resolveDocument(sessionId, context, path);
    return resolved
      ? {
          path,
          content: resolved.content,
          revision: resolved.node.revision,
        }
      : null;
  }

  async writeDocument(
    sessionId: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument> {
    const context = await this.context(sessionId);
    const current = await this.resolveDocument(
      sessionId,
      context,
      request.path,
    );
    if (
      (request.expectedRevision !== undefined &&
        current?.node.revision !== request.expectedRevision) ||
      (request.expectedRevision === undefined && current !== null)
    ) {
      throw documentConflict();
    }
    if (current) {
      for (const duplicate of current.duplicates) {
        await this.safeRemove(context, duplicate.handle);
      }
    }

    const content = Buffer.from(request.content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const stagingPath = this.stagingPath('document');
    const staged = await this.authenticatedBridgeCall(
      sessionId,
      context.state,
      () =>
        this.options.bridge.uploadFile(context.sdkSession, {
          rootHandle: context.folder.handle,
          path: stagingPath,
          size: content.byteLength,
          sha256,
          content: Readable.from(content),
        }),
    );
    if (staged.size !== content.byteLength || staged.sha256 !== sha256) {
      await this.safeRemove(context, staged.handle);
      throw bridgeProtocolError();
    }

    const latest = await this.resolveDocument(sessionId, context, request.path);
    if (latest?.node.revision !== current?.node.revision) {
      await this.safeRemove(context, staged.handle);
      throw documentConflict();
    }

    const backupPath = this.stagingPath('backup');
    let backup: MegaSdkFile | null = null;
    let published: MegaSdkFile;
    try {
      if (current) {
        backup = await this.authenticatedBridgeCall(
          sessionId,
          context.state,
          () =>
            this.options.bridge.moveFile(
              context.sdkSession,
              current.node.handle,
              context.folder.handle,
              backupPath,
            ),
        );
      }
      published = await this.authenticatedBridgeCall(
        sessionId,
        context.state,
        () =>
          this.options.bridge.moveFile(
            context.sdkSession,
            staged.handle,
            context.folder.handle,
            request.path,
          ),
      );
    } catch (error) {
      await this.safeRemove(context, staged.handle);
      if (backup) {
        await this.safeMove(context, backup.handle, request.path);
      }
      throw mapWriteRace(error);
    }

    try {
      const resolved = await this.resolveDocument(
        sessionId,
        context,
        request.path,
      );
      if (!resolved || resolved.content !== request.content) {
        throw documentConflict();
      }
      if (backup) {
        await this.safeRemove(context, backup.handle);
      }
      return {
        path: request.path,
        content: request.content,
        revision: resolved.node.revision,
      };
    } catch (error) {
      await this.safeRemove(context, published.handle);
      const remaining = await this.fileCandidates(
        sessionId,
        context,
        request.path,
      );
      if (backup && remaining.length === 0) {
        await this.safeMove(context, backup.handle, request.path);
      } else if (backup) {
        await this.safeRemove(context, backup.handle);
      }
      throw mapWriteRace(error);
    }
  }

  async deleteDocument(
    sessionId: string,
    request: DocumentDeleteRequest,
  ): Promise<void> {
    const context = await this.context(sessionId);
    const current = await this.resolveDocument(
      sessionId,
      context,
      request.path,
    );
    if (!current) {
      return;
    }
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.node.revision
    ) {
      throw documentConflict();
    }
    for (const candidate of [current.node, ...current.duplicates]) {
      await this.safeRemove(context, candidate.handle);
    }
  }

  async headObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObject | null> {
    const context = await this.context(sessionId);
    const node = await this.resolveObject(sessionId, context, path);
    return node ? objectMetadata(node) : null;
  }

  async downloadObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObjectDownload | null> {
    const context = await this.context(sessionId);
    const node = await this.resolveObject(sessionId, context, path);
    if (!node) {
      return null;
    }
    const content = await this.authenticatedBridgeCall(
      sessionId,
      context.state,
      () =>
        this.options.bridge.downloadFile(
          context.sdkSession,
          context.folder.handle,
          node.handle,
        ),
    );
    const verifier = integrityTransform(node.sha256 as string, node.size);
    content.pipe(verifier);
    return {
      metadata: objectMetadata(node),
      mediaType: path.endsWith('.pdf')
        ? 'application/pdf'
        : 'application/epub+zip',
      content: verifier,
    };
  }

  async uploadObject(
    sessionId: string,
    upload: RemoteObjectUpload,
  ): Promise<RemoteObject> {
    const context = await this.context(sessionId);
    const existing = await this.resolveObject(sessionId, context, upload.path);
    if (existing) {
      if (existing.sha256 !== upload.sha256 || existing.size !== upload.size) {
        throw objectConflict();
      }
      await verifyReadable(upload.content, upload.sha256, upload.size);
      return objectMetadata(existing);
    }

    const stagingPath = this.stagingPath('publication');
    const verifier = integrityTransform(upload.sha256, upload.size);
    upload.content.pipe(verifier);
    let staged: MegaSdkFile;
    try {
      staged = await this.authenticatedBridgeCall(
        sessionId,
        context.state,
        () =>
          this.options.bridge.uploadFile(context.sdkSession, {
            rootHandle: context.folder.handle,
            path: stagingPath,
            size: upload.size,
            sha256: upload.sha256,
            content: verifier,
          }),
      );
      await finished(verifier);
    } catch (error) {
      verifier.destroy();
      throw error;
    }
    if (staged.size !== upload.size || staged.sha256 !== upload.sha256) {
      await this.safeRemove(context, staged.handle);
      throw bridgeProtocolError();
    }

    const concurrent = await this.resolveObject(
      sessionId,
      context,
      upload.path,
    );
    if (concurrent) {
      await this.safeRemove(context, staged.handle);
      if (
        concurrent.sha256 === upload.sha256 &&
        concurrent.size === upload.size
      ) {
        return objectMetadata(concurrent);
      }
      throw objectConflict();
    }

    let published: MegaSdkFile;
    try {
      published = await this.authenticatedBridgeCall(
        sessionId,
        context.state,
        () =>
          this.options.bridge.moveFile(
            context.sdkSession,
            staged.handle,
            context.folder.handle,
            upload.path,
          ),
      );
    } catch (error) {
      await this.safeRemove(context, staged.handle);
      throw error;
    }
    try {
      const resolved = await this.resolveObject(
        sessionId,
        context,
        upload.path,
      );
      if (
        !resolved ||
        resolved.sha256 !== upload.sha256 ||
        resolved.size !== upload.size
      ) {
        throw objectConflict();
      }
      return objectMetadata(resolved);
    } catch (error) {
      await this.safeRemove(context, published.handle);
      throw error;
    }
  }

  async deleteObject(
    sessionId: string,
    request: RemoteObjectDelete,
  ): Promise<void> {
    const context = await this.context(sessionId);
    const current = await this.resolveObject(sessionId, context, request.path);
    if (!current) {
      return;
    }
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    ) {
      throw objectConflict();
    }
    const candidates = await this.fileCandidates(
      sessionId,
      context,
      request.path,
    );
    for (const candidate of candidates) {
      await this.authenticatedBridgeCall(sessionId, context.state, () =>
        this.options.bridge.removeFile(
          context.sdkSession,
          context.folder.handle,
          candidate.handle,
        ),
      );
    }
  }

  private async requirePendingAuthorization(
    sessionId: string,
    state: string | undefined,
  ): Promise<MegaSessionState> {
    const pending = await this.options.sessions.get(sessionId);
    if (
      !pending?.authorizationState ||
      !state ||
      state !== pending.authorizationState
    ) {
      throw new GatewayHttpError(400, 'MEGA authorization state is invalid');
    }
    return pending;
  }

  private async authenticatedState(
    sessionId: string,
    required: boolean,
  ): Promise<MegaSessionState | null> {
    const state = await this.options.sessions.get(sessionId);
    if (state?.sdkSession && state.account) {
      return state;
    }
    if (required) {
      throw new GatewayHttpError(401, 'Connect a MEGA account first');
    }
    return null;
  }

  private async requireAuthenticatedState(
    sessionId: string,
  ): Promise<MegaSessionState> {
    return (await this.authenticatedState(sessionId, true)) as MegaSessionState;
  }

  private async context(sessionId: string): Promise<MegaContext> {
    const state = await this.requireAuthenticatedState(sessionId);
    if (!state.folder) {
      throw new GatewayHttpError(409, 'Choose a MEGA sync folder first');
    }
    const folders = await this.authenticatedBridgeCall(sessionId, state, () =>
      this.options.bridge.folders(state.sdkSession as string),
    );
    const folder = folders.find(
      (candidate) =>
        candidate.handle === state.folder?.handle && candidate.canWrite,
    );
    if (!folder) {
      await this.options.sessions.set(sessionId, {
        ...state,
        folder: undefined,
      });
      throw new GatewayHttpError(
        403,
        'The selected MEGA folder is no longer writable',
      );
    }
    return {
      state: folder === state.folder ? state : { ...state, folder },
      sdkSession: state.sdkSession as string,
      folder,
    };
  }

  private async files(
    sessionId: string,
    context: MegaContext,
    prefix: string,
  ): Promise<readonly MegaSdkFile[]> {
    return this.authenticatedBridgeCall(sessionId, context.state, () =>
      this.options.bridge.files(
        context.sdkSession,
        context.folder.handle,
        prefix,
      ),
    );
  }

  private async fileCandidates(
    sessionId: string,
    context: MegaContext,
    path: string,
  ): Promise<readonly MegaSdkFile[]> {
    const files = await this.files(sessionId, context, path);
    return files.filter((file) => file.path === path);
  }

  private async resolveDocument(
    sessionId: string,
    context: MegaContext,
    path: string,
  ): Promise<ResolvedDocument | null> {
    return this.resolveDocumentCandidates(
      sessionId,
      context,
      path,
      await this.fileCandidates(sessionId, context, path),
    );
  }

  private async resolveDocumentCandidates(
    sessionId: string,
    context: MegaContext,
    path: string,
    candidates: readonly MegaSdkFile[],
  ): Promise<ResolvedDocument | null> {
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length > MAX_DUPLICATE_CANDIDATES) {
      throw duplicateConflict(path);
    }
    const resolved: ResolvedDocument[] = [];
    for (const node of candidates) {
      resolved.push({
        node,
        content: await this.readDocumentNode(sessionId, context, node),
        duplicates: [],
      });
    }
    const expected = resolved[0]?.content;
    if (
      expected === undefined ||
      resolved.some((candidate) => candidate.content !== expected)
    ) {
      throw duplicateConflict(path);
    }
    const ordered = resolved.sort((left, right) =>
      left.node.handle.localeCompare(right.node.handle),
    );
    const winner = ordered[0] as ResolvedDocument;
    return {
      ...winner,
      duplicates: ordered.slice(1).map((candidate) => candidate.node),
    };
  }

  private async readDocumentNode(
    sessionId: string,
    context: MegaContext,
    node: MegaSdkFile,
  ): Promise<string> {
    if (node.size > MAX_DOCUMENT_BYTES) {
      throw new GatewayHttpError(413, 'A MEGA sync document is too large');
    }
    const content = await this.authenticatedBridgeCall(
      sessionId,
      context.state,
      () =>
        this.options.bridge.downloadFile(
          context.sdkSession,
          context.folder.handle,
          node.handle,
        ),
    );
    const bytes = await collectReadable(content, node.size, MAX_DOCUMENT_BYTES);
    if (
      node.sha256 &&
      createHash('sha256').update(bytes).digest('hex') !== node.sha256
    ) {
      throw new GatewayHttpError(502, 'A MEGA sync document failed integrity');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new GatewayHttpError(
        502,
        'A MEGA sync document is not valid UTF-8',
      );
    }
  }

  private async resolveObject(
    sessionId: string,
    context: MegaContext,
    path: string,
  ): Promise<MegaSdkFile | null> {
    const candidates = await this.fileCandidates(sessionId, context, path);
    if (candidates.length === 0) {
      return null;
    }
    if (
      candidates.length > MAX_DUPLICATE_CANDIDATES ||
      candidates.some(
        (candidate) =>
          !candidate.sha256 ||
          candidate.sha256 !== candidates[0]?.sha256 ||
          candidate.size !== candidates[0]?.size,
      )
    ) {
      throw duplicateConflict(path);
    }
    return [...candidates].sort((left, right) =>
      left.handle.localeCompare(right.handle),
    )[0] as MegaSdkFile;
  }

  private authenticatedBridgeCall<T>(
    sessionId: string,
    state: MegaSessionState,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation().catch(async (error: unknown) => {
      if (error instanceof GatewayHttpError && error.statusCode === 401) {
        await this.options.sessions.delete(sessionId);
      }
      throw error;
    });
  }

  private publicSession(state: MegaSessionState): unknown {
    return {
      authenticated: true,
      account: state.account,
      folder: state.folder ?? null,
    };
  }

  private stagingPath(kind: string): string {
    return `${STAGING_ROOT}/${kind}-${this.randomId()}`;
  }

  private async safeRemove(
    context: MegaContext,
    handle: string,
  ): Promise<void> {
    try {
      await this.options.bridge.removeFile(
        context.sdkSession,
        context.folder.handle,
        handle,
      );
    } catch {
      // Cleanup is best effort; staging paths are invisible to synchronization.
    }
  }

  private async safeMove(
    context: MegaContext,
    handle: string,
    path: string,
  ): Promise<void> {
    try {
      await this.options.bridge.moveFile(
        context.sdkSession,
        handle,
        context.folder.handle,
        path,
      );
    } catch {
      // A subsequent sync detects and reports the surviving staging node.
    }
  }
}

function groupByPath(
  files: readonly MegaSdkFile[],
): Map<string, MegaSdkFile[]> {
  const groups = new Map<string, MegaSdkFile[]>();
  for (const file of files) {
    const group = groups.get(file.path) ?? [];
    group.push(file);
    groups.set(file.path, group);
  }
  return groups;
}

async function collectReadable(
  content: Readable,
  expectedSize: number,
  maximumSize: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of content) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumSize || size > expectedSize) {
      content.destroy();
      throw new GatewayHttpError(502, 'A MEGA sync document has invalid size');
    }
    chunks.push(bytes);
  }
  if (size !== expectedSize) {
    throw new GatewayHttpError(502, 'A MEGA sync document has invalid size');
  }
  return Buffer.concat(chunks, size);
}

function integrityTransform(
  expectedDigest: string,
  expectedSize: number,
): Transform {
  const hash = createHash('sha256');
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, encoding, callback) {
      void encoding;
      size += chunk.byteLength;
      if (size > expectedSize) {
        callback(
          new GatewayHttpError(400, 'Publication integrity check failed'),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const digest = hash.digest('hex');
      callback(
        size === expectedSize && digest === expectedDigest
          ? null
          : new GatewayHttpError(400, 'Publication integrity check failed'),
      );
    },
  });
}

async function verifyReadable(
  content: Readable,
  expectedDigest: string,
  expectedSize: number,
): Promise<void> {
  const verifier = integrityTransform(expectedDigest, expectedSize);
  content.pipe(verifier);
  verifier.resume();
  await finished(verifier);
}

function objectMetadata(node: MegaSdkFile): RemoteObject {
  if (!node.sha256) {
    throw bridgeProtocolError();
  }
  return {
    path: node.path,
    revision: node.revision,
    size: node.size,
    sha256: node.sha256,
  };
}

function duplicateConflict(path: string): GatewayHttpError {
  return new GatewayHttpError(
    409,
    `Conflicting duplicate MEGA nodes exist at ${path}`,
  );
}

function documentConflict(): GatewayHttpError {
  return new GatewayHttpError(409, 'The remote MEGA document changed');
}

function objectConflict(): GatewayHttpError {
  return new GatewayHttpError(
    409,
    'A different publication already exists at that MEGA path',
  );
}

function mapWriteRace(error: unknown): unknown {
  if (
    error instanceof GatewayHttpError &&
    [404, 409].includes(error.statusCode)
  ) {
    return documentConflict();
  }
  return error;
}

function bridgeProtocolError(): GatewayHttpError {
  return new GatewayHttpError(
    502,
    'The MEGA SDK bridge returned inconsistent file metadata',
  );
}

function commonSyncPathPrefix(paths: readonly string[]): string {
  const common = (paths[0] as string).split('/');
  for (const path of paths.slice(1)) {
    const segments = path.split('/');
    while (
      common.length > 1 &&
      common.some((segment, index) => segment !== segments[index])
    ) {
      common.pop();
    }
  }
  return common.join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}
