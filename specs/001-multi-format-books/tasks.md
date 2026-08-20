---
description: 'Executable, test-first task list for multi-format books'
---

# Tasks: Multi-Format Books

**Input**: Design documents from `specs/001-multi-format-books/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/`, `quickstart.md`, `checklists/review.md`,
`checklists/accessibility.md`, `checklists/health-performance.md`, and
`checklists/badge-ux.md`

**Tests**: Required. The specification, constitution, and acceptance-evidence
section require focused failing tests before every behavioral implementation,
plus browser, persistence, migration, synchronization, accessibility, recovery,
and compatibility evidence.

**Organization**: Shared identity and persistence foundations precede three
independently testable user stories. User Story 3 owns the cross-device
preferred-format and membership-reconciliation outcomes. Backup and final
acceptance follow after every durable state kind is defined.

The badge-only card refinement was accepted after the original implementation
tasks had started. Completed task T027 records the earlier explicit-button
baseline only; Phase 7 and the revised open story tasks supersede that card UI
for FR-022, FR-023, and SC-007.

## Format: `[ID] [P?] [Story?] Description`

- Start every task with `- [ ] TNNN`.
- Add `[P]` only when it touches different files and has no incomplete dependency.
- Add `[US1]`, `[US2]`, or `[US3]` to every user-story task.
- Keep failing tests before the implementation they constrain.
- Record exact command evidence and unavailable environment gates in this file.

## Phase 1: Governance, Impact, and Analysis

**Purpose**: Resolve the formal requirements-review gate, reconcile generated
artifacts, and confirm the current code blast radius before source changes.

- [x] T001 Complete every item in `specs/001-multi-format-books/checklists/review.md`, `specs/001-multi-format-books/checklists/accessibility.md`, and `specs/001-multi-format-books/checklists/health-performance.md`, recording findings inline and reconciling failures in `specs/001-multi-format-books/spec.md`, `specs/001-multi-format-books/plan.md`, `specs/001-multi-format-books/data-model.md`, and `specs/001-multi-format-books/contracts/`
- [x] T002 Run `$speckit-analyze` across `specs/001-multi-format-books/spec.md`, `specs/001-multi-format-books/plan.md`, and `specs/001-multi-format-books/tasks.md`, resolving every critical cross-artifact finding before source changes
- [x] T003 Re-run CodeGraph impact queries for `BookRecord`, `LibraryRepository`, `BrowserLibraryRepository`, `LibraryBackupService`, `BookSyncService`, `LibrarySyncManifestService`, `LibraryPageComponent`, `ReaderPageComponent`, `SettingsPageComponent`, and `SyncSettingsPageComponent`, then update evidence anchors in `specs/001-multi-format-books/plan.md`

**Phase 1 evidence (2026-07-31)**: `$speckit-analyze` reported 27/27
requirements covered by 112 sequential tasks, with zero critical/high,
ambiguity, duplication, or constitution findings. CodeGraph refreshed all T003
definitions and call paths; the resulting current line anchors are recorded in
`plan.md`. This evidence predates FR-022, FR-023, SC-007, and the Phase 7 badge
refinement; T087 and T088 provide the renewed requirements and analysis gates.

**Checkpoint**: Requirements quality, traceability, ownership, and current blast
radius are accepted.

---

## Phase 2: Foundational Logical Identity and Persistence

**Purpose**: Add the format-neutral aggregate, synchronized preference register,
durable reconciliation records, and restart-safe singleton migration. This phase
blocks every user story.

### Tests for Foundational Behavior

- [x] T004 [P] Add failing logical-book ID, membership-cardinality, preferred-format register, reconciliation-record, mutation-result, canonical `VariantAvailability` status/cause discriminant, and logical-change validation tests in `libs/reader/domain/src/lib/logical-book.spec.ts` and `libs/reader/domain/src/lib/publication-record-validation.spec.ts`
- [x] T005 [P] Add a failing real IndexedDB v8→v9 migration fixture covering singleton logical books, covers, preference/reconciliation stores, no synthesized legacy preference, unchanged variant-state keys, idempotent reopen, abort/retry, and malformed-record quarantine in `libs/library/data-access/src/lib/browser-library-repository.migration.spec.ts`
- [x] T006 [P] Add failing lightweight and authoritative availability tests for `checking`, each `unavailable` cause, each `quarantined` cause, same-size digest mismatch, detected-format mismatch, malformed active references, historical quarantine, exact-source replacement, no-healthy-member, and cover-state exclusion in `libs/library/data-access/src/lib/browser-library-repository.spec.ts` and `libs/library/data-access/src/lib/publication-binary-storage.spec.ts`
- [x] T007 Add failing standalone import and synchronized-variant storage tests proving each exact variant receives one deterministic singleton aggregate without rewriting variant-keyed state in `libs/library/data-access/src/lib/browser-library-repository.spec.ts`

### Foundational Implementation

- [x] T008 Define `LogicalBookId`, `LogicalBookRecord`, `LogicalBookFormatPreference`, `MembershipReconciliation`, `LogicalBookMutationResult`, device-local `VariantAvailability` status/cause, causal-head, conflict-ID, and logical-ID types without adding health to durable records in `libs/reader/domain/src/lib/logical-book.ts`
- [x] T009 Extend `LibraryRepository` with logical reads, `resolveVariantAvailability()`, `openHealthyVariant()`, local `replaceVariantSource()`, preference and reconciliation operations, atomic mutations, consistent snapshot revisions, and `logical-book-change` journal support without provider/network authority in `libs/reader/domain/src/lib/publication.ts`
- [x] T010 Implement bounded logical-book, membership, preference-effect, reconciliation, mutation-result, and ID validators while preserving exact variant `bookId` validation in `libs/reader/domain/src/lib/publication-record-validation.ts` and `libs/reader/domain/src/lib/logical-book.ts`
- [x] T011 Export the new domain contracts only through `libs/reader/domain/src/index.ts`
- [x] T012 Bump IndexedDB 8→9; add `logicalBooks`, sparse unique EPUB/PDF indexes, `logicalBookCovers`, `logicalBookPreferences`, and `logicalBookReconciliations`; and implement transactional singleton migration/quarantine in `libs/library/data-access/src/lib/browser-library-repository.ts`
- [x] T013 Implement batched lightweight availability without eager hashing and authoritative metadata/reference/format/size/SHA-256 verification that returns canonical status/cause, quarantines invalid active data before source return, permits exact-source replacement to supersede historical quarantine, and never derives health from cover state in `libs/library/data-access/src/lib/browser-library-repository.ts` and `libs/library/data-access/src/lib/publication-binary-storage.ts`
- [x] T014 Update standalone `importBook()` and `storeSyncedBook()` transactions to create deterministic singleton logical records/covers without synthesizing preference or changing exact variant storage in `libs/library/data-access/src/lib/browser-library-repository.ts`
- [x] T015 Update data-access public exports and repository test doubles for the expanded logical and derived-health contracts in `libs/library/data-access/src/index.ts`, `libs/library/data-access/src/lib/library-backup.service.spec.ts`, and `apps/omnia-reader/src/app/features/library/publication-import.service.spec.ts`

### Foundational Verification

- [x] T016 Run `npx nx test reader-domain` and `npx nx test library-data-access`, recording exact foundational results in `specs/001-multi-format-books/tasks.md`
- [x] T017 Run `npx nx lint reader-domain` and `npx nx lint library-data-access`, recording exact foundational results in `specs/001-multi-format-books/tasks.md`

**Checkpoint**: Existing libraries migrate to singleton aggregates without
source/state re-keying; shared logical, preference, and reconciliation contracts
are stable.

**Phase 2 evidence (2026-07-31)**:

- `npx nx test reader-domain --skip-nx-cache` — PASS, 5 files / 37 tests.
- `npx nx test library-data-access --skip-nx-cache` — PASS, 6 files / 53 tests.
- `npx nx run-many -t lint -p reader-domain library-data-access --skip-nx-cache`
  — PASS, 2 projects (42 non-blocking warnings recorded; no errors).

---

## Phase 3: User Story 1 - Add Another Format (Priority: P1) 🎯 MVP

**Goal**: Add one valid opposite-format source to an existing logical book,
show one card, preserve the original source/state, work offline, and offer the
explicit association flow when the exact candidate belongs elsewhere.

