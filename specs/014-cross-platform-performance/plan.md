# Implementation Plan: Cross-Platform Performance Drivers

**Feature Directory**: `014-cross-platform-performance` | **Date**: 2026-08-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-cross-platform-performance/spec.md`

## Summary

Generalize the existing evidence contract into a backward-compatible versioned
profile registry and a platform-neutral qualified-process lifecycle. Add
contract-tested, fail-closed driver foundations in three independent slices:
mobile web through a disposable pinned AVD and Chrome CDP; Linux packaged
desktop through external `tauri-driver` against an unmodified verified release
artifact; and packaged Android through a separate, profile-bound test
instrumentation APK against an exact non-debuggable release APK. No platform
may sample until its live identity is complete, and unavailable automation or
host artifacts remain `UNVERIFIED` rather than becoming substitute evidence.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23; Tauri 2; Android SDK
36/NDK 29 where Android qualification is available

**Primary dependencies**: Existing Node standard library, Playwright 1.61.1,
Tauri CLI/driver, Android SDK platform/emulator tools, and repository fixture
builders; no new npm dependency without a separately documented need

**Storage**: Immutable JSON profiles, bounded JSON evidence, release artifact
and provenance files, and disposable AVD/application state; no product durable
schema change

**Testing**: Node contract tests, reduced Chromium smoke, external Tauri
WebDriver spike, Android instrumentation contract tests, existing performance
evidence suite, E2E lint, production builds, and exact qualified runs only on
matching hosts

**Target platforms**: Existing desktop-web Chromium unchanged; Android-emulator
Chrome mobile web; Linux packaged Tauri desktop; x86_64 packaged Tauri Android

**Performance goals**: Preserve the frozen fourteen branches, at least 20
acknowledgements per branch, five separate distributions, exactly 20 discarded
warm-ups and at least 200 final samples per distribution, existing thresholds,
and all four zero-tolerance counters for every platform

**Constraints**: Exact clean source and lock identity, immutable versioned
profiles, exact release bytes, page-observed timings, finite host constraints,
bounded hostile input, ownership-scoped teardown, no evidence overwrite, no
debug or emulated substitute for packaged evidence

**Scope**: `omnia-reader-e2e` performance contracts, platform controllers and
drivers, Nx targets, immutable profiles/provenance contracts, focused release
workflow output, and Spec Kit/release-gate documentation; product UI, reader,
persistence, synchronization, and provider behavior remain unchanged

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

No exception is required. Platform automation is test infrastructure outside
the production webview capability surface. The plan deliberately blocks
packaged evidence when external or instrumentation automation cannot prove the
unmodified release artifact.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `assertProfileSet`, `assertEnvironmentRecord`,
  `atomicWriteEvidence`, `evaluatePreflight`, `runPrimaryManagementMeasurement`,
  `runDesktopWebCli`, and the existing management page drivers/evaluator.
- **Owning project(s)**: `omnia-reader-e2e`; narrow release provenance output in
  repository release tooling/workflow; Tauri/Android test-only integration only
  if the exact-artifact spikes succeed.
- **Affected consumers**: existing desktop driver/evidence tests, new platform
  Nx targets, aggregate evaluation, and release reviewers.
- **Unchanged boundaries**: Angular product code, reader engines, IndexedDB/OPFS
  and backup schemas, synchronization, provider credentials, production Tauri
  capabilities, frozen v1 semantics, and the legacy large-publication gate.

### Repository Paths

```text
apps/omnia-reader-e2e/performance/          # versioned contracts, lifecycle, controllers, drivers, Node tests
apps/omnia-reader-e2e/src/                  # shared page workload and reduced platform smoke
apps/omnia-reader-e2e/project.json          # explicit opt-in platform targets
tools/release/                              # native artifact provenance when required
.github/workflows/verify.yml                # bounded package + provenance artifacts
specs/001-multi-format-books/performance/   # immutable profile versions and primary results
specs/014-cross-platform-performance/       # feature design, tasks, and validation guide
docs/universal-reader-plan.md               # verified release-gate status only
```

## Design

### Contracts and State

- Replace the v1-only assertion with an allowlisted profile-set registry. It
  validates v1 exactly as today and recognizes v2 only through a separate
  schema descriptor; it never reinterprets a v1 file.
- `profiles-v2.json` is created only from reviewed real identities. Unresolved
  platform values remain absent from primary qualification and are never filled
  with placeholder digests.
- A platform-neutral lifecycle owns qualification, identity recapture,
  measurement child execution, canonical evaluation, bounded diagnostics,
  signal handling, cleanup, and no-replace promotion. Platform adapters own
  only artifact/runtime discovery and automation transport.
- Artifact provenance records exact size/digest, source/lock digests, package
  identity, target, release mode, toolchain, and signer where applicable.
- No application durable records or migrations change. All AVD, installed app,
  browser session, raw result, and extraction state is disposable.

### User Interface and Accessibility

- Drivers reuse the same labelled product controls and page timing protocol;
  they do not call Angular component internals or alter names, focus order,
  announcements, touch targets, or Android back behavior.
- Mobile web uses the real emulator viewport/density and Chrome runtime, not
  Playwright device emulation. Packaged drivers operate the release application,
  not the development server.
- Reduced smoke proves orchestration only and is marked supplemental; it cannot
  meet or publish primary cardinality.

### Security and Failure Handling

- JSON, AVD trees, package archives, tool output, CDP/WebDriver responses, APK
  metadata, provenance, and raw results are bounded and validated as hostile.
- A reviewed AVD is copied to an exclusive temporary `ANDROID_AVD_HOME`, hashed,
  launched with an exact serial and `-no-snapshot-save`, and removed afterward.
- Mobile Chrome package/APK and CDP identities must agree. Guest external
  networking is disabled after boot to prevent runtime update drift.
- Desktop packages are copied through a regular-file boundary, hashed, safely
  extracted when needed, and revalidated immediately before launching the
  owned copy. The production embedded WebDriver feature remains disabled.
- Android rejects debug/unsigned/wrong-ABI APKs and proves installed `base.apk`
  bytes. A separate bounded test APK may drive the release app; unrestricted
  release WebView debugging is forbidden.
- Drivers select exact PIDs/serials/endpoints, never first-match resources, and
  never use broad `pkill`, `adb kill-server`, or user-owned AVD deletion.
- Final evidence uses unique approved names and no-replace atomic promotion.
  Every mismatch, crash, disconnect, signal, timeout, or invalid result removes
  only owned temporary state and preserves prior evidence.

### Lifecycle and Performance

- The lifecycle state machine is `CREATED -> QUALIFIED -> LAUNCHED ->
REVALIDATED -> SAMPLING -> EVALUATED -> PROMOTED`, with every pre-promotion
  state able to transition to `ABORTED` and deterministic cleanup.
- Driver, production server, emulator/application, browser/webview, and
  measurement children must share or independently prove the finite constraint
  scope. Guest core/RAM flags alone are not host resource limits.
- All logs, screenshots, dumps, file counts/sizes, JSON arrays, waits, retries,
  and termination grace intervals are bounded.
- Dataset setup and warm-ups remain outside final samples; platform adapters do
  not duplicate or alter workload semantics.

## Verification Plan

| Requirement/story           | Evidence                                                               | Command or environment                                                                                 | Required locally?              |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------ |
| FR-001, FR-014-FR-015       | v1 compatibility, v2 registry, aggregate and no-replace tests          | `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`                                | Yes                            |
| FR-005, FR-009-FR-013 / all | lifecycle, drift, interruption, ownership, and output contract tests   | `node --test apps/omnia-reader-e2e/performance/*platform*.spec.mjs`                                    | Yes                            |
| US1 / mobile web            | disposable AVD/serial/Chrome-CDP qualification tests and reduced smoke | `npx nx run omnia-reader-e2e:performance-mobile-web-smoke --skip-nx-cache`                             | When approved AVD exists       |
| US2 / packaged desktop      | external WebDriver attaches to exact unmodified release artifact       | `npx nx run omnia-reader-e2e:performance-packaged-desktop-smoke --skip-nx-cache`                       | Linux release host only        |
| US3 / Android               | release APK + test APK instrumentation, installed-byte/WebView checks  | `npx nx run omnia-reader-e2e:performance-android-smoke --skip-nx-cache`                                | Approved AVD/toolchain only    |
| FR-006-FR-010 / each        | exact full-cardinality primary platform result                         | `npx nx run omnia-reader-e2e:performance-<platform> --skip-nx-cache`                                   | Exact matching profile only    |
| SC-006                      | existing desktop contracts and branch smoke                            | `npx nx run omnia-reader-e2e:performance-management-branch-smoke --skip-nx-cache`                      | Yes                            |
| Project quality             | E2E lint and production web build                                      | `npx nx lint omnia-reader-e2e --skip-nx-cache`; `npx nx build omnia-reader --configuration production` | Yes when source/target changes |
| Formatting                  | whitespace validation                                                  | `git diff --check`                                                                                     | Yes                            |

## Delivery and Documentation

- **Vertical slices**: versioned profile/lifecycle foundation; mobile-web
  qualification; exact packaged-desktop spike/driver; exact packaged-Android
  spike/driver; four-platform aggregation.
- **Migration/rollout**: additive opt-in targets and profiles. Existing v1
  commands/results remain byte-for-byte meaningful. Each platform may land with
  fixture tests and an honest `UNVERIFIED` live outcome before its frozen host
  identity becomes available.
- **Documentation**: maintain platform contract/quickstart and update
  `docs/universal-reader-plan.md` only after verified gate status changes.
- **Residual gates**: approved AVD snapshot creation, exact Chrome/WebView
  versions, signed release artifact provenance, host cgroups/power state,
  packaged runs on additional operating systems, and physical-device evidence.

## Complexity and Exceptions

No Constitution violation or architectural exception is required.
