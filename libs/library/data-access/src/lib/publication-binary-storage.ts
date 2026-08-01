import { PublicationFormat } from '@omnia-reader/reader/domain';

const PUBLICATIONS_DIRECTORY = 'publications-v1';
const BOOK_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

interface StoredPublicationBinaryBase {
  schemaVersion: 2;
  bookId: string;
  fileName: string;
  mediaType: string;
  size: number;
}

export type IndexedDbPublicationBinary = StoredPublicationBinaryBase & {
  storage: 'indexeddb';
} & ({ bytes: ArrayBuffer; blob?: never } | { blob: Blob; bytes?: never });

export interface OpfsPublicationBinary extends StoredPublicationBinaryBase {
  storage: 'opfs';
  opfsFileName: string;
}

export type StoredPublicationBinary =
  | IndexedDbPublicationBinary
  | OpfsPublicationBinary;

export interface PublicationBinaryWrite {
  bookId: string;
  format: PublicationFormat;
  fileName: string;
  mediaType: string;
  blob: Blob;
}

export interface PublicationBinaryStorage {
  save(request: PublicationBinaryWrite): Promise<StoredPublicationBinary>;
  open(stored: StoredPublicationBinary): Promise<Blob | null>;
  migrate(
    stored: StoredPublicationBinary,
    format: PublicationFormat,
  ): Promise<StoredPublicationBinary>;
  remove(stored: StoredPublicationBinary): Promise<void>;
}

