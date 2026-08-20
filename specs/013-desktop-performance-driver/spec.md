# Feature Specification: Qualified Desktop Performance Driver

**Feature Directory**: `013-desktop-performance-driver`

**Created**: 2026-08-20

**Status**: Draft

**Input**: User description: "Continue improving Omnia Reader by implementing the next release-critical performance tasks after the fail-closed evidence core: the deterministic multi-format management matrix and qualified desktop-web measurement driver."

## Outcome and Scope _(mandatory)_

**Outcome**: Release reviewers can run one reproducible desktop-web command
that first proves the host matches the frozen profile, exercises the complete
multi-format management and open/switch workload, and emits raw evidence that
the existing fail-closed evaluator can independently validate.

**In scope**:

- A deterministic 1,000-logical-book, 2,000-variant workload with bounded
  change history and stable identity.
- The fixed fourteen-branch acknowledgement matrix for add, associate, detach,
  delete, reconcile, replace, and restore outcomes.
- Separate filtering, EPUB open, PDF open, EPUB-to-PDF, and PDF-to-EPUB final
  distributions with page-side activation and visible-result boundaries.
- A desktop-web driver that refuses to sample unless the exact clean frozen
  desktop profile passes preflight.
- Canonical raw-result output compatible with the committed performance
  evidence evaluator.

**Non-goals**:

- Mobile-web, packaged-desktop, Android, emulator, or physical-device drivers.
- Changing performance thresholds, reducing sample counts, pooling actions, or
  replacing exact host qualification with browser throttling.
- Product UI, persistence schema, synchronization protocol, reader-engine, or
  dependency changes solely to make the measurement pass.
- Claiming four-profile SC-004 acceptance from desktop evidence alone.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Reproduce the management workload (Priority: P1)

A release reviewer can create the same representative library and enumerate
the exact required success and failure journeys without choosing a convenient
subset.

**Why this priority**: Measurements are not comparable or complete until the
dataset, branch denominator, and visible boundaries are deterministic.

**Independent test**: Generate the workload twice, compare its identity and
inventory, then validate that all fourteen unique branches and five separate
final distributions are present with their required activation and completion
boundaries.

**Acceptance scenarios**:

1. **Given** the fixed seed, **When** the workload is generated twice, **Then**
   both runs identify exactly 1,000 logical books, 2,000 EPUB/PDF variants, a
   500-change history, and the same digest.
2. **Given** the measurement contract, **When** the management matrix is
   enumerated, **Then** each of the fourteen approved success/failure branches
   appears exactly once and no unknown branch is accepted.
3. **Given** an omitted, duplicated, reordered-with-semantic-drift, or unknown
   workload entry, **When** validation runs, **Then** measurement is rejected
   before a browser starts.

---

### User Story 2 - Measure qualified desktop behavior (Priority: P1)

A release reviewer can run one desktop-web command that samples only after the
frozen profile qualifies and records page-observed acknowledgement and final
results for the complete workload.

**Why this priority**: A repeatable workload has release value only when the
timings come from the exact approved host and from user-visible browser states.

**Independent test**: On a matching clean desktop profile, run the driver and
verify it performs twenty discarded warm-ups, at least twenty acknowledgement
samples per branch, at least two hundred samples per final distribution, and
writes one evaluator-valid raw result.

**Acceptance scenarios**:

1. **Given** an exact clean desktop profile, **When** the driver starts, **Then**
   it validates profile, dataset, browser, viewport, power, CPU, and memory
   identity before starting any timed action.
2. **Given** a missing or mismatched qualification field, **When** the driver
   starts, **Then** no measurement action runs and an honest non-passing report
   explains the mismatch.
3. **Given** a qualified run, **When** a timed action occurs, **Then** activation,
   first painted semantic acknowledgement, and action-specific final state use
   one page monotonic time origin; host-side timers are diagnostic only.
4. **Given** any wrong result, console error, missing acknowledgement, or
   overlapping reader engines, **When** evaluation runs, **Then** the desktop
   result cannot pass.

---

### User Story 3 - Preserve evidence after interruption (Priority: P2)

A release reviewer receives a bounded, machine-readable outcome when the
browser, application, fixture setup, or result write fails, without partial
evidence being mistaken for a pass.

**Why this priority**: Long performance runs must fail safely and diagnostically
without weakening the primary acceptance contract.

