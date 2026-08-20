import {
  BookRecord,
  BookSource,
  LibraryRepository,
} from '@omnia-reader/reader/domain';
import { bookObjectPath } from './book-sync-manifest';
import {
  LibrarySyncTransport,
  ObjectTransferOptions,
  RemoteObject,
} from './library-sync-transport';

export interface RemoteVariantRecoveryDescriptor {
  path: string;
  revision: string;
  size: number;
  sha256: string;
}

export interface RemoteVariantRecovery {
  probe(book: BookRecord): Promise<RemoteVariantRecoveryDescriptor | null>;
  recover(book: BookRecord, options?: ObjectTransferOptions): Promise<void>;
}

export class RemoteVariantRecoveryMismatchError extends Error {
  constructor() {
    super(
      'The synchronized publication no longer matches this library variant',
    );
    this.name = 'RemoteVariantRecoveryMismatchError';
  }
}

export class DefaultRemoteVariantRecovery implements RemoteVariantRecovery {
  constructor(
    private readonly remote: LibrarySyncTransport,
    private readonly repository: LibraryRepository,
  ) {}

  async probe(
    book: BookRecord,
  ): Promise<RemoteVariantRecoveryDescriptor | null> {
    const object = await this.remote.headObject(bookObjectPath(book));
    return object && matchesBook(object, book) ? object : null;
  }

  async recover(
    book: BookRecord,
    options: ObjectTransferOptions = {},
  ): Promise<void> {
    const path = bookObjectPath(book);
    const object = await this.remote.headObject(path);
    if (!object || !matchesBook(object, book)) {
      throw new RemoteVariantRecoveryMismatchError();
    }

    const content = await this.remote.downloadObject(path, {
      ...options,
      expectedSize: book.size,
    });
    const source: BookSource = {
      name: book.fileName,
      mediaType: book.mediaType,
      size: content.size,
      open: async () => content,
    };
    await this.repository.replaceVariantSource(book.id, source);
  }
}

function matchesBook(object: RemoteObject, book: BookRecord): boolean {
  return (
    object.path === bookObjectPath(book) &&
    object.size === book.size &&
    object.sha256.toLowerCase() ===
      book.id.slice('sha256:'.length).toLowerCase()
  );
}
