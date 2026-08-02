---
description: 'Executable, test-first task list for efficient reading synchronization'
---

# Tasks: Efficient Reading Synchronization

**Input**: Design documents from `specs/006-efficient-reading-sync/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/request-budget.md`, and `quickstart.md`

## Phase 1: Impact and Contracts

- [x] T001 Record CodeGraph callers, exact reported request ownership, affected Nx projects, and constitution decisions in `specs/006-efficient-reading-sync/plan.md`
- [x] T002 Define request-count, unchanged-open, retry, integrity, and compatibility contracts in `specs/006-efficient-reading-sync/spec.md`, `specs/006-efficient-reading-sync/data-model.md`, and `specs/006-efficient-reading-sync/contracts/request-budget.md`

**Checkpoint**: Accepted behavior, ownership, request bounds, and rollback are explicit.

---

## Phase 2: User Story 1 - Open without publication resync (Priority: P1)

**Goal**: Preserve local recent-opened state without an immediate publication synchronization when manifest metadata did not change.

**Independent test**: Reader-page tests prove unchanged open appends zero `book` operations and changed extracted metadata appends exactly one.

### Tests for User Story 1

- [x] T003 [US1] Add failing unchanged-versus-changed open journal assertions in `apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts`

### Implementation for User Story 1

- [x] T004 [US1] Compare manifest-represented metadata and suppress false open-time book operations in `apps/omnia-reader/src/app/features/reader/reader-page.component.ts`

### Verification for User Story 1

- [x] T005 [US1] Run `npx nx test omnia-reader --skip-nx-cache --include=apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts`

**Checkpoint**: Unchanged publication opening is locally durable and creates no publication sync work.

---

## Phase 3: User Story 2 - Bound fallback publication requests (Priority: P2)

**Goal**: Make a complete publication fallback constant-request for an already-current library and suppress repeated legacy-prefix scans.

**Independent test**: Sync-core request counters prove one active listing, zero per-book verification, and zero legacy listings across stable passes while mutation-triggered cleanup and existing mutation/deletion/conflict cases remain green.

### Tests for User Story 2

- [x] T006 [US2] Add failing snapshot reuse, current-publication skip, missing-publication seed, and repeated legacy cleanup request assertions in `libs/sync/core/src/lib/book-sync-service.spec.ts`
- [x] T007 [US2] Add failing optional-snapshot catalog assertions in `libs/sync/core/src/lib/book-sync-catalog.spec.ts`

### Implementation for User Story 2

- [x] T008 [US2] Reuse validated exact-path remote publication snapshots, restrict synthetic work to missing publications, and make legacy cleanup mutation-triggered and retryable in `libs/sync/core/src/lib/book-sync-service.ts`
- [x] T009 [US2] Accept and reuse a caller-provided active publication snapshot in `libs/sync/core/src/lib/book-sync-catalog.ts`

### Verification for User Story 2

- [x] T010 [US2] Run `npx nx test sync-core --skip-nx-cache --include=libs/sync/core/src/lib/book-sync-service.spec.ts --include=libs/sync/core/src/lib/book-sync-catalog.spec.ts`

**Checkpoint**: Progress-only fallback cost is independent of current local library size while uncertain publication states retain full validation.

---

## Final Phase: Cross-Cutting Acceptance

- [x] T011 Add or update the fake-gateway request-count journey in `apps/omnia-reader-e2e/src/sync.spec.ts`, then run `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx nx run omnia-reader-e2e:e2e --skip-nx-cache -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts` or record the unavailable boundary
- [x] T012 Run `npx nx run-many -t lint -p sync-core omnia-reader omnia-reader-e2e --skip-nx-cache`, `npx nx build omnia-reader --configuration production --skip-nx-cache`, and `git diff --check`
- [x] T013 Run `$verify-omnia-reader`, reconcile exact evidence in `specs/006-efficient-reading-sync/tasks.md`, and preserve unrelated working-tree changes
- [x] T014 Run `$review-omnia-reader` for synchronization correctness, request bounds, offline behavior, compatibility, and missing-test risk; resolve actionable findings
- [x] T015 Reconcile `specs/006-efficient-reading-sync/spec.md`, `plan.md`, `quickstart.md`, contracts, and completed task state with the delivered behavior

## Verification Evidence

- Reader focus: 1 file, 2 tests passed.
- Sync core: 21 files, 147 tests passed.
- Chromium fake-gateway journey: 13 passed and 2 opt-in two-device cases skipped on the completed run. A later rerun was blocked before Playwright by an Nx recursive task invocation involving `sync-gateway:serve:development`.
- Affected lint: passed with pre-existing warnings and no errors.
- Production build: passed with bundle budgets enforced.
- Full application tests: 146 passed and 18 pre-existing failures in unchanged `library-page.component.spec.ts` compact format badge assertions.
- `git diff --check`: passed.
- Review findings resolved: exact canonical manifest-path indexing, explicit stable-pass LFS integrity boundary, and mutation-triggered cleanup that remains safe across destination changes.
- Not run: live credentialed GitHub timing, Firefox/WebKit, packaged Tauri desktop, Android emulator, and physical-device gates.

## Dependencies and Execution Order

- T001–T002 are complete and block implementation.
- T003 precedes T004; T006–T007 precede T008–T009.
- US1 is independently valuable and may complete before US2.
- T011–T015 depend on both story checkpoints.
- Tasks sharing a file run sequentially.

## Parallel Opportunities

- Reader-page tests and sync-core tests touch separate owners, but this execution keeps test-first evidence sequential and reviewable.
- Final lint targets may run in parallel after source changes stabilize.

## Completion Rules

- Mark a task `[x]` only after its artifact or command is complete.
- Record unavailable browser and live-provider gates explicitly.
- Do not broaden scope to the unrelated sync-settings visibility changes already in the working tree.
- Preserve full validation for pending, missing, malformed, excluded, deleted, or conflicted publications.
