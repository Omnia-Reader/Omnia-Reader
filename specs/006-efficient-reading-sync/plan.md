# Implementation Plan: Efficient Reading Synchronization

**Feature Directory**: `006-efficient-reading-sync` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-efficient-reading-sync/spec.md`

## Summary

Stop treating device-local `lastOpenedAt` changes as publication mutations, then make the existing publication fallback reuse its fetched remote manifest snapshot. Only pending or remotely missing publications enter the expensive source/object verification path. Legacy-layout cleanup becomes mutation-triggered and retryable, removing `.omnia-reader/v1/books` from stable reading/progress passes without adding durable destination state or weakening new/changed/deleted publication validation.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing Angular reader page, reader-domain `BookRecord`, sync-core manifest/book/catalog services, provider-neutral transport, operation journal; no new dependency

**Storage**: Existing IndexedDB library and operation journal plus provider documents/objects; no schema or new storage

**Testing**: Angular/Vitest reader-page tests, sync-core Vitest request-count and regression tests, existing Playwright fake gateway

**Target platforms**: Shared web/PWA, Chromium/Firefox/WebKit browser behavior, desktop and Android Tauri web client; no native code

**Performance goals**: Zero `book` journal operations on unchanged open; one active publication listing, zero per-publication remote checks, and zero legacy listings in a progress-only publication pass

**Constraints**: Offline-first, hostile remote data, complete integrity checks for changed/missing publications, deterministic deletions, safe retries, locked dependencies

**Scope**: EPUB/PDF shared reader orchestration and provider-neutral book synchronization; GitHub exposes the reported cost but routes, authentication, LFS protocol, MEGA transport, engines, and durable schemas remain unchanged

## Constitution Check

_GATE: Passed before research and re-checked after design._

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged.

Post-design check: passed. The design adds no storage, provider route, credential movement, or weaker validation. Snapshot eligibility requires an exact valid manifest and no pending publication intent; all uncertain states retain the existing path.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `ReaderPageComponent.loadBook`, `createBookSyncManifest`, `BookSyncService.synchronize/pull/push/cleanupLegacyRemoteLayout`, `updateBookSyncCatalog`, `SyncOperationJournal.pending`.
- **Owning project(s)**: `omnia-reader` owns open-event orchestration; `sync-core` owns publication reconciliation and request bounds; `omnia-reader-e2e` owns the fake-gateway browser journey.
- **Affected consumers**: `LibrarySyncCoordinator` continues to consume `BookSyncService` through the unchanged `SyncWorker` contract. Public `pull` and `push` behavior remains available to existing tests/consumers.
- **Unchanged boundaries**: reader engines, IndexedDB schema, progress/bookmark/annotation merge, sync checkpoint, sync-git client, gateway/provider HTTP, MEGA, backup, Tauri, and native bridge.

### Repository Paths

```text
apps/omnia-reader/src/app/features/reader/reader-page.component.ts
apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts
apps/omnia-reader-e2e/src/sync.spec.ts
libs/sync/core/src/lib/book-sync-service.ts
libs/sync/core/src/lib/book-sync-service.spec.ts
libs/sync/core/src/lib/book-sync-catalog.ts
libs/sync/core/src/lib/book-sync-catalog.spec.ts
specs/006-efficient-reading-sync/
```

## Design

### Contracts and State

- Compare the manifest-represented immutable identity and metadata before and after reader metadata refresh. `lastOpenedAt` and cover state are excluded. Append a `book` upsert only when the represented value changes, using the new open timestamp as the metadata revision.
- `BookSyncService.runSynchronization` fetches deletions, active publication documents, and pending operations once. Private pull/push helpers consume that snapshot; public `pull`/`push` retain standalone fetch behavior.
- Push planning builds a valid exact-path remote-manifest index. Pending book operations remain authoritative. A local book without a valid remote manifest is synthesized for provider seeding. A local book with an exact valid remote manifest and no pending book operation is skipped rather than reopened, rehashed, and rechecked.
- Catalog generation accepts an optional already-fetched publication snapshot. It reuses the snapshot only when the book phase made no remote mutation; otherwise it lists current manifests as before.
- Publication pull or push work marks legacy cleanup pending. Successful cleanup clears the marker; failure or cancellation leaves it pending for retry. Stable passes do not scan the legacy prefix, and later destination publication work schedules cleanup without requiring a destination identity cache.
- No public provider or durable schema changes. Rollback restores redundant work only.

### User Interface and Accessibility

- No UI structure, focus, keyboard, touch, pointer, or accessible-name change. Recent-opened ordering still uses local `lastOpenedAt`.

### Security and Failure Handling

- Only a parsed valid manifest at its canonical path qualifies as remote presence. Malformed paths/content remain rejected and missing manifests still seed through the full source, digest, object, and write checks.
- Journal append failure stays isolated from reading. Provider/cancellation errors preserve pending operations and pending legacy cleanup. A valid exact manifest suppresses routine LFS object probes; object validation remains mandatory whenever pending or missing-manifest work is processed. Credentials remain gateway-only.

### Lifecycle and Performance

- No new async owner, listener, timer, worker, or durable cache.
- Remote snapshot maps are bounded by the already-bounded provider listing and released after each pass.
- Exact request counters in sync-core tests enforce constant publication-list behavior and zero per-book remote/object work for current libraries.
- The browser journey distinguishes reader/open requests from later quiet progress synchronization.

## Verification Plan

| Requirement/story       | Evidence                                                                          | Command or environment                                                                                                                                                    | Required locally?           |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| FR-001–FR-002 / US1     | Unchanged versus changed reader metadata journal assertions                       | `npx nx test omnia-reader --skip-nx-cache --include=apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts`                                              | Yes                         |
| FR-003–FR-007 / US2     | Exact book transport request counts and existing mutation/deletion/conflict cases | `npx nx test sync-core --skip-nx-cache --include=libs/sync/core/src/lib/book-sync-service.spec.ts --include=libs/sync/core/src/lib/book-sync-catalog.spec.ts`             | Yes                         |
| SC-001–SC-003           | Fake-gateway Chromium reading/sync journey                                        | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx nx run omnia-reader-e2e:e2e --skip-nx-cache -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts` | Yes if host Chrome launches |
| TypeScript ownership    | Affected lint                                                                     | `npx nx run-many -t lint -p sync-core omnia-reader omnia-reader-e2e --skip-nx-cache`                                                                                      | Yes                         |
| Application integration | Production compilation and budgets                                                | `npx nx build omnia-reader --configuration production --skip-nx-cache`                                                                                                    | Yes                         |
| Live provider           | Credentialed GitHub request/timing trace                                          | Selected test repository and live gateway                                                                                                                                 | No                          |
| Scope integrity         | Whitespace and status evidence                                                    | `git diff --check` and `git status --short`                                                                                                                               | Yes                         |

## Delivery and Documentation

- **Vertical slices**: First eliminate false reader book mutations; then bound publication fallback requests and legacy cleanup.
- **Migration/rollout**: No migration. Publication work retains legacy compatibility cleanup; stable reading/progress passes do not invoke it.
- **Documentation**: Reconcile this feature and add the bounded request behavior to `docs/sync-gateway-api.md` only if the shared synchronization contract description needs clarification; no product roadmap change.
- **Residual gates**: Live credentialed GitHub timing, Firefox/WebKit, packaged desktop, Android emulator, and physical device are reported separately when unavailable.

## Complexity and Exceptions

No constitution exception is required.
