# Implementation Plan: Multi-Format Books

**Feature Directory**: `001-multi-format-books` | **Date**: 2026-07-31 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-multi-format-books/spec.md`

**Note**: This template is filled by `$speckit-plan`.

## Summary

**2026-08-20 convergence note**: Feature 010 is authoritative for provider
persistence. Multi-format outcomes still use schema-2 manifest compatibility,
provider-neutral exact-object descriptors, deterministic membership/preference
merge, and durable reconciliation, but current clients persist the folded state
in `.omnia-reader/logical-books/state.json`. Append-only remote changes and
checkpoint pages are legacy migration inputs only; implementation and tests
must not recreate them.

Introduce a format-neutral logical-book aggregate while preserving every
existing `BookRecord.id` as the SHA-256 identity of one exact publication
variant. Add an IndexedDB v9 logical-book store and atomic aggregate operations,
then migrate to v10 with a transaction-owned logical-change outbox so the
separate sync journal cannot lose a committed local mutation,
keep progress/bookmarks/annotations and `/reader/:bookId` scoped to the selected
variant, derive variant health locally through authoritative source
verification, migrate backup archives to schema 4, and use the current sync
schema-2 compatibility gate plus one canonical logical-library state document,
an independently merged synchronized preferred-format register, and durable
membership-conflict reconciliation. The library and reader UI resolve a logical book to one
verified healthy variant. Performance evidence separates first-painted
acknowledgement from final result on four versioned minimum profiles with
profile-specific drivers. Exact-source replacement and verified remote retry
recover unhealthy variants without changing their identity or reading state. The
library card always presents exactly one EPUB badge and one PDF badge: a
present-format badge shows its independent whole-number progress and opens that
variant, while a missing-format badge exposes add-local and associate-existing
choices. Separate Read, Add format, and Associate existing card buttons are
removed. The EPUB/PDF engines, host picker contract, provider
transports, gateway credential boundary, and native commands remain unchanged.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22.1; TypeScript 6.0.3; Nx 23.1

**Primary dependencies**: Existing Angular/CDK/Material, RxJS, `hash-wasm`,
JSZip, EPUB, PDF.js, and provider transport dependencies; no new dependency

**Storage**: IndexedDB metadata and journals; OPFS with IndexedDB fallback for
publication binaries; ZIP backup archive; provider-neutral JSON documents and
Git LFS/MEGA objects beneath `.omnia-reader/`, with logical state in
`.omnia-reader/logical-books/state.json`

**Testing**: Vitest/Angular unit tests; fake IndexedDB migration and failure
fixtures; Playwright browser/PWA journeys; Git/MEGA transport conformance
fixtures; fixed manual assistive-technology audits; live provider, packaged
desktop, Android emulator, and physical-device gates where available. Profile
v1 derives package/browser identity from a clean installation of the committed
lockfile; `package-lock.json` currently resolves Playwright 1.61.1.

**Target platforms**: Web/PWA on Chromium, Firefox, and WebKit; desktop Tauri;
Android Tauri. Release evidence includes NVDA with Firefox on Windows,
VoiceOver with Safari on macOS, and TalkBack with Android WebView.

**Performance goals**: Every management activation produces a first-painted
visible busy/progress/success/failure acknowledgement within 1 second. With
1,000 logical books and 2,000 variants, filter, EPUB/PDF open, and both switch
directions are measured separately and achieve p95 and at least 95% of samples
within 2 seconds on every immutable v1 minimum profile; faster hardware is
supplemental. Only the selected variant and reader engine are loaded.

**Constraints**: Offline-first local authority; hostile publication, archive,
and sync data; exact-edition SHA-256 identity; atomic aggregate mutations;
deterministic merge without wall-clock authority; accessible keyboard/touch
interaction; device-local derived health with authoritative SHA-256/format
verification before renderer use; bounded renderer and synchronization
lifecycle; versioned performance profiles; locked dependencies

**Scope**: EPUB/PDF import association, existing-entry association, one-card
library presentation, variant selection and management, independent reading
state, IndexedDB migration, backup/restore, provider-neutral synchronization,
and compatible web/PWA/Tauri behavior. Format conversion, metadata-only
matching, cross-format locator translation, new host APIs, and reader-engine
changes are excluded.

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

Post-design re-check: all gates still pass. The design preserves local-first
writes, the SHA-256 and publication sandbox boundaries, current credential and
native boundaries, lazy engine loading, supported formats, and independent
variant reading state. Synchronized preference never becomes membership or
locator merge authority. Persistent conflicts and restore preflight prevent
silent loss. The fixed screen-reader matrix treats an unavailable combination
as unverified rather than passed. Derived health is neither persisted nor
synchronized, and performance profile drift fails preflight instead of
weakening a release threshold. The badge choice surface is transient UI state,
reuses the existing import and association boundaries, and adds no persistence,
sync, provider, host, or reader-engine contract. No exception is required.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `BookRecord`, `LibraryRepository`,
  `isBookRecord`, `BrowserLibraryRepository.importBook/removeBook`,
  `LibraryBackupService`, `PublicationImportService.importPublications`,
  `LibraryPageComponent`, `ReaderPageComponent`, `ReaderRouteReuseStrategy`,
  `BookSyncManifest`, `BookSyncService`, `LibrarySyncManifestService`,
  `SyncOperation`, `IndexedDbOperationJournal`, and
  `RemoteBookBackupService`.
- **Badge-only UI refinement**: `LibraryPageComponent`, its template and focused
  tests, `LogicalLibraryCard` progress/availability presentation, the existing
  `PublicationAssociationService`, and the existing association dialog are the
  only runtime owners affected by FR-022/FR-023. No durable or provider-facing
  contract changes.
- **Owning project(s)**: `reader-domain` owns logical-book and repository
  contracts; `library-data-access` owns IndexedDB v10, including v8→v9 logical
  migration, the logical-change outbox, OPFS transaction staging,
  migration, quarantine, and backup schema 4; `sync-core` owns schema 2,
  local logical-book changes, deterministic canonical-state merge, legacy
  migration, and provider-neutral application; `sync-git` owns journal compatibility; `omnia-reader` owns UI and
  orchestration; `omnia-reader-e2e` owns real-browser outcomes.
- **Affected consumers**: `omnia-reader` statically consumes `reader-domain`,
  `library-data-access`, `sync-core`, and `sync-git`; `library-data-access` and
  `sync-core` consume `reader-domain`; `sync-git` consumes `reader-domain` and
  `sync-core`. `sync-mega` and Git-backed transports consume the unchanged
  provider-neutral transport while gaining conformance fixtures.
- **Unchanged boundaries**: `reader-core`, `reader-epub`, and `reader-pdf` keep
  variant-based engine contracts; `platform` keeps `pickPublications()`;
  `sync-gateway` keeps safe-path/credential/session enforcement; `src-tauri` and
  `tools/mega-sdk-bridge` gain no command or filesystem capability.
- **Refreshed source anchors (2026-07-31)**: `BookRecord` and
  `LibraryRepository` are at `libs/reader/domain/src/lib/publication.ts:148` and
  `:214`; `BrowserLibraryRepository` is at
  `libs/library/data-access/src/lib/browser-library-repository.ts:98`;
  `LibraryBackupService` is at
  `libs/library/data-access/src/lib/library-backup.service.ts:144`;
  `BookSyncService`, `LibrarySyncManifestService`, and
  `RemoteBookBackupService` are at `libs/sync/core/src/lib/book-sync-service.ts:74`,
  `libs/sync/core/src/lib/library-sync-manifest-service.ts:31`, and
  `libs/sync/core/src/lib/remote-book-backup-service.ts:42`;
  `IndexedDbOperationJournal` is at
  `libs/sync/git/src/lib/indexed-db-operation-journal.ts:17`; and the application
  surfaces are `LibraryPageComponent` at
  `apps/omnia-reader/src/app/features/library/library-page.component.ts:52`,
  `ReaderPageComponent` at
  `apps/omnia-reader/src/app/features/reader/reader-page.component.ts:126`,
  `SettingsPageComponent` at
  `apps/omnia-reader/src/app/features/settings/settings-page.component.ts:36`,
  and `SyncSettingsPageComponent` at
  `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.ts:46`.
  CodeGraph confirms `listBooks()` fans into backup, import orchestration, and
  library UI; `importBook()` is owned by publication import; `removeBook()` fans
  into backup rollback and library removal; and sync workers are composed in
  `apps/omnia-reader/src/app/app.config.ts`.

### Repository Paths

```text
apps/omnia-reader/src/app/features/library/       # aggregate cards, dialogs, association orchestration
apps/omnia-reader/src/app/features/reader/        # sibling-format choice and safe route switch
apps/omnia-reader/src/app/reader-route-reuse-strategy.ts
apps/omnia-reader-e2e/src/                         # browser, accessibility, storage, and offline journeys
apps/omnia-reader-e2e/performance/                 # profile preflight, page timing, raw-result schema
libs/reader/domain/src/lib/                        # logical-book records, validation, repository/sync contracts
libs/library/data-access/src/lib/                  # IndexedDB v10, atomic mutations/outbox, backup schema 4
libs/sync/core/src/lib/                            # root schema 2, outbox journal bridge, canonical state, merge/recovery
libs/sync/git/src/lib/                             # journal entity compatibility and focused tests
libs/sync/mega/src/lib/                            # provider-neutral conformance tests only, if fixtures live here
specs/001-multi-format-books/performance/          # immutable profile sets and raw acceptance results
```

## Design

### Contracts and State

- Preserve `BookRecord` storage and wire shape as the publication-variant
  record. Its `id`, current `bookId` references, binary metadata, OPFS object,
  progress, progress documents, bookmarks, and annotations remain exact-file
  and format-specific.
- Define `VariantAvailability` as a device-local derived result, never a
  `BookRecord`, backup, or sync field. Lightweight library-card resolution may
  report `checking`, `unavailable` with a missing/evicted/inaccessible/incomplete
  cause, or `quarantined` with an integrity-invalid/unsupported/malformed-
  reference cause without claiming unverified bytes are healthy. Eligibility
  uses status; explanations use cause. The authoritative open boundary requires valid metadata
  and binary reference, supported detected format, accessible size-matching
  bytes, and SHA-256 equality with `BookRecord.id`; digest/format mismatch
  quarantines the active invalid reference before renderer use. Valid replacement
  active data supersedes historical quarantine evidence.
- Expose exact-source `replaceVariantSource` at the repository boundary.
  `sync-core` separately owns exact-object descriptor lookup and user-requested
  download retry, then supplies verified bytes to that replacement operation.
  Both paths use the authoritative hostile-source checks and atomically replace
  only device-local binary/reference and quarantine evidence. They never change
  variant identity, logical membership, catalog data, reading state, preference,
  or logical-change history; failure or cancellation leaves the prior active
  source unchanged.
- Add `LogicalBookRecord` schema 1 with a stable opaque `logicalBookId`, copied
  catalog metadata, an `epub`/`pdf` membership map, and catalog cover state. Add
  a separate synchronized `LogicalBookFormatPreference` register and durable
  `MembershipReconciliation` records. The detailed fields and invariants are in
  [data-model.md](data-model.md).
- Bump IndexedDB 8→9 and add `logicalBooks`, unique sparse indexes for each
  format membership, `logicalBookCovers`, `logicalBookPreferences`, and
  `logicalBookReconciliations`. In the version-change transaction, wrap each
  valid existing variant in a singleton logical book and copy its catalog cover
  while leaving every existing key and state record unchanged. Do not infer a
  synchronized preference from legacy activity. Quarantine malformed legacy
  records losslessly.
- Expose explicit logical-book repository reads and atomic `addVariant`,
  `associate`, `detachVariant`, and `deleteVariant` mutations. Association and
  detachment only rewrite aggregate membership; add stages bytes before one
  metadata transaction; delete commits unreachable metadata before best-effort
  OPFS cleanup. The operation returns the complete local change only after the
  durable transaction commits.
- Bump backup manifest 3→4. Keep publication entries content-addressed and add
  logical books, logical covers, synchronized preferences, reconciliation
  authority, and membership validation. Restore v1–v3 as singleton aggregates.
  After complete hostile-input validation, compare every archived membership
  with one consistent current snapshot and return every ownership/occupied-slot
  conflict in canonical order. Any conflict aborts before staging or mutation;
  a conflict-free restore rechecks the snapshot revision before one repository
  commit or complete before-image rollback.
- Validate the schema-2 root manifest at `.omnia-reader/manifest.json` before
  publishing association data; old clients reject the schema before normal
  sync. Keep exact variant state operations keyed by SHA-256 IDs. Publish
  verified immutable variant objects first, fold durable local
  `LogicalBookChange` journal payloads into the canonical
  `.omnia-reader/logical-books/state.json`, then reread and semantically verify
  the optimistic write before acknowledgement.
- Fold change documents causally by declared parent heads; order concurrent
  changes by change ID, never device clocks or device-local journal revisions.
  Conflicting losing associations preserve their variants in the last accepted
  membership and create a deterministic persistent reconciliation record. An
  explicit child reconciliation change that observes every conflicting/current
  head is required to resolve it. Preference-only changes fold in an independent
  register: descendants win and concurrent choices use the same change-ID
  tie-break without reading or rewriting membership or variant state.
  Tombstones participate in the same causal order. Bounded record clocks and
  tombstones inside canonical state retain membership/deletion,
  preference-head, and open/resolved reconciliation authority needed by an
  offline client. Former change/checkpoint entries are migration inputs only.
- Add `logical-book-change` to `SyncOperation.entity`. Append it after local
  commit; do not coalesce distinct changes by logical-book ID. Provider failure
  leaves local state usable and the operation pending.
- Public and storage contracts are specified in
  [contracts/domain-repository.md](contracts/domain-repository.md),
  [contracts/backup-v4.md](contracts/backup-v4.md), and
  [contracts/sync-v2.md](contracts/sync-v2.md). Performance profile and result
  evidence follows
  [contracts/performance-evidence.md](contracts/performance-evidence.md).

### User Interface and Accessibility

- Load logical books for library search/count/sort and join their variants and
  per-variant progress for presentation. Every card renders exactly two compact
  controls of equal visual weight in one format row after catalog metadata and
  before secondary management actions, in stable EPUB-then-PDF order. Format
  and percentage are text in the same control, not adjacent sibling controls. A
  present-format badge displays
  `<FORMAT> <whole-number>%`, obtains progress only from that exact variant, and
  uses `100%` only for normalized progress at or above completion; otherwise it
  displays `min(99, round(100 * clamp(p, 0, 1)))%`, with absent progress as
  `0%`. Do not expose the settled card until batched progress resolution
  completes. A later refresh retains the last resolved percentage with
  `Progress updating` or `Progress temporarily unavailable` until another value
  resolves in the same slot. A healthy present badge opens through the
  authoritative source boundary. A missing-format badge displays `<FORMAT> Add`
  and opens an anchored non-modal action menu named for the book and format.
  The menu initially focuses `Add local <format>`, followed by `Associate
