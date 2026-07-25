import { ReaderEngine } from '@omnia-reader/reader/domain';
import { inferPublicationFormat } from './reader-errors';
import { ReaderEngineRegistry } from './reader-engine-registry';

describe('ReaderEngineRegistry', () => {
  it('loads only the engine requested for a publication', async () => {
    const registry = new ReaderEngineRegistry();
    const engine = {} as ReaderEngine;
    const epubLoader = vi.fn(async () => engine);
    const pdfLoader = vi.fn(async () => engine);
    registry.register('epub', epubLoader);
    registry.register('pdf', pdfLoader);

    await expect(registry.create('pdf')).resolves.toBe(engine);
    expect(pdfLoader).toHaveBeenCalledOnce();
    expect(epubLoader).not.toHaveBeenCalled();
  });

  it('rejects formats without a registered engine', async () => {
    const registry = new ReaderEngineRegistry();

    await expect(registry.create('epub')).rejects.toThrow(
      'No reader engine is registered',
    );
  });
});

describe('inferPublicationFormat', () => {
  it.each([
    ['novel.epub', '', 'epub'],
    ['novel', 'application/epub+zip', 'epub'],
    ['manual.PDF', '', 'pdf'],
    ['manual', 'application/pdf', 'pdf'],
  ] as const)('detects %s (%s) as %s', (name, mediaType, expected) => {
    expect(inferPublicationFormat(name, mediaType)).toBe(expected);
  });

  it('rejects unsupported files', () => {
    expect(() => inferPublicationFormat('notes.txt', 'text/plain')).toThrow(
      'Unsupported publication',
    );
  });
});
