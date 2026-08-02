---
description: 'Executable, test-first task list for the Octokit GitHub synchronization migration'
---

# Tasks: Octokit GitHub Synchronization

**Input**: Design documents from `specs/002-octokit-github-sync/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/provider-boundary.md`, and `quickstart.md`

**Tests**: Every provider behavior change is locked down by focused gateway tests before implementation.

## Phase 1: Impact and Contracts

**Purpose**: Confirm ownership and externally visible compatibility.

- [x] T001 Record current CodeGraph symbols, callers, tests, and affected `sync-gateway` ownership in `specs/002-octokit-github-sync/plan.md`
- [x] T002 Resolve the Constitution Check and dependency justification in `specs/002-octokit-github-sync/plan.md` and `specs/002-octokit-github-sync/research.md`
- [x] T003 Define unchanged public and internal provider ownership in `specs/002-octokit-github-sync/contracts/provider-boundary.md`
- [x] T004 Define session compatibility and rollback behavior in `specs/002-octokit-github-sync/data-model.md`

**Checkpoint**: The gateway, session, error, and Git LFS boundaries are explicit.

---

## Phase 2: User Story 1 - Continue GitHub synchronization (Priority: P1)

**Goal**: Preserve authorization, repository, and document behavior through Octokit-backed provider operations.

**Independent test**: The focused gateway suite exercises the existing complete GitHub synchronization flow through an injected fake provider.

### Tests for User Story 1

- [x] T005 [US1] Add Octokit request/authentication compatibility assertions to `apps/sync-gateway/src/github-adapter.spec.ts` and observe them fail before implementation

### Implementation for User Story 1

- [x] T006 [US1] Add the locked `octokit` runtime dependency to `package.json` and `package-lock.json`
- [x] T007 [US1] Replace manual GitHub REST, pagination, App JWT, installation-token, OAuth exchange, refresh, and revocation requests in `apps/sync-gateway/src/github-adapter.ts` while preserving its public types and session fields

### Verification for User Story 1

- [x] T008 [US1] Run `npx nx test sync-gateway --skip-nx-cache` and record the result in `specs/002-octokit-github-sync/tasks.md`

**Checkpoint**: Authorization, repositories, and document operations remain independently usable.

---

## Phase 3: User Story 2 - Recover safely from provider failures (Priority: P2)

**Goal**: Preserve session races, rate-limit propagation, timeouts, safe errors, and access-removal behavior.

**Independent test**: Existing and updated tests inject each provider failure and assert the exact gateway outcome and session mutation.

### Tests for User Story 2

- [x] T009 [US2] Extend failure-path assertions for Octokit request errors, safe automatic retries, mutation replay prevention, and bounded provider-aware throttling in `apps/sync-gateway/src/github-adapter.spec.ts`

### Implementation for User Story 2

- [x] T010 [US2] Implement Octokit-to-`GatewayHttpError` translation, bounded retry/throttle callbacks, and per-request mutation replay controls in `apps/sync-gateway/src/github-adapter.ts`

### Verification for User Story 2

- [x] T011 [US2] Run `npx nx test sync-gateway --skip-nx-cache` and `npx nx lint sync-gateway --skip-nx-cache`

**Checkpoint**: Provider failure and recovery semantics match the existing contract.

---

## Phase 4: User Story 3 - Preserve publication transfers (Priority: P3)

**Goal**: Keep Git LFS custom, streaming, bounded, and ordered after the REST/auth migration.

**Independent test**: LFS success, interruption, unsafe action, timeout, verification, and concurrent pointer tests pass without routing signed transfers through Octokit.

### Tests for User Story 3

- [x] T012 [US3] Assert that LFS batch and signed transfer requests retain their exact custom headers, deadlines, redirect behavior, and pointer ordering in `apps/sync-gateway/src/github-adapter.spec.ts`

### Implementation for User Story 3

- [x] T013 [US3] Preserve and isolate custom Git LFS request paths in `apps/sync-gateway/src/github-adapter.ts`

### Verification for User Story 3

- [x] T014 [US3] Run `npx nx test sync-gateway --skip-nx-cache`

**Checkpoint**: Publication transfer compatibility and integrity are preserved.

---

## Final Phase: Cross-Cutting Acceptance

**Purpose**: Reconcile artifacts and run the full gateway/dependency gates.

- [x] T015 Update Octokit ownership and retained Git LFS behavior in `docs/sync-gateway-api.md`
- [x] T016 Format intentional files with `npx prettier --write` and run `git diff --check`
- [x] T017 Run `npx nx build sync-gateway --configuration production --skip-nx-cache`
- [x] T018 Run `npm audit --omit=dev`
- [x] T019 Reconcile `specs/002-octokit-github-sync/spec.md`, `plan.md`, contracts, and completed task state
- [x] T020 Run `$verify-omnia-reader` and record exact evidence in `specs/002-octokit-github-sync/tasks.md`
- [x] T021 Run `$review-omnia-reader`, resolve actionable findings, and record residual live-provider gates in `specs/002-octokit-github-sync/tasks.md`

## Completion Evidence

- `npx nx test sync-gateway --skip-nx-cache`: 8 test files passed; 111 tests passed and 1 optional Redis test skipped.
- `npx nx lint sync-gateway --skip-nx-cache`: passed.
- `npx nx build sync-gateway --configuration production --skip-nx-cache`: passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `npx prettier --write <intentional paths>`: all intentional files already formatted.
- `git diff --check`: passed.
- `$review-omnia-reader`: no actionable findings remained after adding the stalled REST response-body timeout regression and buffering Octokit REST bodies under the gateway deadline.
- Credentialed live GitHub App authorization, repository synchronization, Git LFS transfer, disconnect, and reconnect remain an unavailable release gate in this environment.

## Dependencies and Execution Order

- T001–T004 block implementation.
- T005 precedes T006–T007; T009 precedes T010; T012 precedes T013.
- US2 depends on the US1 provider client boundary. US3 verifies the adjacent unchanged LFS boundary after US1.
- Final acceptance depends on all story checkpoints.

## Parallel Opportunities

- Documentation updates may proceed independently after provider ownership is stable.
- Test and implementation changes share `github-adapter.spec.ts` and `github-adapter.ts`, so they run sequentially.
- Verification commands may run concurrently only after formatting and implementation are complete.

## Completion Rules

- Mark a task `[x]` only after its artifact or command is complete.
- A passing unit suite does not replace the credentialed live GitHub App gate.
- Preserve unrelated `libs/sync/core` worktree changes.
