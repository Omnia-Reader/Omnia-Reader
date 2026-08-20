# Implementation Plan: Qualified Desktop Performance Driver

**Feature Directory**: `013-desktop-performance-driver` | **Date**: 2026-08-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-desktop-performance-driver/spec.md`

## Summary

Add a dependency-free deterministic workload/branch contract beside the
existing performance evidence core, prove it with Node tests, then connect a
separate opt-in Playwright management journey and desktop launcher to the
existing preflight/evaluator. Setup is outside timed intervals; acceptance
timings originate inside the page. The legacy large-publication gate remains
unchanged and separately selectable.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing Node standard library, Playwright 1.61.1,
Angular application controls, current EPUB/PDF fixture builders; no new package

**Storage**: Existing IndexedDB/OPFS library through normal application import
or restore setup; generated workload descriptions and JSON evidence only

**Testing**: Node contract tests plus a focused serial Chromium Playwright
journey; existing performance evidence tests and E2E lint

**Target platforms**: Qualified desktop-web Chromium only; functional smoke is
Chromium-local and non-acceptance

**Performance goals**: 14 branches with acknowledgement at most 1,000 ms; five
unpooled distributions with p95 at most 2,000 ms and at least 95% within target;
20 warm-ups per distribution, at least 20 acknowledgement samples per branch,
and 200 final samples per distribution

**Constraints**: Exact clean profile before sampling, page monotonic timing,
paint-eligible semantic states, zero wrong/missing/console/overlap counters,
8 MiB evidence bound, atomic confined output, no threshold/sample reduction

**Scope**: `apps/omnia-reader-e2e` performance contract, fixture recipe,
Playwright management measurement, driver scripts, Nx targets, and Spec Kit
evidence; no application or library behavior change is planned

## Constitution Check

_GATE: Passed before research and re-checked after design._

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included
      where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged, or the approved scope change is
      documented.

No exception is required. The design adds test/measurement infrastructure only,
uses public UI behavior for timed actions, and keeps unavailable platform gates
explicit.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: existing `performance.spec.ts` large-publication
  tests and helpers; `LibraryPageComponent.addFormat`, `readFormat`,
  `requestVariantDetach`, and the reader's `switchReadingFormat` are observed
  through roles/test IDs, not called directly. The committed
  `evaluatePreflight`, `evaluateRawResult`, and `atomicWriteEvidence` contracts
  own qualification and output validation.
- **Owning project(s)**: `omnia-reader-e2e` only.
- **Affected consumers**: new Nx performance targets and release documentation;
  no exported application/library API changes.
- **Unchanged boundaries**: application UI, reader engines, persistence schema,
  backup schema, synchronization providers/gateway, Tauri hosts, CSP, and
  dependencies.

### Repository Paths

```text
apps/omnia-reader-e2e/performance/                # workload, matrix, driver, Node tests
apps/omnia-reader-e2e/src/performance-management.spec.ts # browser orchestration
apps/omnia-reader-e2e/project.json                # focused smoke/desktop targets
specs/001-multi-format-books/                     # parent-task reconciliation
specs/013-desktop-performance-driver/             # intent, design, tasks, evidence
docs/universal-reader-plan.md                     # verified release-gate status only
```

## Design

### Contracts and State

- `management-branches.mjs` exports the exact ordered fourteen-branch contract
  and five distribution identifiers. Strict validation rejects unknown keys,
  duplicate/missing IDs, unsupported activation kinds, and incomplete visible
  boundaries.
- `management-workload.mjs` derives a compact deterministic recipe and logical
  inventory from the frozen seed. It does not retain 2,000 publication buffers
  in the contract result; fixture bytes are produced on demand from stable
  item descriptors and existing safe builders.
- Browser measurement emits only the base raw-result schema already consumed by
  `performance-evidence.mjs`; producer summaries are optional and never trusted.
- No application durable schema changes. Generated setup/evidence is disposable
  test data and is not synchronization input.

### User Interface and Accessibility

- Timed interactions use labelled product controls, file input change, dialog
  confirmation, visible status/alert regions, library inventory, and rendered
  EPUB/PDF content.
- The harness does not call Angular component instances, alter focus, replace
  accessible names, or suppress announcements.
- Reduced smoke fixtures prove orchestration correctness; they are always
  marked non-primary and never satisfy the fixed sample contract.

### Security and Failure Handling

- Contract/workload JSON is bounded and strictly validated before browser
  launch. Publication/backup bytes continue through existing hostile-input
  validation.
- The desktop launcher invokes preflight first and parses its canonical report;
  any non-`READY` outcome exits before Playwright.
- The launched browser identity and Git state are rechecked before timed work.
  Any page error, console error, timeout, crash, mismatch, or invalid result
  exits non-zero.
- Evidence is written with the committed confined atomic writer. Temporary
  setup/result paths stay under an owned temporary directory and are removed in
  `finally`/signal cleanup.

### Lifecycle and Performance

- One serial worker avoids overlapping samples. Every action has a bounded
  timeout and timing observer cleanup.
- Page instrumentation captures activation and visible states with
  `performance.now()` and `requestAnimationFrame`; Node timers are diagnostics.
- Dataset setup/warm-up is excluded from measured samples. Raw arrays remain
  below the evidence core's 10,000-sample-per-collection and 8 MiB limits.
- The implementation imports no application code into the initial bundle and
  adds no dependency.

## Verification Plan

| Requirement/story           | Evidence                                              | Command or environment                                                       | Required locally?               |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| FR-001-FR-005 / US1         | Deterministic recipe and exact matrix contract tests  | `node --test apps/omnia-reader-e2e/performance/management-workload.spec.mjs` | Yes                             |
| FR-007, FR-010-FR-011 / US2 | Reduced labelled-control Chromium measurement journey | `npx nx run omnia-reader-e2e:performance-management-smoke --skip-nx-cache`   | Yes when Chromium is installed  |
| FR-008-FR-015 / US2-US3     | Driver/preflight/result/cleanup contract tests        | `node --test apps/omnia-reader-e2e/performance/run-desktop-web.spec.mjs`     | Yes                             |
| Desktop acceptance          | Exact constrained 1,000-book primary profile run      | `npx nx run omnia-reader-e2e:performance-desktop-web --skip-nx-cache`        | No; only on matching clean host |
| Project quality             | E2E lint                                              | `npx nx lint omnia-reader-e2e --skip-nx-cache`                               | Yes                             |
| Formatting                  | Whitespace validation                                 | `git diff --check`                                                           | Yes                             |

Application production build is required only as the existing dependency of a
real Playwright target; no separate bundle claim is made if only Node contracts
change. Mobile, packaged, emulator, and device performance are not substitutes
for this desktop profile and remain unverified.

## Delivery and Documentation

- **Vertical slices**: deterministic workload/matrix contract; reduced browser
  orchestration; qualified primary desktop driver and cleanup.
- **Migration/rollout**: additive opt-in targets; legacy performance target and
  evidence v1 remain compatible. Profile semantics are not edited.
- **Documentation**: reconcile `specs/001-multi-format-books/tasks.md`, the
  performance README, and roadmap only after exact checks run.
- **Residual gates**: exact constrained desktop primary run may be unavailable;
  mobile-web, packaged-desktop, Android emulator, and physical-device runs stay
  outside this feature.

## Complexity and Exceptions

No Constitution violation or architectural exception is required.
