# Tasks: Cross-Platform Performance Drivers

**Input**: Design documents from `specs/014-cross-platform-performance/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/platform-measurement.md`

**Tests**: Behavioral and hostile-input tests precede every implementation slice as required by the constitution.

## Phase 1: Setup

**Purpose**: Establish additive profile and platform-driver boundaries without changing v1 behavior.

- [x] T001 Add shared test fixtures for v1/v2 profile identities and hostile platform inputs in `apps/omnia-reader-e2e/performance/platform-test-fixtures.mjs`
- [x] T002 [P] Add reviewed profile-v2 schema documentation with unresolved live identities explicitly non-primary in `specs/001-multi-format-books/performance/profiles-v2.md`
- [x] T003 [P] Add shared platform identifiers, bounds, and lifecycle states in `apps/omnia-reader-e2e/performance/platform-contract.mjs`

---

## Phase 2: Foundational Contracts

**Purpose**: Provide the blocking versioning, lifecycle, artifact, and output contracts used by all platform stories.

**⚠️ CRITICAL**: Complete before any platform-specific primary driver.

- [x] T004 Add failing v1 compatibility, unknown-v2 rejection, and allowlisted-v2 registry tests in `apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`
- [x] T005 Implement the backward-compatible profile-set descriptor registry in `apps/omnia-reader-e2e/performance/performance-contract.mjs`
- [x] T006 Add failing existing-destination, symlink, traversal, and concurrent-promotion tests in `apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`
- [x] T007 Implement bounded atomic no-replace evidence promotion while preserving the existing writer contract in `apps/omnia-reader-e2e/performance/performance-contract.mjs`
- [x] T008 Add failing lifecycle transition, drift, timeout, signal, diagnostic-bound, and owned-cleanup tests in `apps/omnia-reader-e2e/performance/platform-lifecycle.spec.mjs`
- [x] T009 Implement the platform-neutral qualification/evaluation lifecycle in `apps/omnia-reader-e2e/performance/platform-lifecycle.mjs`
- [x] T010 Add failing artifact/provenance schema, debug substitution, size/digest drift, and TOCTOU tests in `apps/omnia-reader-e2e/performance/artifact-identity.spec.mjs`
- [x] T011 Implement bounded release artifact and provenance validation/copying in `apps/omnia-reader-e2e/performance/artifact-identity.mjs`
- [x] T012 Refactor the desktop driver to consume shared lifecycle primitives without changing CLI/result semantics in `apps/omnia-reader-e2e/performance/run-desktop-web.mjs`
- [x] T013 Reconcile shared contract commands and exact v1 compatibility evidence in `specs/014-cross-platform-performance/quickstart.md`

**Checkpoint**: Existing desktop-web contracts pass unchanged and common hostile-input/lifecycle behavior is reusable.

---

## Phase 3: User Story 1 - Qualify Mobile Web (Priority: P1) 🎯 MVP

**Goal**: Run the frozen workload in exact emulator Chrome with complete pre-sampling qualification.

**Independent Test**: A fixture-backed driver rejects every identity mismatch before sampling; an approved disposable AVD reaches reduced real-Chrome smoke or reports exact `UNVERIFIED` prerequisites.

### Tests for User Story 1

- [x] T014 [US1] Add failing canonical AVD-tree, serial selection, device-collision, snapshot-drift, and owned-cleanup tests in `apps/omnia-reader-e2e/performance/android-emulator-controller.spec.mjs`
- [x] T015 [US1] Add failing Chrome package/CDP mismatch, viewport, battery, network, cgroup, and sampling-recapture tests in `apps/omnia-reader-e2e/performance/mobile-web-environment.spec.mjs`
- [ ] T016 [US1] Add failing driver crash, disconnect, timeout, signal, invalid-result, and no-promotion tests in `apps/omnia-reader-e2e/performance/run-mobile-web.spec.mjs`

### Implementation for User Story 1

- [x] T017 [US1] Implement exact serial-scoped disposable AVD ownership in `apps/omnia-reader-e2e/performance/android-emulator-controller.mjs`
- [x] T018 [US1] Implement live mobile Chrome/environment capture and CDP agreement in `apps/omnia-reader-e2e/performance/mobile-web-environment.mjs`
- [ ] T019 [US1] Extract the reusable page workload runner from `apps/omnia-reader-e2e/src/performance-management.spec.ts` into `apps/omnia-reader-e2e/src/performance-management-runner.ts`
- [ ] T020 [US1] Implement the fail-closed CDP mobile-web driver in `apps/omnia-reader-e2e/performance/run-mobile-web.mjs`
- [ ] T021 [US1] Wire mobile-web contract/smoke/primary targets in `apps/omnia-reader-e2e/project.json`
- [ ] T022 [US1] Record reviewed real AVD/Chrome identity in `specs/001-multi-format-books/performance/profiles-v2.json` only when qualification artifacts exist

**Checkpoint**: Mobile web independently produces evaluator evidence on the exact profile or an honest non-primary unavailable result.

---

## Phase 4: User Story 2 - Qualify Packaged Desktop (Priority: P1)

**Goal**: Measure an unmodified Linux release application and bind results to exact package bytes.

**Independent Test**: External WebDriver executes a labelled semantic action and page script against an owned copy of one verified release package; unsupported/mismatched hosts stop before sampling.

### Tests for User Story 2

