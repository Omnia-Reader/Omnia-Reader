# Implementation Plan: Fail-Closed Performance Evidence Core

**Feature Directory**: `012-performance-evidence-core` | **Date**: 2026-08-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from
`specs/012-performance-evidence-core/spec.md`

## Summary

Add a dependency-free Node evidence core under the existing
`omnia-reader-e2e` project. One immutable JSON profile set carries the four
approved environment identities and fixed measurement contract. Shared strict
parsers, canonical hashing, preflight evaluation, raw-result evaluation, and
four-profile aggregation expose importable functions plus narrow CLI entry
points. Test fixtures prove fail-closed classification, recomputed statistics,
hostile-input bounds, deterministic output, and aggregate completeness before
later browser/native drivers consume the contract.

## Technical Context

**Runtime**: Node v26.5.0; ECMAScript modules; Nx 23

**Primary dependencies**: Node standard library only (`node:crypto`,
`node:fs`, `node:os`, `node:path`, `node:process`, `node:child_process`)

**Storage**: Checked-in immutable profile JSON; bounded raw/aggregate JSON
evidence under `specs/001-multi-format-books/performance/results/`

**Testing**: Node test runner contract and CLI tests; ESLint for the
`omnia-reader-e2e` project

**Target platforms**: The evidence core runs on the repository Node runtime and
represents desktop web, mobile web, packaged desktop, and Android separately.
No browser, WebView, Tauri package, emulator, or device is launched in this
slice.

**Performance goals**: Validate at most four profiles, fourteen acknowledgement
branches, five final distributions, 10,000 timings per collection, and 8 MiB
per input document without unbounded recursion, reason accumulation, or output.

**Constraints**: Offline, deterministic, no new dependency, hostile JSON,
fail-closed classifications, canonical profile identity, no measurement start
after failed preflight, and no cross-profile pooling

**Scope**: Evidence contracts and tooling only. Application UI, reader engines,
library data, synchronization, backup, provider, native commands, dependencies,
and bundle composition remain unchanged.

## Constitution Check

_GATE: Passed before research and re-checked after design._

- [x] Local reading and durable writes remain authoritative offline. The slice
      does not read or mutate application/library state.
- [x] Hostile inputs and credential boundaries are identified and preserved.
      All JSON is bounded and validated; no credentials or network calls exist.
- [x] Owning Nx projects and public contracts are explicit. Tooling belongs to
      `omnia-reader-e2e`; evidence artifacts remain under the owning spec.
- [x] Behavioral tests precede implementation tasks. Browser gates are not
      applicable because the slice starts no browser and changes no UI/runtime.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
      Plain-text/JSON reports are non-color-dependent; platforms remain distinct.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged.

No exception is required. The post-design check also passes: contracts retain
the fixed profile/threshold scope, do not weaken any release gate, and do not
change application behavior.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: New `readProfileSet`, `evaluatePreflight`,
  `evaluateRawResult`, and `aggregateResults` functions plus their CLI wrappers.
  CodeGraph found no existing implementation or caller; the existing
  `omnia-reader-e2e:performance` target and `performance.spec.ts` remain
  unchanged consumers until a later driver slice.
- **Owning project**: `omnia-reader-e2e`
- **Affected consumers**: Future desktop-web/mobile-web/packaged-desktop/Android
  performance drivers and release reviewers using checked-in evidence.
- **Unchanged boundaries**: Angular application, EPUB/PDF engines, IndexedDB,
  OPFS, backup, synchronization, gateways, providers, Tauri, Android packages,
  service worker, and production bundle.

### Repository Paths

```text
apps/omnia-reader-e2e/performance/                  # Evidence modules, CLIs, tests
apps/omnia-reader-e2e/project.json                  # Focused evidence-test target
specs/001-multi-format-books/performance/           # Immutable v1 profile + results
specs/012-performance-evidence-core/                # Intent, design, tasks, evidence
```

## Design

### Contracts and State

- `profiles-v1.json` contains schema/profile-set version, fixed measurement
  contract, deterministic dataset recipe identity, and exactly four profiles.
- Canonical identity sorts object keys recursively, preserves array order, and
  hashes UTF-8 JSON with the top-level claimed digest omitted. Reordering object
  keys is identity-neutral; changing any value or array order is not.
