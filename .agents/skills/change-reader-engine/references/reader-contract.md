# Reader contract

## Shared surface

- `libs/reader/domain/src/lib/publication.ts`: publication, metadata, locator,
  TOC, selection, and engine-facing domain shapes.
- `libs/reader/domain/src/lib/reader-navigation.ts`: direction-sensitive
  keyboard and page navigation.
- `libs/reader/domain/src/lib/reader-preferences.ts`: format-specific,
  serializable preferences.
- `libs/reader/core/src/lib/reader-engine-registry.ts`: lazy engine selection.
- `apps/omnia-reader/src/app/features/reader/reader-page.component.ts`: engine
  lifecycle, persistence, panels, navigation, and user-visible errors.

## EPUB ownership

- `libs/reader/epub/src/lib/epub-reader-engine.ts`: package open, metadata,
  TOC, pagination, search, selection, decorations, link mediation, and
  teardown.
- `libs/reader/epub/src/lib/epub-locator.ts`: CFI normalization and locator
  conversion.
- Cover and metadata enrichment is orchestrated by
  `publication-enrichment.service.ts`.

Preserve script removal, unsafe URL filtering, iframe isolation, finite
pagination, reading direction, stable CFI resume, and the WebKit selection
fallback.

## PDF ownership

- `libs/reader/pdf/src/lib/pdf-reader-engine.ts`: PDF.js loading, viewer,
  outline, search, password callbacks, page locators, selection geometry,
  external links, thumbnails, and teardown.
- `apps/omnia-reader/src/app/features/reader/pdf-thumbnail.component.ts`:
  thumbnail presentation and virtualization boundary.

Preserve the separately deployed PDF worker, page-relative text offsets,
PDF-space rectangles across zoom/rotation, accessible password ownership in
the Angular shell, and explicit external-link confirmation.

## Cross-format test map

- Pure record and direction rules: `libs/reader/domain/**/*.spec.ts`.
- Registry capabilities: `libs/reader/core/**/*.spec.ts`.
- Engine behavior: the matching EPUB/PDF engine spec.
- Shell behavior: `reader-page.component.spec.ts`.
- Real rendering and resume: `apps/omnia-reader-e2e/src/example.spec.ts`.
- Offline reopen: `apps/omnia-reader-e2e/src/offline.spec.ts`.
- Test publication builders: `apps/omnia-reader-e2e/src/publication-fixtures.ts`.

Add a unit test when the behavior can be isolated. Add an end-to-end assertion
when correctness depends on iframe, canvas, worker, service worker, selection,
layout, browser event, or actual renderer behavior.
