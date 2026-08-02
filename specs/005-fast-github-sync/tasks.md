---
description: 'Executable test-first task list for faster no-change GitHub synchronization'
---

# Tasks: Fast GitHub Synchronization

**Input**: Design documents from `specs/005-fast-github-sync/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/revision-fast-path.md`, and `quickstart.md`

**Tests**: Every behavior task adds a failing or newly relevant assertion before
implementation. Exact evidence is appended under Verification Evidence.

## Phase 1: Impact and Contracts

**Purpose**: Lock down ownership and the externally visible revision/fast-path
contract before implementation.

- [x] T001 Record CodeGraph callers, remote call cost, tests, and affected Nx projects in `specs/005-fast-github-sync/plan.md`
- [x] T002 Resolve and re-check every Constitution Check item in `specs/005-fast-github-sync/plan.md`
- [x] T003 Define the gateway, transport, and skip invariants in `specs/005-fast-github-sync/contracts/revision-fast-path.md`
- [x] T004 Define bounded checkpoint state, transitions, recovery, and rollback in `specs/005-fast-github-sync/data-model.md`

**Checkpoint**: Accepted behavior, ownership, contracts, race handling, and
compatibility are explicit.

---

## Phase 2: User Story 1 - Finish an up-to-date sync immediately (Priority: P1)

**Goal**: A stable repeat GitHub sync uses one revision request and no document,
publication, merge, or mutation work.

**Independent test**: Establish a trusted stable checkpoint, repeat sync without
local or remote changes, and assert zero counts plus no delegate invocation.

### Tests for User Story 1

- [x] T005 [P] [US1] Add failing GitHub adapter and route revision/empty-state/request-count assertions in `apps/sync-gateway/src/github-adapter.spec.ts` and `apps/sync-gateway/src/app.spec.ts`
- [x] T006 [P] [US1] Add failing revision response validation, cancellation, and exact one-request assertions in `libs/sync/git/src/lib/github-gateway-client.spec.ts`
- [x] T007 [P] [US1] Add failing stable-checkpoint, restart persistence, no-delegate, concurrency, storage-bound, and under-100-ms assertions in `libs/sync/core/src/lib/change-aware-sync-worker.spec.ts`

### Implementation for User Story 1

- [x] T008 [US1] Add the optional destination revision contract and `GET /revision` capability routing in `apps/sync-gateway/src/gateway-contract.ts` and `apps/sync-gateway/src/provider-routes.ts`
- [x] T009 [US1] Implement bounded GitHub tree revision lookup and safe empty-state/error parsing in `apps/sync-gateway/src/github-adapter.ts`
- [x] T010 [US1] Add the cancellation-aware optional transport capability in `libs/sync/core/src/lib/library-sync-transport.ts`, `libs/sync/core/src/lib/sync-provider-selection.ts`, and `libs/sync/git/src/lib/github-gateway-client.ts`
- [x] T011 [US1] Implement the bounded browser checkpoint store and serialized no-change worker in `libs/sync/core/src/lib/change-aware-sync-worker.ts` and export it from `libs/sync/core/src/index.ts`

### Verification for User Story 1

- [x] T012 [US1] Run `npx nx test sync-gateway --skip-nx-cache`, `npx nx test sync-git --skip-nx-cache`, and `npx nx test sync-core --skip-nx-cache`
- [x] T013 [US1] Run `npx nx run-many -t lint -p sync-gateway sync-git sync-core --skip-nx-cache`

**Checkpoint**: The optimized worker and provider contract independently prove a
one-request no-change success.

---

## Phase 3: User Story 2 - Never skip real synchronization work (Priority: P2)

**Goal**: Pending local work, remote changes, uncertainty, and failures retain
the complete safe synchronization behavior.

**Independent test**: From a prior checkpoint, introduce each veto condition and
assert the delegate runs and the checkpoint is not advanced until a later stable
pass.

### Tests for User Story 2