- Structural parsing and semantic evaluation are separate. Malformed/unbounded
  documents are invalid and produce no disposition. Structurally valid
  environment absence yields `UNVERIFIED`; intentional non-primary context
  yields `SUPPLEMENTAL`; exact clean qualification yields sampling eligibility.
- Raw results retain unpooled branch/distribution arrays. Statistics are
  recomputed with sorted finite millisecond samples, conventional median, and
  nearest-rank p95 (`ceil(0.95 × count) - 1`). Producer summaries must match.
- Results are durable evidence only when complete JSON is atomically written
  beneath the fixed results root. Temporary files use exclusive creation and
  rename; traversal and symlink escapes are rejected.
- No application schema, backup, synchronization, or migration changes.

### User Interface and Accessibility

- No application UI changes. CLIs write one bounded canonical JSON document to
  stdout and concise error explanations to stderr. Meaning never depends on
  ANSI color or terminal interactivity.

### Security and Failure Handling

- Reject documents over 8 MiB, recursion deeper than 32, unknown object keys,
  strings over their contract bounds, unsafe integers, non-finite/negative
  timings, unknown/duplicate profile/action keys, excessive samples/reasons,
  and inconsistent claimed statistics or digests.
- CLI arguments are parsed as data; evidence content is never evaluated,
  interpolated into a shell, or used as an unrestricted path.
- Invalid input exits non-zero. `FAIL`, `UNVERIFIED`, `SUPPLEMENTAL`, or an
  incomplete aggregate also exit non-zero for acceptance-oriented commands,
  while still emitting their bounded report.
- Current-environment capture uses non-shell Git/OS/runtime probes. Missing
  probes become explicit mismatches; they never authorize primary sampling.

### Lifecycle and Performance

- Parsers allocate only within fixed profile, branch, distribution, sample,
  string, reason, and document bounds.
- Validation starts no browser, worker, WebView, emulator, package, server, or
  network request. No application bundle or runtime dependency changes.
- Canonical serialization is deterministic and ends with one newline for
  byte-identical repeated reports.

## Verification Plan

| Requirement/story     | Evidence                                                                                   | Command or environment                                                                                                                 | Required locally?       |
| --------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| US1 / FR-001–FR-005   | Profile identity, bounds, exact/mismatch/unavailable/supplemental preflight contract tests | `node --test apps/omnia-reader-e2e/performance/validate-profile.spec.mjs`                                                              | Yes                     |
| US2 / FR-006–FR-009   | Complete/incomplete/hostile raw-result tests and deterministic recomputed statistics       | `node --test apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`                                                          | Yes                     |
| US3 / FR-010–FR-012   | Four-profile aggregate completeness and CLI status tests                                   | `node --test apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`                                                          | Yes                     |
| Nx ownership          | Focused project target                                                                     | `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`                                                                | Yes                     |
| Static quality        | JavaScript/JSON/docs lint and formatting                                                   | `npx nx lint omnia-reader-e2e --skip-nx-cache`                                                                                         | Yes                     |
| Current environment   | Honest desktop profile preflight without a measurement claim                               | `node apps/omnia-reader-e2e/performance/validate-profile.mjs specs/001-multi-format-books/performance/profiles-v1.json desktop-web-v1` | Yes                     |
| Repository            | Whitespace and focused diff review                                                         | `git diff --check`                                                                                                                     | Yes                     |
| Browser/native/device | Measurement drivers and exact platform evidence                                            | Later independent features                                                                                                             | No; remain `UNVERIFIED` |

A production application build and Playwright are not required because no app,
asset, service worker, dependency, browser behavior, or bundle composition
changes.

## Delivery and Documentation

- **Vertical slices**: (1) canonical profile/preflight; (2) raw evidence and
  statistics; (3) aggregation/CLI/atomic output.
- **Migration/rollout**: Additive tooling. Drivers adopt the importable contract
  later. Rollback removes tooling and profile v1 without data migration.
- **Documentation**: Update feature 001 evidence contract/tasks only to point at
  verified delivered tooling; update `docs/universal-reader-plan.md` only after
  the release-gate foundation passes.
- **Residual gates**: Actual desktop-web, mobile-web, packaged desktop, Android,
  emulator/device, and constrained-host measurements remain `UNVERIFIED`.

## Complexity and Exceptions

No constitution exception.
