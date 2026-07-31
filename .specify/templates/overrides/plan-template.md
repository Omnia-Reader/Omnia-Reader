# Implementation Plan: [FEATURE]

**Feature Directory**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Input**: Feature specification from `specs/[###-feature-name]/spec.md`

**Note**: This template is filled by `$speckit-plan`.

## Summary

[Summarize the required outcome and smallest coherent technical approach.]

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: [Existing Angular/CDK/reader/provider dependencies;
mark a justified new dependency explicitly]

**Storage**: [IndexedDB, OPFS, backup archive, provider state, filesystem, or N/A]

**Testing**: Vitest/Angular unit tests; Playwright for real-browser journeys;
[Rust/C++/container/provider gates if applicable]

**Target platforms**: [Web/PWA, Chromium, Firefox, WebKit, desktop Tauri,
Android Tauri]

**Performance goals**: [Measurable goals or N/A with rationale]

**Constraints**: Offline-first, hostile publication/sync data, accessible
interaction, bounded renderer lifecycle, locked dependencies

**Scope**: [Affected journeys, formats, providers, records, and platforms]

## Constitution Check

_GATE: Must pass before research and be re-checked after design._

- [ ] Local reading and durable writes remain authoritative offline.
- [ ] Hostile inputs and credential boundaries are identified and preserved.
- [ ] Owning Nx projects and public contracts are explicit.
- [ ] Behavioral tests precede implementation tasks; browser gates are included
      where browser behavior matters.
- [ ] Accessibility and applicable platform behavior have acceptance criteria.
- [ ] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [ ] Required and unavailable verification gates are distinguishable.
- [ ] Product exclusions remain unchanged, or the approved scope change is
      documented.

Record every exception in **Complexity and Exceptions**. An unjustified
exception blocks task generation.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: [Relevant symbols, current callers, and tests]
- **Owning project(s)**: [Nx project names]
- **Affected consumers**: [Dependent projects/public APIs]
- **Unchanged boundaries**: [Nearby systems explicitly not affected]

### Repository Paths

```text
apps/omnia-reader/                 # Angular UI and orchestration, if affected
apps/omnia-reader-e2e/             # Real-browser journeys, if affected
apps/sync-gateway/                 # Provider HTTP, credentials, sessions
libs/reader/domain/                # Format-neutral durable records/contracts
libs/reader/core/                  # Reader engine contracts and registry
libs/reader/epub/                  # EPUB runtime behavior
libs/reader/pdf/                   # PDF.js runtime behavior
libs/library/data-access/          # IndexedDB/OPFS/backup/quarantine
libs/platform/                     # Browser/Tauri host abstraction
libs/sync/core/                    # Provider-neutral synchronization
libs/sync/git/                     # Git/LFS journal and gateway client
libs/sync/mega/                    # MEGA gateway client
src-tauri/                         # Narrow privileged native commands
tools/mega-sdk-bridge/             # Native MEGA SDK sidecar
```

Delete unaffected paths from the feature plan and list the concrete files or
directories that own the change.

## Design

### Contracts and State

- [Public types, engine/provider interfaces, route/API contracts, or N/A]
- [Durable records, schema version, migrations, hashes, tombstones, or N/A]
- [Backward/forward compatibility and rollback behavior]

### User Interface and Accessibility

- [Components, states, focus movement, keyboard/touch behavior, announcements,
  responsive behavior, or N/A]

### Security and Failure Handling

- [Validation points, hostile inputs, credential boundary, CSP/sandbox impact]
- [Offline, unavailable provider, cancellation, retry, restart, and teardown]

### Lifecycle and Performance

- [Workers, listeners, object URLs, canvases, iframes, async cancellation]
- [Bundle, startup, render, storage, memory, or network measurements]

## Verification Plan

List the exact smallest-to-broadest commands required by
`.agents/skills/verify-omnia-reader/references/change-matrix.md`.

| Requirement/story  | Evidence                                 | Command or environment                                         | Required locally? |
| ------------------ | ---------------------------------------- | -------------------------------------------------------------- | ----------------- |
| [FR/US identifier] | [Focused unit/contract assertion]        | `npx nx test [project]`                                        | Yes               |
| [FR/US identifier] | [Real-browser journey]                   | `npx nx run omnia-reader-e2e:e2e -- --project=chromium [spec]` | [Yes/No]          |
| [Boundary]         | [Cross-browser/provider/native evidence] | [Exact gate]                                                   | [Yes/No]          |

Always include `git diff --check`. Include lint for each affected TypeScript
project and a production build when application, worker, asset, style,
dependency, service-worker, or bundle composition changes.

## Delivery and Documentation

- **Vertical slices**: [Order independently verifiable stories.]
- **Migration/rollout**: [Safe sequencing and recovery, or N/A.]
- **Documentation**: [Contracts or `docs/universal-reader-plan.md` updates only
  when materially required.]
- **Residual gates**: [Credentialed, packaged, emulator, device, or live-provider
  checks that cannot be run in the normal local workflow.]

## Complexity and Exceptions

> Fill only when the Constitution Check has a necessary violation.

| Violation           | Why required    | Simpler compliant alternative rejected because |
| ------------------- | --------------- | ---------------------------------------------- |
| [Constitution rule] | [Concrete need] | [Evidence-based reason]                        |