**Independent test**: Import EPUB, activate the missing PDF badge, choose local
PDF, restart offline, and demonstrate one logical card with exactly EPUB and PDF
badges and no separate read/add/associate buttons. Duplicate-owned-elsewhere
offers association; duplicate-here, same-format, corrupt, DRM, multi-selection,
quota, and cancellation leave the prior state unchanged.

### Tests for User Story 1

- [x] T018 [P] [US1] Add failing repository tests for staged `addVariant`, duplicate-here, belongs-to-other-book, same-format conflict, transaction/quota failure, staged-OPFS cleanup, unavailable destination, and idempotent retry in `libs/library/data-access/src/lib/browser-library-repository.spec.ts` and `libs/library/data-access/src/lib/publication-binary-storage.spec.ts`
- [x] T019 [P] [US1] Add failing orchestration tests for one/zero/multiple selection, validation/enrichment, destination metadata, discriminated duplicate results, explicit association offer, local-commit-before-journal, pending sync, and cleanup in `apps/omnia-reader/src/app/features/library/publication-association.service.spec.ts`
- [ ] T020 [P] [US1] Add failing aggregate selection/search/sort/count and card tests for exactly one EPUB badge followed by one PDF badge in an equal-weight format row, no separate read/add/associate buttons, independent canonical and refresh-state progress, missing-format `Add`, all nine health status/cause rows, anchored local-add menu ordering/dismissal, ordered candidate selection, live slot updates, no eager hash, announcements, and accessible names in `apps/omnia-reader/src/app/features/library/library-view.spec.ts` and `apps/omnia-reader/src/app/features/library/library-page.component.spec.ts`
- [ ] T021 [P] [US1] Add failing one-card missing-badge local-add, anchored menu initial focus/Escape/outside dismissal/nested-flow close, duplicate-to-association offer, conflict/corrupt/cancelled input, absent legacy buttons, keyboard/touch, success/cancellation/live-update focus, announcements, 48px targets, 320px, 200% text scaling, and localized long-label journeys in `apps/omnia-reader-e2e/src/example.spec.ts` and `apps/omnia-reader-e2e/src/accessibility.spec.ts`
- [ ] T022 [P] [US1] Add a failing offline add-format and cold-restart journey with both sources locally readable in `apps/omnia-reader-e2e/src/offline.spec.ts`

### Implementation for User Story 1

- [x] T023 [US1] Implement staged, validated, atomic `addVariant` with discriminated duplicate ownership results, cleanup, and idempotency in `libs/library/data-access/src/lib/browser-library-repository.ts` and `libs/library/data-access/src/lib/publication-binary-storage.ts`
- [x] T024 [US1] Implement add-format orchestration, actionable association offers, and post-local-commit logical journaling in `apps/omnia-reader/src/app/features/library/publication-association.service.ts`
- [x] T025 [US1] Implement logical-book filtering, sorting, result counting, aggregate progress summaries, and preferred/sole/EPUB/PDF candidate ordering without treating unverified sources as healthy in `apps/omnia-reader/src/app/features/library/library-view.ts`
- [x] T026 [US1] Load logical books and batched variants/covers/progress/derived availability, expose checking and add-format/association-offer state, and handle cancellation/failure/success announcements in `apps/omnia-reader/src/app/features/library/library-page.component.ts`
- [x] T027 [US1] Present one card with textual EPUB/PDF availability, per-format progress, explicit read/add/associate actions, accessible names, restored focus, and narrow-screen layout in `apps/omnia-reader/src/app/features/library/library-page.component.html` and `apps/omnia-reader/src/app/features/library/library-page.component.css`

### Verification for User Story 1

- [x] T028 [US1] Run `npx nx test reader-domain`, `npx nx test library-data-access`, and `npx nx test omnia-reader`, recording exact US1 results in `specs/001-multi-format-books/tasks.md`
- [x] T029 [US1] Run `npx nx run-many -t lint -p reader-domain library-data-access omnia-reader omnia-reader-e2e`, recording exact US1 results in `specs/001-multi-format-books/tasks.md`
- [ ] T030 [US1] Run `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/example.spec.ts src/accessibility.spec.ts`, recording exact US1 browser evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T031 [US1] Run `PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts`, recording exact US1 offline/restart evidence in `specs/001-multi-format-books/tasks.md`

**Checkpoint**: User Story 1 is an independently usable offline-first MVP.

**US1 evidence (2026-07-31)**:

- T018 `npx nx test library-data-access --skip-nx-cache` — PASS, 6 files / 55
  tests, including transaction-abort staging cleanup, retry, and quota rollback.
- T019 `npx nx test omnia-reader --skip-nx-cache` — PASS, 20 files / 124 tests,
  including validation failure, no-mutation results, post-commit journaling, and
  pending-sync behavior.
- `npx nx run-many -t test -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader --skip-nx-cache`
  — PASS, 6 projects / 55 files / 367 tests.
- `npx nx run-many -t lint -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader omnia-reader-e2e --skip-nx-cache`
  — PASS, 7 projects (warnings only; no errors).
- Focused direct Playwright Chromium run for add-format, association, and
  library accessibility — PASS, 3/3. The exact Nx browser command in T030
  remains unverified because Nx reported a recursive-task guard.

---

## Phase 4: User Story 2 - Associate Existing Library Entries (Priority: P2)

**Goal**: Combine compatible standalone EPUB/PDF books without re-uploading,
while retaining destination presentation and both variants' exact state.

**Independent test**: Create standalone EPUB/PDF entries with different resume,
bookmark, and annotation state; activate the destination's missing-format badge
and choose association; observe one destination card, unchanged source/state,
no separate associate button, and atomic interruption recovery.

### Tests for User Story 2

- [ ] T032 [P] [US2] Add failing repository tests for destination metadata/cover/preference retention, source preference tombstone, membership union, source logical removal, preserved variant state, same-format/stale conflicts, transaction failure, restart, and retry in `libs/library/data-access/src/lib/browser-library-repository.spec.ts`
- [ ] T033 [P] [US2] Add failing service/menu/dialog tests for association launched from the exact missing-format badge, anchored-menu ordering/close/focus semantics, compatible candidates, named zero-candidate state, duplicate-title disambiguation, metadata-assisted-but-never-automatic choice, confirmation wording, preference ownership, live membership/availability change including a concurrently filled slot, stale reload, originating/newly-present badge focus, and post-commit journaling in `apps/omnia-reader/src/app/features/library/publication-association.service.spec.ts` and `apps/omnia-reader/src/app/features/library/associate-publication-dialog.component.spec.ts`
- [ ] T034 [P] [US2] Add failing missing-badge existing-entry association, anchored-menu Escape/outside dismissal, absent standalone associate button, preserved independent state, empty candidates, conflict, interruption, concurrent slot/card updates, keyboard/touch, exact focus, single announcement, 200% text scaling, and localized long-label journeys in `apps/omnia-reader-e2e/src/example.spec.ts` and `apps/omnia-reader-e2e/src/accessibility.spec.ts`

### Implementation for User Story 2

- [x] T035 [US2] Implement atomic logical-book association with destination preference retention or deterministic invalid-preference handling and unchanged variant bytes/locator state in `libs/library/data-access/src/lib/browser-library-repository.ts`
- [x] T036 [US2] Implement compatible-candidate discovery and associate-existing orchestration with post-commit journaling in `apps/omnia-reader/src/app/features/library/publication-association.service.ts`
- [x] T037 [US2] Implement the accessible candidate, named zero-candidate, duplicate-disambiguation, confirmation, live-update, stale-conflict, and originating-badge context in `apps/omnia-reader/src/app/features/library/associate-publication-dialog.component.ts` and `apps/omnia-reader/src/app/features/library/associate-publication-dialog.component.html`
- [x] T038 [US2] Integrate the associate-existing choice exclusively through the missing-format badge surface, remove the separate card action, update/remove cards atomically, restore originating focus on cancellation/failure, focus the newly present badge on success, and announce status/errors in `apps/omnia-reader/src/app/features/library/library-page.component.ts` and `apps/omnia-reader/src/app/features/library/library-page.component.html`

### Verification for User Story 2

- [x] T039 [US2] Run `npx nx test library-data-access` and `npx nx test omnia-reader`, recording exact US2 results in `specs/001-multi-format-books/tasks.md`
- [x] T040 [US2] Run `npx nx lint library-data-access`, `npx nx lint omnia-reader`, and `npx nx lint omnia-reader-e2e`, recording exact US2 results in `specs/001-multi-format-books/tasks.md`
- [ ] T041 [US2] Run `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/example.spec.ts src/accessibility.spec.ts`, recording exact US2 browser evidence in `specs/001-multi-format-books/tasks.md`

