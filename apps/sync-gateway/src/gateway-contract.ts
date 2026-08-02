import type { Readable } from 'node:stream';

export type SyncProviderKind = 'github' | 'mega';

export interface RemoteDocument {
  path: string;
  content: string;
  revision: string;
}

export interface DocumentWriteRequest {
  path: string;
  content: string;
  expectedRevision?: string;
  message: string;
}

export interface DocumentDeleteRequest {
  path: string;
  expectedRevision?: string;
  message: string;
}

export interface RemoteObject {
  path: string;
  revision: string;
  size: number;
  sha256: string;
}

export interface RemoteObjectDownload {
  metadata: RemoteObject;
  mediaType: 'application/epub+zip' | 'application/pdf';
  content: Readable;
}

export interface RemoteObjectUpload {
  path: string;
  mediaType: 'application/epub+zip' | 'application/pdf';
  size: number;
  sha256: string;
  content: Readable;
}

export interface RemoteObjectDelete {
  path: string;
  expectedRevision?: string;
}

export interface CredentialAuthorizationPage {
  provider: string;
  state: string;
  accountLabel: string;
  passwordLabel: string;
  supportsMultiFactorCode: boolean;
}

export interface SyncGatewayAdapter {
  session(sessionId: string): Promise<unknown>;
  authorizationUrl(sessionId: string, returnTo: string): Promise<string>;
  completeAuthorization(
    sessionId: string,
    replacementSessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<string>;
  disconnect(sessionId: string): Promise<void>;
  destinations(sessionId: string): Promise<readonly unknown[]>;
  selectDestination(sessionId: string, selection: unknown): Promise<unknown>;
  destinationRevision?(sessionId: string): Promise<string>;
  listDocuments(
    sessionId: string,
    prefix: string,
  ): Promise<readonly RemoteDocument[]>;
  readDocument(sessionId: string, path: string): Promise<RemoteDocument | null>;
  writeDocument(
    sessionId: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument>;
  deleteDocument(
    sessionId: string,
    request: DocumentDeleteRequest,
  ): Promise<void>;
  headObject(sessionId: string, path: string): Promise<RemoteObject | null>;
  downloadObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObjectDownload | null>;
  uploadObject(
    sessionId: string,
    upload: RemoteObjectUpload,
  ): Promise<RemoteObject>;
  deleteObject(sessionId: string, request: RemoteObjectDelete): Promise<void>;
}

export interface CredentialSyncGatewayAdapter extends SyncGatewayAdapter {
  credentialAuthorizationPage(
    sessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<CredentialAuthorizationPage>;
}

export interface DestinationCreatingSyncGatewayAdapter
  extends SyncGatewayAdapter {
  createDestination(sessionId: string, request: unknown): Promise<unknown>;
}

export function supportsCredentialAuthorization(
  adapter: SyncGatewayAdapter,
): adapter is CredentialSyncGatewayAdapter {
  return (
    'credentialAuthorizationPage' in adapter &&
    typeof adapter.credentialAuthorizationPage === 'function'
  );
}

export function supportsDestinationCreation(
  adapter: SyncGatewayAdapter,
): adapter is DestinationCreatingSyncGatewayAdapter {
  return (
    'createDestination' in adapter &&
    typeof adapter.createDestination === 'function'
  );
}

export function supportsDestinationRevision(
  adapter: SyncGatewayAdapter,
): adapter is SyncGatewayAdapter & {
  destinationRevision(sessionId: string): Promise<string>;
} {
  return (
    'destinationRevision' in adapter &&
    typeof adapter.destinationRevision === 'function'
  );
}

export class GatewayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
    if (
      retryAfterSeconds !== undefined &&
      (!Number.isSafeInteger(retryAfterSeconds) ||
        retryAfterSeconds < 1 ||
        retryAfterSeconds > 86_400)
    ) {
      throw new TypeError('Retry-After must be between 1 second and 24 hours');
    }
  }
}

export type AuthorizationFailureOutcome = 'denied' | 'invalid' | 'failed';

export class AuthorizationHttpError extends GatewayHttpError {
  constructor(
    statusCode: number,
    message: string,
    readonly outcome: AuthorizationFailureOutcome,
  ) {
    super(statusCode, message);
    this.name = 'AuthorizationHttpError';
  }
}
