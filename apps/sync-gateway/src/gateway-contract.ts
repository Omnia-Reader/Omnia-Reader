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
  listDocuments(
    sessionId: string,
    prefix: string,
  ): Promise<readonly RemoteDocument[]>;
  readDocument(sessionId: string, path: string): Promise<RemoteDocument | null>;
  writeDocument(
    sessionId: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument>;
  headObject(sessionId: string, path: string): Promise<RemoteObject | null>;
  downloadObject(
    sessionId: string,
    path: string,
  ): Promise<RemoteObjectDownload | null>;
  uploadObject(
    sessionId: string,
    upload: RemoteObjectUpload,
  ): Promise<RemoteObject>;
}

export interface CredentialSyncGatewayAdapter extends SyncGatewayAdapter {
  credentialAuthorizationPage(
    sessionId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<CredentialAuthorizationPage>;
}

export function supportsCredentialAuthorization(
  adapter: SyncGatewayAdapter,
): adapter is CredentialSyncGatewayAdapter {
  return (
    'credentialAuthorizationPage' in adapter &&
    typeof adapter.credentialAuthorizationPage === 'function'
  );
}

export class GatewayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}
