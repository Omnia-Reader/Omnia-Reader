---
description: 'Test-first task list for truthful synchronization status and recovery'
---

# Tasks: Truthful Sync Status and Recovery

**Input**: Design documents from `specs/004-sync-status-ux/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/sync-readiness.md`, and `quickstart.md`

**Tests**: Every behavioral change receives a failing focused test before implementation.

## Phase 1: Impact and Contracts

- [x] T001 Record CodeGraph callers, current failures, tests, and affected Nx projects in `specs/004-sync-status-ux/plan.md`
- [x] T002 Resolve the Constitution Check in `specs/004-sync-status-ux/plan.md`
- [x] T003 [P] Define readiness precedence and recovery in `specs/004-sync-status-ux/contracts/sync-readiness.md`
- [x] T004 [P] Define connection states and remembered destination lifecycle in `specs/004-sync-status-ux/data-model.md`

**Checkpoint**: Readiness, activity, history, and recovery ownership are explicit.

---

## Phase 2: User Story 1 - Resume an existing GitHub setup (Priority: P1)

**Goal**: Restore repository discovery and recover an authorized destination without redundant setup.

**Independent test**: Renew a GitHub session with a remembered accessible repository and observe the destination restored; multiple choices remain explicit.

### Tests for User Story 1

- [x] T005 [US1] Reproduce wrapped Octokit pagination losing its response URL in `apps/sync-gateway/src/github-adapter.spec.ts`
- [x] T006 [P] [US1] Add remembered destination validation, restoration, rejection, and disconnect tests in `libs/sync/git/src/lib/github-gateway-client.spec.ts`
- [x] T007 [P] [US1] Add single-writable-repository and multiple-choice recovery tests in `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.spec.ts`

### Implementation for User Story 1

- [x] T008 [US1] Preserve response metadata and consume normalized Octokit pagination arrays in `apps/sync-gateway/src/github-adapter.ts`
- [x] T009 [US1] Persist and safely restore a validated device-local repository hint in `libs/sync/git/src/lib/github-gateway-client.ts`
- [x] T010 [US1] Recover one unambiguous writable repository and publish recovery feedback in `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.ts`

### Verification for User Story 1

- [x] T011 [US1] Run the focused gateway regression with `npx nx test sync-gateway --skip-nx-cache -- --testNamePattern="authenticates, rotates the session, and scopes repository selection"`
- [x] T012 [US1] Run `npx nx test sync-git --skip-nx-cache` and the focused sync Settings tests

---

## Phase 3: User Story 2 - See one truthful synchronization status (Priority: P1)

**Goal**: Make current connection readiness authoritative before scheduler activity or history.

**Independent test**: Drive every readiness state and verify incomplete states never display “Synced.”

### Tests for User Story 2

- [x] T013 [P] [US2] Add readiness state, stale refresh, and error tests in `apps/omnia-reader/src/app/sync-connection-status.service.spec.ts`
- [x] T014 [US2] Update toolbar state-matrix tests in `apps/omnia-reader/src/app/navigation/navigation.component.spec.ts`
- [x] T015 [US2] Update detailed Settings account/destination/error assertions in `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.spec.ts`

### Implementation for User Story 2

- [x] T016 [US2] Implement the shared readiness service in `apps/omnia-reader/src/app/sync-connection-status.service.ts`
- [x] T017 [US2] Gate scheduler labels and descriptions on readiness in `apps/omnia-reader/src/app/navigation/navigation.component.ts` and `.html`
- [x] T018 [US2] Publish detailed Settings refresh and mutations through the readiness service in `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.ts`

### Verification for User Story 2

- [x] T019 [US2] Run the focused readiness, navigation, and sync Settings tests with the `omnia-reader` target `--include` options

---

## Phase 4: User Story 3 - Manage instead of restart setup (Priority: P2)

**Goal**: Summarize current provider/account/destination state on the main Settings page with a state-specific action.

