# Architecture map

## Sources of truth

- `README.md`: current capabilities and supported commands.
- `docs/universal-reader-plan.md`: architecture decisions, verified status,
  open release requirements, and release gates.
- `docs/sync-gateway-api.md`: same-origin gateway and security contract.
- `docs/mega-sdk-bridge.md`: native MEGA bridge trust and wire contract.
- `project.json`, `nx.json`, `eslint.config.mjs`, and `tsconfig.base.json`:
  executable project, target, boundary, and alias definitions.

## Project ownership

| Area                                                   | Owner                      |
| ------------------------------------------------------ | -------------------------- |
| Angular shell, lazy routes, library/reader/settings UI | `apps/omnia-reader`        |
| Browser journeys and offline installation              | `apps/omnia-reader-e2e`    |
| Same-origin GitHub/MEGA HTTP boundary                  | `apps/sync-gateway`        |
| Records, locators, preferences, annotations, bookmarks | `libs/reader/domain`       |
| Reader engine contract and registry                    | `libs/reader/core`         |
| EPUB runtime, CFI, sanitization, pagination            | `libs/reader/epub`         |
| PDF.js viewer, locators, links, password, highlights   | `libs/reader/pdf`          |
| IndexedDB/OPFS library, hashing, backup, quarantine    | `libs/library/data-access` |
| Browser/Tauri host abstraction                         | `libs/platform`            |
| Provider-neutral sync and scheduling                   | `libs/sync/core`           |
| Git/LFS journal and gateway client                     | `libs/sync/git`            |
| MEGA gateway client                                    | `libs/sync/mega`           |
| Tauri commands, capabilities, packaging                | `src-tauri`                |
| Official-SDK MEGA sidecar                              | `tools/mega-sdk-bridge`    |

## Main flows

### Import and open

1. A browser or Tauri platform adapter yields a `BookSource`.
2. `BrowserLibraryRepository` fingerprints and stores publication bytes.
3. Publication enrichment opens the matching engine for metadata and cover.
4. The library route opens `/reader/:bookId`.
5. `ReaderPageComponent` restores progress, preferences, bookmarks, and
   annotations before mounting the engine.

### Reading and local state

1. `ReaderEngineRegistry` creates the EPUB or PDF engine lazily.
2. Relocation events produce format-specific locators through the shared
   contract.
3. Local repository writes complete before best-effort journal or renderer
   follow-up.
4. Backgrounding, navigation, and quiet intervals trigger progress and sync
   work without making the network a reading prerequisite.

### Synchronization

1. Local mutations append provider-neutral journal operations.
2. The coordinator selects Git/LFS or MEGA transport.
3. Browser clients call same-origin `/api/sync` gateway endpoints.
4. Provider credentials and reusable sessions remain server-side.
5. Immutable publication objects are verified before manifests can reference
   them; mutable progress, bookmark, and annotation documents use
   deterministic merge rules and tombstones.

## Non-negotiable boundaries

- Keep DRM, LCP, OCR, AI, plugin systems, PDF reflow, and extra formats out of
  the initial release unless scope is explicitly changed.
- Treat publication input and remote sync data as hostile.
- Keep publication scripts disabled and external navigation mediated.
- Validate persisted and synchronized records at trust boundaries.
- Preserve exact-edition SHA-256 identity and declared-size verification.
- Preserve offline local authority and deterministic conflict handling.
- Keep reader engines lazy and release workers, object URLs, canvases, and
  listeners on teardown.
