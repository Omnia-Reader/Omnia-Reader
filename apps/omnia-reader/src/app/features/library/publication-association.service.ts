import { Injectable, inject } from '@angular/core';
import {
  LIBRARY_REPOSITORY,
  publicationFingerprint,
} from '@omnia-reader/library/data-access';
import {
  AddLogicalBookVariantResult,
  BookRecord,
  BookSource,
  detectPublicationFormat,
  LogicalBookId,
  LogicalBookRecord,
  LogicalBookMutationResult,
  LogicalMutationIdentity,
  MembershipReconciliationDecision,
} from '@omnia-reader/reader/domain';
import {
  BOOK_SYNC_EXCLUSIONS,
  BookSyncExclusions,
  bookObjectPath,
} from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { createOpaqueId, DEVICE_ID } from '../../device-identity';
import { PublicationEnrichmentService } from './publication-enrichment.service';

export type AddPublicationFormatResult =
  | { status: 'cancelled' }
  | { status: 'invalid-selection'; selectedCount: number }
  | {
      status: 'added';
      mutation: LogicalBookMutationResult;
      syncPending: boolean;
    }
  | Exclude<AddLogicalBookVariantResult, { status: 'added' }>;

export interface AssociatePublicationsResult {
  mutation: LogicalBookMutationResult;
  syncPending: boolean;
}

export type ManagePublicationResult = AssociatePublicationsResult;

@Injectable({ providedIn: 'root' })
export class PublicationAssociationService {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly enrichment = inject(PublicationEnrichmentService);
  private readonly journal = inject(SYNC_OPERATION_JOURNAL);
  private readonly syncExclusions =
    inject<BookSyncExclusions>(BOOK_SYNC_EXCLUSIONS);
  private readonly deviceId = inject(DEVICE_ID);

  async addFormat(
    logicalBookId: LogicalBookId,
    sources: readonly BookSource[],
  ): Promise<AddPublicationFormatResult> {
    if (sources.length === 0) return { status: 'cancelled' };
    if (sources.length !== 1) {
      return { status: 'invalid-selection', selectedCount: sources.length };
    }

    const selected = sources[0];
    const opened = await selected.open();
    const blob = opened instanceof Blob ? opened : new Blob([opened]);
    const format = detectPublicationFormat(selected.name, selected.mediaType);
    if (!format) {
      throw new Error(`Unsupported publication “${selected.name}”`);
    }
    const id = await publicationFingerprint(blob);
    const source = new CandidateBookSource(
      selected.name,
      selected.mediaType,
      blob,
    );
    const initial: BookRecord = {
      id,
      format,
      fileName: selected.name,
      mediaType:
        selected.mediaType ||
        (format === 'epub' ? 'application/epub+zip' : 'application/pdf'),
      size: blob.size,
      title: titleFromFileName(selected.name),
      authors: [],
      importedAt: new Date().toISOString(),
    };
    const candidate = await this.enrichment.validateSource(source, initial);
    const identity = createMutationIdentity(this.deviceId);
    const result = await this.repository.addVariant(
      logicalBookId,
      candidate.book,
      source,
      bookObjectPath(candidate.book),
      identity,
      candidate.cover,
    );
    if (result.status !== 'added') return result;

    return {
      status: 'added',
      ...(await this.afterLocalMutation(result.mutation)),
    };
  }

  async compatibleCandidates(
    destinationLogicalBookId: LogicalBookId,
  ): Promise<readonly LogicalBookRecord[]> {
    const books = await this.repository.listLogicalBooks();
    const destination = books.find(
      (book) => book.id === destinationLogicalBookId,
    );
    if (!destination)
      throw new Error('The destination book is no longer available');
    return books.filter(
      (candidate) =>
        candidate.id !== destinationLogicalBookId &&
        !(
          (destination.variants.epub && candidate.variants.epub) ||
          (destination.variants.pdf && candidate.variants.pdf)
        ),
    );
  }

  async associate(
    destinationLogicalBookId: LogicalBookId,
    sourceLogicalBookId: LogicalBookId,
  ): Promise<AssociatePublicationsResult> {
    const mutation = await this.repository.associate(
      destinationLogicalBookId,
      sourceLogicalBookId,
      createMutationIdentity(this.deviceId),
    );
    let syncPending = false;
    try {
      await this.journal.append({
        entity: 'logical-book-change',
        entityId: mutation.change.changeId,
        operation: 'upsert',
        payload: mutation.change,
      });
    } catch {
      syncPending = true;
    }
    return { mutation, syncPending };
  }

  async detach(
    logicalBookId: LogicalBookId,
    variantId: string,
  ): Promise<ManagePublicationResult> {
    const mutation = await this.repository.detachVariant(
      logicalBookId,
      variantId,
      createMutationIdentity(this.deviceId),
    );
    return this.afterLocalMutation(mutation);
  }

  async deleteVariant(
    logicalBookId: LogicalBookId,
    variantId: string | null,
  ): Promise<ManagePublicationResult> {
    const logicalBook = await this.repository.getLogicalBook(logicalBookId);
    const targets =
      variantId === null
        ? Object.values(logicalBook?.variants ?? {}).filter(
            (id): id is string => !!id,
          )
        : [variantId];
    const newlyExcluded = targets.filter(
      (target) => !this.syncExclusions.isExcluded(target),
    );
    targets.forEach((target) => this.syncExclusions.exclude(target));
    let mutation: LogicalBookMutationResult;
    try {
      mutation = await this.repository.deleteVariant(
        logicalBookId,
        variantId,
        createMutationIdentity(this.deviceId),
      );
    } catch (error) {
      newlyExcluded.forEach((target) => this.syncExclusions.include(target));
      throw error;
    }
    return this.afterLocalMutation(mutation);
  }

  async reconcile(
    conflictId: string,
    decision: MembershipReconciliationDecision,
  ): Promise<ManagePublicationResult> {
    const mutation = await this.repository.reconcileMembership(
      conflictId,
      decision,
      createMutationIdentity(this.deviceId),
    );
    return this.afterLocalMutation(mutation);
  }

  private async afterLocalMutation(
    mutation: LogicalBookMutationResult,
  ): Promise<ManagePublicationResult> {
    mutation.deletedVariantIds.forEach((variantId) =>
      this.syncExclusions.exclude(variantId),
    );
    mutation.createdVariantIds.forEach((variantId) =>
      this.syncExclusions.include(variantId),
    );
    let syncPending = false;
    try {
      await this.journal.append({
        entity: 'logical-book-change',
        entityId: mutation.change.changeId,
        operation: 'upsert',
        payload: mutation.change,
      });
    } catch {
      syncPending = true;
    }
    return { mutation, syncPending };
  }
}

class CandidateBookSource implements BookSource {
  readonly size: number;

  constructor(
    readonly name: string,
    readonly mediaType: string,
    private readonly blob: Blob,
  ) {
    this.size = blob.size;
  }

  open(): Promise<Blob> {
    return Promise.resolve(this.blob);
  }
}

function createMutationIdentity(deviceId: string): LogicalMutationIdentity {
  const suffix = createOpaqueId();
  return {
    changeId: `change:${deviceId}:${suffix}`,
    parents: [],
    createdAt: new Date().toISOString(),
    deviceId,
    appVersion: '0.0.0',
  };
}

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.(epub|pdf)$/i, '') || 'Untitled publication';
}
