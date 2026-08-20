---
description: 'Executable test-first tasks for the qualified desktop performance driver'
---

# Tasks: Qualified Desktop Performance Driver

**Input**: Design documents from `specs/013-desktop-performance-driver/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/management-measurement.md`, and `quickstart.md`

**Tests**: Contract and browser behavior are test-first. The exact primary
desktop run remains a separate environment gate and cannot be replaced by
reduced smoke evidence.

**Organization**: Stabilize the deterministic workload/matrix first, then add
browser timing and qualification, then harden interruption/output lifecycle.

## Phase 1: Impact and Contracts

**Purpose**: Lock ownership, workload identity, closed measurement boundaries,
and verification before implementation.

- [x] T001 Record CodeGraph callers, existing performance tests, Nx ownership,
      consumers, and unchanged application boundaries in
      `specs/013-desktop-performance-driver/plan.md`
- [x] T002 Resolve pre- and post-design Constitution Check items in
      `specs/013-desktop-performance-driver/plan.md`
- [x] T003 [P] Define closed branch, page timing, distribution, smoke, and
      launcher behavior in
      `specs/013-desktop-performance-driver/contracts/management-measurement.md`
- [x] T004 [P] Define workload descriptors and measurement lifecycle in
      `specs/013-desktop-performance-driver/data-model.md`

**Checkpoint**: Dataset identity and browser evidence boundaries are explicit
without changing application behavior.

---

## Phase 2: User Story 1 - Reproduce the Management Workload (Priority: P1)

**Goal**: Generate one deterministic 1,000-book/2,000-variant workload and
accept exactly the fourteen branches and five unpooled distributions.

**Independent test**: Two generations are byte-for-byte canonically identical;
missing, duplicate, unknown, count-drifted, history-drifted, and digest-drifted
fixtures fail before any browser starts.

### Tests for User Story 1

- [x] T005 [US1] Add initially failing deterministic recipe, exact inventory,
      history total, digest, and hostile mutation tests in
      `apps/omnia-reader-e2e/performance/management-workload.spec.mjs`
- [x] T006 [US1] Add initially failing exact branch/distribution completeness,
      unique ID, activation, semantic boundary, and frozen-order tests in
      `apps/omnia-reader-e2e/performance/management-workload.spec.mjs`

### Implementation for User Story 1

- [x] T007 [US1] Implement the strict frozen fourteen-branch and five-
      distribution contract in
      `apps/omnia-reader-e2e/performance/management-branches.mjs`
- [x] T008 [US1] Implement deterministic bounded workload generation,
      validation, and canonical identity in
      `apps/omnia-reader-e2e/performance/management-workload.mjs`

### Verification for User Story 1

- [x] T009 [US1] Run
      `node --test apps/omnia-reader-e2e/performance/management-workload.spec.mjs`
- [x] T010 [US1] Add the contract suite to the existing
      `omnia-reader-e2e:performance-evidence-test` target in
      `apps/omnia-reader-e2e/project.json` and run it with `--skip-nx-cache`

**Checkpoint**: The workload and complete measurement denominator are
independently reproducible without Angular or a browser.

**Evidence (2026-08-20)**:

- Initial red state: `ERR_MODULE_NOT_FOUND` for the not-yet-created management
  modules.
- `node --test apps/omnia-reader-e2e/performance/management-workload.spec.mjs`:
  PASS, 5 tests, 0 failures.
- `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`:
  PASS, 17 tests, 0 failures.

---

## Phase 3: User Story 2 - Measure Qualified Desktop Behavior (Priority: P1)

**Goal**: Use labelled product controls and page monotonic timing to create a
complete evaluator-compatible desktop result only after exact qualification.

**Independent test**: Reduced Chromium smoke proves timing boundaries and
counters without qualifying as primary evidence; driver tests prove no browser
starts for non-READY preflight.

### Tests for User Story 2

- [x] T011 [P] [US2] Add initially failing page activation,
      requestAnimationFrame acknowledgement/final, timeout, and teardown tests
      in `apps/omnia-reader-e2e/performance/page-measurement.spec.mjs`
- [x] T012 [P] [US2] Add initially failing reduced labelled-control add,
      failure, filter, EPUB/PDF open, and switch journey in
      `apps/omnia-reader-e2e/src/performance-management.spec.ts`
- [x] T013 [US2] Add initially failing READY/non-READY, Git/browser drift, raw
      result, and evaluator exit mapping tests in
      `apps/omnia-reader-e2e/performance/run-desktop-web.spec.mjs`

### Implementation for User Story 2

- [x] T014 [US2] Implement page-owned paint-eligible timing primitives in
      `apps/omnia-reader-e2e/performance/page-measurement.mjs`
- [x] T015 [US2] Implement reduced smoke and full cardinality orchestration in
      `apps/omnia-reader-e2e/src/performance-management.spec.ts`, including the
      real labelled reconciliation controls
- [x] T016 [US2] Implement strict preflight-first desktop launcher and evaluator
      integration in
      `apps/omnia-reader-e2e/performance/run-desktop-web.mjs`
