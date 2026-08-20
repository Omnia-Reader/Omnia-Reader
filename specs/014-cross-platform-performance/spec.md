# Feature Specification: Cross-Platform Performance Drivers

**Feature Directory**: `014-cross-platform-performance`

**Created**: 2026-08-20

**Status**: Draft

**Input**: User description: "Continue the release-critical performance work by freezing the remaining platform identities and adding qualified mobile-web, packaged-desktop, and Android measurement drivers without weakening the completed desktop-web evidence contract."

## Outcome and Scope _(mandatory)_

**Outcome**: Release reviewers can run one fail-closed performance command for
each remaining first-release platform, obtain comparable evidence for the same
multi-format management workload, and clearly distinguish a qualified result
from an unavailable or mismatched environment.

**In scope**:

- Immutable qualification identities for mobile web, packaged desktop, and
  Android emulator runs.
- Separate measurement commands for the three platforms, all using the existing
  deterministic management workload, fixed sample counts, and evaluator.
- Release-artifact identity for packaged desktop and Android measurements.
- Emulator image, snapshot, browser, and WebView identity where applicable.
- Fail-closed interruption, cleanup, output confinement, and honest unavailable
  outcomes for every platform.
- Independent evidence for each platform and aggregate acceptance only after
  every required profile passes.

**Non-goals**:

- Changing the completed desktop-web driver, frozen thresholds, sample counts,
  branch matrix, workload, or evaluator semantics.
- Pooling results across platforms or substituting browser emulation for a real
  packaged application or Android runtime.
- Physical-device performance acceptance, additional operating-system profiles,
  or manual assistive-technology studies.
- Product UI, persistence, synchronization, reader-engine, or dependency changes
  made solely to improve a measurement result.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Qualify Mobile Web (Priority: P1)

A release reviewer can run the fixed mobile-web workload in the approved
emulator browser and receive primary evidence only when the emulator, snapshot,
browser, resources, battery state, and source identity all match.

**Why this priority**: Mobile web is the smallest remaining platform slice and
establishes the reusable emulator qualification boundary before packaged Android
is introduced.

**Independent test**: Run the mobile-web command against the approved emulator,
then verify exact identity, full workload cardinality, separate distributions,
and an evaluator disposition; repeat with one mismatched field and verify no
sampling starts.

**Acceptance scenarios**:

1. **Given** the exact approved mobile-web environment, **When** the reviewer
   runs the command, **Then** all required samples use the emulator browser and
   one evaluator-valid platform result is produced.
2. **Given** a missing emulator snapshot, different browser version, resource
   mismatch, or unavailable emulator, **When** the reviewer runs the command,
   **Then** it exits non-zero before sampling and reports the exact reason.
3. **Given** an interruption during setup or measurement, **When** cleanup
   completes, **Then** owned emulator connections and temporary evidence are
   released without publishing a passing result.

---

### User Story 2 - Qualify Packaged Desktop (Priority: P1)

A release reviewer can measure the exact release desktop application rather
than the development web server and tie every result to the package bytes that
were launched.

**Why this priority**: Browser evidence does not prove packaged-host startup,
runtime, or lifecycle behavior, so the release artifact needs an independent
gate.

**Independent test**: Build or select the approved release package, launch that
exact artifact, exercise the full management workload, and verify the result
contains the artifact digest and qualified host identity.

**Acceptance scenarios**:

1. **Given** an approved release package and matching host, **When** the reviewer
   runs the packaged-desktop command, **Then** the measured application digest
   matches the recorded artifact and one evaluator-valid result is produced.
2. **Given** a debug package, changed package bytes, unsupported host runtime, or
   missing automation boundary, **When** the reviewer runs the command, **Then**
   it refuses primary sampling and preserves no misleading final evidence.
3. **Given** the packaged application exits or hangs mid-run, **When** the driver
   fails, **Then** all owned application and automation processes stop within a
   bounded interval.

---

### User Story 3 - Qualify Packaged Android (Priority: P1)

A release reviewer can build, install, and measure the exact release Android
application in the approved emulator and bind the result to both application
and WebView identities.

**Why this priority**: Android combines packaged-artifact and emulator risks and
therefore follows the reusable boundaries proven by the first two stories.

