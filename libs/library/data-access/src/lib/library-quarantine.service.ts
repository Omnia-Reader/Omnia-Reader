import type { QuarantinedLibraryRecord } from './browser-library-repository';
import { LibraryQuarantineRepository } from './library-quarantine.token';

const QUARANTINE_EXPORT_MEDIA_TYPE =
  'application/vnd.omnia-reader.quarantine+json';

export interface LibraryQuarantineExport {
  blob: Blob;
  fileName: string;
  recordCount: number;
}

interface PortableReference {
  $type: 'reference';
  id: number;
}

type PortableValue =
  | null
  | boolean
  | string
  | number
  | PortableReference
  | {
      $type: string;
      [key: string]: PortableValue | PortableValue[] | number | string | null;
    };

export class LibraryQuarantineService {
  constructor(private readonly repository: LibraryQuarantineRepository) {}

  listRecords(): Promise<readonly QuarantinedLibraryRecord[]> {
    return this.repository.listQuarantinedRecords();
  }

  async exportRecords(
    exportedAt = new Date(),
  ): Promise<LibraryQuarantineExport> {
    const records = await this.listRecords();
    const encoder = new PortableStructuredValueEncoder();
    const document = {
      schemaVersion: 1,
      application: 'omnia-reader',
      exportedAt: exportedAt.toISOString(),
      recordCount: records.length,
      records: await Promise.all(
        records.map(async (record) => ({
          id: record.id ?? null,
          storeName: record.storeName,
          recordKey: await encoder.encode(record.recordKey),
          value: await encoder.encode(record.value),
          reason: record.reason,
          quarantinedAt: record.quarantinedAt,
        })),
      ),
    };
    const blob = new Blob([JSON.stringify(document, null, 2)], {
      type: QUARANTINE_EXPORT_MEDIA_TYPE,
    });

    return {
      blob,
      fileName: `omnia-reader-quarantine-${dateStamp(exportedAt)}.omnia-quarantine.json`,
      recordCount: records.length,
    };
  }
}

class PortableStructuredValueEncoder {
  private readonly references = new WeakMap<object, number>();
  private nextReferenceId = 1;

  async encode(value: unknown): Promise<PortableValue> {
    if (value === null) {
      return null;
    }
    if (typeof value === 'boolean' || typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return encodeNumber(value);
    }
    if (typeof value === 'undefined') {
      return { $type: 'undefined' };
    }
    if (typeof value === 'bigint') {
      return { $type: 'bigint', value: value.toString() };
    }
    if (typeof value !== 'object') {
      return { $type: 'unsupported', value: String(value) };
    }

    const knownReference = this.references.get(value);
    if (knownReference !== undefined) {
      return { $type: 'reference', id: knownReference };
    }
    const id = this.nextReferenceId;
    this.nextReferenceId += 1;
    this.references.set(value, id);

    if (value instanceof Date) {
      return {
        $type: 'date',
        id,
        value: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString(),
      };
    }
    if (value instanceof RegExp) {
      return {
        $type: 'regexp',
        id,
        source: value.source,
        flags: value.flags,
        lastIndex: value.lastIndex,
      };
    }
    if (typeof File !== 'undefined' && value instanceof File) {
      return {
        $type: 'file',
        id,
        name: value.name,
        mediaType: value.type,
        lastModified: value.lastModified,
        size: value.size,
        data: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      };
    }
    if (value instanceof Blob) {
      return {
        $type: 'blob',
        id,
        mediaType: value.type,
        size: value.size,
        data: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      };
    }
    if (value instanceof ArrayBuffer) {
      return {
        $type: 'array-buffer',
        id,
        data: bytesToBase64(new Uint8Array(value)),
      };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        $type: 'array-buffer-view',
        id,
        view: value.constructor.name,
        data: bytesToBase64(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      };
    }
    if (Array.isArray(value)) {
      return {
        $type: 'array',
        id,
        items: await Promise.all(value.map((item) => this.encode(item))),
      };
    }
    if (value instanceof Map) {
      return {
        $type: 'map',
        id,
        entries: await Promise.all(
          [...value.entries()].map(async ([key, entryValue]) => ({
            $type: 'map-entry',
            key: await this.encode(key),
            value: await this.encode(entryValue),
          })),
        ),
      };
    }
    if (value instanceof Set) {
      return {
        $type: 'set',
        id,
        values: await Promise.all(
          [...value.values()].map((entry) => this.encode(entry)),
        ),
      };
    }
    if (value instanceof Error) {
      const errorWithCause = value as Error & { cause?: unknown };
      return {
        $type: 'error',
        id,
        name: value.name,
        message: value.message,
        stack: value.stack ?? '',
        cause: await this.encode(errorWithCause.cause),
        properties: await this.encodeObjectProperties(value),
      };
    }

    return {
      $type: 'object',
      id,
      properties: await this.encodeObjectProperties(value),
    };
  }

  private async encodeObjectProperties(
    value: object,
  ): Promise<PortableValue[]> {
    return Promise.all(
      Object.entries(value).map(async ([key, propertyValue]) => ({
        $type: 'property',
        key,
        value: await this.encode(propertyValue),
      })),
    );
  }
}

function encodeNumber(value: number): PortableValue {
  if (Number.isNaN(value)) {
    return { $type: 'number', value: 'NaN' };
  }
  if (value === Number.POSITIVE_INFINITY) {
    return { $type: 'number', value: 'Infinity' };
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return { $type: 'number', value: '-Infinity' };
  }
  if (Object.is(value, -0)) {
    return { $type: 'number', value: '-0' };
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(chunks.join(''));
}

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10);
}
