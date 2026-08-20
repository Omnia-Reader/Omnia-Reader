# Feature Specification: Fail-Closed Performance Evidence Core

**Feature Directory**: `012-performance-evidence-core`

**Created**: 2026-08-20

**Status**: Draft

**Input**: User description: "Continuously improve Omnia Reader by implementing the next highest-value locally actionable release gap. Establish the fail-closed evidence core for the existing multi-format performance profiles before adding more profile drivers."

## Outcome and Scope _(mandatory)_

**Outcome**: A release reviewer can tell whether multi-format performance
evidence came from the exact approved environment and whether it satisfies the
fixed acceptance contract. Missing, malformed, drifted, dirty, or incomplete
evidence can never be mistaken for a release pass.

**In scope**:

- Define one immutable versioned profile set for the four already approved
  multi-format performance environments.
- Validate profile identity, environment evidence, fixture identity, source
  revision cleanliness, and packaged-artifact identity before measurements are
  accepted as primary evidence.
- Validate bounded raw results, recompute their statistics, and classify each
  result as `PASS`, `FAIL`, `UNVERIFIED`, or `SUPPLEMENTAL`.
- Aggregate the four primary profiles without pooling their measurements and
  allow the cross-platform performance criterion to pass only when all four
  exact profiles pass.
- Provide deterministic command-line and contract-test evidence for the
  profile validator and result aggregator.

**Non-goals**:

- Implement the browser, packaged-desktop, mobile-browser, or Android
  measurement drivers in this slice.
- Change the fixed dataset, acknowledgement matrix, sample counts, thresholds,
  or environment definitions approved by the multi-format performance
  contract.
- Claim desktop-web, mobile-web, packaged-desktop, Android, or aggregate
  performance acceptance without measurements from their exact environments.
- Change reader, library, persistence, synchronization, backup, or native app
  behavior.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Reject Unqualified Primary Runs (Priority: P1)

A release reviewer validates a proposed performance run before sampling and
receives an objective disposition that distinguishes an exact clean primary
environment from an unavailable or deliberately non-primary environment.

**Why this priority**: False primary evidence can hide a release regression.
Failing closed before an expensive run is the smallest useful protection.

**Independent test**: Validate exact, missing, dirty, drifted, and deliberately
supplemental environment records against the immutable profile set and observe
that only the exact clean match is eligible for primary sampling.

**Acceptance scenarios**:

1. **Given** the approved profile set and a clean environment record matching
   every required identity field, **When** preflight runs, **Then** the selected
   profile is eligible for primary measurement.
2. **Given** an unavailable runtime, artifact, device, or required host
   capability, **When** preflight runs, **Then** the result is `UNVERIFIED`, no
   primary measurement is authorized, and every mismatch is reported.
3. **Given** a dirty source tree, an unconstrained/faster host, viewport-only
   mobile emulation, or another intentional non-primary configuration, **When**
   preflight runs, **Then** the result is `SUPPLEMENTAL` and cannot establish a
   release pass.
4. **Given** a changed committed v1 profile set or a profile-set digest that no
   longer matches its canonical content, **When** preflight runs, **Then** it
   fails closed instead of silently accepting the drift.

---

### User Story 2 - Trust Only Complete Raw Evidence (Priority: P1)

A release reviewer loads a raw performance result and receives statistics and
a disposition derived from the fixed thresholds rather than trusting values
claimed by the producer.

**Why this priority**: Profile qualification alone cannot protect against
truncated, pooled, inconsistent, or fabricated result summaries.

**Independent test**: Submit complete passing data and fixtures with missing
branches, insufficient samples, threshold violations, pooled distributions,
wrong-result counts, malformed numbers, or inconsistent summaries; only the
complete threshold-compliant result is classified `PASS`.

**Acceptance scenarios**:

1. **Given** all fourteen acknowledgement branches with at least twenty samples
   each and all five final distributions with twenty discarded warm-ups and at
   least two hundred measured samples each, **When** every fixed threshold and
   zero-tolerance condition is satisfied, **Then** the raw result is `PASS`.
2. **Given** a qualified primary run with any missing branch, insufficient
   sample count, sample over the acknowledgement ceiling, slow final
   distribution, console error, wrong book/format, or overlapping engine,
   **When** it is evaluated, **Then** the result is `FAIL` with stable reasons.