**Independent test**: Install the approved release application on the pinned
emulator snapshot, exercise the complete workload through the packaged app, and
verify exact APK, WebView, emulator, and environment identity in the result.

**Acceptance scenarios**:

1. **Given** the exact release application and approved Android emulator,
   **When** the reviewer runs the command, **Then** one evaluator-valid Android
   result is bound to the installed application and WebView versions.
2. **Given** a changed APK, snapshot, WebView, resource limit, battery state, or
   device profile, **When** the reviewer runs the command, **Then** no primary
   sampling starts and the mismatch is reported.
3. **Given** installation, launch, browser connection, or measurement failure,
   **When** the run ends, **Then** temporary application state and owned
   processes are cleaned without replacing prior valid evidence.

### Edge Cases

- The emulator or packaged application becomes unavailable after preflight but
  before the first sample.
- A browser, WebView, package, or emulator snapshot changes between setup and
  sampling.
- Multiple emulator devices or packaged application instances are visible.
- A release artifact is missing, unreadable, too large, or changes while its
  digest is being established.
- A platform completes the action with the wrong book, format, association, or
  reader engine while producing plausible timing data.
- A sample times out, automation disconnects, or a child process ignores normal
  termination.
- An output name attempts traversal, overwrite, aliasing, or escape from the
  approved results directory.
- One platform passes while another is unavailable or fails.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The release evidence set MUST define immutable, independently
  versioned qualification identities for mobile web, packaged desktop, and
  Android.
- **FR-002**: Mobile-web identity MUST include the approved emulator image and
  snapshot, device class, browser version, resource limits, battery state,
  source revision, locked inputs, and workload identity.
- **FR-003**: Packaged-desktop identity MUST include the exact release artifact
  digest, host/runtime identity, resource and power constraints, source
  revision, locked inputs, and workload identity.
- **FR-004**: Android identity MUST include the exact release application
  digest, emulator image and snapshot, device class, WebView version, resource
  limits, battery state, source revision, locked inputs, and workload identity.
- **FR-005**: Every platform command MUST complete qualification before starting
  a measurement and MUST refuse sampling unless every required identity field
  is present and matches.
- **FR-006**: Every platform MUST execute the same frozen fourteen-branch
  management matrix and five unpooled final distributions without reducing
  thresholds or sample counts.
- **FR-007**: Every platform result MUST record page-observed raw timings,
  independent zero-tolerance counters, qualification identity, and artifact
  identity where applicable.
- **FR-008**: Browser emulation or a development server MUST NOT be accepted as
  packaged-desktop or Android evidence.
- **FR-009**: Each platform command MUST revalidate source, runtime, environment,
  workload, and artifact identity immediately before sampling.
- **FR-010**: Each platform command MUST pass raw results through the canonical
  evaluator and publish final evidence only for structurally valid `PASS` or
  honest threshold `FAIL` outcomes.
- **FR-011**: Unavailable, mismatched, supplemental, interrupted, crashed,
  invalid, or unevaluated runs MUST exit non-zero and MUST NOT create or replace
  primary evidence.
- **FR-012**: Each driver MUST bound diagnostics, timeouts, temporary storage,
  and sample data and MUST terminate only the browser, emulator, application,
  server, and automation processes it owns.
- **FR-013**: Final writes MUST remain atomic, bounded, and confined to one
  approved JSON filename per platform.
- **FR-014**: Aggregate performance acceptance MUST remain incomplete unless
  desktop web, mobile web, packaged desktop, and Android each independently
  produce an evaluator `PASS` for the immutable profile set.
- **FR-015**: The completed desktop-web driver and legacy large-publication gate
  MUST retain their current independent behavior and evidence meaning.

### Key Entities and Durable State _(include when data changes)_

- **Platform qualification profile**: Immutable required source, workload,
  host, runtime, resource, emulator, and artifact identity for one platform.
- **Release artifact identity**: Kind, canonical digest, build provenance, and
  platform association for the exact package being measured.
- **Emulator identity**: Image, snapshot digest, device configuration, resource
  constraints, battery state, and browser or WebView runtime.
