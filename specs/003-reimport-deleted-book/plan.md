# Implementation Plan: Re-import Deleted Books

**Feature Directory**: `003-reimport-deleted-book` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-reimport-deleted-book/spec.md`

## Summary

Prevent logical variant deletion from racing with the legacy book synchronizer by updating device-local exclusions around the atomic repository mutation. Make exact-edition import recover a valid physical publication record that has no logical owner, and classify duplicates from visible logical membership rather than raw retained metadata.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing Angular dependency injection, reader-domain library contracts, synchronization core exclusions, and sync operation journal; no new dependency

**Storage**: Existing IndexedDB book/logical-book stores, OPFS or IndexedDB publication bytes, and localStorage-backed device exclusions; no schema change

**Testing**: Vitest/Angular unit tests for repository and application services

**Target platforms**: Shared web/PWA and desktop/Android Tauri application code

**Performance goals**: One logical-library snapshot per import batch; no duplicate binary write for a retained healthy publication

**Constraints**: Offline-first local deletion, exact-edition SHA-256 identity, hostile publication validation, deterministic deletion intent, locked dependencies

**Scope**: EPUB/PDF import, logical variant deletion, device-local legacy book-sync exclusions, orphaned physical record recovery

## Constitution Check

_GATE: Passed before research and re-checked after design._

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged, or the approved scope change is documented.

No constitution exceptions are required.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `BrowserLibraryRepository.importBook`, `PublicationImportService.importPublications`, `PublicationAssociationService.addFormat`, `PublicationAssociationService.deleteVariant`; callers remain the library page and existing dependency-injection providers.
- **Owning project(s)**: `library-data-access` for membership repair; `omnia-reader` for import classification and deletion/sync orchestration.
- **Affected consumers**: Existing `LibraryRepository` consumers observe only repaired logical membership; no public method or durable type changes.
- **Unchanged boundaries**: Reader engines, provider transports, gateway credentials, remote paths, logical merge rules, backup format, and database schema.

### Repository Paths

```text
apps/omnia-reader/src/app/features/library/    # import and association orchestration plus focused tests
libs/library/data-access/src/lib/              # retained-record membership repair plus repository test
libs/sync/core/                                # existing exclusion contract consumed without modification
```

## Design

### Contracts and State

- `LibraryRepository` public signatures remain unchanged.
- When `importBook` finds an existing exact-edition record, it repairs missing singleton logical membership after ensuring usable publication bytes; an existing owner is preserved.
- Import duplicate classification uses the logical-library snapshot present before the batch. An ownerless exact edition is therefore an addition and emits the existing bootstrap logical change after validation.
- Deletion records device-local exclusions before invoking the repository mutation and restores only newly introduced exclusions if that mutation fails. The committed mutation's created/deleted variant IDs reconcile exclusions before journaling.
- No database version, record schema, synchronized path, or backup migration changes.

### User Interface and Accessibility

- No template, focus, control, or navigation changes.
- Existing live status text reports the recovered edition as added; truly visible exact editions remain duplicates.

### Security and Failure Handling

- Existing file fingerprint, format, size, enrichment, and renderer validation remain authoritative.
- A failed validation rolls back a newly created or repaired invisible membership through existing repository cleanup, while a visible duplicate is never removed.
- Local mutations remain committed when journaling is unavailable; the existing `syncPending` result remains authoritative.

### Lifecycle and Performance

- No new worker, listener, stream, object URL, or lifecycle resource.
- One `listLogicalBooks` read replaces raw-book membership inference for each import batch.
- Retained valid publication bytes are reused rather than rewritten.

## Verification Plan

| Requirement/story            | Evidence                                                                                     | Command or environment                                                                           | Required locally? |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------- |
| FR-001, FR-002, FR-007 / US1 | Ownerless retained record is repaired and counted as added; visible record remains duplicate | `npx nx test library-data-access --skip-nx-cache` and `npx nx test omnia-reader --skip-nx-cache` | Yes               |
| FR-003, FR-004 / US2         | Exclusion precedes deletion and rolls back on failure                                        | `npx nx test omnia-reader --skip-nx-cache`                                                       | Yes               |
| FR-005, FR-006 / US1-US2     | Successful creation re-includes; journal failure preserves local outcome                     | `npx nx test omnia-reader --skip-nx-cache`                                                       | Yes               |
| TypeScript boundaries        | Application and library lint                                                                 | `npx nx lint library-data-access --skip-nx-cache` and `npx nx lint omnia-reader --skip-nx-cache` | Yes               |
| Production integration       | Application compiles and bundle budgets hold                                                 | `npx nx build omnia-reader --configuration production --skip-nx-cache`                           | Yes               |
| Formatting                   | No whitespace errors                                                                         | `git diff --check`                                                                               | Yes               |
| Browser/provider/native      | No changed interaction, provider, or native contract                                         | Existing release gates                                                                           | No                |

## Delivery and Documentation

- **Vertical slices**: First repair and classify retained ownerless records; then prevent future resurrection and reconcile exclusions for logical mutations.
- **Migration/rollout**: Lazy repair occurs only when the user imports an affected exact edition; no startup scan or schema migration.
- **Documentation**: Feature artifacts and colocated tests are sufficient; product scope and architecture do not change.
- **Residual gates**: Live provider synchronization is not required for this deterministic local regression and remains an existing release gate.

## Complexity and Exceptions

No exceptions.
