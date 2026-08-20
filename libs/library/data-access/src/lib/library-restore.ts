import {
  BookRecord,
  LogicalBookFormatPreference,
  LogicalBookId,
  LogicalBookRecord,
  MembershipReconciliation,
  PublicationAnnotation,
  PublicationBookmark,
  ReaderPreferences,
  ReadingProgress,
} from '@omnia-reader/reader/domain';

export interface LibraryRestorePublication {
  record: BookRecord;
  content: Blob;
}

export interface AtomicLibraryRestoreRequest {
  expectedLogicalRevision: string;
  publications: readonly LibraryRestorePublication[];
  logicalBooks: readonly LogicalBookRecord[];
  logicalBookPreferences: readonly LogicalBookFormatPreference[];
  membershipReconciliations: readonly MembershipReconciliation[];
  logicalBookCovers: ReadonlyMap<LogicalBookId, Blob>;
  progress: readonly ReadingProgress[];
  progressDocuments: readonly ReadingProgress[];
  readerPreferences: readonly ReaderPreferences[];
  bookmarks: readonly PublicationBookmark[];
  annotations: readonly PublicationAnnotation[];
}

export interface AtomicLibraryRestoreRepository {
  restoreLibraryBackupAtomically(
    request: AtomicLibraryRestoreRequest,
  ): Promise<void>;
}

export class LibraryRestoreStaleRevisionError extends Error {
  constructor() {
    super('The library changed while the backup restore was being prepared');
    this.name = 'LibraryRestoreStaleRevisionError';
  }
}