- **Platform measurement result**: Qualified profile identity, raw action
  timings, independent counters, evaluator disposition, and artifact identity
  where applicable.
- **Aggregate release result**: Four independent primary platform dispositions;
  it never pools raw samples or converts an unavailable platform into a pass.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- After locked build and runtime inputs are available, measurement MUST require
  no provider account, credential, or synchronization service.
- Interrupted runs MUST leave repository data and prior valid evidence
  unchanged and MUST start subsequent runs from deterministic disposable state.

**Security and trust**

- Profiles, artifacts, publications, backups, emulator metadata, runtime
  responses, and raw results MUST be treated as hostile and validated before
  use.
- Drivers MUST NOT weaken publication sandboxing, navigation mediation,
  archive validation, native capability confinement, or credential boundaries.

**Accessibility and interaction**

- Timed actions MUST use the same labelled and keyboard- or touch-operable
  controls, visible status, and error states available to users.
- Instrumentation MUST NOT change focus order, accessible names,
  announcements, touch targets, or platform back behavior.

**Platform and compatibility**

- Mobile web MUST run in the approved emulator browser; packaged desktop and
  Android MUST run the exact release application for their profile.
- Physical-device performance and additional desktop operating systems remain
  explicit future gates and MUST NOT be inferred from these results.

**Lifecycle and performance**

- Every action MUST use bounded timeouts and the existing fixed thresholds,
  warm-ups, sample counts, and page-visible timing boundaries.
- Drivers MUST release owned pages, contexts, connections, application
  processes, emulator processes, temporary files, and listeners on success,
  failure, signal, and timeout.

**Migration and compatibility**

- Existing profile and evidence semantics remain immutable; resolving a missing
  identity field may complete the current profile only when it records the
  already-approved artifact or snapshot, while semantic changes require a new
  version.
- No application persistence, backup, or synchronization schema changes are
  permitted in this feature.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Each of the three new platform commands rejects 100% of fixtures
  with one missing, changed, duplicated, or mismatched identity field before
  the first measured action.
- **SC-002**: On each exactly qualified platform, one run records at least 280
  acknowledgement samples, exactly 100 discarded warm-ups, at least 1,000
  unpooled final samples, and all four independent zero-tolerance counters.
- **SC-003**: In 100% of injected crash, timeout, signal, disconnect, invalid
  result, changed artifact, and unapproved-output cases, the run exits non-zero,
  terminates owned resources, and publishes no new primary evidence.
- **SC-004**: Packaged-desktop and Android results identify the exact measured
  artifact bytes, and mobile-web and Android results identify the exact emulator
  snapshot and browser or WebView runtime.
- **SC-005**: Aggregate performance acceptance reports `PASS` only when all four
  immutable platform profiles independently pass; every other combination
  remains non-passing without pooling samples.
- **SC-006**: The existing desktop-web and legacy lifecycle gates retain their
  established commands, result meaning, and passing contract tests.

## Acceptance Evidence _(mandatory)_

- Contract tests for exact profile fields, artifact and snapshot identity,
  missing/mismatched values, qualification precedence, sample cardinality,
  evaluator mapping, output confinement, cleanup, and aggregate status.
- Reduced non-primary platform smoke where available, clearly separated from
  full-cardinality primary evidence.
- One exact qualified run for mobile web, packaged desktop, and Android, or an
  explicit `UNVERIFIED` result naming every unavailable environment gate.
- Production package build and digest evidence for packaged desktop and Android.
- Browser/emulator/application automation evidence proving the measured runtime
  is the qualified runtime rather than a substitute.
- Existing desktop-web contracts, E2E lint, relevant native checks, formatting,
  and whitespace gates.
- Physical-device, additional desktop operating-system, and manual
  assistive-technology gates remain explicitly unverified in this feature.

## Assumptions

- The frozen management workload, branch matrix, sample counts, thresholds,
  raw-result schema, evaluator, and desktop-web implementation remain unchanged.
- Approved emulator images and release toolchains are installed or can be
  reported unavailable without weakening the contract.
- Missing mobile browser, WebView, or snapshot digest values are filled only
  from reviewed real artifacts; placeholder or invented identities are invalid.
- Platform automation may use different host mechanisms while preserving one
  observable product and evidence contract.
