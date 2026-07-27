import { Injectable, inject, signal } from '@angular/core';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import {
  BookRecord,
  BookSource,
  NewSyncOperation,
} from '@omnia-reader/reader/domain';
import {
  BOOK_SYNC_EXCLUSIONS,
  createBookSyncDeletionTombstone,
  createBookSyncManifest,
} from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { PublicationEnrichmentService } from './publication-enrichment.service';

export interface PublicationImportResult {
  books: readonly BookRecord[];
  added: readonly BookRecord[];
  duplicates: readonly BookRecord[];
  failures: readonly PublicationImportFailure[];
}

export interface PublicationImportFailure {
  sourceName: string;
  message: string;
}

export function describePublicationImportFailures(
  result: PublicationImportResult,
): string | null {
  if (result.failures.length === 0) {
    return null;
  }
  const visible = result.failures
    .slice(0, 3)
    .map((failure) => `“${failure.sourceName}”: ${failure.message}`)
    .join(' ');
  const remaining = result.failures.length - 3;
  return (
    `${result.failures.length === 1 ? 'Could not import' : 'Could not import selected publications:'} ${visible}` +
    (remaining > 0 ? ` And ${remaining} more.` : '')
  );
}

@Injectable({ providedIn: 'root' })
export class PublicationImportService {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly syncJournal = inject(SYNC_OPERATION_JOURNAL);
  private readonly enrichment = inject(PublicationEnrichmentService);
  private readonly syncExclusions = inject(BOOK_SYNC_EXCLUSIONS);
  private readonly importedListeners = new Set<
    (books: readonly BookRecord[]) => void
  >();
  private readonly errorState = signal<string | null>(null);

  readonly error = this.errorState.asReadonly();

  async importPublications(
    sources: readonly BookSource[],
  ): Promise<PublicationImportResult> {
    const books: BookRecord[] = [];
    const added: BookRecord[] = [];
    const duplicates: BookRecord[] = [];
    const failures: PublicationImportFailure[] = [];
    const existingBookIds = new Set(
      (await this.repository.listBooks()).map((book) => book.id),
    );
    for (const source of sources) {
      let imported: BookRecord | null = null;
      try {
        imported = await this.repository.importBook(source);
        const isDuplicate = existingBookIds.has(imported.id);
        const book = await this.enrichment.validateAndEnrich(imported);
        this.syncExclusions.include(book.id);
        books.push(book);
        (isDuplicate ? duplicates : added).push(book);
        existingBookIds.add(book.id);
        await this.appendJournalEntry({
          entity: 'book',
          entityId: book.id,
          operation: 'upsert',
          payload: createBookSyncManifest(book, new Date().toISOString()),
        });
      } catch (error) {
        if (imported && !existingBookIds.has(imported.id)) {
          try {
            await this.repository.removeBook(imported.id);
          } catch {
            // Preserve the validation error; repository recovery can
            // quarantine any incomplete record left by failed cleanup.
          }
        }
        failures.push({
          sourceName: source.name,
          message:
            error instanceof Error
              ? error.message
              : 'The publication could not be imported',
        });
      }
    }
    if (books.length > 0) {
      for (const listener of this.importedListeners) {
        listener(books);
      }
    }
    return { books, added, duplicates, failures };
  }

  async removePublication(book: BookRecord): Promise<void> {
    const wasExcluded = this.syncExclusions.isExcluded(book.id);
    this.syncExclusions.exclude(book.id);
    try {
      await this.repository.removeBook(book.id);
    } catch (error) {
      if (!wasExcluded) {
        this.syncExclusions.include(book.id);
      }
      throw error;
    }
    await this.appendJournalEntry({
      entity: 'book',
      entityId: book.id,
      operation: 'delete',
      payload: createBookSyncDeletionTombstone(book),
    });
  }

  onImported(listener: (books: readonly BookRecord[]) => void): () => void {
    this.importedListeners.add(listener);
    return () => this.importedListeners.delete(listener);
  }

  reportError(error: unknown): void {
    this.errorState.set(
      error instanceof Error ? error.message : 'The publication import failed',
    );
  }

  clearError(): void {
    this.errorState.set(null);
  }

  private async appendJournalEntry(operation: NewSyncOperation): Promise<void> {
    try {
      await this.syncJournal.append(operation);
    } catch {
      // A journal outage must never make a successfully imported book fail.
    }
  }
}