existing <format>`, closes before the selected picker/dialog opens, and
  restores the badge on Escape, cancellation, or failure. Tab closes it and
  continues document order; outside dismissal preserves its clicked focusable
  target or otherwise restores the badge.
  The card renders no
  separate Read EPUB, Read PDF, Add format, or Associate existing buttons.
  Checking, unavailable, and quarantined present variants retain their badge,
  percentage, and textual status. They remain focusable with
  `aria-disabled="true"`; activation keeps focus in place, announces status once,
  and cannot open or initiate recovery. Applicable recovery stays separately
  named and adjacent. A card with no healthy variant remains visible and
  manageable.
- Reuse the existing local picker/add orchestration, compatible-candidate query,
  association dialog, atomic repository mutations, and post-commit journaling.
  The badge choice surface owns no durable state and never preselects an action
  or candidate. Add is constrained to the badge's missing format; association
  lists only compatible standalone entries containing that format. Duplicate,
  stale, occupied-slot, invalid input, empty candidates, cancellation, and
  failure keep membership unchanged. Success updates the destination card in
  place and changes the originating badge from `Add` to its initial progress.
- Unavailable and quarantined formats expose exact-source replacement with
  status/cause-specific explanation. Verified synchronized-download retry is
  additionally exposed only when the sync catalog has the exact remote object.
  Recovery uses the existing picker or provider retry boundary, announces
  progress/result, restores focus, and updates the existing card without a
  logical or preference change.
- Add a focused missing-format choice surface and retain focused dialogs/actions
  for candidate association, detach, delete variant, export variant, and remove
  whole book. Same-format conflicts, invalid input, and cancellation do not
  mutate state. A duplicate owned by another logical book offers the explicit
  existing-book association flow without moving it. Open synchronization
  membership conflicts remain visible on affected cards and in sync settings
  until an accessible reconciliation dialog commits a valid explicit resolution.
- Keep `/reader/:bookId` variant-based. `ReaderPageComponent` loads the logical
  sibling context in addition to current variant state. Before switching it
  flushes progress, resolves or preserves any annotation draft, closes transient
  panels, and navigates to the sibling variant ID. Existing route recreation
  tears down the old engine; the registry lazily loads only the new engine.
  After an explicit target format successfully opens, persist and journal a
  preference change only when the format differs; failed opens and automatic
  fallbacks never change preference.
- Dialogs use initial and restored focus. Present badge names include book,
  format, progress, and availability; missing badge names include book, format,
  and `Add or associate`. The choice surface is named by book and format, uses
  visible text for both actions, and restores focus to the originating badge on
  cancellation/failure or to the same slot after it becomes the newly present
  badge on success. Status/alert
  announcements distinguish completion and failure; badges do not rely on
  color; compact visuals retain visible focus and at least 48px hit targets.
  At 320 CSS pixels and 200% text scaling, the format row may wrap while keeping
  order and avoiding page-level horizontal scrolling; localized labels and long
  distinguishing text wrap without clipping or ellipsis. Progress, health, and
  membership updates preserve the existing slot and focus. A newly filled slot
  closes its open choice menu, becomes present, receives focus, and is announced
  once; removal of the whole card moves focus to the nearest stable library
  control. Association and reconciliation dialogs revalidate live membership
  changes before confirmation.
  The same format choice remains reachable in the narrow-screen reader action
  panel. Before release, the add, associate, choose, detach,
  delete, synchronization-reconciliation, all-unavailable-management, and
  restore-conflict journeys are audited with NVDA + Firefox on Windows,
  VoiceOver + Safari on macOS, and TalkBack + Android WebView. Evidence records
  names and states, dialog/conflict/status/failure announcements, focus order,
  and completion without visual interpretation; an unavailable combination is
  unverified, not passed. Automated Playwright/accessibility checks are a
  prerequisite and never substitute for a matrix cell. See
  [contracts/ui-interaction.md](contracts/ui-interaction.md).

### Security and Failure Handling

- Candidate files pass the existing format, declared-size, SHA-256, EPUB/PDF,
  DRM, script, unsafe-navigation, and quarantine validation before membership
  commit. Candidate metadata cannot replace destination catalog metadata.
- Health is re-derived locally at ingestion, restore/download, replacement, and
  authoritative open boundaries. Missing/evicted/inaccessible or incomplete
  bytes are `unavailable` with a precise cause; malformed metadata/reference,
  digest mismatch, or detected-format mismatch is `quarantined` with the
  corresponding malformed-reference/integrity-invalid/unsupported cause before
  renderer use. Library listing never eagerly hashes every source, and cover
  state never influences health.
- Persisted, backup, and synchronized logical records validate ID syntax,
  bounded metadata, unique membership, one variant per format, referential
  integrity, format agreement, safe paths, sizes, digests, parent counts, and
  document bounds before mutation.
- Restore separates hostile archive validation from current-library conflict
  preflight. It collects all membership/occupied-format conflicts without
  short-circuiting and performs no OPFS, repository, preference,
  reconciliation, or journal write when the report is non-empty. The final
  transaction rechecks the preflight revision to close the comparison/commit
  race.
- Local mutation failure produces the complete before state or complete after
  state. Staged OPFS bytes are cleaned on commit failure; post-delete cleanup may
  leave unreachable bytes but cannot leave a visible partial book. Missing or
  quarantined variants remain visible with their cause while healthy siblings
  remain readable.
- Each logical mutation writes its immutable change to the v10 outbox in the
  same transaction. Post-commit journal handoff removes that copy only after
  the normal journal accepts it; a failed handoff remains visible through the
  journal contract across restart. Provider failure therefore leaves durable
  pending work rather than merely a process-local status.
  Remote objects are verified before change publication; incomplete publication
  is invisible. Pull builds and validates a candidate graph before one local
  transaction. Cancellation and retry are idempotent.
- Provider credentials, reusable sessions, gateway path confinement, CSP,
  publication sandboxing, and native command allowlists do not change.

### Lifecycle and Performance

- Library joins are bounded to at most two variants per logical book and use
  membership indexes rather than loading binaries. Search/sort operates on
  logical catalog records and batched progress summaries.
- Adding a format hashes/validates once and stages one binary. Association and
  detachment do not copy publication bytes. Catalog cover duplication is bounded
  to the small cover asset required for lossless detach and destination
  presentation.
- Format switching explicitly flushes progress and ends transient work before
  route navigation; route recreation releases the previous engine's worker,
  iframe/canvas/object URLs/listeners and loads only the selected engine.
- Change documents are bounded, immutable, and checkpointed in deterministic
  pages that stay within the existing validated JSON-document limit. Provider
  listing and merge benchmarks cover 1,000 logical books/2,000 variants and an
  interrupted checkpoint.
- Performance evidence uses the fixed dataset and timing protocol in
  [quickstart.md](quickstart.md) and the profile/evidence contract in
  [contracts/performance-evidence.md](contracts/performance-evidence.md). A
  page-side monotonic capture measures activation to the first painted semantic
  acknowledgement separately from activation to the action-specific final
  result. Busy state never satisfies the final-result boundary. Warm-up and
  measured samples remain separate; actions, formats, directions, and profiles
  are not pooled.
- The acknowledgement denominator is the fixed 14-branch success/failure matrix
  for add, associate, detach, delete variant, reconcile, replace source, and
  restore conflict handling in the performance contract. No sampled subset may
  establish SC-004.
- `desktop-web-v1`, `mobile-web-v1`, `packaged-desktop-v1`, and `android-v1`
  freeze the minimum CPU, memory, power, OS, and browser/WebView environment in
  `specs/001-multi-format-books/performance/profiles-v1.json`. Preflight fails
  closed on environment, fixture, or runtime-version drift. Packaged and Android
  evidence uses release builds. Faster or unconstrained runs are supplemental;
  an unavailable primary profile is unverified, not passed. Separate desktop-
  web, mobile-web, packaged-desktop, and Android drivers own their environments;
  the native drivers build release artifacts before preflight and include the
  artifact digest. The Chromium Playwright target is desktop-web evidence only.
- No dependency or eager-engine bundle increase is planned. The production
  application budget remains a release gate.

## Verification Plan

Commands are ordered from focused contract evidence to broad application and
environment gates.

| Requirement/story                              | Evidence                                                                                                                                                                                                                                                                                                               | Command or environment                                                                                                                                                                                          | Required locally?                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| FR-001, FR-005, FR-009, FR-010                 | Record validation, stable SHA IDs, membership/cardinality, variant-scoped locator state                                                                                                                                                                                                                                | `npx nx test reader-domain`                                                                                                                                                                                     | Yes                                                                                                     |
| FR-002, FR-003, FR-006, FR-011–FR-014, US1–US3 | IndexedDB v8→v9 logical migration and v9→v10 durable outbox migration; add/associate/detach/delete atomic failure and restart; missing bytes/quarantine                                                                                                                                                                | `npx nx test library-data-access`                                                                                                                                                                               | Yes                                                                                                     |
| FR-015, FR-016, FR-020                         | Backup v4 round-trip, v1–v3 singleton migration, all-conflict preflight, revision recheck, zero mutation, rollback                                                                                                                                                                                                     | `npx nx test library-data-access`                                                                                                                                                                               | Yes                                                                                                     |
| FR-015, FR-017, FR-021                         | Durable outbox/journal handoff, root schema gate, canonical-state migration, causal membership/preference merge, persistent reconciliation, tombstones, optimistic retry                                                                                                                                               | `npx nx test sync-core`                                                                                                                                                                                         | Yes                                                                                                     |
| FR-015, FR-017, FR-021                         | Logical/preference/reconciliation journal work remains durable, ordered, and acknowledgement-safe                                                                                                                                                                                                                      | `npx nx test sync-git`                                                                                                                                                                                          | Yes                                                                                                     |
| FR-015, FR-017, FR-021                         | Provider-neutral membership/preference/reconciliation fixtures preserve identical semantics                                                                                                                                                                                                                            | `npx nx test sync-mega`                                                                                                                                                                                         | Yes                                                                                                     |
| FR-002–FR-012, FR-017–FR-023, US1–US3          | Always-visible EPUB/PDF badges, per-variant percentages and refresh states, anchored menu semantics, present-format open, missing-format add/associate choice, duplicate/empty/cancel/focus/live-update outcomes, all nine health rows, no-readable state, conflict reports, reconciliation, safe format switch        | `npx nx test omnia-reader`                                                                                                                                                                                      | Yes                                                                                                     |
| UI/domain/persistence/sync/E2E source          | Project boundary and static analysis                                                                                                                                                                                                                                                                                   | `npx nx run-many -t lint -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader omnia-reader-e2e`                                                                                       | Yes                                                                                                     |
| SC-002, SC-005, SC-007, FR-007, FR-018–FR-023  | Chromium closed 48-row settled-card matrix, separate nine-row health-presentation matrix, canonical percentage/refresh states, badge-only presentation, anchored add/associate menu, live-update and exact success/cancel focus, 200% localized-text/320px layout, restore conflict report, and accessibility journeys | `npx nx run omnia-reader-e2e:e2e -- --project=chromium src/example.spec.ts src/accessibility.spec.ts`                                                                                                           | Yes                                                                                                     |
| FR-014, FR-017, FR-021, SC-003                 | PWA restart, persistent reconciliation, preference convergence/fallback, and both variants readable                                                                                                                                                                                                                    | `PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts src/sync.spec.ts`                                                                                                          | Yes                                                                                                     |
| Cross-browser contract                         | Library controls and EPUB/PDF format switch                                                                                                                                                                                                                                                                            | `npx nx run omnia-reader-e2e:e2e -- --project=firefox src/example.spec.ts` and `npx nx run omnia-reader-e2e:e2e -- --project=webkit src/example.spec.ts`                                                        | Yes                                                                                                     |
| SC-005, accessibility contract                 | Manual audit of add, associate, choose, detach, delete, reconciliation, all-unavailable management, and restore conflicts; automation is prerequisite evidence, not a substitute                                                                                                                                       | Fixed NVDA/Firefox, VoiceOver/Safari, and TalkBack/Android WebView matrix from `specs/001-multi-format-books/quickstart.md`; record `specs/001-multi-format-books/accessibility-results.md`                     | No—required before release; unavailable combinations are unverified                                     |
| SC-001                                         | Fixed 40-participant, two-direction unassisted usability protocol                                                                                                                                                                                                                                                      | Protocol and evidence record from `specs/001-multi-format-books/quickstart.md`                                                                                                                                  | No—required before release                                                                              |
| SC-003, SC-006                                 | Fixed recovery/compatibility matrices and canonical before/after inventories                                                                                                                                                                                                                                           | Matrix from `specs/001-multi-format-books/quickstart.md` plus focused and simulated-provider tests                                                                                                              | Yes                                                                                                     |
| SC-004                                         | All 14 management branches acknowledge within 1,000 ms; separate raw filter, EPUB/PDF open, and bidirectional-switch distributions meet p95 and 95%-within-2,000-ms on all four immutable v1 profiles                                                                                                                  | `performance-desktop-web`, `performance-mobile-web`, `performance-packaged-desktop`, and `performance-android` runs from `quickstart.md`; raw results under `specs/001-multi-format-books/performance/results/` | Desktop web locally; other primary profiles are required before release and unverified when unavailable |
| Bundle/PWA release gate                        | Production compile, service worker, lazy engines, and configured bundle budgets                                                                                                                                                                                                                                        | `npx nx build omnia-reader --configuration production`                                                                                                                                                          | Yes                                                                                                     |
| Repository hygiene                             | Repository formatting and no whitespace errors in the intended diff                                                                                                                                                                                                                                                    | `npx nx format:check` and `git diff --check`                                                                                                                                                                    | Yes                                                                                                     |
| Provider boundary                              | Interrupted upload, CAS conflict, schema upgrade, checkpoint, deletion, and convergence against live GitHub and MEGA                                                                                                                                                                                                   | Credentialed provider matrix from `specs/001-multi-format-books/quickstart.md`                                                                                                                                  | No—required before release when credentials/providers are available                                     |
| Host boundary                                  | Add/select/manage formats using packaged desktop picker and persistence                                                                                                                                                                                                                                                | `npm run native:build` plus packaged desktop journey                                                                                                                                                            | No—requires desktop host toolchain                                                                      |
| Android boundary                               | Add/select/manage formats after restart on emulator and physical device                                                                                                                                                                                                                                                | `npm run android:build -- --debug --apk --target aarch64 --ci` plus emulator/device journey                                                                                                                     | No—requires Android toolchain/device                                                                    |

Correct formatting only in the intended feature diff before rerunning
`npx nx format:check` and `git diff --check`. A Rust check is not required
unless the implementation departs from this plan and changes native commands.

## Delivery and Documentation

- **Vertical slices**: (1) domain records, IndexedDB v9 singleton migration, and
  add-format with one-card UI; (2) associate existing entries with preserved
  state; (3) format choice/switch, detach, and delete; (4) backup v4; (5) sync
  schema 2, deterministic canonical membership/preference merge, persistent
  conflict reconciliation, legacy migration, and provider conformance. Each slice starts with
  focused failing tests and remains locally usable before optional sync work.
- **Migration/rollout**: Ship local v9 migration before UI mutation paths, then
  v10 as an additive empty-outbox migration before relying on crash-durable
  post-commit journal handoff. Ship
  backup v4 reader/writer with legacy readers before relying on it. A new client
  may read sync schema 1 only to verify/copy exact variants into singleton
  logical state, then compare-and-swap the root to schema 2 before publishing
  association changes. Retain legacy provider objects until canonical state is
  written, reread, and semantically verified; then remove legacy changes and
  checkpoints as one retryable batch. An old sync already in flight cannot be
  recalled, but the schema gate prevents it from interpreting new membership;
  a later upgrade reconciles its legacy singleton copies without data loss.
- **Documentation**: Keep detailed contracts in this feature directory. Update
  `docs/universal-reader-plan.md` only after implementation evidence changes
  verified product/architecture status. Document backup v4, sync schema 2, and
  canonical logical state
  compatibility for users before release.
- **Residual gates**: Live GitHub/MEGA credentials and quotas, provider
  interruption during schema upgrade/canonical-state migration, packaged desktop behavior,
  Android emulator, physical-device behavior, Windows NVDA/Firefox, macOS
  VoiceOver/Safari, Android TalkBack/WebView, the pinned Pixel-class AVD, and
  packaged/Android performance profiles cannot be implied by local unit/browser
  results and must be reported separately. Browser/WebView, OS, power-mode,
  CPU/memory-limit, or fixture drift requires a new profile version; unavailable
  primary profiles and assistive-technology combinations remain explicitly
  unverified.

## Complexity and Exceptions

None. The additional logical aggregate and sync change/checkpoint model are
required to preserve existing exact-file identities and provide atomic,
deterministic association without weakening constitution gates.