3. **Given** producer-supplied statistics that disagree with recomputed values,
   non-finite or negative timings, unknown action/profile keys, duplicate
   distributions, or excessive input size, **When** validation runs, **Then**
   the evidence is rejected as invalid and no acceptance disposition is
   inferred.

---

### User Story 3 - Aggregate Without Overclaiming (Priority: P2)

A release reviewer combines independently validated profile results and sees
the overall performance criterion pass only when the complete approved profile
set has primary `PASS` evidence.

**Why this priority**: A local desktop result is useful evidence but must not be
presented as cross-platform acceptance.

**Independent test**: Aggregate complete passing evidence, missing profiles,
duplicate profiles, mixed dispositions, stale profile-set identities, and
supplemental evidence; only one current primary pass for each of the four
approved profiles produces an aggregate pass.

**Acceptance scenarios**:

1. **Given** one validated current primary `PASS` result for every approved
   profile, **When** aggregation runs, **Then** the cross-platform criterion is
   `PASS` and lists all four evidence records.
2. **Given** any missing, duplicated, stale, `FAIL`, `UNVERIFIED`, or
   `SUPPLEMENTAL` profile evidence, **When** aggregation runs, **Then** the
   criterion is not passed and the exact blocking profiles are reported.

### Edge Cases

- Profile and result JSON are empty, truncated, duplicated, unexpectedly large,
  or contain unknown fields intended to disguise a mismatch.
- Timings include negative values, fractions beyond the supported precision,
  non-finite values, or values serialized as strings.
- A result was captured at the right revision but after local modifications, or
  at a clean revision different from the one recorded by the environment.
- A packaged profile references a debug artifact, a missing artifact, or bytes
  whose digest differs from the preflight record.
- Multiple results exist for one profile, or evidence from different profile
  set versions is combined.
- A profile environment is unavailable; an explicit `UNVERIFIED` record remains
  valid evidence of absence but cannot contribute a pass.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The evidence core MUST define exactly the four approved primary
  profile identities and the fixed dataset, branch, distribution, sample-count,
  threshold, and zero-tolerance contract in one immutable versioned profile
  set.
- **FR-002**: Profile-set identity MUST be derived from canonical content so a
  changed field, reordered collection, or stale claimed digest cannot be
  accepted as the same profile set.
- **FR-003**: Preflight MUST compare every required source, environment,
  runtime, fixture, viewport/device, constraint, and packaged-artifact field
  applicable to the selected profile before authorizing primary sampling.
- **FR-004**: Preflight MUST classify unavailable exact environments as
  `UNVERIFIED` and deliberate non-primary environments as `SUPPLEMENTAL`; both
  classifications MUST prohibit primary sampling.
- **FR-005**: Dirty, mismatched, malformed, incomplete, or unbounded evidence
  MUST fail closed and MUST NOT be promoted to `PASS` by command-line flags or
  producer-supplied summaries.
- **FR-006**: Raw result validation MUST require all fourteen distinct
  acknowledgement branches with at least twenty bounded samples per branch and
  all five distinct unpooled final distributions with twenty discarded warm-ups
  and at least two hundred measured samples per distribution.
- **FR-007**: Raw result evaluation MUST recompute count, median, 95th
  percentile, maximum, and within-target ratio from the raw timings using one
  documented deterministic rule.
- **FR-008**: A qualified primary result MUST be `PASS` only when every
  acknowledgement sample is at most 1,000 milliseconds; every final
  distribution has a 95th percentile at most 2,000 milliseconds and at least
  95% of samples at most 2,000 milliseconds; and console-error, wrong-result,
  missing-acknowledgement, and overlapping-engine counts are all zero.
- **FR-009**: A qualified primary result that is structurally valid but misses
  any acceptance threshold MUST be `FAIL` with stable machine-readable and
  human-readable reasons.
- **FR-010**: Aggregation MUST accept at most one current validated result per
  approved profile and MUST pass the cross-platform criterion only when all four
  are primary `PASS` results from the same profile set.
