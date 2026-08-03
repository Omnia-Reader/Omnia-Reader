# Implementation Plan: Provider Book Filenames

**Feature Directory**: `010-provider-filenames` | **Date**: 2026-08-03 | **Spec**: [spec.md](spec.md)

## Summary

Make `bookObjectPath(BookRecord)` the sole source for new publication references and move the current synchronization root from `.omnia-reader/v1/` to `.omnia-reader/`. Add a provider-neutral entry inventory and a resumable full-sync preflight/postflight that migrates and verifies valid previous-root documents and objects before removing the obsolete `v1` tree. Replace append-only logical changes with one bounded, validated `logical-books/state.json` whose record clocks and tombstones preserve deterministic offline convergence.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing reader domain, library data-access, sync-core, and Angular application projects; no new dependency

**Storage**: Existing IndexedDB synchronization journal and provider-neutral Git/LFS or MEGA objects; new remote logical-state schema version 1

**Testing**: Vitest/Angular unit tests; existing Playwright sync journey as an optional regression gate

**Target platforms**: Web/PWA, Chromium, Firefox, WebKit, desktop Tauri, Android Tauri through shared TypeScript records

**Performance goals**: Constant-time path generation; one bounded previous-root inventory and one batch cleanup request per full sync; one canonical logical-state read and normally one optimistic write; bounded conflict retries; no history-sized reads after migration; reuse stored object digests without rehashing local publications

**Constraints**: Offline-first, hostile filenames and sync data, immutable SHA-256 edition identity, backward-compatible legacy reads during migration, no whole-document last-writer-wins merge

**Scope**: New logical-book paths, compact logical state and legacy-change migration, root migration/reconciliation, provider inventory, gateway confinement, Git LFS and MEGA staging paths; no credential or authorization change

## Constitution Check

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged.

Post-design check: all gates still pass. There are no exceptions.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `SYNC_ROOT`, `bookObjectPath`, `LogicalBookSyncService`, `foldLogicalBookChanges`, `LibrarySyncCoordinator`, `LibrarySyncTransport`, provider gateway clients/adapters, `logicalSyncPath`, and the publication import/repository constructors.
- **Owning project(s)**: `sync-core` owns canonical provider-neutral paths and record validation; `library-data-access` and `omnia-reader` consume that public contract.
- **Affected consumers**: Every root-derived sync domain plus GitHub/Git LFS and MEGA provider transports.
- **Unchanged boundaries**: Reader engines, credentials, sessions, local binary storage, and backup archive schema.

### Repository Paths

```text
libs/sync/core/src/lib/book-sync-manifest.ts
libs/sync/core/src/lib/logical-book-change.ts
libs/sync/core/src/lib/logical-book-change.spec.ts
libs/sync/core/src/lib/book-sync-service.ts
libs/sync/core/src/lib/book-sync-service.spec.ts
libs/reader/domain/src/lib/publication.ts
libs/library/data-access/src/lib/browser-library-repository.ts
libs/library/data-access/src/lib/browser-library-repository.spec.ts
apps/omnia-reader/src/app/features/library/publication-import.service.ts
apps/omnia-reader/src/app/features/library/publication-import.service.spec.ts
apps/omnia-reader/src/app/features/library/publication-association.service.ts
apps/omnia-reader/src/app/features/library/publication-association.service.spec.ts
apps/omnia-reader-e2e/src/sync.spec.ts
docs/sync-gateway-api.md
```

## Design

### Contracts and State

- Export and reuse the existing provider-neutral canonical object-path function for every new publication descriptor. The application supplies the path to the repository's atomic add-variant mutation so the library data-access project does not acquire a sync-project dependency.
- New logical upserts require the canonical readable filename path. Legacy logical upserts remain accepted only at the exact digest/format path previously generated.
- Publication records retain their schema versions. Logical persistence gains a versioned canonical state document containing current logical books, active remote variant descriptors, preferences, reconciliations, causal heads, record clocks, and book/variant/preference tombstones.
- A deterministic state reducer applies legacy or pending `LogicalBookChange` values to individual records. Clock comparison uses the existing immutable change identity (`createdAt`, then `changeId`, with `deviceId` retained for audit) and stored owner provenance for deterministic membership-conflict construction. State serialization sorts all sets and arrays so equivalent state has identical content.
- Logical synchronization reads `state.json` and the durable journal. It uploads missing immutable publication objects first, applies pending mutations, and writes the state using the read revision. A revision conflict causes a reread, deterministic remerge, and retry up to a small fixed bound; journal operations are acknowledged only after the written state is reread and semantically verified.
- When only legacy `changes/` entries exist, synchronization validates and folds all of them, converts the result and variant effects into canonical state, writes and rereads `state.json`, proves semantic equivalence, then deletes the inventoried changes in one batch. If state already exists after an interrupted cleanup, legacy changes are reapplied idempotently by clock and then removed only after verification.
- New synchronization never writes `logical-books/changes/`. The unused checkpoint scaffold is removed because a bounded canonical state replaces its intended compaction role.
- Full sync preflight inventories `.omnia-reader/v1/`, maps supported paths to `.omnia-reader/`, normalizes embedded owned paths, and verifies copied documents and publication SHA-256/size. Postflight removes all exposed `v1` entries only after current workers succeed.
- Inventory records distinguish documents from binary objects without embedding document content; existing read/head/download APIs remain responsible for verification and transfer.
- Cleanup sends the verified inventory as one bounded provider-neutral deletion batch. GitHub validates every blob revision against one current tree and commits all removals atomically; MEGA processes the same batch within one gateway request.
- Rollback preserves current book manifests, the durable local journal, and legacy changes until state verification succeeds. Change-only clients are incompatible once `state.json` is authoritative and must be upgraded before synchronizing this destination.