- [x] T017 [US2] Add serial `performance-management-smoke` and
      `performance-desktop-web` targets in `apps/omnia-reader-e2e/project.json`

### Verification for User Story 2

- [x] T018 [US2] Run Node page/driver contracts and
      `npx nx run omnia-reader-e2e:performance-management-smoke --skip-nx-cache`
- [x] T019 [US2] Run the primary desktop target; record `PASS`/`FAIL` only on an
      exact qualified host or the honest preflight refusal in
      `specs/013-desktop-performance-driver/tasks.md`

**Checkpoint**: Qualified desktop evidence and reduced smoke are mechanically
distinct and cannot be confused.

**Partial evidence (2026-08-20)**:

- Combined workload, page-timing, and injectable-driver Node contracts: PASS,
  17 tests, 0 failures.
- `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`:
  PASS, 17 tests, 0 failures.
- `npx nx run omnia-reader-e2e:performance-management-smoke --skip-nx-cache`:
  PASS, 1 Chromium test, including the dependent production build.
- `npx nx lint omnia-reader-e2e --skip-nx-cache`: PASS.
- Full-cardinality orchestration is implemented under T015 and its exact
  cardinality is covered by the primary-run contract. Primary desktop evidence
  remains a separate exact-host acceptance gate.
- `npx nx run omnia-reader-e2e:performance-desktop-web --skip-nx-cache`:
  honest `SUPPLEMENTAL` refusal with exit 1 before Nx, the application build,
  or Playwright started. The current host is dirty and differs from the frozen
  profile in nine environment/browser fields; no result file was written.
- Deterministic dataset contracts: PASS, 2 tests, including exact schema-v9
  counts for 1,000 logical books, 2,000 unique byte-backed EPUB/PDF variants,
  and 500 logical-change journal entries.
- `npx nx run omnia-reader-e2e:performance-management-dataset-smoke
--skip-nx-cache`: PASS, 1 Chromium test and 1 expected mode skip, including
  the dependent production build. The real repository validated the exact
  inventory and opened EPUB then PDF without overlapping engines. This remains
  setup/integration evidence, not primary sampled evidence.
- The existing membership-reconciliation dialog and service had no reachable
  library control. The library now lists open conflicts, opens the existing
  decision dialog, removes resolved conflicts after reload, and preserves
  failed conflicts with an alert. Focused component verification passes 35/35.

---

## Phase 4: User Story 3 - Preserve Evidence After Interruption (Priority: P2)

**Goal**: Fail safely on timeout, crash, signal, invalid evidence, or output
attack without leaking processes or a passing partial result.

**Independent test**: Inject each lifecycle failure and prove non-zero exit,
bounded diagnostic output, owned-process cleanup, temporary-file removal, and
no final evidence promotion.

### Tests for User Story 3

- [x] T020 [US3] Add initially failing child crash, timeout, SIGINT/SIGTERM,
      invalid JSON, evaluator rejection, traversal, and temporary cleanup tests
      in `apps/omnia-reader-e2e/performance/run-desktop-web.spec.mjs`

### Implementation for User Story 3

- [x] T021 [US3] Implement abort-aware child lifecycle and bounded diagnostics
      in `apps/omnia-reader-e2e/performance/run-desktop-web.mjs`
- [x] T022 [US3] Integrate confined atomic final promotion through
      `apps/omnia-reader-e2e/performance/performance-contract.mjs`

### Verification for User Story 3

- [x] T023 [US3] Run
      `node --test apps/omnia-reader-e2e/performance/run-desktop-web.spec.mjs`
      and verify no owned test process/temp artifact remains

**Checkpoint**: Infrastructure failure cannot publish acceptance evidence.

**Evidence (2026-08-20)**:

- Initial red state: `run-desktop-web.mjs` did not export the required owned
  process lifecycle API.
- `node --test apps/omnia-reader-e2e/performance/run-desktop-web.spec.mjs`:
  PASS, 8 tests, 0 failures. Covered child PASS, crash, bounded diagnostics,
  timeout, SIGINT/SIGTERM-style abort, invalid JSON, forged evaluator output,
  traversal refusal, atomic promotion, and owned temporary cleanup.

---

## Final Phase: Cross-Cutting Acceptance

**Purpose**: Reconcile the additive desktop driver without claiming unavailable
profile measurements.

- [x] T024 Run the unchanged legacy gate with
      `npx nx run omnia-reader-e2e:performance --skip-nx-cache` and record its
      independent 3/3 result or exact unavailable browser boundary here
- [x] T025 Run Prettier for every changed MJS/TS/JSON/Markdown path and
      `npx nx lint omnia-reader-e2e --skip-nx-cache`
- [x] T026 Run `git diff --check`
- [x] T027 Apply `$verify-omnia-reader` and `$review-omnia-reader`, resolve
      actionable performance, hostile-input, accessibility, lifecycle, path,
      and missing-test findings, and record exact evidence here
