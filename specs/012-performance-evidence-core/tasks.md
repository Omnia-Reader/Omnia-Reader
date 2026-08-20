# Tasks: Fail-Closed Performance Evidence Core

**Input**: Design documents from `specs/012-performance-evidence-core/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/evidence-core.md`, and `quickstart.md`

**Tests**: Every evidence classification and failure boundary receives a
failing Node contract test before implementation. No browser test is required
because this slice starts no browser and changes no application behavior.

## Phase 1: Impact and Contracts

**Purpose**: Lock profile identity, status semantics, ownership, bounds, and
verification before implementation.

- [x] T001 Record CodeGraph/Nx impact, consumers, and unchanged application
      boundaries in `specs/012-performance-evidence-core/plan.md`
- [x] T002 Resolve the pre- and post-design Constitution Check in
      `specs/012-performance-evidence-core/plan.md`
- [x] T003 [P] Define canonical identity, CLI exits, status vocabulary, and
      stable reasons in
      `specs/012-performance-evidence-core/contracts/evidence-core.md`
- [x] T004 [P] Define profile, environment, preflight, raw-result, and aggregate
      states in `specs/012-performance-evidence-core/data-model.md`

**Checkpoint**: The evidence core cannot weaken or substitute for the fixed
four-profile acceptance contract.

---

## Phase 2: User Story 1 - Reject Unqualified Primary Runs (Priority: P1)

**Goal**: Only an exact clean current profile is eligible to start primary
measurement; absence, drift, dirtiness, and deliberate substitutes fail closed.

**Independent test**: Exact, reordered, changed, unavailable, dirty,
supplemental, unknown, oversized, and current-host fixtures produce the exact
accepted preflight state and exit status.

### Tests for User Story 1

- [x] T005 [US1] Add failing canonical profile identity, strict schema, hostile
      bounds, and exact/reordered/drifted digest tests in
      `apps/omnia-reader-e2e/performance/validate-profile.spec.mjs`
- [x] T006 [US1] Add failing exact, unavailable, dirty, supplemental, mismatch,
      current-capture, and CLI-exit tests using deterministic fixtures in
      `apps/omnia-reader-e2e/performance/validate-profile.spec.mjs` and
      `apps/omnia-reader-e2e/performance/test-fixtures.mjs`

### Implementation for User Story 1

- [x] T007 [US1] Create the immutable four-profile contract with fixed dataset
      and measurement identities in
      `specs/001-multi-format-books/performance/profiles-v1.json`
- [x] T008 [US1] Implement bounded JSON parsing, canonical serialization,
      canonical hashing, strict profile parsing, and stable reason ordering in
      `apps/omnia-reader-e2e/performance/performance-contract.mjs`
- [x] T009 [US1] Implement environment capture, profile comparison,
      `READY`/`UNVERIFIED`/`SUPPLEMENTAL` evaluation, and the preflight CLI in
      `apps/omnia-reader-e2e/performance/validate-profile.mjs`

### Verification for User Story 1

- [x] T010 [US1] Run
      `node --test apps/omnia-reader-e2e/performance/validate-profile.spec.mjs`
- [x] T011 [US1] Run the current desktop preflight command from
      `specs/012-performance-evidence-core/quickstart.md` and record the exact
      honest disposition in `specs/012-performance-evidence-core/tasks.md`

**Checkpoint**: No unqualified primary run can begin.

---

## Phase 3: User Story 2 - Trust Only Complete Raw Evidence (Priority: P1)

**Goal**: Recompute complete unpooled evidence and distinguish measured failure
from invalid, unavailable, or supplemental input.

**Independent test**: Passing, slow, incomplete, pooled, malformed, inconsistent,
and zero-tolerance fixtures produce the required disposition or structural
rejection without trusting producer summaries.

### Tests for User Story 2

- [x] T012 [US2] Add failing deterministic p50/p95/max/ratio and complete
      passing/threshold-failing raw-result tests in
      `apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`
- [x] T013 [US2] Add failing missing/duplicate branch and distribution,
      insufficient/excessive samples, invalid timing/counter, inconsistent
      summary, unverified, supplemental, and CLI-exit tests in
      `apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`

### Implementation for User Story 2

- [x] T014 [US2] Implement strict raw-result parsing, unpooled matrix
      completeness, deterministic statistics, producer-summary verification,
      zero-tolerance checks, and `PASS`/`FAIL`/`UNVERIFIED`/`SUPPLEMENTAL`
      evaluation in
      `apps/omnia-reader-e2e/performance/performance-evidence.mjs`