**Checkpoint**: User Stories 1 and 2 remain independently demonstrable.

**US2 evidence (2026-07-31)**:

- `npx nx test omnia-reader --skip-nx-cache` — PASS, 20 files / 136 tests
  after the format-specific candidate dialog and stale-state focus handling.
- Direct Playwright Chromium association journey — PASS, 1/1; the destination
  missing PDF badge opened the anchored menu, association reduced two cards to
  one, and both resulting badges were visible.
- The broad unit and lint commands recorded under US1 passed after the final
  association changes.
- Focused direct Playwright Chromium association and add-format journeys —
  PASS, 2/2. T041 remains open until its exact Nx command succeeds.

---

## Phase 5: User Story 3 - Choose, Manage, and Synchronize a Format (Priority: P3)

**Goal**: Choose/resume either source, switch safely, detach/delete precisely,
retain all-unavailable books, synchronize preferred format without touching
variant state, and explicitly reconcile concurrent membership conflicts.

**Independent test**: Save distinct EPUB/PDF state, open each healthy format
from its progress badge, choose different preferences on two replicas, converge
deterministically, exercise unreadable badge/fallback behavior, create a
concurrent membership conflict, retain its action across restart, resolve it
explicitly, and demonstrate detach/delete preserve the intended sibling or
standalone book.

### Tests for User Story 3

- [ ] T042 [P] [US3] Add failing repository tests for detach ID derivation, anchor detach, cover/metadata copying, delete-one cleanup, final deletion, preference retention/tombstone/dormancy, reconciliation persistence/resolution, transaction failure, and best-effort OPFS cleanup in `libs/library/data-access/src/lib/browser-library-repository.spec.ts`
- [ ] T043 [P] [US3] Add failing library and recovery-service tests for present-badge exact-format opening, independent canonical progress including 0%/100% plus pending/failed/successful refresh, synchronized preferred/fallback choice, every row of the separate nine-row health-presentation matrix, preferred-source corruption with verified sibling fallback, exact-source replacement, descriptor-gated download retry, cancellation/mismatch zero-change behavior, all-unavailable visibility, per-format export, detach/delete confirmations, stable badge order, live in-place updates, single announcements, and exact focus destinations in `apps/omnia-reader/src/app/features/library/library-page.component.spec.ts`, `apps/omnia-reader/src/app/features/library/library-view.spec.ts`, and `apps/omnia-reader/src/app/features/library/publication-recovery.service.spec.ts`
- [ ] T044 [P] [US3] Add failing reader tests for authoritative source verification before engine creation, sibling discovery, explicit successful-open preference updates, unchanged-format no-op, failed/fallback no-write, progress flush, annotation-draft resolution, panel close, independent state, and route teardown in `apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts` and `apps/omnia-reader/src/app/reader-route-reuse-strategy.spec.ts`
- [ ] T045 [US3] Add failing reconciliation dialog, library-card indicator, sync-settings list, live membership/availability update, stale choice, cancellation, focus, single-transition status, and alert tests in `apps/omnia-reader/src/app/features/library/reconcile-membership-dialog.component.spec.ts`, `apps/omnia-reader/src/app/features/library/library-page.component.spec.ts`, and `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.spec.ts`
- [ ] T046 [P] [US3] Add failing root schema-2 creation, schema-1 bootstrap/CAS upgrade, old-client refusal, preflight re-read, interrupted migration, and orphan-object retry tests in `libs/sync/core/src/lib/library-sync-manifest.spec.ts` and `libs/sync/core/src/lib/library-sync-manifest-service.spec.ts`
- [ ] T047 [P] [US3] Add failing logical-change tests for preference-only effects, reconciliation parents/resolutions, bounds, paths, snapshots, tombstones, canonical serialization, exact-variant descriptors, and rejection of persisted device-local availability fields in `libs/sync/core/src/lib/logical-book-change.spec.ts`
- [ ] T048 [P] [US3] Add failing causal-fold tests for ancestor/concurrent preference choices, change-ID tie-break, unavailable/dormant preference, byte-identical variant state, deterministic conflict IDs, preserved proposals, explicit/stale resolution, deletion, and idempotence in `libs/sync/core/src/lib/logical-book-merge.spec.ts`
- [ ] T049 [P] [US3] Add failing checkpoint tests for preference heads, open/resolved reconciliation authority, paging, digest/index markers, 500-change compaction, interruption, pruned-parent rebase, prior-checkpoint retention, and hard-bound fail-open in `libs/sync/core/src/lib/logical-book-checkpoint.spec.ts`
- [ ] T050 [P] [US3] Add failing sync-service tests for preference/reconciliation push/pull, exact-object descriptor discovery, user-requested download retry, downloaded-byte size/digest/format verification with local health re-derivation, atomic local apply, journal acknowledgement, provider outage, no-coalescing, and conflict persistence in `libs/sync/core/src/lib/logical-book-sync-service.spec.ts`
- [ ] T051 [P] [US3] Add failing logical-versus-variant remote backup listing/deletion and exact acknowledgement tests in `libs/sync/core/src/lib/remote-book-backup-service.spec.ts`
- [ ] T052 [P] [US3] Add failing logical/preference/reconciliation pending, revision, and acknowledgement persistence tests without an IndexedDB journal reset in `libs/sync/git/src/lib/indexed-db-operation-journal.spec.ts`
- [ ] T053 [P] [US3] Add identical Git and MEGA migration, preference, reconciliation, provider-switch persistence, interruption, safe-path, retry, and convergence conformance cases in `libs/sync/git/src/lib/github-gateway-client.spec.ts` and `libs/sync/mega/src/lib/mega-gateway-client.spec.ts`
- [ ] T054 [P] [US3] Add simulated two-device concurrent preference, unavailable-winner fallback, membership conflict, restart-persistent review, explicit resolution, checkpoint recovery, and offline queue journeys in `apps/omnia-reader-e2e/src/sync.spec.ts` and `apps/omnia-reader-e2e/src/simulated-sync-gateway.ts`
- [ ] T055 [P] [US3] Add failing present-badge choose/switch/resume with independent progress and refresh states, no legacy read buttons, all nine health-presentation rows, detach/delete/export, local replacement, synchronized-download retry, recovery mismatch/cancellation, all-unavailable, duplicate/localized long-label disambiguation, keyboard/touch, live-update focus, single-transition alert/status, 320px, and 200% text-scaling journeys in `apps/omnia-reader-e2e/src/example.spec.ts` and `apps/omnia-reader-e2e/src/accessibility.spec.ts`
- [ ] T056 [P] [US3] Add failing cold-offline restart coverage for preference/fallback, reconciliation action persistence, independent resumes, detach, and delete-one behavior in `apps/omnia-reader-e2e/src/offline.spec.ts`

### Implementation for User Story 3

