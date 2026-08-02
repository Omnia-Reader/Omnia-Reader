# Implementation Plan: Draggable Book Progress

**Feature Directory**: `009-draggable-book-progress` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

## Summary

Extend the existing reader progress UI so native range input queues sequential latest-value-wins seeks during dragging, explicit rail clicks map to arbitrary in-between percentages, and chapter-filtered milestone derivation is replaced by a dedicated Beginning target plus all authored top-level TOC entries. Keep the shared engine contract and durable state unchanged.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing Angular component/runtime and reader engine APIs; no new dependency

**Storage**: Existing IndexedDB progress persistence, unchanged

**Testing**: Angular/Vitest component tests; Playwright real-browser EPUB journey

**Target platforms**: Web/PWA, Chromium, Firefox, WebKit, desktop and Android Tauri webviews

**Performance goals**: At most one renderer seek in flight and one latest pending percentage regardless of input event count

**Constraints**: Offline-first, hostile publication labels/locators, accessible native slider and buttons, bounded renderer lifecycle, locked dependencies

**Scope**: Reader-page progress orchestration and EPUB-focused browser evidence; EPUB/PDF engine implementations and public contracts remain unchanged

## Constitution Check

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged.

Post-design re-check: all gates remain satisfied; no exception is required.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `ReaderPageComponent.onProgressSliderInput`, `onProgressSliderClick`, `seekToProgress`, `seekToProgressPercent`, `deriveChapterProgressMilestones`, `findProgressMilestoneForCurrentPage`; current engine capability is `ReaderEngine.goToProgression`.
- **Owning project(s)**: `omnia-reader` for orchestration/UI; `omnia-reader-e2e` for browser evidence.
- **Affected consumers**: reader-page component template/spec and EPUB fixture journey. The EPUB engine is exercised but its code and public API do not change.
- **Unchanged boundaries**: reader domain/core APIs, EPUB/PDF engine internals, persistence, sync, backup, gateway, and native hosts.

### Repository Paths

```text
apps/omnia-reader/src/app/features/reader/reader-page.component.ts
apps/omnia-reader/src/app/features/reader/reader-page.component.html
apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts
apps/omnia-reader-e2e/src/example.spec.ts
specs/009-draggable-book-progress/
```

## Design

### Contracts and State

- `ReaderProgressMilestone` becomes an internal discriminated target: Beginning uses progression 0; authored sections retain exact TOC locators.
- Slider input writes the latest requested percent into ephemeral component state. A single drain promise executes seeks sequentially and replaces any older pending value.
- A primary-pointer click on the slider maps the pointer coordinate through the same thumb-aware rail geometry used by milestones, then enters the existing seek queue. Keyboard-synthesized clicks remain owned by the native range behavior.
- No durable records, schemas, public interfaces, migrations, hashes, or tombstones change.

### User Interface and Accessibility

- Keep the native `range` control, its `Book progress` label, percentage value text, focus, arrow-key behavior, pointer behavior, and touch behavior.
- Do not disable the slider during its own queued seek; keep it disabled during loading or an unrelated navigation.
- Keep milestones as labelled buttons. Beginning is the first item; authored top-level entries follow in authored order, including unnumbered labels.

### Security and Failure Handling

- Labels remain escaped by Angular binding; locators continue through existing engine validation and sandbox boundaries.
- A rejected seek uses the existing navigation error. The drain releases busy state and permits retry.
- Pending percentages are cleared during teardown; no new seek begins after destruction.

### Lifecycle and Performance

- The queue retains constant state: one active renderer promise plus one number. Intermediate pending values are overwritten.
- No listener, worker, object URL, canvas, iframe, dependency, or bundle entry is added.

## Verification Plan

| Requirement/story                 | Evidence                                                                                          | Command or environment                                                                                                                                                                                                                                              | Required locally? |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| FR-001 to FR-003 and FR-009 / US1 | Component test for live, sequential, latest-value seeking, direct rail clicks, and enabled slider | `npx nx test omnia-reader --skip-nx-cache`                                                                                                                                                                                                                          | Yes               |
| FR-004 to FR-008 / US2            | Component tests for Beginning plus all top-level entries and target routing                       | `npx nx test omnia-reader --skip-nx-cache`                                                                                                                                                                                                                          | Yes               |
| US1 and US2                       | Real EPUB rendering, live input, in-between clicks, Beginning, Preface, chapters                  | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 --grep "scrubs and exposes every top-level milestone" apps/omnia-reader-e2e/src/example.spec.ts` | Yes               |
| Compatibility                     | Same focused journey                                                                              | Firefox and WebKit projects                                                                                                                                                                                                                                         | When available    |
| App quality                       | Affected lint                                                                                     | `npx nx lint omnia-reader --skip-nx-cache` and `npx nx lint omnia-reader-e2e --skip-nx-cache`                                                                                                                                                                       | Yes               |
| Bundle gate                       | Production application build                                                                      | `npx nx build omnia-reader --configuration production --skip-nx-cache`                                                                                                                                                                                              | Yes               |
| Formatting                        | Whitespace/conflict check                                                                         | `git diff --check`                                                                                                                                                                                                                                                  | Yes               |

## Delivery and Documentation

- **Vertical slices**: continuous scrubbing first; structural milestones second; reconcile and validate together.
- **Migration/rollout**: N/A; internal ephemeral UI behavior only.
- **Documentation**: feature artifacts only; product scope and architecture do not change, so `docs/universal-reader-plan.md` remains unchanged.
- **Residual gates**: packaged Tauri, Android emulator, and physical-device testing are not required for the web-only implementation; Firefox/WebKit results are reported if local browser binaries permit them.

## Complexity and Exceptions

No constitution exceptions.