### Verification for User Story 2

- [x] T015 [US2] Run
      `node --test apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`

**Checkpoint**: Only complete threshold-compliant raw primary evidence passes.

---

## Phase 4: User Story 3 - Aggregate Without Overclaiming (Priority: P2)

**Goal**: Cross-platform acceptance requires one current primary pass for each
approved profile and never pools measurements.

**Independent test**: Four passes aggregate to `PASS`; missing, duplicate,
stale, failed, unverified, supplemental, and malformed inputs cannot.

### Tests for User Story 3

- [x] T016 [US3] Add failing four-pass, missing, duplicate, stale, failed,
      unverified, supplemental, deterministic-output, and aggregate CLI-exit
      tests in
      `apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`

### Implementation for User Story 3

- [x] T017 [US3] Implement non-pooling aggregate validation and canonical
      aggregate reports in
      `apps/omnia-reader-e2e/performance/performance-evidence.mjs`
- [x] T018 [US3] Implement path-confined atomic evidence writing in
      `apps/omnia-reader-e2e/performance/performance-contract.mjs`
- [x] T019 [US3] Add the focused `performance-evidence-test` target to
      `apps/omnia-reader-e2e/project.json`

### Verification for User Story 3

- [x] T020 [US3] Run
      `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`

**Checkpoint**: Partial local evidence cannot be reported as cross-platform
acceptance.

---

## Final Phase: Cross-Cutting Acceptance

**Purpose**: Reconcile the new evidence foundation without claiming unrun
measurement profiles.

- [x] T021 Run `npx prettier --write` for all changed feature/evidence files and
      `npx nx lint omnia-reader-e2e --skip-nx-cache`
- [x] T022 Run `git diff --check`
- [x] T023 Apply `$verify-omnia-reader` and `$review-omnia-reader`, resolve
      actionable correctness, hostile-input, reproducibility, path, lifecycle,
      and missing-test findings, and record exact evidence in
      `specs/012-performance-evidence-core/tasks.md`
- [x] T024 Reconcile delivered foundation status in
      `specs/001-multi-format-books/contracts/performance-evidence.md`,
      `specs/001-multi-format-books/tasks.md`, and
      `apps/omnia-reader-e2e/performance/README.md` without marking profile
      measurements or aggregate acceptance complete
- [x] T025 Update `docs/universal-reader-plan.md` only with the verified
      fail-closed evidence-foundation status and explicit residual profile gates

## Dependencies and Execution Order

- T001–T004 block implementation.
- T005–T006 precede T007–T009; T010–T011 close User Story 1.
- T012–T013 precede T014; T015 closes User Story 2.
- T016 precedes T017–T019; T020 closes User Story 3.
- T021–T025 depend on all story checkpoints.

## Parallel Opportunities

- Contract and data-model artifacts were independent after scope stabilized.
- Test cases within one file remain sequential to avoid fixture drift.
- Formatting/lint and documentation reconciliation begin only after the
  implementation contract is stable.

## Verification Evidence (2026-08-20)

- Test-first red state was observed as module-not-found failures before the
  evidence modules were implemented.
- `node --test apps/omnia-reader-e2e/performance/validate-profile.spec.mjs apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`:
  PASS, 12 tests, 0 failures.
- `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`:
  PASS, 12 tests, 0 failures.
- `npx nx lint omnia-reader-e2e --skip-nx-cache`: PASS, 0 errors.
- `git diff --check`: PASS.
- Current `desktop-web-v1` preflight: `SUPPLEMENTAL`; the worktree was dirty
  and constrained CPU/memory, power, viewport, and Chromium runtime evidence
  was unavailable. No measurement runtime started and no profile acceptance is
  claimed.
- Review found no remaining actionable correctness, hostile-input,
  reproducibility, path-confinement, or missing-test defects in this slice.
  Actual browser, packaged-native, emulator, and physical-device profile gates
  remain unverified.

## Completion Rules

- Mark a task `[x]` only after its artifact or exact command is complete.
- Observe test-first failure for T005/T006, T012/T013, and T016 before their
  corresponding implementation.
- `READY` is not `PASS`; a preflight result never completes a measurement gate.
- Leave desktop-web, mobile-web, packaged-desktop, Android, emulator/device, and
  aggregate profile acceptance explicitly `UNVERIFIED` until exact drivers run.
- Keep the slice dependency-free and outside application bundles.
