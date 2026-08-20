# Tasks: Secure Runtime Dependencies

**Input**: Design documents from `specs/011-secure-runtime-dependencies/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/security-release-gate.md`, and `quickstart.md`

**Tests**: Dependency contract and hostile-input tests precede lockfile and
runtime changes. Existing PDF/browser/gateway suites become mandatory
compatibility gates rather than being weakened for the upgrade.

## Phase 1: Impact and Contracts

**Purpose**: Lock down advisory ranges, ownership, and unchanged boundaries.

- [x] T001 Record CodeGraph callers, tests, affected Nx projects, and unchanged
      consumers in `specs/011-secure-runtime-dependencies/plan.md`
- [x] T002 Resolve the Constitution Check and dependency choices in
      `specs/011-secure-runtime-dependencies/plan.md` and
      `specs/011-secure-runtime-dependencies/research.md`
- [x] T003 [P] Define the fail-closed dependency, PDF, gateway, and evidence
      contract in `specs/011-secure-runtime-dependencies/contracts/security-release-gate.md`
- [x] T004 [P] Define lock-resolution/evidence states and rollback rules in
      `specs/011-secure-runtime-dependencies/data-model.md`

**Checkpoint**: The affected advisory ranges, public boundaries, and required
evidence are explicit.

---

## Phase 2: User Story 1 - Safely open PDF publications (Priority: P1)

**Goal**: Remove the malicious-PDF runtime advisory without regressing reader
behavior, security, lazy loading, or lifecycle cleanup.

**Independent test**: The lock graph rejects the affected PDF range; focused
unit and real-browser PDF fixtures pass on the patched runtime.

### Tests for User Story 1

- [x] T005 [P] [US1] Add a failing locked-runtime advisory-range contract test
      in `tools/security/runtime-dependencies.spec.mjs`
- [x] T006 [P] [US1] Add explicit supported PDF load and worker-asset coverage
      in
      `libs/reader/pdf/src/lib/pdf-reader-engine.spec.ts`
- [x] T007 [P] [US1] Add a deterministic PDF JavaScript-action fixture and
      no-execution browser assertion in
      `apps/omnia-reader-e2e/src/publication-fixtures.ts` and
      `apps/omnia-reader-e2e/src/security.spec.ts`

### Implementation for User Story 1

- [x] T008 [US1] Upgrade `pdfjs-dist` outside GHSA-hq66-cqwq-w95j and refresh
      its locked integrity in `package.json` and `package-lock.json`
- [x] T009 [US1] Adapt private PDF runtime or copied-asset integration only if
      required by the patched API in `libs/reader/pdf/src/lib/pdf-reader-engine.ts`
      and `apps/omnia-reader/project.json`

### Verification for User Story 1

- [x] T010 [US1] Run `node --test tools/security/runtime-dependencies.spec.mjs`,
      `npx nx test reader-pdf --skip-nx-cache`, and
      `npx nx lint reader-pdf --skip-nx-cache`
- [x] T011 [US1] Run the Chromium/WebKit PDF security journeys from
      `specs/011-secure-runtime-dependencies/quickstart.md` and record exact
      results in `specs/011-secure-runtime-dependencies/tasks.md`
- [x] T012 [US1] Run `npx nx run omnia-reader-e2e:performance` and record
      virtualization, long-task, canvas, heap, and teardown evidence in
      `specs/011-secure-runtime-dependencies/tasks.md`

**Checkpoint**: User Story 1 is independently safe and compatible.

---

## Phase 3: User Story 2 - Keep gateway validation trustworthy (Priority: P1)

**Goal**: Remove the URL host-confusion dependency findings and retain strict
gateway confinement, authentication, and provider behavior.

**Independent test**: Both locked URL parser major lines are patched; explicit
backslash-authority inputs are rejected; the complete gateway suite passes.

### Tests for User Story 2

- [x] T013 [US2] Add same-origin backslash-authority and confined-path variants
      to `apps/sync-gateway/src/app.spec.ts` and version assertions to
      `tools/security/runtime-dependencies.spec.mjs`

### Implementation for User Story 2

- [x] T014 [US2] Refresh both `fast-uri` major lines outside
      GHSA-7p8r-x3mc-p8w7 through compatible lock resolution in
      `package-lock.json`, using a root override in `package.json` only if normal
      resolution cannot produce the patched graph
- [x] T015 [US2] Tighten gateway validation only if the new hostile fixtures
      expose a boundary gap in `apps/sync-gateway/src/security.ts`

