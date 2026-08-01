import { inject, Injectable } from '@angular/core';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { BookRecord } from '@omnia-reader/reader/domain';

export type PublicationRecoveryResult =
  | { status: 'cancelled' }
  | { status: 'invalid-selection'; selectedCount: number }
  | { status: 'replaced' };

@Injectable({ providedIn: 'root' })
export class PublicationRecoveryService {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly platform = inject(PLATFORM_PORT);

  async replaceFromPicker(
    book: BookRecord,
  ): Promise<PublicationRecoveryResult> {
    const sources = await this.platform.pickPublications();
    if (sources.length === 0) return { status: 'cancelled' };
    if (sources.length !== 1) {
      return { status: 'invalid-selection', selectedCount: sources.length };
    }

    // The repository is the authoritative exact-source gate. It verifies the
    // selected bytes against the existing variant's digest, size, and format
    // before replacing anything, so cancellation or mismatch is zero-change.
    await this.repository.replaceVariantSource(book.id, sources[0]);
    return { status: 'replaced' };
  }
}
