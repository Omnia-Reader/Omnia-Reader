---
description: 'Executable, test-first task list for deleted-book re-import recovery'
---

# Tasks: Re-import Deleted Books

**Input**: Design documents from `specs/003-reimport-deleted-book/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/library-lifecycle.md`, and `quickstart.md`

**Tests**: Every behavior change receives a failing focused regression before implementation.

## Phase 1: Impact and Contracts

**Purpose**: Confirm ownership and preserve local deletion, exact-edition identity, and existing sync contracts.

- [x] T001 Record CodeGraph callers, tests, and affected Nx projects in `specs/003-reimport-deleted-book/plan.md`
- [x] T002 Resolve the Constitution Check in `specs/003-reimport-deleted-book/plan.md`
- [x] T003 [P] Define import and deletion lifecycle behavior in `specs/003-reimport-deleted-book/contracts/library-lifecycle.md`
- [x] T004 [P] Define ownerless publication recovery and exclusion state transitions in `specs/003-reimport-deleted-book/data-model.md`

**Checkpoint**: The invisible-orphan state, deletion intent, and recovery contract are explicit.

---

## Phase 2: User Story 1 - Re-import a removed publication (Priority: P1)

**Goal**: Re-import an ownerless retained exact edition as one visible added book while preserving true duplicate behavior.

**Independent test**: Retain a publication record without logical membership, import the same bytes, and verify one repaired visible membership and an added result.

### Tests for User Story 1

- [x] T005 [P] [US1] Add repository regression coverage for ownerless exact-edition repair without binary duplication in `libs/library/data-access/src/lib/browser-library-repository.spec.ts`
- [x] T006 [P] [US1] Add import-service coverage for ownerless additions, visible duplicates, bootstrap journaling, and failed validation cleanup in `apps/omnia-reader/src/app/features/library/publication-import.service.spec.ts`

### Implementation for User Story 1

- [x] T007 [US1] Repair missing singleton logical membership for a retained exact edition in `libs/library/data-access/src/lib/browser-library-repository.ts`
- [x] T008 [US1] Classify duplicates from the pre-import logical membership snapshot and clean up failed ownerless repairs in `apps/omnia-reader/src/app/features/library/publication-import.service.ts`

### Verification for User Story 1

- [x] T009 [US1] Run `npx nx test library-data-access --skip-nx-cache`
- [x] T010 [US1] Run the focused `omnia-reader` import and association service tests with the target's `--include` option

**Checkpoint**: A retained invisible edition is recoverable and a visible exact edition remains a duplicate.

---

## Phase 3: User Story 2 - Keep deleted publications deleted during synchronization (Priority: P2)

**Goal**: Mirror logical variant creation and deletion into legacy book-sync eligibility without weakening local-first mutation.

**Independent test**: Verify exclusion-before-delete ordering, rollback on local failure, retained exclusion on journal failure, and re-inclusion after successful creation.

### Tests for User Story 2

- [x] T011 [US2] Add exclusion ordering, rollback, journal outage, whole-book deletion, and re-inclusion tests in `apps/omnia-reader/src/app/features/library/publication-association.service.spec.ts`

### Implementation for User Story 2

- [x] T012 [US2] Integrate `BOOK_SYNC_EXCLUSIONS` with successful created/deleted logical variants and pre-delete rollback in `apps/omnia-reader/src/app/features/library/publication-association.service.ts`

### Verification for User Story 2

- [x] T013 [US2] Run the focused `omnia-reader` import and association service tests with the target's `--include` option

**Checkpoint**: Older book sync cannot recreate a deleted exact edition, and intentional restoration becomes sync-eligible.

---

## Final Phase: Cross-Cutting Acceptance

**Purpose**: Reconcile artifacts and run every local gate needed for completion.

- [x] T014 Run `$speckit-analyze` and resolve critical or high consistency findings across `specs/003-reimport-deleted-book/spec.md`, `plan.md`, and `tasks.md`
- [x] T015 Format intentional files with `npx prettier --write <paths>` and run `git diff --check`
- [x] T016 Run `npx nx lint library-data-access --skip-nx-cache` and `npx nx lint omnia-reader --skip-nx-cache`
- [x] T017 Run `npx nx build omnia-reader --configuration production --skip-nx-cache`
- [x] T018 Reconcile `specs/003-reimport-deleted-book/spec.md`, `plan.md`, contracts, and completed task state
- [x] T019 Run `$verify-omnia-reader` and record exact evidence in `specs/003-reimport-deleted-book/tasks.md`
- [x] T020 Run `$review-omnia-reader`, resolve actionable findings, and record unavailable gates in `specs/003-reimport-deleted-book/tasks.md`

## Completion Evidence

- `npx nx test library-data-access --skip-nx-cache`: passed, 6 files and 56 tests.
- `npx nx test omnia-reader --skip-nx-cache --include=apps/omnia-reader/src/app/features/library/publication-import.service.spec.ts --include=apps/omnia-reader/src/app/features/library/publication-association.service.spec.ts`: passed, 2 files and 23 tests.
- `npx nx lint library-data-access --skip-nx-cache`: passed with 68 existing warnings.
- `npx nx lint omnia-reader --skip-nx-cache`: passed with 1 existing warning.
- `npx nx build omnia-reader --configuration production --skip-nx-cache`: passed; the production bundle gate completed successfully.
- `npx nx test omnia-reader --skip-nx-cache`: 19 of 20 files and 132 of 150 tests passed. The remaining 18 failures are the unchanged pre-existing `library-page.component.spec.ts` baseline covering compact badges, progress presentation, export, add-format, availability, and open-state expectations; none are in the changed services.
- `npx prettier --write <intentional paths>` completed, and the final `git diff --check` passed.
- `$review-omnia-reader`: no actionable finding remained after reviewing membership repair, exclusion-before-delete ordering, local-failure rollback, journal-outage behavior, and existing-exclusion preservation.
- Browser/Playwright, provider, credentialed, native, emulator, and physical-device gates are not applicable to this deterministic repository/service regression. No schema, gateway, transport, renderer, or native contract changed.

## Dependencies and Execution Order

- T001-T004 block implementation.
- T005 precedes T007; T006 precedes T008.
- US2 depends on the visible-membership contract established by US1 but remains independently testable.
- T011 precedes T012.
- Final acceptance depends on both story checkpoints.

## Parallel Opportunities

- T003 and T004 use separate design artifacts.
- T005 and T006 use separate test files and may be authored independently before implementation.
- Verification commands for distinct Nx projects may run concurrently after implementation and formatting.

## Implementation Strategy

- **MVP**: Complete US1 so affected readers can recover already-orphaned editions immediately.
- **Prevention**: Complete US2 in the same delivery so later synchronization cannot recreate the mismatch.
- Preserve the unrelated existing edits in `libs/sync/core/src/lib/logical-book-sync-service.ts` and its spec.

## Completion Rules

- Mark a task `[x]` only after its artifact or command is complete.
- A passing unit suite does not replace deletion race and failure-path assertions.
- Browser, provider, native, emulator, and device gates remain not applicable to this deterministic local regression.
- Do not modify or revert unrelated worktree changes.