**Independent test**: Render ready, incomplete, unavailable, and local-only Settings cards and inspect summary plus action.

### Tests for User Story 3

- [x] T020 [US3] Add main Settings summary/action assertions in `apps/omnia-reader/src/app/features/settings/settings-page.component.spec.ts`
- [x] T021 [P] [US3] Extend the Chromium journey in `apps/omnia-reader-e2e/src/sync.spec.ts`

### Implementation for User Story 3

- [x] T022 [US3] Replace generic sync onboarding copy with the shared summary and state-specific action in `apps/omnia-reader/src/app/features/settings/settings-page.component.ts` and `.html`

### Verification for User Story 3

- [x] T023 [US3] Run the focused main Settings unit test and Chromium sync journey

---

## Final Phase: Cross-Cutting Acceptance

- [x] T024 Reconcile `spec.md`, `plan.md`, contract, and completed task state in `specs/004-sync-status-ux/`
- [x] T025 Format intentional files and run `git diff --check`
- [x] T026 Run affected `sync-gateway`, `sync-git`, `sync-core`, and `omnia-reader` tests and lint
- [x] T027 Run production builds for `sync-gateway` and `omnia-reader`
- [x] T028 Run `$verify-omnia-reader` and record exact evidence in `specs/004-sync-status-ux/tasks.md`
- [x] T029 Run `$review-omnia-reader`, resolve actionable findings, and record unavailable gates
- [x] T030 Reproduce missing-variant membership ordering in `libs/sync/core/src/lib/library-sync-coordinator.spec.ts`
- [x] T031 Restore publication variants before logical membership in `libs/sync/core/src/lib/library-sync-coordinator.ts` and run `npx nx test sync-core --skip-nx-cache`

## Dependencies and Execution Order

- T001–T004 block story implementation.
- T005–T007 precede T008–T010.
- US2 depends on stable gateway/client recovery behavior from US1.
- US3 depends on the shared readiness contract from US2.
- Final acceptance depends on every story checkpoint.

## Parallel Opportunities

- Contract and data-model artifacts are independent.
- Client, readiness-service, and browser test files can be authored independently after the contract stabilizes.
- Gateway and application verification can run concurrently after implementation and formatting.

## Completion Rules

- Mark a task `[x]` only after its artifact, behavior, or exact command is complete.
- A scheduler success never substitutes for account and destination readiness.
- Unit tests do not replace the required Chromium journey or live-provider probe when credentials are available.
- Preserve unrelated library and logical-sync worktree changes.

## Completion evidence

- `npx nx test sync-gateway --skip-nx-cache`: 111 passed, 1 skipped.
- `npx nx test sync-git --skip-nx-cache`: 31 passed.
- `npx nx test sync-core --skip-nx-cache`: 120 passed.
- Focused `omnia-reader` readiness, navigation, and Settings suites: 53 passed after the final readiness probe and coalescing coverage.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx nx run omnia-reader-e2e:e2e -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts`: 12 passed, 2 skipped.
- `npx nx lint sync-gateway --skip-nx-cache`, `sync-git`, `sync-core`, and `omnia-reader`: passed; existing unrelated warnings remain in dirty library/logical-sync test files.
- `npx nx build sync-gateway --configuration production --skip-nx-cache` and `npx nx build omnia-reader --configuration production --skip-nx-cache`: passed; final application initial bundle is 363.91 kB raw and 81.57 kB estimated transfer.
- `git diff --check`: passed.
- Review resolved stale-success readiness, repository-list failure classification, same-provider refresh coalescing with forced post-mutation refresh, duplicate onboarding during gateway failure, and publication-before-membership ordering.
- Live credentialed GitHub authorization was not repeated during deterministic validation; the already-running local gateway had previously reproduced the Octokit pagination failure. Native, emulator, physical-device, and PWA-offline gates are out of scope for this provider UX change.