### User Interface and Accessibility

- No component, interaction, focus, keyboard, touch, or announcement change.

### Security and Failure Handling

- Canonical generation retains the current deterministic filename confinement and collision suffix.
- Legacy acceptance derives the only allowed digest and format from the validated variant; arbitrary or traversal paths remain rejected.
- Canonical state parsing rejects unknown schema versions, duplicate identities, invalid clocks, non-canonical object paths, inconsistent active/tombstoned identities, malformed nested records, and documents exceeding the existing remote-document and logical-record bounds.
- Cleanup treats only `.omnia-reader/v1` as wholly obsolete. Current `.omnia-reader/*` records and content outside `.omnia-reader/` are not deletion candidates.
- Every entry in the owned `logical-books/` subtree except `state.json` is obsolete, but changes and checkpoints are batch-deleted only after verified state migration; publication deletion markers under `.omnia-reader/.deletions/` remain current because they prevent stale physical objects from being restored.
- Journal failure remains best effort and provider failure never rolls back a completed local import.

### Lifecycle and Performance

- No listeners, object URLs, renderer resources, or dependencies are added.
- Migration adds one bounded inventory and transfers only missing previous-root data. Stable destinations retain the existing Git revision fast path.
- Cleanup latency is bounded by one client/gateway round trip and, on GitHub, one tree commit regardless of the number of previous-root files.
- Stable logical synchronization reads one state document instead of listing and parsing every historical mutation. Concurrent writes add at most the configured bounded retry count; failed retries retain journal work.
- The device-local unchanged-revision checkpoint advances to schema 3 so schema-2 installations perform one complete migration pass before the fast path can be trusted again.

## Verification Plan

| Requirement/story        | Evidence                                                                                                                                  | Command or environment                                                                                                                 | Required locally?                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --- |
| FR-001–FR-006, US1–US2   | Canonical new path, legacy compatibility, unsafe rejection                                                                                | `npx nx test sync-core --skip-nx-cache`                                                                                                | Yes                                          |
| FR-007–FR-009, US3       | Stable full-sync cleanup and retry                                                                                                        | `npx nx test sync-core --skip-nx-cache`                                                                                                | Yes                                          |
| FR-001–FR-002, US1       | Import journal payload uses canonical path                                                                                                | `npx nx test omnia-reader --skip-nx-cache`                                                                                             | Yes                                          |
| FR-001–FR-005, US1–US2   | Repository-created change payloads use canonical path                                                                                     | `npx nx test library-data-access --skip-nx-cache`                                                                                      | Yes                                          |
| FR-014–FR-019, US4       | State validation/reducer, migration, tombstones, variant restoration, optimistic retry, checkpoint invalidation, and no new change writes | `npx nx test sync-core --skip-nx-cache`                                                                                                | Yes                                          |
| TypeScript boundaries    | Affected project lint                                                                                                                     | `npx nx lint sync-core --skip-nx-cache`, `npx nx lint library-data-access --skip-nx-cache`, `npx nx lint omnia-reader --skip-nx-cache` | Yes                                          |
| FR-001, FR-007, US1, US3 | Simulated-provider exact filename and full-sync cleanup request                                                                           | `npx nx run omnia-reader-e2e:e2e -- --project=chromium --grep "stable repeated Git sync                                                | deletes a synchronized publication locally"` | Yes |
| Repository hygiene       | Whitespace and conflict markers                                                                                                           | `git diff --check`                                                                                                                     | Yes                                          |

## Delivery and Documentation

- **Vertical slices**: First canonical new records; then strict legacy-read compatibility; then stable full-sync destination cleanup; finally canonical logical state with verified legacy-history retirement.
- **Migration/rollout**: No eager rename outside sync. Preflight copies and verifies previous-root state; current workers validate/reconcile it; postflight retires all `v1` entries. Logical migration folds legacy changes into `state.json` and removes them only after reread and semantic verification. Any conflict or failure aborts the pass and is retried without acknowledging local journal work.
- **Documentation**: Describe `.omnia-reader/` as the sole current root, the entry inventory, and the lossless previous-root migration.
- **Residual gates**: Credentialed GitHub/MEGA, Firefox/WebKit, packaged Tauri, Android emulator, and physical device are unverified unless explicitly run.

## Complexity and Exceptions

None.