- [x] T014 [P] [US2] Add failing pending-local, changed-remote, missing/invalid checkpoint, unstable or mutating pass, conflicts/rejections, probe failure, cancellation, and unsupported-provider assertions in `libs/sync/core/src/lib/change-aware-sync-worker.spec.ts`
- [x] T015 [P] [US2] Add failing manual/automatic shared-worker composition assertions in `apps/omnia-reader/src/app/app.config.spec.ts`
- [x] T016 [P] [US2] Add a repeat-sync fake-gateway request-count journey in `apps/omnia-reader-e2e/src/sync.spec.ts`

### Implementation for User Story 2

- [x] T017 [US2] Complete safe fallback, pre/post stability, journal recheck, checkpoint clearing, cancellation, and delegate-result semantics in `libs/sync/core/src/lib/change-aware-sync-worker.ts`
- [x] T018 [US2] Compose the change-aware worker around the existing coordinator for the shared manual/automatic service in `apps/omnia-reader/src/app/app.config.ts`
- [x] T019 [US2] Document the revision endpoint, fast-path invariants, deployment compatibility, and live-provider gate in `docs/sync-gateway-api.md`

### Verification for User Story 2

- [x] T020 [US2] Run `npx nx test sync-core --skip-nx-cache` and focused affected `omnia-reader` tests
- [x] T021 [US2] Run `npx nx lint omnia-reader --skip-nx-cache`
- [x] T022 [US2] Run `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx nx run omnia-reader-e2e:e2e -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts`, or record the unavailable browser boundary below

**Checkpoint**: Both stories are independently testable and every uncertain case
falls back to the existing complete merge.

---

## Final Phase: Cross-Cutting Acceptance

**Purpose**: Reconcile artifacts and run every gate needed for the completion
claim.

- [x] T023 Reconcile `specs/005-fast-github-sync/spec.md`, `plan.md`, contracts, and completed task state
- [x] T024 Format only intended files and run `git diff --check`
- [x] T025 Run `npx nx run-many -t test -p sync-gateway sync-git sync-core omnia-reader --skip-nx-cache`
- [x] T026 Run `npx nx run-many -t lint -p sync-gateway sync-git sync-core omnia-reader --skip-nx-cache`
- [x] T027 Run `npx nx build sync-gateway --configuration production --skip-nx-cache` and `npx nx build omnia-reader --configuration production --skip-nx-cache`
- [x] T028 Run `$verify-omnia-reader` and record exact evidence under Verification Evidence
- [x] T029 Run `$review-omnia-reader`, resolve actionable findings, and record residual risk under Verification Evidence
- [x] T030 Record credentialed live GitHub repeat-sync evidence, or explicitly leave that external gate unverified under Verification Evidence

## Corrective Optimization: Eliminate Repeated No-Op Fetches

- [x] T031 Add regressions proving identical books, progress, bookmarks, and annotations report no remote push and mutable record workers reuse their list snapshot
- [x] T032 Correct actual-mutation accounting, reuse optimistic remote snapshots, and run progress/bookmark/annotation workers with concurrency bounded to three
- [x] T033 Stabilize mutating or changed passes once inside the same sync so the next user-triggered sync needs only `GET /revision`
- [x] T034 Update the Chromium journey to prove the second sync, rather than the third, performs exactly one request
- [x] T035 Reconcile the feature contract, data model, plan, gateway documentation, and quickstart with the corrected request behavior
- [x] T036 Re-run sync-core, affected lint/build, the complete Chromium sync journey, final diff checks, and repository review

## Live Checkpoint-Veto Recovery

- [x] T037 Inspect the live Chrome checkpoint, history, durable journal, and GitHub request timing without exposing credentials or synchronized document contents
- [x] T038 Add regressions for legacy EPUB `position: -1` progress operations and valid progress belonging to an unavailable local publication
- [x] T039 Normalize the legacy sentinel losslessly, acknowledge it only after convergence, and stop classifying unavailable-book progress as malformed
- [x] T040 Prove the captured 29-operation live state converges to an empty journal and trusted checkpoint without remote mutation, then prove the repeated sync is sub-second

## Dependencies and Execution Order

- T001–T004 establish the contract and block implementation.
- T005–T007 precede T008–T011; gateway, client, and core test files are independent.
- T014–T016 precede T017–T019. T018 depends on the core wrapper and transport
  capability; T019 depends on finalized behavior.