### Verification for User Story 2

- [x] T016 [US2] Run `npx nx test sync-gateway --skip-nx-cache`,
      `npx nx lint sync-gateway --skip-nx-cache`, and
      `npx nx build sync-gateway --configuration production --skip-nx-cache`

**Checkpoint**: Both P1 stories are independently testable and verified.

---

## Final Phase: Cross-Cutting Acceptance

**Purpose**: Prove the production graph is clean and reader/gateway release
boundaries remain intact.

- [x] T017 Run two clean `npm ci` passes with an unchanged lockfile digest,
      `npm ls pdfjs-dist fast-uri fastify fast-json-stringify ajv ajv-formats
--all`, and `npm audit --omit=dev`, recording exact reproducibility and
      zero-finding evidence in
      `specs/011-secure-runtime-dependencies/tasks.md`
- [x] T018 Run `npx nx run-many -t lint -p reader-pdf sync-gateway
omnia-reader-e2e --skip-nx-cache`, both production builds from
      `quickstart.md`, and `git diff --check`
- [x] T019 Apply `$verify-omnia-reader` and `$review-omnia-reader`, resolve
      actionable security, compatibility, lifecycle, bundle, and missing-test
      findings, and reconcile `spec.md`, `plan.md`, `quickstart.md`, and
      `tasks.md`
- [x] T020 Update `docs/universal-reader-plan.md` only for verified audit and
      compatibility status, record unavailable packaged/native/device gates,
      and restore `.specify/feature.json` to the next active feature when one is
      selected

## Dependencies and Execution Order

- T001–T004 block behavior changes.
- T005–T007 precede T008–T009; T010–T012 close User Story 1.
- T013 precedes T014–T015; T016 closes User Story 2.
- User Stories 1 and 2 share the lock file, so implementation runs sequentially
  even though their first tests can be authored independently.
- T017–T020 depend on both story checkpoints.

## Parallel Opportunities

- T005/T006/T007 touch independent contract, unit, and browser-test files.
- T003/T004 were independently authored after the behavior stabilized.
- Reader and gateway focused verification may run independently after the
  shared lockfile is stable.

## Completion Rules

- Mark a task `[x]` only after its artifact or exact command is complete.
- Do not weaken assertions, advisory ranges, or audit severity to obtain a pass.
- Browser, packaged, emulator, device, and credentialed gates remain distinct;
  unavailable evidence is recorded explicitly.
- Preserve exact reader, gateway, storage, and provider contracts unless a
  failing compatibility test proves a private adaptation is necessary.
- Keep the commit narrow and do not include registry caches or generated build
  output.

## Completion Evidence (2026-08-20)

- Locked graph: `pdfjs-dist@6.2.108`, `fast-uri@3.1.5`, and nested
  `fast-uri@4.1.2`; no root override was required.
- Dependency contract: `node --test tools/security/runtime-dependencies.spec.mjs`
  passed 2/2. `npm audit --omit=dev` reported zero vulnerabilities.
- Reproducibility: two `npm ci` passes completed and preserved lockfile SHA-256
  `f2e8589150b4b2e6fd8ce1ea83fd983bde10fac555c4045784f49b7255112e30`.
- Reader: `npx nx test reader-pdf --skip-nx-cache` passed 6/6. Chromium and
  WebKit each passed the encrypted, malformed, and inert-document-JavaScript
  PDF journeys (3/3 per browser).
- Performance: `npx nx run omnia-reader-e2e:performance` passed 3/3, including
  the 180-page PDF virtualization and teardown gate.
- Gateway: `npx nx test sync-gateway --skip-nx-cache` passed 121 tests with one
  intentional live-Redis skip; backslash-authority and raw/encoded separator
  fixtures passed.
- Quality: lint passed for `reader-pdf`, `sync-gateway`, and
  `omnia-reader-e2e`; both production builds passed; the application initial
  bundle was 394.46 kB and PDF.js remained in a lazy chunk; `git diff --check`
  passed.
- Review: `$verify-omnia-reader` and `$review-omnia-reader` found no remaining
  actionable defects after aligning the PDF unit contract with the patched
  public API and expanding the browser grep to include the new security test.
- External gates: packaged desktop, Android emulator/physical-device, and live
  credentialed-provider validation remain **UNVERIFIED**. No next feature was
  selected, so `.specify/feature.json` remains on feature 011.