**Independent test**: Inject setup, action, browser, and output failures and
verify each exits non-zero, tears down owned processes, preserves no passing
partial result, and emits a bounded reason.

**Acceptance scenarios**:

1. **Given** an interrupted run, **When** cleanup completes, **Then** browser and
   server processes owned by the driver stop and no temporary result is exposed
   as final evidence.
2. **Given** a result whose raw samples or computed summary is incomplete or
   inconsistent, **When** the driver evaluates it, **Then** it exits non-zero
   and the canonical evaluator rejects it.
3. **Given** a destination outside the approved results directory, **When** a
   write is requested, **Then** no file is created or replaced.

### Edge Cases

- A profile becomes dirty or its commit changes between preflight and sampling.
- The lockfile browser revision differs from the launched browser revision.
- A semantic busy state is created but is never paint-eligible.
- An action completes with the wrong logical book, format, membership, or
  restored source.
- A reader switch briefly leaves both EPUB and PDF engines mounted.
- A sample times out, the page closes, or the browser crashes mid-distribution.
- A generated dataset item collides with an existing exact-edition identity.
- The result would exceed the evidence core's 8 MiB input bound.
- The output filename attempts traversal, a separator, a symlink, or overwrite
  through an unapproved path.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The workload MUST deterministically represent exactly 1,000
  logical books, 2,000 exact EPUB/PDF variants, and a bounded 500-change
  history from one frozen seed and recipe identity.
- **FR-002**: Workload validation MUST reject unknown fields, duplicate
  identities, missing variants, digest drift, count drift, and out-of-bound
  history before browser measurement.
- **FR-003**: The management matrix MUST contain exactly the fourteen approved
  success/failure branches for add local, associate, detach, delete, reconcile,
  replace, and restore conflict handling.
- **FR-004**: Every branch MUST declare one trusted user activation, one first
  visible semantic acknowledgement, and one action-specific final-result state.
- **FR-005**: Filtering, EPUB open, PDF open, EPUB-to-PDF, and PDF-to-EPUB MUST
  remain five distinct final-result distributions; samples MUST NOT be pooled.
- **FR-006**: The driver MUST perform exactly twenty discarded warm-ups for each
  final distribution, at least twenty measured acknowledgement samples for
  every branch, and at least two hundred measured samples for every final
  distribution.
- **FR-007**: Timed acceptance intervals MUST originate in the page's monotonic
  clock at the trusted activation event and end only after the required visible
  state is paint-eligible.
- **FR-008**: The driver MUST run the existing desktop profile preflight before
  starting a browser measurement and MUST refuse sampling unless the result is
  `READY` with `mayMeasure=true`.
- **FR-009**: The driver MUST prove the launched browser, dataset, source
  revision, viewport, device scale, power mode, CPU quota, and memory limit
  still match the preflight identity at measurement time.
- **FR-010**: The driver MUST record every raw acknowledgement, warm-up, and
  final timing plus zero-tolerance counters in the existing raw-result schema.
- **FR-011**: Wrong results, console errors, missing acknowledgements, and
  overlapping engines MUST each be counted independently and MUST remain zero
  for a passing result.
- **FR-012**: The driver MUST pass its raw output through the existing canonical
  evaluator and MUST exit zero only when that evaluator returns desktop
  `PASS`.
- **FR-013**: Invalid, unavailable, supplemental, failed, interrupted, or
  unevaluated runs MUST never create or preserve a final file that can be
  mistaken for passing primary evidence.
- **FR-014**: Result writes MUST remain atomic, bounded, and confined to one JSON
  filename under the approved performance-results directory.
- **FR-015**: The driver MUST stop browser/server processes and remove temporary
  artifacts that it owns on success, failure, signal, or timeout.
- **FR-016**: The legacy large-publication lifecycle/backup gate MUST remain
  independently runnable and MUST not count as this management acceptance run.
- **FR-017**: Open synchronized membership conflicts MUST be exposed through a
  labelled library control that opens the existing reconciliation dialog,
  preserves the conflict after a failed decision, and reports the outcome in a
  visible status or alert region.

### Key Entities and Durable State _(include when data changes)_

- **Workload recipe**: Frozen seed, counts, logical-change bound, deterministic
  naming/content rules, and canonical digest for one dataset version.
