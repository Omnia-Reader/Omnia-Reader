import { LibraryQuarantineService } from './library-quarantine.service';

describe('LibraryQuarantineService', () => {
  it('exports lossless binary and cyclic recovery data without removing it', async () => {
    const cyclicValue: Record<string, unknown> = {
      title: 'Malformed publication',
      binary: new Uint8Array([0, 1, 2, 255]),
      notANumber: Number.NaN,
    };
    cyclicValue['self'] = cyclicValue;
    const records = [
      {
        id: 7,
        storeName: 'books' as const,
        recordKey: 'corrupt-book',
        value: cyclicValue,
        reason: 'Book metadata failed schema validation',
        quarantinedAt: '2026-07-25T11:00:00.000Z',
      },
    ];
    const repository = {
      listQuarantinedRecords: vi.fn(async () => records),
    };
    const exported = await new LibraryQuarantineService(
      repository,
    ).exportRecords(new Date('2026-07-25T12:30:00.000Z'));
    const document = JSON.parse(await blobText(exported.blob)) as {
      schemaVersion: number;
      recordCount: number;
      records: {
        storeName: string;
        value: {
          $type: string;
          properties: {
            key: string;
            value: { $type?: string; data?: string; id?: number };
          }[];
        };
      }[];
    };

    expect(repository.listQuarantinedRecords).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(exported.fileName).toBe(
      'omnia-reader-quarantine-2026-07-25.omnia-quarantine.json',
    );
    expect(exported.blob.type).toBe(
      'application/vnd.omnia-reader.quarantine+json',
    );
    expect(document.schemaVersion).toBe(1);
    expect(document.recordCount).toBe(1);
    expect(document.records[0].storeName).toBe('books');
    expect(
      document.records[0].value.properties.find(
        (property) => property.key === 'binary',
      )?.value,
    ).toMatchObject({
      $type: 'array-buffer-view',
      data: 'AAEC/w==',
    });
    expect(
      document.records[0].value.properties.find(
        (property) => property.key === 'self',
      )?.value,
    ).toMatchObject({
      $type: 'reference',
      id: 1,
    });
  });
});

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read quarantine export')),
    );
    reader.readAsText(blob);
  });
}
