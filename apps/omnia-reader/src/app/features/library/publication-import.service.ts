import { Injectable, inject, signal } from '@angular/core';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import {
  BookRecord,
  BookSource,
  NewSyncOperation,
} from '@omnia-reader/reader/domain';
import { createBookSyncManifest } from '@omnia-reader/sync/core';
import { SYNC_OPERATION_JOURNAL } from '@omnia-reader/sync/git';
import { PublicationEnrichmentService } from './publication-enrichment.service';

@Injectable({ providedIn: 'root' })
export class PublicationImportService {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly syncJournal = inject(SYNC_OPERATION_JOURNAL);
  private readonly enrichment = inject(PublicationEnrichmentService);
  private readonly importedListeners = new Set<
    (books: readonly BookRecord[]) => void
  >();
  private readonly errorState = signal<string | null>(null);

  readonly error = this.errorState.asReadonly();

  async importPublications(
    sources: readonly BookSource[],
  ): Promise<readonly BookRecord[]> {
    const books: BookRecord[] = [];
    const existingBookIds = new Set(
      (await this.repository.listBooks()).map((book) => book.id),
    );
    for (const source of sources) {
      let imported: BookRecord | null = null;
      try {
        imported = await this.repository.importBook(source);
        const book = await this.enrichment.validateAndEnrich(imported);
        books.push(book);
        existingBookIds.add(book.id);
        await this.appendJournalEntry({
          entity: 'book',
          entityId: book.id,
          operation: 'upsert',
          payload: createBookSyncManifest(book),
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
        throw error;
      }
    }
    if (books.length > 0) {
      for (const listener of this.importedListeners) {
        listener(books);
      }
    }
    return books;
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