- **Management branch**: Stable branch identifier, action, expected outcome,
  activation boundary, acknowledgement boundary, final boundary, and required
  failure mechanism.
- **Measurement run**: Qualified profile identity, source revision, command,
  raw page timings, counters, and evaluator disposition.
- **Temporary result**: In-progress evidence that is never acceptance input and
  is atomically promoted only after complete validation.

## Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- The workload and browser journey MUST run without a provider, credential, or
  network dependency after the locked application/browser inputs are present.
- Interruption MUST leave the user's existing repository data untouched and a
  later run MUST start from a fresh deterministic measurement state.

**Security and trust**

- Generated and restored publications, archive input, profile input, and raw
  result input remain hostile and MUST pass existing format, size, path, and
  digest validation.
- The driver MUST NOT weaken CSP, publication sandboxing, archive checks, or
  local path confinement and MUST NOT log publication content or secrets.

**Accessibility and interaction**

- Measured actions MUST use the same labelled, keyboard-operable product
  controls and visible live status/error states available to users; private
  component calls do not establish acknowledgement evidence.
- Measurement instrumentation MUST not alter focus order, accessible names,
  announcements, or pointer/touch behavior.

**Platform and compatibility**

- This slice qualifies only the frozen desktop-web Chromium profile.
  Firefox/WebKit compatibility remains covered by functional journeys but does
  not substitute for desktop primary performance evidence.
- Mobile web, packaged desktop, Android emulator, and physical-device evidence
  remain separate unverified release gates.

**Lifecycle and performance**

- Instrumentation overhead MUST be excluded from the declared intervals where
  possible and MUST remain deterministic and bounded.
- Each sample MUST time out rather than hang indefinitely; browser pages,
  contexts, servers, listeners, and temporary files MUST be released.
- The fixed thresholds remain 1,000 ms for acknowledgement and 2,000 ms for
  final p95/95%-within-target acceptance.

**Migration and compatibility**

- No application persistence, backup, or synchronization schema changes are
  allowed in this slice.
- Existing v1 performance profiles and evidence remain immutable; any semantic
  recipe or environment change requires a new version rather than mutation of
  previously accepted evidence.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Two independent workload generations produce identical identity,
  exactly 1,000 logical books, 2,000 variants, and a 500-change history.
- **SC-002**: Contract validation covers 14/14 unique acknowledgement branches
  and 5/5 unpooled final distributions, rejecting every missing, duplicate, or
  unknown entry fixture.
- **SC-003**: On an exact qualified desktop profile, one command produces a raw
  result containing at least 280 acknowledgement samples, exactly 100 discarded
  warm-ups, and at least 1,000 final samples, then receives an evaluator `PASS`
  or an honest threshold `FAIL` without structural rejection.
- **SC-004**: In 100% of preflight mismatch, dirty-tree, browser-crash,
  interruption, invalid-result, and unapproved-path tests, the command exits
  non-zero and produces no passing final evidence.
- **SC-005**: The legacy three-case large-publication gate retains its existing
  behavior and remains independently selectable.

## Acceptance Evidence _(mandatory)_

- Deterministic contract tests for workload identity, branch completeness,
  sample cardinality, invalid input, status precedence, output confinement, and
  cleanup.
- A focused Chromium journey proving trusted activation, painted
  acknowledgement, action-specific final states, exact result identity, and
  independent distributions on a reduced non-acceptance fixture.
- The exact constrained desktop command on the frozen 1,000-book dataset; if
  the host cannot qualify, record `UNVERIFIED` or `SUPPLEMENTAL` without
  claiming performance acceptance.
- Omnia Reader E2E lint and whitespace checks; no application production build
  is required unless implementation changes application code or bundle inputs.
- Mobile-web, packaged-desktop, Android emulator, and physical-device profile
  runs remain explicitly unavailable/unverified in this feature.

## Assumptions

- The committed `multi-format-performance-v1` evidence core, thresholds,
  profile identity, status vocabulary, and raw-result schema remain unchanged.
- Existing product controls and deterministic EPUB/PDF fixture builders can
  express most required management journeys. The reconciliation dialog and
  service existed without a reachable library entry point, so this feature
  exposes that existing decision path without changing persistence or merge
  semantics.
- The acceptance workload may be expensive and opt-in; reduced fixtures can
  prove orchestration correctness but cannot establish primary performance.