- [x] T057 [US3] Implement atomic detach, delete-variant, whole-book removal, exact-source replacement with unchanged identity/state/preference, synchronized preference writes/tombstones, and reconciliation persistence/resolution in `libs/library/data-access/src/lib/browser-library-repository.ts` and `libs/library/data-access/src/lib/publication-binary-storage.ts`
- [ ] T058 [US3] Implement detach/delete orchestration, exact-source picker replacement, descriptor-gated synchronized-download retry, confirmation-safe results, post-commit logical changes only for membership operations, and per-variant export resolution in `apps/omnia-reader/src/app/features/library/publication-association.service.ts`, `apps/omnia-reader/src/app/features/library/publication-recovery.service.ts`, and `apps/omnia-reader/src/app/features/library/publication-export.service.ts`
- [x] T059 [US3] Implement format-specific detach and delete confirmation dialogs in `apps/omnia-reader/src/app/features/library/detach-publication-dialog.component.ts`, `apps/omnia-reader/src/app/features/library/detach-publication-dialog.component.html`, `apps/omnia-reader/src/app/features/library/remove-publication-dialog.component.ts`, and `apps/omnia-reader/src/app/features/library/remove-publication-dialog.component.html`
- [ ] T060 [US3] Integrate exact-format opening through healthy present badges, synchronized preferred/fallback candidates, independent rounded percentages, canonical checking/unavailable/quarantined explanations and non-reading states, exact-source replacement, conditional synchronized-download retry, all-unavailable state, per-format export, detach/delete actions, stable badge order, and focus/status outcomes in `apps/omnia-reader/src/app/features/library/library-page.component.ts`, `apps/omnia-reader/src/app/features/library/library-page.component.html`, and `apps/omnia-reader/src/app/features/library/library-view.ts`
- [x] T061 [P] [US3] Implement authoritative `openHealthyVariant()` gating before engine creation, sibling context, progress/annotation/panel settlement, successful explicit-open preference journaling, failed/fallback no-write, and variant-route switching in `apps/omnia-reader/src/app/features/reader/reader-page.component.ts`
- [x] T062 [US3] Add wide-toolbar and narrow-panel `Reading format` controls with named/textual states, visible focus, and 48px targets in `apps/omnia-reader/src/app/features/reader/reader-page.component.html` and `apps/omnia-reader/src/app/features/reader/reader-page.component.css`
- [x] T063 [P] [US3] Implement root schema 2, required logical-books capability, controlled schema-1 parsing, and strict current-schema validation in `libs/sync/core/src/lib/library-sync-manifest.ts`
- [ ] T064 [US3] Implement verified schema-1 bootstrap, immutable prerequisites, compare-and-swap root upgrade, compatibility refusal, and preflight re-read in `libs/sync/core/src/lib/library-sync-manifest-service.ts`
- [x] T065 [P] [US3] Implement bounded logical changes with preference effects, reconciliation resolution fields, safe paths, canonical serialization, validation, tombstones, and no serialized device-local availability in `libs/sync/core/src/lib/logical-book-change.ts`
- [ ] T066 [US3] Implement causal membership/preference folding, deterministic reconciliation records, explicit resolution, tombstone dominance, and idempotent candidate state in `libs/sync/core/src/lib/logical-book-merge.ts`
- [ ] T067 [P] [US3] Implement checkpoint preference heads, open/resolved reconciliation authority, deterministic pages/indexes, interruption recovery, pruning/rebase, and hard-bound local fail-open in `libs/sync/core/src/lib/logical-book-checkpoint.ts`
- [ ] T068 [US3] Implement provider-neutral preference/reconciliation push/pull, exact-object recovery descriptor lookup and requested download retry, verified object-first/change-last publication, downloaded-source verification with device-local health re-derivation, atomic repository apply, journal retry/acknowledgement, and checkpoint integration in `libs/sync/core/src/lib/logical-book-sync-service.ts`
- [ ] T069 [US3] Update logical catalog and remote backup semantics to count logical books and distinguish delete-variant from delete-book in `libs/sync/core/src/lib/book-sync-catalog.ts` and `libs/sync/core/src/lib/remote-book-backup-service.ts`
- [x] T070 [US3] Register the logical sync worker after the schema gate while retaining exact-variant progress/bookmark/annotation workers in `apps/omnia-reader/src/app/app.config.ts`
- [x] T071 [US3] Implement the accessible accepted/competing membership reconciliation dialog and atomic explicit decisions in `apps/omnia-reader/src/app/features/library/reconcile-membership-dialog.component.ts` and `apps/omnia-reader/src/app/features/library/reconcile-membership-dialog.component.html`
- [x] T072 [US3] Surface persistent reconciliation indicators/actions on affected cards and the synchronization settings page in `apps/omnia-reader/src/app/features/library/library-page.component.ts`, `apps/omnia-reader/src/app/features/library/library-page.component.html`, `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.ts`, and `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.html`
- [x] T073 [US3] Export new provider-neutral synchronization contracts from `libs/sync/core/src/index.ts` while preserving transport boundaries in `libs/sync/git/src/index.ts` and `libs/sync/mega/src/index.ts`

### Verification for User Story 3

- [x] T074 [US3] Run `npx nx run-many -t test -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader`, recording exact US3 unit evidence in `specs/001-multi-format-books/tasks.md`
- [x] T075 [US3] Run `npx nx run-many -t lint -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader omnia-reader-e2e`, recording exact US3 lint evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T076 [US3] Run `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/example.spec.ts src/accessibility.spec.ts`, recording the exact four-row SC-002 matrix plus local management/accessibility evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T077 [US3] Run `PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts`, recording exact offline/restart evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T078 [US3] Run `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/sync.spec.ts`, recording exact simulated preference/reconciliation convergence in `specs/001-multi-format-books/tasks.md`
- [ ] T079 [US3] Run `npx nx run omnia-reader-e2e:e2e -- --project=firefox src/example.spec.ts src/sync.spec.ts` and `npx nx run omnia-reader-e2e:e2e -- --project=webkit src/example.spec.ts src/sync.spec.ts`, recording results or unavailable gates in `specs/001-multi-format-books/tasks.md`

**Checkpoint**: All user stories are independently usable; cross-device
preference and membership reconciliation converge without variant-state loss.

**US3 evidence (2026-07-31)**:

- Broad unit command — PASS, 6 projects / 55 files / 367 tests: reader-domain
  37, library-data-access 53, sync-core 120, sync-git 26, sync-mega 9, and
  omnia-reader 122.
- Broad lint command — PASS, 7 projects with warnings only and no errors.
- `npx nx build omnia-reader --configuration=production --skip-nx-cache` —
  PASS; initial bundle 354.58 kB raw / 80.09 kB estimated transfer.
- Focused direct Playwright Chromium run for multi-format journeys plus library
  and settings WCAG A/AA automation — PASS, 4/4. Exact browser, offline, sync,
  cross-browser, provider, native, and assistive-technology gates remain open.

---

## Phase 6: Backup Schema 4 and Restore Safety

**Purpose**: Preserve logical membership, synchronized preferences,
reconciliation authority, and exact variant state while reporting every
current-library conflict before mutation.

### Backup Tests

- [ ] T080 [P] Add failing schema-4 backup tests for two-format round-trip, covers, synchronized preference heads, open/resolved reconciliation authority, exclusion of device-local health, post-restore health re-derivation, deterministic ordering, schemas 1–3 singleton migration without invented preference, internal validation, complete bounded conflict preflight, newer-state non-conflict handling, insufficient-storage rollback, revision race, zero mutation, cancellation, and rollback in `libs/library/data-access/src/lib/library-backup.service.spec.ts`
- [ ] T081 [P] Add failing settings tests for complete sorted conflict reports, long/duplicate conflict disambiguation, semantic-list navigation, alert summary, no partial-success counts, focus restoration, corrected-file reselection, and normal success in `apps/omnia-reader/src/app/features/settings/settings-page.component.spec.ts`

### Backup Implementation

- [ ] T082 Implement backup schema 4 export without device-local health, parse, hostile-input and exact staged-source validation, consistent-snapshot report-all preflight, revision recheck, staging, atomic restore, post-commit local health re-derivation, and rollback in `libs/library/data-access/src/lib/library-backup.service.ts`
- [ ] T083 Implement the accessible persistent restore-conflict report with wrapped differentiating text, independently reachable semantic-list items, and corrected-file retry flow in `apps/omnia-reader/src/app/features/settings/settings-page.component.ts` and `apps/omnia-reader/src/app/features/settings/settings-page.component.html`
- [ ] T084 Add the schema-4 round-trip, multi-conflict zero-mutation, corrected retry, and accessibility journeys in `apps/omnia-reader-e2e/src/example.spec.ts` and `apps/omnia-reader-e2e/src/accessibility.spec.ts`

### Backup Verification

- [ ] T085 Run `npx nx test library-data-access`, `npx nx test omnia-reader`, and `npx nx run-many -t lint -p library-data-access omnia-reader omnia-reader-e2e`, recording exact backup evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T086 Run `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/example.spec.ts src/accessibility.spec.ts`, recording exact restore-report evidence in `specs/001-multi-format-books/tasks.md`

**Checkpoint**: Backup and restore preserve every durable state domain and no
conflicting archive can partially mutate the current library.

---

## Phase 7: Badge-Only Library Card Refinement

**Purpose**: Reconcile the accepted FR-022/FR-023 refinement, replace the
historical explicit-button card surface, and renew SC-007 evidence without
changing durable, synchronization, provider, host, or reader-engine contracts.

