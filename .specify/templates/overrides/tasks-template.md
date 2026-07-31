---
description: 'Executable, test-first task list for an Omnia Reader feature'
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `specs/[###-feature-name]/`

**Prerequisites**: `spec.md` and `plan.md`; use `research.md`, `data-model.md`,
`contracts/`, and `quickstart.md` when present

**Tests**: Behavioral changes require focused test tasks before their
implementation tasks. Documentation-only or mechanical changes may omit them
only when the plan records why no observable behavior changes.

**Organization**: Group work by independently testable user story. Keep tasks
small enough to implement, verify, and resume without reconstructing context.

## Format: `[ID] [P?] [Story?] Description`

- Start every task with `- [ ] TNNN`.
- Add `[P]` only when it touches different files and has no incomplete
  dependency.
- Add `[US1]`, `[US2]`, and so on to every story task.
- Include exact repository paths and, for verification, exact commands.

## Phase 1: Impact and Contracts

**Purpose**: Confirm ownership and lock down externally visible behavior before
implementation.

- [ ] T001 Record CodeGraph callers/tests and affected Nx projects in
      `specs/[###-feature-name]/plan.md`
- [ ] T002 Resolve remaining Constitution Check items in
      `specs/[###-feature-name]/plan.md`
- [ ] T003 [P] Define or update required contracts in [exact contract path]
- [ ] T004 [P] Define migration, recovery, or rollback behavior in
      `specs/[###-feature-name]/data-model.md` when durable state changes

**Checkpoint**: Accepted behavior, ownership, contracts, and compatibility are
explicit.

---

## Phase 2: User Story 1 - [Title] (Priority: P1)

**Goal**: [Smallest valuable outcome]

**Independent test**: [How this story is demonstrated without later stories]

### Tests for User Story 1

> Write or update these tests first and observe the new assertion fail for the
> expected reason before implementing the behavior.

- [ ] T005 [P] [US1] Add focused unit/contract coverage in [exact `*.spec.ts`
      path]
- [ ] T006 [P] [US1] Add a focused Playwright journey in
      `apps/omnia-reader-e2e/src/[journey].spec.ts` when browser behavior applies

### Implementation for User Story 1

- [ ] T007 [US1] Implement the owning domain/engine/data/platform behavior in
      [exact library path]
- [ ] T008 [US1] Integrate user-visible orchestration in [exact app path]
- [ ] T009 [US1] Implement failure, offline, accessibility, and teardown paths in
      [exact paths]

### Verification for User Story 1

- [ ] T010 [US1] Run focused tests with `[exact Nx/Vitest command]`
- [ ] T011 [US1] Run affected lint with `[exact Nx lint command]`
- [ ] T012 [US1] Run the focused browser/platform gate with `[exact command]`, or
      record the unavailable boundary in `specs/[###-feature-name]/tasks.md`

**Checkpoint**: User Story 1 is independently usable and verified.

---

## Phase 3: User Story 2 - [Title] (Priority: P2)

**Goal**: [Next independently valuable outcome]

**Independent test**: [How this story is demonstrated on its own]

### Tests for User Story 2

- [ ] T013 [P] [US2] Add focused unit/contract coverage in [exact `*.spec.ts`
      path]
- [ ] T014 [P] [US2] Add focused browser coverage in [exact Playwright path]
      when applicable

### Implementation for User Story 2

- [ ] T015 [US2] Implement the owning behavior in [exact path]
- [ ] T016 [US2] Integrate the story and its failure/accessibility paths in
      [exact paths]

### Verification for User Story 2

- [ ] T017 [US2] Run focused tests and lint with `[exact commands]`
- [ ] T018 [US2] Run applicable browser/platform evidence with `[exact command]`

**Checkpoint**: User Stories 1 and 2 remain independently testable.

<!-- Add one phase per remaining user story and renumber tasks sequentially. -->

---

## Final Phase: Cross-Cutting Acceptance

**Purpose**: Reconcile artifacts and run every gate needed for the completion
claim.

- [ ] TXXX Reconcile `spec.md`, `plan.md`, contracts, and completed task state
- [ ] TXXX Run `git diff --check`
- [ ] TXXX Run production builds or broader Nx affected gates required by the
      plan with [exact commands]
- [ ] TXXX Run `$verify-omnia-reader` and record exact pass/fail evidence
- [ ] TXXX Run `$review-omnia-reader` for non-trivial reader, persistence, sync,
      security, cross-project, or native changes and resolve actionable findings
- [ ] TXXX Update [exact documentation paths] only where behavior, contracts,
      architecture, release gates, or verified product status materially changed

## Dependencies and Execution Order

- Impact and contract tasks block story implementation.
- Within each story, tests precede the corresponding implementation.
- Tasks sharing a file run sequentially even if their stories are otherwise
  independent.
- Each story reaches its verification checkpoint before depending stories
  begin.
- Final acceptance depends on every delivered story checkpoint.

## Parallel Opportunities

- Contract, data-model, and independent test-fixture work may run in parallel
  only when paths do not overlap.
- Unit and Playwright test authoring may run in parallel when they use separate
  files and stable contracts.
- Different stories may run in parallel only after shared contracts are stable
  and the plan states they are independent.

## Completion Rules

- Mark a task `[x]` only after its stated artifact or command is complete.
- A passing unit suite does not stand in for required browser, provider, native,
  emulator, or device evidence.
- Record unavailable gates explicitly; do not mark them complete.
- Do not broaden scope to repair unrelated working-tree changes or failures.
- Keep commits narrow and aligned with independently verified slices.