- **FR-011**: Validator and aggregator commands MUST return a non-zero exit
  status for invalid evidence, threshold failure, or incomplete aggregate
  acceptance while still emitting a bounded machine-readable report.
- **FR-012**: The evidence core MUST preserve explicit `UNVERIFIED` and
  `SUPPLEMENTAL` records without treating them as successful measurements.

### Key Entities and Durable State

- **Profile set**: Immutable versioned contract containing four primary profile
  identities, fixed measurement requirements, and its canonical digest.
- **Environment record**: Captured source, runtime, host/device, fixture,
  constraint, and optional artifact identity offered to preflight.
- **Preflight report**: Selected profile, disposition, primary-sampling
  eligibility, and stable mismatch reasons.
- **Raw result**: One profile's environment identity, raw acknowledgement and
  final timings, zero-tolerance counters, recomputed statistics, and
  disposition.
- **Aggregate report**: One result slot per approved profile, blocking reasons,
  and overall cross-platform disposition.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- Validation and aggregation MUST run from checked-in and local evidence with
  no provider, gateway, credential, or network dependency. An interrupted write
  MUST not replace previously valid evidence with a partial record.

**Security and trust**

- Profile, environment, and raw-result files are hostile input. The evidence
  core MUST bound file size, collection counts, strings, numeric ranges, and
  accepted keys; reject path traversal and unsafe output destinations; and never
  execute or interpolate evidence content as code or a shell command.

**Accessibility and interaction**

- The slice adds no application UI. Command reports MUST use stable plain-text
  explanations alongside machine-readable output so a reviewer does not need
  color, animation, or pointer interaction to understand a failure.

**Platform and compatibility**

- Validation MUST run on the repository-defined Node runtime. It MUST represent
  desktop web, mobile web, packaged desktop, and Android as distinct profiles;
  one platform's evidence cannot substitute for another.

**Lifecycle and performance**

- Validation MUST remain bounded by the fixed maximum profiles, branches,
  distributions, samples, file sizes, and reason counts. It MUST not start a
  browser, emulator, packaged application, or measurement run after failed
  preflight.

**Migration and compatibility**

- The v1 profile set is append-only and MUST never be rewritten to describe a
  new environment. Any accepted contract or environment change requires a new
  profile-set version. This slice changes no application data, backup, sync, or
  provider contract.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of exact clean profile fixtures are eligible for primary
  sampling and 100% of missing, dirty, drifted, malformed, or deliberately
  non-primary fixtures are prevented from starting a primary run.
- **SC-002**: 100% of complete threshold-compliant raw-result fixtures pass and
  100% of incomplete, pooled, inconsistent, malformed, or threshold-violating
  fixtures are rejected or fail with the expected stable reason.
- **SC-003**: The aggregate passes for exactly four current primary passes and
  never passes when any approved profile is absent, duplicated, stale, failed,
  unverified, or supplemental.
- **SC-004**: Repeated validation of the same canonical evidence produces
  byte-identical machine-readable reports and identical exit status.
- **SC-005**: Every invalid-input path is bounded and completes without starting
  a measurement runtime or modifying application/library state.

## Acceptance Evidence _(mandatory)_

- Contract tests cover canonical identity, exact and mismatched preflight,
  primary/supplemental/unverified classification, hostile bounds, deterministic
  statistics, threshold decisions, raw-result validation, and four-profile
  aggregation.
- Command-line tests prove non-zero failure status, stable bounded JSON output,
  and the prohibition on primary sampling after failed preflight.
- A current local environment capture is evaluated against `desktop-web-v1` and
  recorded honestly as eligible, `UNVERIFIED`, or `SUPPLEMENTAL`; it is not a
  performance pass because measurement drivers are outside this slice.
- Browser, packaged desktop, mobile-browser emulator, Android emulator/device,
  and live provider gates are not required for this non-UI evidence-core slice.
  Their performance measurements remain explicitly `UNVERIFIED` until their
  separate drivers run on exact approved profiles.

## Assumptions

- The fixed four-profile definitions and thresholds in the existing
  multi-format performance contract remain approved and are imported without
  relaxation.
- Node v26.5.0 and the checked-in lockfile are available locally.
- Profile drivers will consume the preflight report and raw-result contract in
  later independently specified slices rather than reimplementing validation.
