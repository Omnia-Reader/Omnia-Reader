import {
  DocumentWriteRequest,
  LibrarySyncTransport,
  RemoteDocument,
  SyncConflictError,
} from '@omnia-reader/sync/core';

export type GitFile = RemoteDocument;
export type GitWriteRequest = DocumentWriteRequest;

export type GitRepositoryTransport = Pick<
  LibrarySyncTransport,
  'list' | 'read' | 'write' | 'deleteDocument'
>;

export class GitConflictError extends SyncConflictError {
  constructor(message = 'The remote Git document changed') {
    super(message);
    this.name = 'GitConflictError';
  }
}
