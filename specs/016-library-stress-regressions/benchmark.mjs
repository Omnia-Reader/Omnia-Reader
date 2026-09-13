// Run with Node 26.5.0 from the workspace root. Optional argument: baseline module.
import { pathToFileURL } from 'node:url';
import * as current from '../../apps/omnia-reader/src/app/features/library/library-view.ts';

const variants = Array.from({ length: 10_000 }, (_, index) => ({
  id: `sha256:${index.toString(16).padStart(64, '0')}`,
  format: 'epub',
  title: `Book ${(index * 7919) % 10_000}`,
  authors: ['Author'],
  fileName: 'book.epub',
  mediaType: 'application/epub+zip',
  size: 1024,
  importedAt: '2026-01-01T00:00:00.000Z',
}));
const cards = current.createLogicalLibraryCards(
  variants.map((variant) => ({
    ...variant,
    id: `logical:${variant.id}`,
    variants: { epub: variant.id },
  })),
  variants,
  [],
  new Map(),
);
const modules = { current };
if (process.argv[2])
  modules.baseline = await import(pathToFileURL(process.argv[2]).href);
const samples = Object.fromEntries(
  Object.keys(modules).map((name) => [name, []]),
);
for (let iteration = 0; iteration < 12; iteration++) {
  // Alternate order to reduce systematic warmup and scheduling bias.
  const entries = Object.entries(modules);
  if (iteration % 2) entries.reverse();
  for (const [name, module] of entries) {
    const started = performance.now();
    module.selectLogicalLibraryCards(cards, '', 'title');
    if (iteration >= 3) samples[name].push(performance.now() - started);
  }
}
console.log(
  JSON.stringify(
    {
      cards: cards.length,
      node: process.version,
      results: Object.fromEntries(
        Object.entries(samples).map(([name, values]) => [
          name,
          {
            samplesMs: values,
            medianMs: [...values].sort((a, b) => a - b)[
              Math.floor(values.length / 2)
            ],
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