- Each story reaches its verification checkpoint before final acceptance.
- T023–T030 depend on both story checkpoints. T031–T036 are the corrective
  trace-driven optimization after browser evidence exposed false pushes.
  T037–T040 are the live-state recovery after persistent legacy journal entries
  were shown to veto every checkpoint.

## Parallel Opportunities

- T005, T006, and T007 touch separate projects and can run in parallel.
- T014, T015, and T016 touch separate test boundaries and can run in parallel.
- Focused tests for separate Nx projects can run in parallel when local resources
  allow, but builds and browser evidence remain explicit gates.

## Implementation Strategy

1. Deliver the revision endpoint/client and a checkpoint-worker unit slice.
2. Prove every fallback and race invariant before Angular composition.
3. Integrate the single shared worker so manual and automatic flows cannot drift.
4. Expand from focused suites to browser, lint, and production builds.

## Verification Evidence

_Append exact commands, observed counts, timings, failures, and unavailable gates
here during implementation._

- `npx nx test sync-gateway --skip-nx-cache`: passed, 8 files; 116 tests
  passed and 1 optional Redis test skipped.
- `npx nx test sync-git --skip-nx-cache`: passed, 4 files and 37 tests.
- `npx nx test sync-core --skip-nx-cache`: passed, 20 files and 143 tests.
- `npx nx test omnia-reader --skip-nx-cache --include=apps/omnia-reader/src/app/features/settings/sync-settings-page.component.spec.ts --include=apps/omnia-reader/src/app/app.config.spec.ts`:
  passed, 2 files and 31 tests.
- `npx nx test omnia-reader --skip-nx-cache`: the broad application suite ran;
  142 tests passed and 18 pre-existing `library-page.component.spec.ts` tests
  failed against unchanged library-page source. The failures concern compact
  badge labels/actions and are outside this diff; focused changed-area tests,
  production build, and the real-browser sync journey pass.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx nx run omnia-reader-e2e:e2e -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts`:
  passed, 13 tests; 2 explicitly opt-in two-device convergence tests skipped.
  The immediately following second sync observed exactly `GET /revision` and no
  document, object, LFS, or mutation request.
- `npx nx run-many -t lint -p sync-gateway sync-git sync-core omnia-reader omnia-reader-e2e --skip-nx-cache`:
  passed with 0 errors. Existing warnings remain in unrelated logical-book,
  library-page, and example E2E tests.
- `npx nx build sync-gateway --configuration production --skip-nx-cache`:
  passed.
- `npx nx build omnia-reader --configuration production --skip-nx-cache`:
  passed; initial bundle 367.52 kB raw and 82.22 kB estimated transfer.
- `git diff --check`: passed.
- `$review-omnia-reader`: no actionable finding remains after correcting false
  push counts, moving convergence into the mutating sync, reusing mutable-record
  snapshots, bounding provider reads, normalizing only the legacy unknown EPUB
  position sentinel, and preserving conflict re-reads, tombstones, journal
  authority, and checkpoint stability checks.
- Credentialed live GitHub validation against the selected repository used a
  copied browser state and blocked every non-GET gateway request. The captured
  pre-fix state contained 29 legacy progress operations and reported 31 rejected
  items. With the recovery change, one 9.99-second fallback reduced the journal
  from 29 operations to 0, reported 0 rejected items, stored revision
  `1313223246:main:2a6416927047c4e278bbeb60811d5b2434838daa`, and attempted no
  mutation. The following unchanged sync completed in 0.44 seconds with
  0 pulled, 0 pushed, 0 conflicts, and 0 rejected; its synchronization worker
  issued only `GET /revision`. Settings initialization requests observed around
  the click were separate from that worker request.
- Firefox, WebKit, packaged Tauri, Android emulator, and physical-device gates
  were not run; this change has no renderer or native-specific implementation.

## Completion Rules

- Mark a task `[x]` only after its stated artifact or command is complete.
- A passing unit suite does not replace browser or credentialed provider evidence.
- Preserve the unrelated `.codex/config.toml` worktree change.
- Do not modify MEGA, reader-engine, library schema, or synchronized record scope.