- [x] T028 Reconcile T098-T103 status in
      `specs/001-multi-format-books/tasks.md` without marking mobile, packaged,
      Android, or aggregate SC-004 gates complete
- [x] T029 Update `apps/omnia-reader-e2e/performance/README.md` and
      `docs/universal-reader-plan.md` only with verified commands, status, and
      explicit residual platform gates

**Cross-cutting evidence (2026-08-20)**:

- Prettier completed for every changed source, test, project, and feature
  artifact; `git diff --check` passed.
- `npx nx lint omnia-reader --skip-nx-cache` and
  `npx nx lint omnia-reader-e2e --skip-nx-cache`: PASS.
- `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`:
  PASS, 43 tests.
- Focused library reconciliation verification: PASS, 35 tests. The full
  `omnia-reader` suite passed 173/174 but its unrelated reader annotation test
  exceeded the existing five-second timeout; that reader spec passed 2/2 in
  isolation.
- Repository-specific self-review found no remaining actionable correctness,
  accessibility, hostile-input, lifecycle, path-confinement, or missing-test
  defect in this slice.
- Focused library verification after availability-priority refinement: PASS,
  36 tests.
- `npx nx run omnia-reader-e2e:performance-management-branch-smoke
--skip-nx-cache --outputStyle=stream`: PASS, one active Chromium journey and
  three expected mode skips, including the production build. It drove one real
  sample for all fourteen branches and five distributions, including stale
  association and reconciliation failures.
- Full-cardinality orchestration is implemented for fourteen times twenty
  acknowledgement samples and five independent distributions with twenty
  discarded warm-ups plus 200 samples each. T015 is complete for
  implementation; exact qualified-host primary evidence remains explicitly
  unavailable on the current host.
- `npx nx run omnia-reader-e2e:performance-desktop-web --skip-nx-cache` on the
  clean current worktree: expected `UNVERIFIED` exit 1 before Playwright because
  required constrained-host, power, viewport/device-scale, and Chromium values
  were absent. No primary result was written.
- Parent tasks T098 and T103 are reconciled complete for implementation and the
  explicit `UNVERIFIED` desktop run respectively. T099 and the all-platform
  T101 remain incomplete; mobile-web, packaged-desktop, Android, and aggregate
  SC-004 gates remain open.

## Dependencies and Execution Order

- T001-T004 block every implementation task.
- T005-T006 precede T007-T008; T009-T010 close User Story 1.
- User Story 2 depends on the stable workload/matrix contract.
- T011-T013 precede T014-T017; T018-T019 close User Story 2.
- User Story 3 depends on the launcher from User Story 2.
- Final acceptance depends on every delivered story checkpoint.

## Parallel Opportunities

- Page timing Node tests and reduced Playwright authoring use separate files
  after the branch/workload contract is stable.
- Specification reconciliation may begin only after exact verification results
  are known.

## Completion Rules

- Mark a task `[x]` only after the stated artifact or command is complete.
- Observe each new test failing for the expected missing/incorrect behavior
  before implementing its subject.
- Reduced fixtures and an unconstrained host are never primary evidence.
- Leave exact desktop performance `UNVERIFIED` or `SUPPLEMENTAL` unless every
  frozen preflight field matches and the complete measurement runs.
- Mobile-web, packaged-desktop, Android, emulator/device, and aggregate SC-004
  acceptance remain outside this feature.

**Legacy evidence (2026-08-20)**:

- `npx nx run omnia-reader-e2e:performance --skip-nx-cache`: PASS, 3 Chromium
  tests, including the dependent production build.

## Phase 5: Convergence

- [x] T030 Add failing CLI tests and confine the production desktop driver to
      the committed immutable profile set, removing any path that can redefine
      frozen v1 qualification requirements per FR-008 and FR-009 (contradicts)
- [x] T031 Add failing CLI tests and confine final desktop evidence to
      `specs/001-multi-format-books/performance/results/`, while retaining
      injectable temporary roots only below the internal test API, per FR-014
      and US3/AC3 (contradicts)
- [x] T032 Add failing classification tests and preserve nested
      `PageMeasurementError` identity through diagnostic wrappers so missing
      acknowledgements and wrong results remain independent counters per FR-011
      (partial)

**Convergence evidence (2026-08-20)**:

- Initial red state: the focused Node run failed because neither the confined
  CLI parser nor nested page-measurement classifier was exported.
- `node --test apps/omnia-reader-e2e/performance/run-desktop-web.spec.mjs
apps/omnia-reader-e2e/performance/page-measurement.spec.mjs`: PASS, 18 tests.
- `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`:
  PASS, 43 tests, 0 failures.
- `npx nx lint omnia-reader-e2e --skip-nx-cache`: PASS, 0 errors.
- `npx nx run omnia-reader-e2e:performance-management-branch-smoke
--skip-nx-cache --outputStyle=stream`: PASS, one active Chromium journey,
  three expected mode skips, and the dependent production build.
- The production CLI now always loads the committed profile set and always
  promotes final evidence beneath the approved repository results directory.
  Programmatic test APIs retain injectable roots without widening the CLI.