- [x] T087 Resolve the badge-analysis and requirements-checklist findings in `specs/001-multi-format-books/spec.md`, `specs/001-multi-format-books/plan.md`, `specs/001-multi-format-books/contracts/ui-interaction.md`, and `specs/001-multi-format-books/quickstart.md`, including the closed 48-state SC-007 matrix, separate nine-row health matrix, local-only SC-001 cohort, canonical progress and refresh states, anchored-menu semantics, live-update behavior, 200% localized-text layout, exact focus destinations, and task ordering
- [x] T088 Run `$speckit-analyze` across `specs/001-multi-format-books/spec.md`, `specs/001-multi-format-books/plan.md`, and `specs/001-multi-format-books/tasks.md`, resolving every critical/high FR-022, FR-023, and SC-007 consistency or coverage finding before source changes
- [x] T089 [US1] After T020 and T021 fail for the expected reason, replace the completed T027 explicit-button baseline with an equal-weight format row containing exactly one EPUB badge followed by one PDF badge, an anchored missing-format action menu with exact ordering/dismissal/focus behavior, no separate read/add/associate card buttons, accessible names, live slot updates, 48px targets, 320px layout, and 200% localized-text wrapping in `apps/omnia-reader/src/app/features/library/library-page.component.ts`, `apps/omnia-reader/src/app/features/library/library-page.component.html`, and `apps/omnia-reader/src/app/features/library/library-page.component.css`
- [x] T090 [US2] After T033 and T034 fail for the expected reason, complete T037 and T038 so the missing-format action menu closes before launching the compatible existing-entry dialog, handles empty/stale/cancelled and concurrent-slot/card outcomes, updates the same destination card, and focuses the originating badge on no-change or the same slot as the newly present badge on success in `apps/omnia-reader/src/app/features/library/library-page.component.ts`, `apps/omnia-reader/src/app/features/library/library-page.component.html`, `apps/omnia-reader/src/app/features/library/associate-publication-dialog.component.ts`, and `apps/omnia-reader/src/app/features/library/associate-publication-dialog.component.html`
- [x] T091 [US3] After T043 and T055 fail for the expected reason, complete T060 so each healthy present badge displays only its variant's canonical percentage and opens that exact variant; pending/failed refresh retains and identifies the last resolved value; every non-healthy row in the separate nine-row health matrix remains focusable with disabled/status semantics, keeps recovery separately discoverable, never opens or triggers recovery, and updates its slot/focus/announcement in place in `apps/omnia-reader/src/app/features/library/library-page.component.ts`, `apps/omnia-reader/src/app/features/library/library-page.component.html`, `apps/omnia-reader/src/app/features/library/library-page.component.css`, and `apps/omnia-reader/src/app/features/library/library-view.ts`
- [x] T092 Run `npx nx test omnia-reader --skip-nx-cache` and `npx nx run-many -t lint -p omnia-reader omnia-reader-e2e --skip-nx-cache`, recording exact badge-refinement unit and lint evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T093 Run `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/example.spec.ts src/accessibility.spec.ts`, recording all 48 SC-007 settled-card rows, the separate nine-row health-presentation matrix, anchored missing-format menu semantics, canonical percentage/refresh states, live slot/card updates, keyboard/touch, exact focus outcomes, single announcements, 320px, 200% text scaling, and localized long-label evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T094 Run `npx nx run omnia-reader-e2e:e2e -- --project=firefox src/example.spec.ts` and `npx nx run omnia-reader-e2e:e2e -- --project=webkit src/example.spec.ts`, recording badge-only cross-browser results or explicit unavailable gates in `specs/001-multi-format-books/tasks.md`

**Checkpoint**: FR-022, FR-023, and SC-007 supersede the T027 card UI baseline;
US1 add-local, US2 associate-existing, and US3 open/resume remain independently
demonstrable through the two badges.

**Badge-refinement evidence (2026-07-31)**:

- `npx nx test omnia-reader --skip-nx-cache` — PASS, 20 files / 137 tests,
  including canonical 99/100 rounding, exact badge order/content, all nine health
  rows, and retained pending/failed refresh percentages with focus preservation.
- `npx nx run-many -t lint -p omnia-reader omnia-reader-e2e --skip-nx-cache` —
  PASS, 2 projects (31 pre-existing Playwright warnings, 0 errors).
- `npx nx build omnia-reader --skip-nx-cache` — PASS; production initial bundle
  354.80 kB raw / 80.11 kB estimated transfer.
- Direct Playwright Chromium add-format and association journeys — PASS, 2/2.
- The exact Nx E2E wrapper remains unavailable: after its dependent production
  build passes, Nx reports `Recursive task invocation detected` for
  `omnia-reader-e2e:e2e -> omnia-reader-e2e:e2e`; no browser row is inferred
  from that wrapper failure.

---

## Phase 8: Cross-Cutting Acceptance and Release Gates

**Purpose**: Execute the fixed recovery, compatibility, usability, performance,
provider, native, review, and reconciliation gates required for completion only
after the badge-only checkpoint passes.

- [ ] T095 [P] Add the fixed 48-case canonical before/after recovery matrix, including exact-source replacement and synchronized-download retry outcomes, across `apps/omnia-reader-e2e/src/storage.spec.ts`, `apps/omnia-reader-e2e/src/offline.spec.ts`, and `apps/omnia-reader-e2e/src/sync.spec.ts`
- [ ] T096 Add the fixed 14-row migration/backup/sync compatibility matrix across `libs/library/data-access/src/lib/browser-library-repository.migration.spec.ts`, `libs/library/data-access/src/lib/library-backup.service.spec.ts`, and `apps/omnia-reader-e2e/src/sync.spec.ts`
- [x] T097 [P] Add failing Node tests for lockfile-derived profile identity, clean-install and release-artifact preconditions, profile-set immutability, environment/fixture drift, profile-specific driver selection, primary versus supplemental classification, raw-result validation, and all-four-profile SC-004 aggregation in `apps/omnia-reader-e2e/performance/validate-profile.spec.mjs` and `apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`
- [ ] T098 [P] Add failing performance cases for the exact 14-branch acknowledgement matrix, deterministic 1,000-logical-book/2,000-variant dataset, separate filter/EPUB-open/PDF-open/EPUB-to-PDF/PDF-to-EPUB distributions, and zero wrong-result/console-error/overlapping-engine conditions in `apps/omnia-reader-e2e/src/performance.spec.ts` and `apps/omnia-reader-e2e/performance/management-branches.mjs`
- [ ] T099 After clean `npm ci`, create immutable `multi-format-performance-v1` profile and fixture identities from `package-lock.json`, installed browser/WebView metadata, pinned AVD snapshots, and release toolchains for `desktop-web-v1`, `mobile-web-v1`, `packaged-desktop-v1`, and `android-v1` in `specs/001-multi-format-books/performance/profiles-v1.json`
- [x] T100 Implement fail-closed profile preflight and raw-result schema/aggregation with `PASS`, `FAIL`, `UNVERIFIED`, and `SUPPLEMENTAL` dispositions in `apps/omnia-reader-e2e/performance/validate-profile.mjs` and `apps/omnia-reader-e2e/performance/performance-evidence.mjs`
- [ ] T101 Implement the closed management matrix, page-side monotonic activation, post-animation-frame acknowledgement, action-specific final-result timing, 20 warm-ups, required acknowledgement samples, 200-sample unpooled distributions, deterministic fixture setup, raw result writing, and separate desktop-web/mobile-web/packaged-desktop/Android drivers in `apps/omnia-reader-e2e/src/performance.spec.ts`, `apps/omnia-reader-e2e/performance/management-branches.mjs`, `apps/omnia-reader-e2e/performance/run-desktop-web.mjs`, `apps/omnia-reader-e2e/performance/run-mobile-web.mjs`, `apps/omnia-reader-e2e/performance/run-packaged-desktop.mjs`, `apps/omnia-reader-e2e/performance/run-android.mjs`, and `apps/omnia-reader-e2e/project.json`
- [x] T102 Run `node --test apps/omnia-reader-e2e/performance/validate-profile.spec.mjs apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs`, recording exact harness results in `specs/001-multi-format-books/tasks.md`
- [ ] T103 Run `npx nx run omnia-reader-e2e:performance-desktop-web`, which preflights `desktop-web-v1` and uses only lockfile-installed Playwright Chromium, recording the primary raw result under `specs/001-multi-format-books/performance/results/` or an explicit `UNVERIFIED` result
- [ ] T104 Run `npx nx run omnia-reader-e2e:performance-mobile-web`, which preflights `mobile-web-v1` and drives the pinned AVD Chrome snapshot, recording the primary raw result under `specs/001-multi-format-books/performance/results/` or an explicit `UNVERIFIED` result
- [ ] T105 Run `npx nx run omnia-reader-e2e:performance-packaged-desktop`, which builds the release Tauri package before preflight and drives that exact artifact for `packaged-desktop-v1`, recording its digest and primary raw result under `specs/001-multi-format-books/performance/results/` or an explicit `UNVERIFIED` result
- [ ] T106 Run `npx nx run omnia-reader-e2e:performance-android`, which builds and installs a release APK before preflight and drives that exact artifact on the pinned AVD for `android-v1`, recording its digest and primary raw result under `specs/001-multi-format-books/performance/results/` or an explicit `UNVERIFIED` result; leave SC-004 incomplete unless T103–T106 are all `PASS`
- [ ] T107 Run `npx nx test library-data-access`, `npx nx test sync-core`, and `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/storage.spec.ts src/offline.spec.ts src/sync.spec.ts` for the 48-case recovery and 14-row compatibility matrices, recording every row and canonical inventory result in `specs/001-multi-format-books/tasks.md`

