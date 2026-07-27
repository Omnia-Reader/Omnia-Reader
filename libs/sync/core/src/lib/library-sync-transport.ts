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

export type ObjectTransferDirection = 'download' | 'upload';

export interface ObjectTransferProgress {
  direction: ObjectTransferDirection;
  path: string;
  transferredBytes: number;
  totalBytes: number;
}

export type ObjectTransferProgressListener = (
  progress: ObjectTransferProgress,
) => void;

export interface ObjectTransferOptions {
  signal?: AbortSignal;
  onProgress?: ObjectTransferProgressListener;
}

export interface ObjectDownloadOptions extends ObjectTransferOptions {
  expectedSize?: number;
}

export interface ObjectUploadRequest extends ObjectTransferOptions {
  path: string;
  content: Blob;
  size: number;
  sha256: string;
  mediaType: string;
}

export interface ObjectDeleteRequest {
  path: string;
  expectedRevision?: string;
}

export interface LibrarySyncTransport {
  list(prefix: string): Promise<readonly RemoteDocument[]>;
  read(path: string): Promise<RemoteDocument | null>;
  write(request: DocumentWriteRequest): Promise<RemoteDocument>;
  headObject(path: string): Promise<RemoteObject | null>;
  downloadObject(path: string, options?: ObjectDownloadOptions): Promise<Blob>;
  uploadObject(request: ObjectUploadRequest): Promise<RemoteObject>;
  deleteObject?(request: ObjectDeleteRequest): Promise<void>;
}

export class SyncConflictError extends Error {
  constructor(message = 'The remote sync document changed') {
    super(message);
    this.name = 'SyncConflictError';
  }
}
