import type { ReaderPreferences } from './reader-preferences';
import type { PublicationAnnotation } from './publication-annotation';
import type { PublicationBookmark } from './publication-bookmark';
import type {
  LogicalBookFormatPreference,
  LogicalBookChange,
  LogicalBookId,
  LogicalBookMutationResult,
  LogicalBookRecord,
  LogicalLibrarySnapshot,
  LogicalMutationIdentity,
  AddLogicalBookVariantResult,
  MembershipReconciliationDecision,
  MembershipReconciliation,
  VariantAvailability,
} from './logical-book';
import type {
  PublicationReadingDirection,
  ReaderCommand,
  ReaderNavigationDirection,
  ReaderZoomDirection,
} from './reader-navigation';

export type PublicationFormat = 'epub' | 'pdf';
export type PublicationLayout = 'reflowable' | 'pre-paginated';

export interface BookSource {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  open(): Promise<Blob | ArrayBuffer>;
}

export interface PublicationMetadata {
  title: string;
  authors: string[];
  language?: string;
  publisher?: string;
  identifier?: string;
  readingDirection?: PublicationReadingDirection;
  layout?: PublicationLayout;
  cover?: Blob;
}

export interface MetadataUpdateOptions {
  markOpened?: boolean;
  markCoverUnavailable?: boolean;
}

export interface PublicationLocator {
  href: string;
  type: string;
  title?: string;
  locations?: {
    fragments?: string[];
    progression?: number;
    position?: number;
    totalProgression?: number;
  };
  text?: {
    before?: string;
    highlight?: string;
    after?: string;
  };
}

export interface TocEntry {
  title: string;
  locator: PublicationLocator;
  numbering?: 'numbered' | 'unnumbered';
  children?: readonly TocEntry[];
}

export interface SearchResult {
  locator: PublicationLocator;
  excerpt: string;
}

export interface PublicationSelection {
  locator: PublicationLocator;
}

export type PublicationPasswordReason = 'required' | 'incorrect';

export class PublicationPasswordRequiredError extends Error {
  override readonly name = 'PublicationPasswordRequiredError';

  constructor() {
    super('This PDF requires a password');
  }
}

export interface PublicationPasswordChallenge {
  reason: PublicationPasswordReason;
  submit(password: string): void;
  cancel(): void;
}

