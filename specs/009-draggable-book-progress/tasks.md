# Tasks: Draggable Book Progress

**Input**: Design documents from `specs/009-draggable-book-progress/`

## Phase 1: Impact and Contracts

- [x] T001 Record CodeGraph callers, tests, affected Nx projects, and unchanged engine/persistence boundaries in `specs/009-draggable-book-progress/plan.md`
- [x] T002 Complete the Constitution Check and bounded lifecycle design in `specs/009-draggable-book-progress/plan.md`
- [x] T003 Define slider queue and milestone targeting behavior in `specs/009-draggable-book-progress/contracts/progress-navigation.md`
- [x] T004 Define ephemeral queue and milestone state in `specs/009-draggable-book-progress/data-model.md`

## Phase 2: User Story 1 - Scrub through a book (Priority: P1)

**Goal**: Seek during dragging with one renderer call in flight and the latest pending value winning.

**Independent test**: Emit multiple input values around a deferred seek and prove the slider remains enabled, no calls overlap, and the final reversed value is requested.

- [x] T005 [US1] Add failing coalesced live-seek, reversal, enabled-state, and retry coverage in `apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts`
- [x] T006 [US1] Implement sequential latest-value progress seeking and teardown handling in `apps/omnia-reader/src/app/features/reader/reader-page.component.ts`
- [x] T007 [US1] Wire native slider input and busy accessibility state in `apps/omnia-reader/src/app/features/reader/reader-page.component.html`
- [x] T008 [US1] Add a focused real-browser drag/input journey in `apps/omnia-reader-e2e/src/example.spec.ts`

## Phase 3: User Story 2 - Navigate complete book structure (Priority: P2)

**Goal**: Show Beginning plus every authored top-level TOC entry and route each target correctly.

**Independent test**: Assert ordered Beginning, Preface, Chapter One, and Chapter Two controls and activate progression/locator targets independently.

- [x] T009 [US2] Add failing Beginning/all-top-level/fallback-position assertions in `apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts`
- [x] T010 [US2] Implement discriminated Beginning and top-level milestone derivation/navigation in `apps/omnia-reader/src/app/features/reader/reader-page.component.ts`
- [x] T011 [US2] Update milestone labels, disabled state, and structural group semantics in `apps/omnia-reader/src/app/features/reader/reader-page.component.html`
- [x] T012 [US2] Extend the focused EPUB journey for Beginning, Preface, and every top-level entry in `apps/omnia-reader-e2e/src/example.spec.ts`

## Final Phase: Cross-Cutting Acceptance

- [x] T013 Reconcile implemented behavior with `specs/009-draggable-book-progress/spec.md`, `plan.md`, and `contracts/progress-navigation.md`
- [x] T014 Format changed files with `npx prettier --write <changed paths>` and run `git diff --check`
- [x] T015 Run `npx nx test omnia-reader --skip-nx-cache`
- [x] T016 Run affected lint with `npx nx lint omnia-reader --skip-nx-cache` and `npx nx lint omnia-reader-e2e --skip-nx-cache`
- [x] T017 Run the focused Chromium journey from `specs/009-draggable-book-progress/quickstart.md` and record Firefox/WebKit availability
- [x] T018 Run `npx nx build omnia-reader --configuration production --skip-nx-cache`
- [x] T019 Apply the repository reader review checklist to the working-tree diff and resolve actionable findings
- [x] T020 Extend the focused Chromium journey to click forward and backward at arbitrary positions between milestones and record the result

## Verification Evidence

- Red test: `npx nx test omnia-reader --skip-nx-cache` failed at the new live-input assertion because `goToProgression(0.2)` had not been called.
- Final unit gate: `npx nx test omnia-reader --skip-nx-cache` passed 22 files and 164 tests.
- Final lint gates: `npx nx lint omnia-reader --skip-nx-cache` and `npx nx lint omnia-reader-e2e --skip-nx-cache` passed with no findings.
- Production gate: `npx nx build omnia-reader --configuration production --skip-nx-cache` passed with a 373.09 kB initial bundle and no budget warning.
- Focused Chromium regression: the direct Playwright command in `quickstart.md` passed the drag/Beginning/Preface journey; the related chapter-boundary and milestone-hover set passed 3 tests in 8.0 seconds.
- In-between click red evidence: before the explicit click mapping, Chromium remained at 0% and timed out waiting for a value above the Chapter One milestone.
- In-between click final evidence: the focused Chromium journey passed with forward and backward clicks strictly between Chapter One and Chapter Two in both slider and persisted progression; the three related milestone tests passed together in 8.8 seconds.
- `git diff --check` passed.
- The Nx e2e wrapper was attempted but stopped before Playwright because the current workspace reports a recursive `sync-gateway:serve:development -> omnia-reader-e2e:e2e` invocation. Direct Playwright against the production build supplied the browser evidence.
- Firefox and WebKit were not run in this local pass; Firefox is repository opt-in. Packaged Tauri, Android emulator, and physical-device gates were outside this web-only change.
- Review resolved a stale-intent race between a draining slider seek and a later milestone request. The incremental click review strengthened browser evidence to wait for persisted progression; no remaining actionable issue was found.

## Dependencies and Execution Order

- T001-T004 establish the accepted contract and block implementation.
- T005 precedes T006-T007; T008 follows the working P1 slice.
- T009 precedes T010-T011; T012 follows the working P2 slice.
- T013-T020 depend on both story checkpoints.
- Component tests share one file and therefore run sequentially; the focused browser journey combines both stories.

## Parallel Opportunities

- Spec/design artifacts are isolated from source tests, but implementation is intentionally sequential because both stories share reader-page source and browser fixtures.
- Unit and browser verification commands may run independently after formatting and implementation are complete.

## Implementation Strategy

- Deliver P1 first so live scrubbing is independently usable.
- Add the structural milestone model without changing engine or durable contracts.
- Finish with focused browser evidence, affected quality gates, and a repository-specific risk review.