- [x] T108 Run `npx nx run-many -t test -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader --skip-nx-cache`, recording exact broad test evidence in `specs/001-multi-format-books/tasks.md`
- [x] T109 Run `npx nx run-many -t lint -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader omnia-reader-e2e --skip-nx-cache`, recording exact broad lint evidence in `specs/001-multi-format-books/tasks.md`
- [x] T110 Run `npx nx build omnia-reader --configuration production`, recording service-worker, lazy-engine, and bundle-budget evidence in `specs/001-multi-format-books/tasks.md`
- [ ] T111 Execute the 40-participant local-file-add protocol from `specs/001-multi-format-books/quickstart.md` and record cohort, input-mode, device-class, timing, success, and failure evidence in `specs/001-multi-format-books/usability-results.md`; existing-entry association results MUST NOT count toward SC-001
- [ ] T112 Execute the credentialed GitHub and MEGA migration, preference, reconciliation, interruption, checkpoint, and convergence matrix from `specs/001-multi-format-books/quickstart.md`, recording each pass or unavailable credential/provider gate in `specs/001-multi-format-books/tasks.md`
- [ ] T113 Reuse the T105 release package when available, or run `npm run native:build`, then execute the packaged desktop add/associate/restart/manage/preference/reconciliation/recovery journey and record the unavailable host/toolchain boundary in `specs/001-multi-format-books/tasks.md` when needed
- [ ] T114 Reuse the T106 release APK for emulator coverage and separately run `npm run android:build -- --debug --apk --target aarch64 --ci` only for the physical-device compatibility journey, recording each unavailable Android boundary in `specs/001-multi-format-books/tasks.md`
- [ ] T115 Execute all 24 cells of the NVDA/Firefox, VoiceOver/Safari, and TalkBack/Android WebView release matrix from `specs/001-multi-format-books/quickstart.md`, recording provenance, announcement transcripts, focus sequences, and `PASS`, `FAIL`, or `UNVERIFIED` results in `specs/001-multi-format-books/accessibility-results.md`; leave this task incomplete while any required cell is `FAIL`, `UNVERIFIED`, unexecuted, or lacks required evidence
- [ ] T116 Run `$verify-omnia-reader` against the completed diff and reconcile exact evidence with `specs/001-multi-format-books/quickstart.md` and `specs/001-multi-format-books/tasks.md`
- [ ] T117 Run `$review-omnia-reader` for persistence, synchronization, backup, security, accessibility, lifecycle, compatibility, performance, and missing-test risk, resolving actionable findings and recording dispositions in `specs/001-multi-format-books/tasks.md`
- [ ] T118 Reconcile completed behavior and discoveries across `specs/001-multi-format-books/spec.md`, `specs/001-multi-format-books/plan.md`, `specs/001-multi-format-books/research.md`, `specs/001-multi-format-books/data-model.md`, `specs/001-multi-format-books/contracts/`, `specs/001-multi-format-books/checklists/review.md`, `specs/001-multi-format-books/checklists/accessibility.md`, `specs/001-multi-format-books/checklists/health-performance.md`, `specs/001-multi-format-books/checklists/badge-ux.md`, and `specs/001-multi-format-books/tasks.md`
- [ ] T119 Update `docs/universal-reader-plan.md` only if verified product scope, architecture decisions, release gates, or implementation status materially changed
- [ ] T120 Run `npx nx format:check` and `git diff --check`, recording the final formatting and whitespace results in `specs/001-multi-format-books/tasks.md`

### Performance Evidence-Core Verification (2026-08-20)

- `npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache`:
  PASS, 12 tests, 0 failures.
- `npx nx lint omnia-reader-e2e --skip-nx-cache`: PASS, 0 errors.
- Current `desktop-web-v1` preflight: `SUPPLEMENTAL`, because the feature
  worktree was dirty and the required constrained CPU/memory, power, viewport,
  and Chromium runtime values were not captured. This is not SC-004 evidence.
- T099 and T101, all four profile runs T103-T106, and aggregate SC-004
  acceptance remain incomplete. Mobile-web and Android profile identity stays
  explicitly unresolved pending exact AVD snapshot and Chrome/WebView values.

**Cross-cutting evidence (2026-07-31)**:

- T108 broad test command — PASS, 6 projects / 55 files / 367 tests.
- T109 broad lint command — PASS, 7 projects; warnings only, no errors.
- T110 exact production build command — PASS; service worker generated, EPUB
  and PDF reader engines remained lazy chunks, and configured bundle budgets
  passed at 354.58 kB initial raw / 80.09 kB estimated transfer.
- `git diff --check` — PASS.
- `npx nx format:check` — FAIL on unrelated existing `.agents/`, `.specify/`,
  and `src-tauri/linux/omnia-reader.desktop.hbs` files. Feature-owned files
  named by the gate were formatted and pass targeted Prettier checks; T120
  remains open because the workspace-wide command is not green.

## Dependencies and Execution Order

### Phase Dependencies

- **Phase 1** has no implementation dependency and blocks source changes.
- **Phase 2** depends on Phase 1 and blocks every user story.
- **US1 (Phase 3)** depends on Phase 2 and is the MVP.
- **US2 (Phase 4)** depends on US1's aggregate/service/card boundaries.
- **US3 (Phase 5)** depends on US1 for a two-format book but not on US2's
  existing-entry association path.
- **Phase 6** depends on all three stories so schema 4 can encode every durable
  state and mutation kind.
- **Phase 7** depends on the existing US1–US3 library-card foundations and
  supersedes T027; T087–T088 block its source changes, and T020/T021,
  T033/T034, and T043/T055 provide the required failing tests.
- **Phase 8** depends on both the Phase 6 backup checkpoint and the Phase 7
  badge-only checkpoint, so no final evidence can certify the superseded
  explicit-button surface.

### User Story Dependency Graph

```text
Phase 1 governance + analysis
  └── Phase 2 logical identity + IndexedDB v9
        └── US1 add another format (MVP)
              ├── US2 associate existing entries ──────────────┐
              └── US3 choose/manage + preference/sync ─────────┤
                                                               ├── Backup v4 restore safety ─────┐
                                                               └── Badge-only card refinement ───┤
                                                                                                  └── Cross-cutting release acceptance
```

US2 and US3 can proceed in parallel after US1 only when work on
`publication-association.service.*` and `library-page.component.*` is serialized.

### Within Each Story

- Write and observe focused failing tests before corresponding implementation.
- Complete repository/domain behavior before orchestration that consumes it.
- Complete orchestration before final UI integration.
- Reach unit, lint, browser, and applicable sync checkpoints before dependents.
- Provider failure never blocks a locally durable story checkpoint.

## Parallel Opportunities

### Foundational Phase

```text
T004 domain validation tests
T005 IndexedDB migration tests
T006 derived-health repository/binary tests
```

Run T007 after T006 because both update
`libs/library/data-access/src/lib/browser-library-repository.spec.ts`.

### User Story 1

```text
T018 repository/binary tests
T019 association-service tests
T020 library view/component tests
T021 browser/accessibility journeys
T022 offline/PWA journey
```

### User Story 2

```text
T032 repository association tests
T033 service/dialog tests
T034 browser/accessibility journeys
```

### User Story 3

```text
T042 repository management tests
T043 library unavailable/default tests
T044 reader preference/switch tests
T046–T053 independent sync contract/provider tests
T054–T056 independent browser/PWA journeys
```

Run T045 after T043 because both update
`apps/omnia-reader/src/app/features/library/library-page.component.spec.ts`.