- [ ] T023 [US2] Add failing debug package, archive/link attack, stale endpoint, duplicate instance, process-scope drift, crash, hang, and cleanup tests in `apps/omnia-reader-e2e/performance/packaged-desktop-environment.spec.mjs`
- [ ] T024 [US2] Add an exact-artifact external WebDriver spike test in `apps/omnia-reader-e2e/performance/packaged-desktop-spike.spec.mjs`
- [ ] T025 [US2] Add failing primary driver result/cardinality/evaluator/no-promotion tests in `apps/omnia-reader-e2e/performance/run-packaged-desktop.spec.mjs`

### Implementation for User Story 2

- [ ] T026 [US2] Implement release package extraction/runtime/process attestation in `apps/omnia-reader-e2e/performance/packaged-desktop-environment.mjs`
- [ ] T027 [US2] Implement a bounded protocol-neutral semantic automation adapter in `apps/omnia-reader-e2e/performance/management-automation.mjs`
- [ ] T028 [US2] Implement the fail-closed external-Tauri packaged driver in `apps/omnia-reader-e2e/performance/run-packaged-desktop.mjs`
- [ ] T029 [US2] Generate bounded native package provenance and checksums in `tools/release/write-native-provenance.mjs`
- [ ] T030 [US2] Upload only intended native packages plus provenance/checksums in `.github/workflows/verify.yml`
- [ ] T031 [US2] Wire packaged-desktop smoke/primary targets in `apps/omnia-reader-e2e/project.json`
- [ ] T032 [US2] Freeze the reviewed package/runtime identity in `specs/001-multi-format-books/performance/profiles-v2.json` only after the external-driver spike passes

**Checkpoint**: Packaged desktop independently measures exact unmodified release bytes or remains explicitly `UNVERIFIED`.

---

## Phase 5: User Story 3 - Qualify Packaged Android (Priority: P1)

**Goal**: Install and measure an exact non-debuggable release APK on the approved emulator without weakening the production WebView.

**Independent Test**: Release APK metadata, signer, ABI, installed bytes, WebView, AVD snapshot, and test instrumentation all match before a reduced semantic run; every mismatch prevents sampling.

### Tests for User Story 3

- [ ] T033 [US3] Add failing APK manifest/signer/ABI/debug/installed-byte and hostile-tool-output tests in `apps/omnia-reader-e2e/performance/android-artifact-identity.spec.mjs`
- [ ] T034 [US3] Add failing instrumentation identity, WebView drift, install/launch/disconnect, foreign-device survival, and cleanup tests in `apps/omnia-reader-e2e/performance/android-environment.spec.mjs`
- [ ] T035 [US3] Add failing primary Android driver cardinality/evaluator/no-promotion tests in `apps/omnia-reader-e2e/performance/run-android.spec.mjs`

### Implementation for User Story 3

- [ ] T036 [US3] Implement release APK metadata/signer/installed-byte validation in `apps/omnia-reader-e2e/performance/android-artifact-identity.mjs`
- [ ] T037 [US3] Add the bounded test-only management instrumentation project under `src-tauri/android-performance-test/`
- [ ] T038 [US3] Implement instrumentation/WebView/environment attestation in `apps/omnia-reader-e2e/performance/android-environment.mjs`
- [ ] T039 [US3] Implement the fail-closed packaged Android driver in `apps/omnia-reader-e2e/performance/run-android.mjs`
- [ ] T040 [US3] Wire Android instrumentation build and smoke/primary targets in `apps/omnia-reader-e2e/project.json`
- [ ] T041 [US3] Freeze reviewed release APK/test APK/WebView identity in `specs/001-multi-format-books/performance/profiles-v2.json` only after the exact-artifact smoke passes

**Checkpoint**: Packaged Android independently measures exact release bytes or remains explicitly `UNVERIFIED`; release WebView debugging stays disabled.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T042 Add four-platform same-profile aggregation and mixed/unavailable result tests in `apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`
- [ ] T043 Implement v2 four-platform aggregate evaluation without sample pooling in `apps/omnia-reader-e2e/performance/performance-evidence.mjs`
- [ ] T044 Re-run existing desktop evidence, branch smoke, E2E lint, production build, and platform contract gates from `specs/014-cross-platform-performance/quickstart.md`
- [ ] T045 Reconcile verified gate status and explicit unavailable boundaries in `docs/universal-reader-plan.md`
- [ ] T046 Run repository review and self-review against `specs/014-cross-platform-performance/spec.md`, `plan.md`, and `tasks.md`

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 is mandatory.
- Phase 2 blocks all platform stories.
- US1 is the MVP and proves disposable emulator ownership before US3.
- US2 is independent of US1 after Phase 2.
- US3 depends on Phase 2 and reuses the AVD contract proven by US1.
- Aggregate work depends on all implemented platform result schemas, but it must remain non-passing while any platform is unavailable.

## Parallel Opportunities

- T002 and T003 can proceed after T001 ownership is clear.
- Within each platform story, fixture design for distinct files may proceed in parallel, but implementation follows its failing tests.
- US2 can proceed in parallel with US1 after Phase 2; US3 waits for the shared AVD boundary.

## Implementation Strategy

### MVP First

1. Complete setup and foundational contracts.
2. Commit and verify v1 compatibility plus no-replace/lifecycle safety.
3. Implement US1 through fixture tests and an honest live preflight.
4. Stop at a stable checkpoint if no reviewed AVD exists; do not invent `profiles-v2.json` values.

### Incremental Delivery

Each story lands as an independently testable driver whose live state is either exact qualified evidence or an explicit non-primary unavailable result. Debug or supplemental automation never advances a release gate.
