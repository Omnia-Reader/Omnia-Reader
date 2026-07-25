import { BookSource } from '@omnia-reader/reader/domain';

export class BrowserBookSource implements BookSource {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;

  constructor(private readonly file: File) {
    this.name = file.name;
    this.mediaType = file.type;
    this.size = file.size;
  }

  async open(): Promise<Blob> {
    return this.file;
  }
}

export class StoredBlobBookSource implements BookSource {
  readonly size: number;

  constructor(
    readonly name: string,
    readonly mediaType: string,
    private readonly blob: Blob,
  ) {
    this.size = blob.size;
  }

  async open(): Promise<Blob> {
    return this.blob;
  }
}