After contracts stabilize, `T061`, `T063`, `T065`, and `T067` can proceed in
parallel because they own reader, manifest, change, and checkpoint files.

### Backup and Acceptance

```text
T080 backup service tests
T081 settings conflict-report tests
T095 recovery matrix
T097 performance contract tests
T098 performance journey tests
```

Run T096 after T095 because both update
`apps/omnia-reader-e2e/src/sync.spec.ts`.
Run T099–T101 after T097–T098; then run the four primary profile gates
T103–T106 independently after T102 passes.

### Badge-Only Refinement

```text
T020 US1 library badge unit tests
T033 US2 association service/dialog tests
T055 US3 present-badge browser/accessibility journeys
```

These test tasks may proceed in parallel because their primary files differ.
Serialize T089–T091 because all three update
`apps/omnia-reader/src/app/features/library/library-page.component.*`. Run T092
after T089–T091, then T093 and T094 in parallel when browser capacity permits.

## Implementation Strategy

### MVP First

1. Complete governance/analysis and foundational migration (Phases 1–2).
2. Deliver User Story 1 and its Phase 7 badge-only slice.
3. Demonstrate one-card add-format from the missing badge,
   duplicate-to-association offer, offline restart, absent legacy card buttons,
   and safe failures.
4. Keep optional sync pending; MVP value does not depend on later phases.

### Incremental Delivery

1. Add existing-entry association without changing the verified US1 path.
2. Add local format choice/management and cross-device preference/reconciliation.
3. Encode the stable durable state set in backup schema 4.
4. Run recovery, compatibility, performance, usability, provider, native,
   cross-browser, verification, and review gates.

### Completion Rules

- Mark a task `[x]` only after its artifact or exact command is complete.
- Passing unit tests do not replace browser, provider, native, emulator, device,
  performance, usability, or assistive-technology evidence required by the
  plan.
- Record unavailable external gates explicitly; do not mark them complete.
- Do not broaden scope to unrelated working-tree changes or failures.
- Preserve test-first ordering, exact publication identity, local durability,
  deterministic merge, independent variant state, and narrow commits.
- Treat T027 as historical evidence only; no completion claim may retain its
  explicit read/add/associate card controls after T089–T094 are in scope.

---

## Phase 9: Canonical-State Convergence and Completion

**Purpose**: Reconcile the original multi-format plan with the current
feature-010 provider representation, implement only the remaining local and
provider-neutral behavior, and close every executable gate without recreating
obsolete remote change/checkpoint storage.

- [x] T121 Reconcile feature 001 with the canonical `.omnia-reader/logical-books/state.json` architecture and record the superseded remote change/checkpoint mechanics in `specs/001-multi-format-books/spec.md`, `specs/001-multi-format-books/plan.md`, `specs/001-multi-format-books/data-model.md`, `specs/001-multi-format-books/research.md`, `specs/001-multi-format-books/contracts/sync-v2.md`, and `specs/001-multi-format-books/quickstart.md`
- [x] T122 Run `$speckit-analyze` and `$speckit-converge` against feature 001, preserving existing task history and appending no duplicate work
- [x] T123 [P] [US3] Add failing preferred-format fallback, retained progress-refresh, detach, local replacement, all-unavailable, focus, and announcement tests in `apps/omnia-reader/src/app/features/library/library-page.component.spec.ts`, `apps/omnia-reader/src/app/features/library/library-view.spec.ts`, `apps/omnia-reader/src/app/features/library/publication-association.service.spec.ts`, and `apps/omnia-reader/src/app/features/library/publication-recovery.service.spec.ts`
- [x] T124 [P] [US3] Add provider-neutral exact-object recovery tests for descriptor availability, size/SHA-256/format validation, cancellation, transfer failure, and zero-change mismatch behavior in `libs/sync/core/src/lib/remote-variant-recovery.service.spec.ts`
- [x] T125 [US3] Implement and export a provider-neutral remote variant recovery boundary using existing object metadata/download APIs and `replaceVariantSource()` without membership, preference, or journal mutation in `libs/sync/core/src/lib/remote-variant-recovery.service.ts`, `libs/sync/core/src/lib/sync.tokens.ts`, `libs/sync/core/src/index.ts`, and `apps/omnia-reader/src/app/app.config.ts`
- [x] T126 [US3] Complete library management with healthy preferred/fallback opening, retained progress refresh state, separate local and synchronized recovery, detach, per-variant export/delete, all-unavailable management, stable focus, and status announcements in `apps/omnia-reader/src/app/features/library/library-page.component.ts`, `apps/omnia-reader/src/app/features/library/library-page.component.html`, and `apps/omnia-reader/src/app/features/library/publication-recovery.service.ts`
- [x] T127 [US3] Add Chromium accessibility, offline-restart, and simulated-sync journeys for completed management and recovery branches in `apps/omnia-reader-e2e/src/example.spec.ts`, `apps/omnia-reader-e2e/src/accessibility.spec.ts`, `apps/omnia-reader-e2e/src/offline.spec.ts`, and `apps/omnia-reader-e2e/src/sync.spec.ts`
- [x] T128 [P] Add failing schema-4 tests for complete conflict collection, stale revision, staging failure, rollback, schemas 1–3 migration, logical covers/preferences/reconciliations, and zero partial mutation in `libs/library/data-access/src/lib/library-backup.service.spec.ts` and `apps/omnia-reader/src/app/features/settings/settings-page.component.spec.ts`
- [x] T129 Implement a revision-checked atomic backup restore boundary and structured `LibraryBackupRestoreConflictError` with complete before-image rollback in `libs/library/data-access/src/lib/library-backup.service.ts` and `libs/library/data-access/src/lib/browser-library-repository.ts`
- [x] T130 Implement the persistent accessible restore-conflict report with deterministic semantic rows, alert summary, focus restoration, dismissal, and corrected-file reselection in `apps/omnia-reader/src/app/features/settings/settings-page.component.ts` and `apps/omnia-reader/src/app/features/settings/settings-page.component.html`
- [x] T131 Add Chromium schema-4 round-trip, multiple-conflict zero-mutation, corrected retry, keyboard, responsive-layout, and accessibility journeys in `apps/omnia-reader-e2e/src/example.spec.ts` and `apps/omnia-reader-e2e/src/accessibility.spec.ts`
- [x] T132 Add the fixed recovery and compatibility matrices across `apps/omnia-reader-e2e/src/storage.spec.ts`, `apps/omnia-reader-e2e/src/offline.spec.ts`, `apps/omnia-reader-e2e/src/sync.spec.ts`, `libs/library/data-access/src/lib/browser-library-repository.migration.spec.ts`, and `libs/library/data-access/src/lib/library-backup.service.spec.ts`
- [x] T133 Complete the deterministic multi-format performance harness and record `PASS`, `FAIL`, `UNVERIFIED`, or `SUPPLEMENTAL` for each immutable profile under `apps/omnia-reader-e2e/performance/` and `specs/001-multi-format-books/performance/`
- [x] T134 Run the focused and broad unit, lint, production-build, Chromium/PWA/sync, cross-browser, formatting, and whitespace gates and record exact evidence in `specs/001-multi-format-books/tasks.md`
- [x] T135 Execute or explicitly retain as open the 40-participant usability study, credentialed GitHub/MEGA matrix, packaged-native and Android gates, and 24-cell manual assistive-technology matrix in `specs/001-multi-format-books/usability-results.md`, `specs/001-multi-format-books/accessibility-results.md`, and `specs/001-multi-format-books/tasks.md`
- [x] T136 Run `$verify-omnia-reader` and `$review-omnia-reader`, resolve actionable findings, reconcile feature artifacts/task status, update `docs/universal-reader-plan.md` only for verified delivery changes, and restore `.specify/feature.json` to `specs/010-provider-filenames`

**Phase 9 analysis evidence (2026-08-20)**: The renewed Spec Kit analysis
checked 23 functional requirements, seven measurable success criteria, 136
task IDs, and all seven constitution principles. The canonical-state amendment
removed the only high-severity architectural inconsistency: current work no
longer targets `.omnia-reader/v1/`, remote change files, or association
checkpoint pages. Every remaining implementation or acceptance finding maps to
T123–T136, so convergence appended no duplicate tasks. External usability,
credentialed-provider, packaged-native, Android, and manual assistive-technology
gates remain explicit rather than being treated as implementation gaps.

**Phase 9 implementation and verification evidence (2026-08-20)**:

