---
name: change-reader-engine
description: Implement or diagnose EPUB and PDF reader behavior in Omnia Reader. Use for ReaderEngine contracts, EPUB CFI or pagination, PDF.js pages or locators, search, selection, highlights, passwords, links, rendering lifecycle, reader preferences, or reader-shell integration in libs/reader and apps/omnia-reader/src/app/features/reader.
---

# Change Reader Engine

Change format behavior while preserving the shared reader contract, hostile
publication boundary, lazy loading, exact resume, and cross-browser behavior.

## Trace before editing

1. Inspect the exact publication, failing journey, stack trace, or test first.
2. Use CodeGraph to trace the affected `ReaderEngine` method through the
   registry and `ReaderPageComponent`; include teardown and event callbacks in
   the blast radius.
3. Read [references/reader-contract.md](references/reader-contract.md).
4. Consult current primary documentation for Angular, PDF.js, or the pinned
   EPUB runtime when API behavior is material.

## Keep ownership explicit

- Change `reader/domain` for shared serializable records and pure navigation
  rules.
- Change `reader/core` for format-neutral engine capabilities and selection.
- Change only the relevant engine library for rendering details.
- Change the app reader feature for orchestration and user-visible panels.
- Avoid format checks in shared code when a capability or engine method can
  express the distinction.

## Preserve invariants

- Make locators serializable, deterministic, and sufficient for exact resume.
- Save progress from relocation, not only explicit button actions.
- Persist bookmarks and annotations before rendering or sync follow-up.
- Keep EPUB content sandboxed and sanitized; mediate unsafe or external links.
- Keep PDF external navigation explicit and outside the publication context.
- Preserve password retry and cancellation behavior without retaining secrets.
- Keep engines in lazy chunks and avoid moving renderer dependencies into the
  application shell.
- Release event listeners, workers, object URLs, canvases, decorations, and
  renderer instances during teardown.
- Preserve LTR/RTL direction and keyboard behavior; do not assume left always
  means previous.

## Test the behavior

1. Add focused engine tests for parsing, locator, lifecycle, error, and
   security branches.
2. Add reader-shell tests for orchestration or visible state changes.
3. Add or extend Playwright fixtures for real rendering, resume, selection,
   browser integration, or cross-browser regressions.
4. Run `$verify-omnia-reader` with the reader-engine rows from its change
   matrix.

State which publication/browser combinations were exercised. Do not generalize
from a synthetic fixture to encrypted, fixed-layout, RTL, malformed, or very
large publications unless those cases were actually tested.