export class BrowserPublicationBinaryStorage
  implements PublicationBinaryStorage
{
  constructor(
    private readonly storageManager: StorageManager | undefined = globalThis
      .navigator?.storage,
  ) {}

  async save(
    request: PublicationBinaryWrite,
  ): Promise<StoredPublicationBinary> {
    return (
      (await this.writeOpfs(request)) ?? {
        schemaVersion: 2,
        storage: 'indexeddb',
        bookId: request.bookId,
        fileName: request.fileName,
        mediaType: request.mediaType,
        size: request.blob.size,
        bytes: await blobBytes(request.blob),
      }
    );
  }

  async open(stored: StoredPublicationBinary): Promise<Blob | null> {
    if (stored.storage === 'indexeddb') {
      const blob =
        stored.blob ??
        new Blob([stored.bytes], {
          type: stored.mediaType,
        });
      return blob.size === stored.size ? blob : null;
    }

    try {
      const directory = await this.publicationsDirectory(false);
      if (!directory) {
        return null;
      }
      const handle = await directory.getFileHandle(stored.opfsFileName);
      const file = await handle.getFile();
      return file.size === stored.size
        ? file.slice(0, file.size, stored.mediaType)
        : null;
    } catch {
      return null;
    }
  }

  async migrate(
    stored: StoredPublicationBinary,
    format: PublicationFormat,
  ): Promise<StoredPublicationBinary> {
    if (stored.storage === 'opfs') {
      return stored;
    }
    return (
      (await this.writeOpfs({
        bookId: stored.bookId,
        format,
        fileName: stored.fileName,
        mediaType: stored.mediaType,
        blob:
          stored.blob ??
          new Blob([stored.bytes], {
            type: stored.mediaType,
          }),
      })) ?? stored
    );
  }

  async remove(stored: StoredPublicationBinary): Promise<void> {
    if (stored.storage !== 'opfs') {
      return;
    }
    try {
      const directory = await this.publicationsDirectory(false);
      await directory?.removeEntry(stored.opfsFileName);
    } catch {
      // Metadata deletion remains authoritative if browser storage was evicted.
    }
  }

  private async writeOpfs(
    request: PublicationBinaryWrite,
  ): Promise<OpfsPublicationBinary | null> {
    const opfsFileName = publicationFileName(request.bookId, request.format);
    let directory: FileSystemDirectoryHandle | null = null;
    try {
      directory = await this.publicationsDirectory(true);
      if (!directory) {
        return null;
      }
      const handle = await directory.getFileHandle(opfsFileName, {
        create: true,
      });
      const writable = await handle.createWritable();
      try {
        await writable.write(request.blob);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      const persisted = await handle.getFile();
      if (persisted.size !== request.blob.size) {
        throw new Error('The publication was not completely written to OPFS');
      }
      return {
        schemaVersion: 2,
        storage: 'opfs',
        bookId: request.bookId,
        fileName: request.fileName,
        mediaType: request.mediaType,
        size: request.blob.size,
        opfsFileName,
      };
    } catch {
      await directory?.removeEntry(opfsFileName).catch(() => undefined);
      return null;
    }
  }

  private async publicationsDirectory(
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    if (typeof this.storageManager?.getDirectory !== 'function') {
      return null;
    }
    const root = await this.storageManager.getDirectory();
    return root.getDirectoryHandle(PUBLICATIONS_DIRECTORY, { create });
  }
}

export function parseStoredPublicationBinary(
  value: unknown,
): StoredPublicationBinary | null {
  if (!isRecord(value)) {
    return null;
  }
  const bookId = value['bookId'];
  const fileName = value['fileName'];
  const mediaType = value['mediaType'];
  const digest =
    typeof bookId === 'string' ? BOOK_ID_PATTERN.exec(bookId)?.[1] : undefined;
  if (
    typeof bookId !== 'string' ||
    !digest ||
    typeof fileName !== 'string' ||
    !fileName ||
    fileName.length > 1024 ||
    typeof mediaType !== 'string' ||
    !mediaType ||
    mediaType.length > 1024
  ) {
    return null;
  }

  if (value['storage'] === 'opfs') {
    const size = value['size'];
    const opfsFileName = value['opfsFileName'];
    return value['schemaVersion'] === 2 &&
      Number.isSafeInteger(size) &&
      (size as number) > 0 &&
      typeof opfsFileName === 'string' &&
      (opfsFileName === `${digest}.epub` || opfsFileName === `${digest}.pdf`)
      ? {
          schemaVersion: 2,
          storage: 'opfs',
          bookId,
          fileName,
          mediaType,
          size: size as number,
          opfsFileName,
        }
      : null;
  }

  const blob = value['blob'];
  const bytes = value['bytes'];
  const currentIndexedDbBlob =
    value['schemaVersion'] === 2 &&
    value['storage'] === 'indexeddb' &&
    blob instanceof Blob &&
    value['size'] === blob.size;
  const legacyIndexedDbBlob =
    value['schemaVersion'] === undefined &&
    value['storage'] === undefined &&
    blob instanceof Blob;
  if (currentIndexedDbBlob || legacyIndexedDbBlob) {
    return {
      schemaVersion: 2,
      storage: 'indexeddb',
      bookId,
      fileName,
      mediaType,
      size: blob.size,
      blob,
    };
  }
  const arrayBuffer = asArrayBuffer(bytes);
  if (
    value['schemaVersion'] === 2 &&
    value['storage'] === 'indexeddb' &&
    arrayBuffer &&
    value['size'] === arrayBuffer.byteLength
  ) {
    return {
      schemaVersion: 2,
      storage: 'indexeddb',
      bookId,
      fileName,
      mediaType,
      size: arrayBuffer.byteLength,
      bytes: arrayBuffer,
    };
  }
  return null;
}

function publicationFileName(
  bookId: string,
  format: PublicationFormat,
): string {
  const digest = BOOK_ID_PATTERN.exec(bookId)?.[1];
  if (!digest) {
    throw new TypeError('Book IDs must be SHA-256 fingerprints');
  }
  return `${digest}.${format}`;
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read publication bytes'));
      }
    });
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read publication bytes')),
    );
    reader.readAsArrayBuffer(blob);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  ) {
    return value as ArrayBuffer;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  return null;
}