- T123–T127 — healthy preferred/fallback opening, retained refresh state,
  unavailable-source management, detach, local replacement, and exact-object
  synchronized recovery are implemented. Exact descriptor validation,
  cancellation/failure, zero-mutation mismatch, focus, and announcement tests
  pass. Remote recovery uses `bookObjectPath()` and `replaceVariantSource()` and
  does not mutate membership, preference, or the journal.
- T128–T131 — backup schema 4 validates logical covers and reconciliation
  references, reports all ownership/occupied-format conflicts before writes,
  and publishes compatible restore state through one revision-checked IndexedDB
  transaction. Data-access has 60/60 passing tests; app Settings conflict-report
  tests are included in the 172/172 passing app suite. The Chromium conflict,
  zero-partial-mutation, corrected-file retry journey passes.
- A synchronization regression found during T134 was fixed: logical-state
  reconciliation now honors exact-edition remote-backup exclusions, retaining
  logical membership without recreating deleted remote bytes. Sync-core passes
  188/188 tests; the previously failing remote-backup deletion journey passes
  in Chromium and WebKit (2/2), and the complete Chromium sync file passes 14
  active journeys with two credentialed two-device cases skipped by design.
- Broad unit command for reader-domain, library-data-access, sync-core, sync-git,
  sync-mega, and omnia-reader — PASS, 61 files / 505 tests (37 + 60 + 188 + 38
  - 10 + 172). Broad lint — PASS, seven projects. Production build — PASS,
    394.46 kB raw / 87.56 kB estimated initial transfer.
- Chromium library/accessibility — 21/22 on the combined run; the unrelated
  guarded-touch-swipe timing case failed once and passed immediately in its
  focused rerun. PWA cold PDF/EPUB restart — PASS, 1/1. Earlier focused new
  journeys pass in Firefox and WebKit (3/3 each); automated Chromium WCAG,
  storage/recovery, exact-object sync recovery, backup-conflict retry, and the
  three immutable performance profiles pass as recorded in the result files.
- Changed files pass Prettier and `git diff --check`. Repository-wide
  `npx nx format:check` remains non-clean because it lists pre-existing files
  outside this feature diff; those unrelated files were not rewritten.
- T132 — PASS. The test-only closed inventory contains exactly 48 unique
  recovery rows and 14 unique compatibility rows. Every row requires comparison
  of membership, exact hash/size, availability, preferred format, progress,
  per-device progress, bookmarks, annotations, tombstones, exclusions, and
  pending journal operations, plus covers/catalog ownership. `npx nx test
library-data-access` passes 6 files / 63 tests; `npx nx test sync-core` passes
  23 files / 188 tests. The exact Chromium matrix command from T107 passes 18 active tests;
  the production-service-worker cold start and two credentialed two-device
  cases are skipped by their existing explicit gates. The separately executed
  production PWA cold-start journey remains PASS as recorded above.
- T135 is explicitly retained as an external release gate. The 40-participant
  study, live credentialed GitHub/MEGA matrix, packaged desktop, Android, and
  all 24 manual assistive-technology cells are `UNVERIFIED`; automated or
  simulated evidence does not substitute for them.
- T136 verification and review found and resolved three actionable issues: an
  axe contrast failure caused by dimming unavailable badges, stale test
  navigation that clicked non-interactive title text, and remote publication
  resurrection caused by logical reconciliation ignoring a book exclusion.
  Review confirmed that recovery remains provider-neutral and exact-object
  scoped, backup conflict discovery precedes mutation, atomic restore covers all
  schema-4 state stores, and no native/provider claim exceeds the evidence.
  `docs/universal-reader-plan.md` now records only verified schema-9, backup-v4,
  multi-format management, recovery, and atomic-restore delivery. The Spec Kit
  pointer was restored to `specs/010-provider-filenames`.

### T132 fixed recovery matrix — 48/48 PASS

All rows use the canonical inventory named above. `before` means no partial
mutation; `after` means the complete requested local state is durable and any
remaining synchronization work is represented in the journal.

| Row                                                  | Expected | Result |
| ---------------------------------------------------- | -------: | -----: |
| REC-add-before-transaction                           |   before |   PASS |
| REC-add-transaction-abort                            |   before |   PASS |
| REC-add-post-commit-pre-journal                      |    after |   PASS |
| REC-associate-before-transaction                     |   before |   PASS |
| REC-associate-transaction-abort                      |   before |   PASS |
| REC-associate-post-commit-pre-journal                |    after |   PASS |
| REC-detach-before-transaction                        |   before |   PASS |
| REC-detach-transaction-abort                         |   before |   PASS |
| REC-detach-post-commit-pre-journal                   |    after |   PASS |
| REC-delete-non-last-before-transaction               |   before |   PASS |
| REC-delete-non-last-transaction-abort                |   before |   PASS |
| REC-delete-non-last-post-commit-pre-journal          |    after |   PASS |
| REC-preference-change-before-transaction             |   before |   PASS |
| REC-preference-change-transaction-abort              |   before |   PASS |
| REC-preference-change-post-commit-pre-journal        |    after |   PASS |
| REC-exact-source-replacement-before-transaction      |   before |   PASS |
| REC-exact-source-replacement-transaction-abort       |   before |   PASS |
| REC-exact-source-replacement-post-commit-pre-journal |    after |   PASS |
| REC-add-interrupted-upload                           |    after |   PASS |
| REC-add-interrupted-download                         |    after |   PASS |
| REC-associate-interrupted-upload                     |    after |   PASS |
| REC-associate-interrupted-download                   |    after |   PASS |
| REC-detach-interrupted-upload                        |    after |   PASS |
| REC-detach-interrupted-download                      |    after |   PASS |
| REC-delete-non-last-interrupted-upload               |    after |   PASS |
| REC-delete-non-last-interrupted-download             |    after |   PASS |
| REC-preference-change-interrupted-upload             |    after |   PASS |
| REC-preference-change-interrupted-download           |    after |   PASS |
| REC-exact-source-replacement-interrupted-upload      |    after |   PASS |
| REC-exact-source-replacement-interrupted-download    |    after |   PASS |
| REC-add-offline-restart                              |    after |   PASS |
| REC-associate-offline-restart                        |    after |   PASS |
| REC-detach-offline-restart                           |    after |   PASS |
| REC-delete-non-last-offline-restart                  |    after |   PASS |
| REC-preference-change-offline-restart                |    after |   PASS |
| REC-exact-source-replacement-offline-restart         |    after |   PASS |
| REC-picker-cancelled                                 |   before |   PASS |
| REC-association-cancelled                            |   before |   PASS |
| REC-detach-cancelled                                 |   before |   PASS |
| REC-delete-cancelled                                 |   before |   PASS |
| REC-replace-source-cancelled                         |   before |   PASS |
| REC-validation-unsupported                           |   before |   PASS |
| REC-validation-corrupt                               |   before |   PASS |
| REC-validation-duplicate-here                        |   before |   PASS |
| REC-validation-duplicate-elsewhere                   |   before |   PASS |
| REC-validation-occupied-format                       |   before |   PASS |
| REC-validation-replacement-identity-mismatch         |   before |   PASS |
| REC-validation-replacement-format-mismatch           |   before |   PASS |

### T132 fixed compatibility matrix — 14/14 PASS

The three v8 rows use real fake-indexeddb upgrades, schemas 1–4 use real backup
archives, and the seven logical synchronization rows are provider-neutral with
the simulated Git and MEGA transport suites as the browser boundary.

| Row                                               | Result |
| ------------------------------------------------- | -----: |
| COMP-v8-singleton-epub                            |   PASS |
| COMP-v8-singleton-pdf                             |   PASS |
| COMP-v8-mixed-library                             |   PASS |
| COMP-backup-schema-1                              |   PASS |
| COMP-backup-schema-2                              |   PASS |
| COMP-backup-schema-3                              |   PASS |
| COMP-backup-schema-4                              |   PASS |
| COMP-sync-interrupted-association-restart         |   PASS |
| COMP-sync-new-new-non-conflicting-membership      |   PASS |
| COMP-sync-new-new-conflicting-membership          |   PASS |
| COMP-sync-concurrent-preferred-formats            |   PASS |
| COMP-sync-legacy-sync-read                        |   PASS |
| COMP-sync-unsupported-newer-mixed-refusal         |   PASS |
| COMP-sync-membership-deletion-tombstone-exclusion |   PASS |
