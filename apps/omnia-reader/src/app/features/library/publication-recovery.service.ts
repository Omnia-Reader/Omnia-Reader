import { inject, Injectable } from '@angular/core';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { BookRecord } from '@omnia-reader/reader/domain';
import {
  ObjectTransferOptions,
  REMOTE_VARIANT_RECOVERY,
  RemoteVariantRecoveryDescriptor,
} from '@omnia-reader/sync/core';

export type PublicationRecoveryResult =
  | { status: 'cancelled' }
  | { status: 'invalid-selection'; selectedCount: number }
  | { status: 'replaced' };

@Injectable({ providedIn: 'root' })
export class PublicationRecoveryService {
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly platform = inject(PLATFORM_PORT);
  private readonly remote = inject(REMOTE_VARIANT_RECOVERY, { optional: true });

  async synchronizedReplacement(
    book: BookRecord,
  ): Promise<RemoteVariantRecoveryDescriptor | null> {
    if (!this.remote) return null;
    try {
      return await this.remote.probe(book);
    } catch {
      return null;
    }
  }

  async replaceFromSynchronization(
    book: BookRecord,
    options?: ObjectTransferOptions,
  ): Promise<void> {
    if (!this.remote) {
      throw new Error('Synchronized recovery is not available in this build');
    }
    await this.remote.recover(book, options);
  }

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
