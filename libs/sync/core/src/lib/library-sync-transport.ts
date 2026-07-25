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

export interface ObjectUploadRequest {
  path: string;
  content: Blob;
  size: number;
  sha256: string;
  mediaType: string;
}

export interface LibrarySyncTransport {
  list(prefix: string): Promise<readonly RemoteDocument[]>;
  read(path: string): Promise<RemoteDocument | null>;
  write(request: DocumentWriteRequest): Promise<RemoteDocument>;
  headObject(path: string): Promise<RemoteObject | null>;
  downloadObject(path: string): Promise<Blob>;
  uploadObject(request: ObjectUploadRequest): Promise<RemoteObject>;
}

export class SyncConflictError extends Error {
  constructor(message = 'The remote sync document changed') {
    super(message);
    this.name = 'SyncConflictError';
  }
}