export interface PageNavigation {
  readonly pageCount: number;
  renderThumbnail(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    maxWidth: number,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ReaderPageStatus {
  current: number;
  total: number;
  scope: 'publication' | 'section';
}

export interface ReaderEngine {
  open(source: BookSource): Promise<PublicationMetadata>;
  mount(viewport: HTMLElement): Promise<void>;
  close(): Promise<void>;
  tableOfContents(): readonly TocEntry[];
  currentLocator(): PublicationLocator | null;
  pageStatus?(): ReaderPageStatus | null;
  onRelocated(listener: (locator: PublicationLocator) => void): () => void;
  onSelection(
    listener: (selection: PublicationSelection | null) => void,
  ): () => void;
  onSelectionActionRequested?(
    listener: (selection: PublicationSelection) => void,
  ): () => void;
  onAnnotationActivated?(listener: (annotationId: string) => void): () => void;
  onAnnotationGroupActivated?(
    listener: (annotationIds: readonly string[]) => void,
  ): () => void;
  onNavigationRequested?(
    listener: (direction: ReaderNavigationDirection) => void,
  ): () => void;
  onCommandRequested?(
    listener: (command: ReaderCommand) => boolean,
  ): () => void;
  onZoomRequested?(
    listener: (direction: ReaderZoomDirection) => void,
  ): () => void;
  onExternalLinkRequested?(listener: (url: string) => void): () => void;
  clearSelection(): void;
  setAnnotations(annotations: readonly PublicationAnnotation[]): Promise<void>;
  applyPreferences(preferences: ReaderPreferences): Promise<void>;
  goTo(locator: PublicationLocator): Promise<void>;
  /**
   * Moves to the nearest stable location for an overall publication
   * progression in the inclusive 0..1 range.
   */
  goToProgression?(totalProgression: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  search(query: string): AsyncIterable<SearchResult>;
  onPasswordRequested?(
    listener: (challenge: PublicationPasswordChallenge) => void,
  ): () => void;
  pageNavigation?(): PageNavigation | null;
}

export interface BookRecord {
  id: string;
  format: PublicationFormat;
  fileName: string;
  mediaType: string;
  size: number;
  title: string;
  authors: string[];
  language?: string;
  publisher?: string;
  identifier?: string;
  importedAt: string;
  lastOpenedAt?: string;
  coverState?: 'available' | 'unavailable';
}

export interface ReadingProgress {
  schemaVersion: 1;
  bookId: string;
  format: PublicationFormat;
  deviceId: string;
  locator: PublicationLocator;
  furthestTotalProgression: number;
  updatedAt: string;
  appVersion: string;
}

/**
 * Durable provider-neutral snapshots of each device's reading position.
 *
 * `LibraryRepository` keeps the merged resume position, while this port keeps
 * the individual records needed for deterministic synchronization and complete
 * portable backups.
 */
export interface ProgressDocumentRepository {
  listProgressDocuments(bookId?: string): Promise<readonly ReadingProgress[]>;
  saveProgressDocument(progress: ReadingProgress): Promise<void>;
}

export interface SyncOperation {
  id: string;
  entity:
    | 'book'
    | 'progress'
    | 'bookmark'
    | 'annotation'
    | 'preference'
    | 'logical-book-change';
  entityId: string;
  operation: 'upsert' | 'delete';
  revision: number;
  createdAt: string;
  payload: unknown;
}

export type NewSyncOperation = Pick<
  SyncOperation,
  'entity' | 'entityId' | 'operation' | 'payload'
>;

export interface SyncOperationJournal {
  append(operation: NewSyncOperation): Promise<SyncOperation>;
  pending(): Promise<readonly SyncOperation[]>;
  acknowledge(operationIds: readonly string[]): Promise<void>;
}

/**
 * Durable handoff for logical changes committed before the separate sync
 * journal can accept them. Implementations must persist a change in the same
 * transaction as its owning logical-library mutation.
 */
export interface LogicalBookChangeOutbox {
  listPendingLogicalBookChanges(): Promise<readonly LogicalBookChange[]>;
  acknowledgePendingLogicalBookChanges(
    changeIds: readonly string[],
  ): Promise<void>;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
}

export interface LibraryRepository {
  listBooks(): Promise<readonly BookRecord[]>;
  getBook(bookId: string): Promise<BookRecord | null>;
  getBookSource(bookId: string): Promise<BookSource | null>;
  getBookCover(bookId: string): Promise<Blob | null>;
  importBook(source: BookSource): Promise<BookRecord>;
  storeSyncedBook(book: BookRecord, source: BookSource): Promise<void>;
  updateMetadata(
    bookId: string,
    metadata: PublicationMetadata,
    options?: MetadataUpdateOptions,
  ): Promise<BookRecord>;
  removeBook(bookId: string): Promise<void>;
  getProgress(bookId: string): Promise<ReadingProgress | null>;
  listProgress(): Promise<readonly ReadingProgress[]>;
  saveProgress(progress: ReadingProgress): Promise<void>;
  getBookmark(bookmarkId: string): Promise<PublicationBookmark | null>;
  listBookmarks(
    bookId?: string,
    includeDeleted?: boolean,
  ): Promise<readonly PublicationBookmark[]>;
  saveBookmark(bookmark: PublicationBookmark): Promise<void>;
  getAnnotation(annotationId: string): Promise<PublicationAnnotation | null>;
  listAnnotations(
    bookId?: string,
    includeDeleted?: boolean,
  ): Promise<readonly PublicationAnnotation[]>;
  saveAnnotation(annotation: PublicationAnnotation): Promise<void>;
  getReaderPreferences(
    format: PublicationFormat,
  ): Promise<ReaderPreferences | null>;
  saveReaderPreferences(preferences: ReaderPreferences): Promise<void>;
  listLogicalBooks(): Promise<readonly LogicalBookRecord[]>;
  getLogicalBook(
    logicalBookId: LogicalBookId,
  ): Promise<LogicalBookRecord | null>;
  findLogicalBookByVariant(
    variantId: string,
  ): Promise<LogicalBookRecord | null>;
  getLogicalBookCover(logicalBookId: LogicalBookId): Promise<Blob | null>;
  getLogicalBookFormatPreference(
    logicalBookId: LogicalBookId,
  ): Promise<LogicalBookFormatPreference | null>;
  getLogicalLibrarySnapshot(): Promise<LogicalLibrarySnapshot>;
  addVariant(
    logicalBookId: LogicalBookId,
    variant: BookRecord,
    source: BookSource,
    objectPath: string,
    mutationIdentity: LogicalMutationIdentity,
    cover?: Blob,
  ): Promise<AddLogicalBookVariantResult>;
  associate(
    destinationLogicalBookId: LogicalBookId,
    sourceLogicalBookId: LogicalBookId,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult>;
  detachVariant(
    logicalBookId: LogicalBookId,
    variantId: string,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult>;
  deleteVariant(
    logicalBookId: LogicalBookId,
    variantId: string | null,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult>;
  saveLogicalBookFormatPreference(
    logicalBookId: LogicalBookId,
    preferredFormat: PublicationFormat,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookChange | null>;
  listOpenMembershipReconciliations(): Promise<
    readonly MembershipReconciliation[]
  >;
  reconcileMembership(
    conflictId: string,
    decision: MembershipReconciliationDecision,
    mutationIdentity: LogicalMutationIdentity,
  ): Promise<LogicalBookMutationResult>;
  resolveVariantAvailability(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, VariantAvailability>>;
  openHealthyVariant(
    variantId: string,
  ): Promise<
    | { availability: { status: 'healthy' }; source: BookSource }
    | { availability: Exclude<VariantAvailability, { status: 'healthy' }> }
  >;
  replaceVariantSource(variantId: string, source: BookSource): Promise<void>;
}

export interface SyncProvider {
  authenticate(): Promise<void>;
  pull(): Promise<SyncResult>;
  push(operations: readonly SyncOperation[]): Promise<SyncResult>;
  disconnect(): Promise<void>;
}

export interface FileSaveRequest {
  suggestedName: string;
  mediaType: string;
  extensions: readonly string[];
}

export interface PlatformFileSave {
  writable: WritableStream<Uint8Array>;
}

export type PlatformStoragePersistence =
  | 'persistent'
  | 'best-effort'
  | 'unavailable';

export interface PlatformStorageStatus {
  persistence: PlatformStoragePersistence;
  usageBytes?: number;
  quotaBytes?: number;
}

export interface PlatformPort {
  readonly kind: 'web' | 'tauri-desktop' | 'tauri-android';
  readonly supportsStreamingFileSave: boolean;
  getStorageStatus(): Promise<PlatformStorageStatus>;
  requestPersistentStorage(): Promise<PlatformStorageStatus>;
  pickPublications(): Promise<readonly BookSource[]>;
  createFileSave(request: FileSaveRequest): Promise<PlatformFileSave | null>;
  onPublicationsOpened(
    callback: (sources: readonly BookSource[]) => void | Promise<void>,
  ): Promise<() => void>;
  onBookDeepLink(
    callback: (bookId: string) => void | Promise<void>,
  ): Promise<() => void>;
  onBackRequested(callback: () => void | Promise<void>): Promise<() => void>;
  openExternalUrl(url: string): Promise<void>;
  requestApplicationExit(): Promise<void>;
  onBackground(callback: () => void): () => void;
}
