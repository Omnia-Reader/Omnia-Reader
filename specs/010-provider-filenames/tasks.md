# Tasks: Provider Book Filenames

**Input**: Design documents from `specs/010-provider-filenames/`

**Tests**: Focused tests precede each behavior change.

## Phase 1: Impact and Contracts

- [x] T001 Record CodeGraph callers, tests, owning Nx projects, and unchanged boundaries in `specs/010-provider-filenames/plan.md`
- [x] T002 Resolve the Constitution Check and compatibility strategy in `specs/010-provider-filenames/plan.md`
- [x] T003 Define the current-write and legacy-read contract in `specs/010-provider-filenames/contracts/provider-object-path.md`
- [x] T004 Define compatible durable states in `specs/010-provider-filenames/data-model.md`

## Phase 2: User Story 1 - Recognizable provider backup (Priority: P1)

**Goal**: Every newly produced publication reference uses the canonical readable filename path.

**Independent test**: New manifest, import, and add-variant payloads end with the publication filename and contain no newly generated legacy `books/<digest>/publication.*` reference.

### Tests for User Story 1

- [x] T005 [P] [US1] Add canonical logical-change path coverage in `libs/sync/core/src/lib/logical-book-change.spec.ts`
- [x] T006 [P] [US1] Assert import journal payload paths in `apps/omnia-reader/src/app/features/library/publication-import.service.spec.ts`
- [x] T007 [P] [US1] Assert add-variant mutation paths in `libs/library/data-access/src/lib/browser-library-repository.spec.ts`

### Implementation for User Story 1

- [x] T008 [US1] Use the canonical `bookObjectPath` contract for logical changes in `libs/sync/core/src/lib/logical-book-change.ts`
- [x] T009 [US1] Use the canonical `bookObjectPath` contract in `apps/omnia-reader/src/app/features/library/publication-import.service.ts`
- [x] T010 [US1] Use the canonical `bookObjectPath` contract in `libs/library/data-access/src/lib/browser-library-repository.ts`

### Verification for User Story 1

- [x] T011 [US1] Run `npx nx test sync-core --skip-nx-cache`, `npx nx test library-data-access --skip-nx-cache`, and `npx nx test omnia-reader --skip-nx-cache`

## Phase 3: User Story 2 - Existing backup compatibility (Priority: P2)

**Goal**: Existing exact legacy records remain readable while hostile or mismatched paths remain rejected.

**Independent test**: One strict legacy fixture parses, while wrong digest, format, and traversal fixtures fail.

### Tests for User Story 2

- [x] T012 [US2] Add strict legacy-path acceptance and mismatch rejection coverage in `libs/sync/core/src/lib/logical-book-change.spec.ts`

### Implementation for User Story 2

- [x] T013 [US2] Retain exact derived legacy-path validation without allowing new legacy producers in `libs/sync/core/src/lib/logical-book-change.ts`
- [x] T014 [US2] Clarify compatibility-only `.omnia-reader/v1/books` use in `docs/sync-gateway-api.md`

### Verification for User Story 2

- [x] T015 [US2] Run `npx nx test sync-core --skip-nx-cache`

## Phase 4: User Story 3 - Current-format destination (Priority: P2)

**Goal**: Every full book sync removes known obsolete layout files, including unchanged passes, and retries cleanup failures.

**Independent test**: Seed current and legacy fixtures, run an unchanged full sync, and observe only the legacy manifest and publication objects removed; inject one failure and observe the next pass retry.

### Tests for User Story 3

- [x] T016 [US3] Add unchanged-pass cleanup, current-record preservation, retry, and simulated-provider filename coverage in `libs/sync/core/src/lib/book-sync-service.spec.ts` and `apps/omnia-reader-e2e/src/sync.spec.ts`

### Implementation for User Story 3

- [x] T017 [US3] Run confined legacy-layout reconciliation after every full book sync in `libs/sync/core/src/lib/book-sync-service.ts`
- [x] T018 [US3] Document full-sync convergence and reserved-prefix ownership in `docs/sync-gateway-api.md`

### Verification for User Story 3

- [x] T019 [US3] Run `npx nx test sync-core --skip-nx-cache` and `npx nx run omnia-reader-e2e:e2e -- --project=chromium --grep "stable repeated Git sync|deletes a synchronized publication locally"`

## Final Phase: Cross-Cutting Acceptance

- [x] T020 Add provider-neutral remote-entry inventory contracts and GitHub/MEGA gateway implementations
- [x] T021 Add TDD coverage for previous-root migration, verification, conflict safety, cleanup retry, and outside-root preservation
- [x] T022 Implement full-sync preflight/postflight reconciliation and wire it around current domain workers
- [x] T023 Move all current root, gateway security, MEGA staging, Git LFS, documentation, and E2E paths to `.omnia-reader/`
- [x] T024 Verify GitHub and MEGA inventory parity and gateway path confinement

- [x] T025 Reconcile feature artifacts and completed task state
- [x] T026 Run affected tests, lints, builds, focused Chromium E2E, and native bridge checks where changed
- [x] T027 Run `git diff --check`
- [x] T028 Apply `$verify-omnia-reader` and record exact evidence in `quickstart.md`
- [x] T029 Apply `$review-omnia-reader` to the final working-tree diff and resolve actionable findings

## Regression Phase: Bounded Previous-Root Cleanup

- [x] T030 Add batch-cleanup contract and request-count tests across sync core, provider clients, gateway routes, and GitHub adapter
- [x] T031 Replace per-entry cleanup calls with one bounded provider-neutral batch request
- [x] T032 Remove all inventoried GitHub legacy entries in one revision-guarded atomic tree commit and preserve retry behavior on conflicts
- [x] T033 Re-run `$verify-omnia-reader`, production builds, focused sync E2E, and `$review-omnia-reader`

## Phase 5: User Story 4 - Compact logical-library persistence (Priority: P2)

**Goal**: Replace permanent logical mutation history with one safe canonical state document while preserving offline multi-device convergence.

**Independent test**: Seed legacy changes and concurrent/stale mutations, synchronize, and observe one verified `logical-books/state.json`, no remaining change entries, deterministic merged state, and preserved retry inputs after injected failures.

### Tests for User Story 4

- [x] T034 [P] [US4] Add canonical state schema, deterministic serialization, malformed/oversized input, duplicate identity, and invariant coverage in `libs/sync/core/src/lib/logical-book-state.spec.ts`
- [x] T035 [P] [US4] Add record-clock, book/variant tombstone, preference-clear, idempotent replay, and deterministic membership-conflict reducer coverage in `libs/sync/core/src/lib/logical-book-state.spec.ts`
- [x] T036 [US4] Add legacy fold migration, verified change/checkpoint cleanup, interrupted cleanup retry, remote-only variant restoration, no new historical writes, and preservation-on-failure coverage in `libs/sync/core/src/lib/logical-book-sync-service.spec.ts`
- [x] T037 [US4] Add optimistic state revision conflict convergence and bounded retry exhaustion coverage in `libs/sync/core/src/lib/logical-book-sync-service.spec.ts`

### Implementation for User Story 4

- [x] T038 [US4] Implement the bounded canonical document parser, serializer, clocks, tombstones, state reducer, and legacy conversion in `libs/sync/core/src/lib/logical-book-state.ts`
- [x] T039 [US4] Export the canonical logical-state contract and remove the unused checkpoint export/module in `libs/sync/core/src/index.ts`, `libs/sync/core/src/lib/logical-book-checkpoint.ts`, and `libs/sync/core/src/lib/logical-book-checkpoint.spec.ts`
- [x] T040 [US4] Replace logical change listing/writes with state read-merge-write-reread verification and bounded optimistic retry in `libs/sync/core/src/lib/logical-book-sync-service.ts`
- [x] T041 [US4] Migrate exact legacy change inventories only after semantic state verification and batch-delete them idempotently in `libs/sync/core/src/lib/logical-book-sync-service.ts`
- [x] T042 [US4] Restore active remote-only variants from canonical state descriptors and acknowledge journal entries only after verified state coverage in `libs/sync/core/src/lib/logical-book-sync-service.ts`
- [x] T043 [US4] Document the single-file logical format, migration boundary, and retained `.deletions` purpose in `docs/sync-gateway-api.md`

### Verification for User Story 4

- [x] T044 [US4] Run focused `sync-core` tests and lint plus `git diff --check`, then record exact evidence in `specs/010-provider-filenames/quickstart.md`
- [x] T045 [US4] Apply `$verify-omnia-reader` and `$review-omnia-reader`, resolve actionable findings, and mark the compact-state tasks complete
- [x] T046 [US4] Invalidate schema-2 change-aware checkpoints and add upgrade coverage in `libs/sync/core/src/lib/change-aware-sync-worker.ts` and `libs/sync/core/src/lib/change-aware-sync-worker.spec.ts`
- [x] T047 [US4] Seed the prior checkpoint schema in the Chromium sync journey and prove one migration followed by the one-request fast path in `apps/omnia-reader-e2e/src/sync.spec.ts`

## Dependencies and Execution Order

- T001–T004 block behavior changes.
- T005–T007 must fail for the old hard-coded path before T008–T010.
- T012 precedes T013 and protects compatibility.
- T016 precedes T017 and proves cleanup convergence and retry.
- Final acceptance depends on all three story checkpoints.
- T034–T037 precede T038–T042 and protect the compact-state contract before implementation.
- T038–T039 establish the state model before T040–T042 integrate synchronization; T043 can proceed after the final contract stabilizes.
- T044–T045 depend on all User Story 4 implementation tasks.

## Parallel Opportunities

- T005, T006, and T007 touch separate test projects and can be authored independently.
- Once implementation is stable, the three lint commands can run independently.
- T034 and the independent portions of T035 can be authored before service integration; implementation remains sequential where files overlap.

## Completion Rules

- Mark a task `[x]` only after its artifact or command is complete.
- Credentialed live-provider, cross-browser, packaged-native, emulator, and physical-device gates remain explicitly unverified unless run.
- Preserve unrelated worktree changes and do not broaden scope.
