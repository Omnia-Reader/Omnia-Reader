# Feature Specification: Provider Book Filenames

**Feature Directory**: `010-provider-filenames`

**Created**: 2026-08-02

**Status**: Approved

**Input**: User description: "save books on GitHub (or any persistence provider) with their exact file name instead of their hash"

## Clarifications

### Session 2026-08-03

- Q: Which remote representation should replace the growing `logical-books/changes/` directory? → A: One safe canonical state file that preserves offline multi-device merging and removes `changes/`.

## Outcome and Scope

**Outcome**: A synchronized publication is represented by its original filename on every persistence provider rather than by the obsolete hash-named publication path.

**In scope**:

- Use the canonical readable library object path, whose leaf is the original provider-safe EPUB or PDF filename, in newly created publication and logical-book synchronization records.
- Keep the complete SHA-256 identity for integrity, edition identity, collision prevention, and verification.
- Continue accepting existing hash-addressed logical-book records and remove their obsolete objects through the existing compatibility cleanup.
- Reconcile the known sync-owned legacy layout during every successful full synchronization so stale version-owned files do not remain indefinitely in a repository or selected provider folder.
- Make `.omnia-reader/` the only current synchronization root and losslessly migrate valid data from the previous `.omnia-reader/v1/` root before removing it.
- Replace the append-only `.omnia-reader/logical-books/changes/` tree with one canonical `.omnia-reader/logical-books/state.json` document containing current logical-book state plus compact merge clocks and tombstones.

**Non-goals**:

- Removing SHA-256 identity or integrity validation.
- Renaming already synchronized provider objects outside a normal synchronization pass.
- Removing the collision-resistant suffix from the containing library directory.
- Deleting unknown user-created files, folders, or provider content outside known Omnia Reader legacy paths.
- Changing provider credentials or authorization behavior.
- Weakening concurrent/offline logical-book merge behavior to last-writer-wins at the whole-document level.

## User Scenarios and Testing

### User Story 1 - Recognizable provider backup (Priority: P1)

A reader imports an EPUB or PDF and synchronizes it to GitHub or another configured provider. The remote publication object uses the book's original provider-safe filename as its leaf name.

**Why this priority**: This directly makes synchronized book files recognizable and portable to the user.

**Independent test**: Import a publication named `My Book.epub`, inspect the generated publication and logical-book synchronization records, and observe that both reference a canonical object path ending in `/My Book.epub` rather than `/publication.epub` under a digest directory.

**Acceptance scenarios**:

1. **Given** a newly imported provider-safe EPUB or PDF filename, **When** synchronization records are created, **Then** every new record references the same canonical library object path ending in the source filename.
2. **Given** synchronization is unavailable, **When** the publication is imported, **Then** the local import remains usable and its retryable journal records retain the canonical filename path.

---

### User Story 2 - Existing backup compatibility (Priority: P2)

A reader with records created by an older Omnia Reader version can still synchronize without losing a book while new records stop extending the obsolete layout.

**Why this priority**: Filename visibility must not make existing remote data unreadable or discard exact editions.

**Independent test**: Seed a valid remote-only publication and reading-state record under `.omnia-reader/v1/`, synchronize a fresh device, and observe equivalent verified records under `.omnia-reader/` before the previous root is removed.

**Acceptance scenarios**:

1. **Given** a valid legacy hash-addressed logical-book record, **When** it is read, **Then** it remains accepted for compatibility.
2. **Given** a malformed, traversal, or identity-mismatched object path, **When** it is read, **Then** it remains rejected without mutating the local library.
3. **Given** valid books, progress, bookmarks, annotations, logical changes, checkpoints, manifests, or catalog data under `.omnia-reader/v1/`, **When** a full synchronization runs, **Then** each migratable entry is copied to its current-root path, embedded owned paths are rewritten, and the source is retained until the destination is verified.

---

### User Story 3 - Current-format destination (Priority: P2)

A reader runs a full synchronization against a repository or selected provider folder that still contains files from the obsolete hash-addressed book layout. After current records are safe, Omnia Reader removes those known obsolete files so the destination converges to the current layout.

**Why this priority**: Stopping new legacy writes is incomplete if old sync-owned artifacts remain forever.

**Independent test**: Seed a mixture of current entries, previous-root entries, and invalid sync-owned files, run an otherwise unchanged full synchronization, and observe that only entries adherent to the current `.omnia-reader/` format remain. Interrupt migration or cleanup once and observe that the next full synchronization safely resumes it.

**Acceptance scenarios**:

1. **Given** an otherwise up-to-date destination containing known obsolete book-layout files, **When** a full synchronization succeeds, **Then** the obsolete manifest and publication objects are removed and current records remain unchanged.
2. **Given** cleanup is interrupted or the provider rejects a deletion, **When** the next full synchronization runs, **Then** cleanup is attempted again without hiding the failure or affecting local reading.
3. **Given** unknown content outside the known legacy layout, **When** cleanup runs, **Then** that content is not deleted.

---

### User Story 4 - Compact logical-library persistence (Priority: P2)

A reader synchronizes a library after many imports, associations, metadata edits, preferences, and deletions. The provider contains one logical-library state document rather than one permanent file per historical mutation.

**Why this priority**: The provider layout should remain understandable and bounded without sacrificing offline multi-device correctness.

**Independent test**: Seed valid historical logical-book changes, synchronize, and observe one verified `logical-books/state.json`, no `logical-books/changes/` entries, identical logical books/preferences/conflicts, and safe retry after an optimistic conflict.

**Acceptance scenarios**:

1. **Given** only historical logical-book change files, **When** synchronization succeeds, **Then** Omnia Reader folds them deterministically into the canonical state, verifies the state document, and removes the historical change files.
2. **Given** a canonical state plus a pending offline mutation, **When** synchronization runs, **Then** it merges the mutation using per-record clocks/tombstones and writes the state with optimistic revision protection.
3. **Given** another device updates the state concurrently, **When** the optimistic write conflicts, **Then** synchronization rereads, deterministically reapplies pending work, and retries within a bounded limit without losing either device's accepted state.
4. **Given** a stale device proposes a deleted logical book or older preference, **When** its mutation is merged, **Then** compact tombstone/version metadata prevents resurrection or regression.
5. **Given** a browser retains a trusted checkpoint from the append-only format, **When** the upgraded application first synchronizes, **Then** it invalidates that performance checkpoint, runs the complete migration once, and only then establishes a current-format checkpoint.

### Edge Cases

- Two different editions with the same filename remain distinct through the containing directory's short identity suffix and complete manifest digest.
- A source filename that cannot be used safely as a provider path remains confined by the existing deterministic safe-name policy; it never creates traversal or an extra path segment.
- A valid legacy record is accepted only when its digest and format match the referenced edition.
- Interrupted provider work leaves the local publication and durable journal operation available for retry.
- Providers with virtual directories remove the obsolete directory when its last file is deleted; providers with physical directories MUST remove sync-owned empty legacy directories when their transport supports it, without deleting the selected root or unknown content.
- A same-name publication collision remains distinct because the containing directory includes the publication digest suffix.
- A destination entry that conflicts with a previous-root entry is never silently overwritten or used as proof of migration unless its bytes or normalized document content match.
- A malformed canonical logical state or failed migration leaves every historical change file intact and fails synchronization visibly.
- Obsolete entries beneath `.omnia-reader/logical-books/`, including checkpoints, are removed only after the canonical state is verified; `state.json` is the only current entry in that subtree.
- Older clients that only understand append-only logical changes are not allowed to make the canonical state authoritative; all actively syncing clients must be upgraded before relying on the compact format.

## Requirements

### Functional Requirements

- **FR-001**: Newly created synchronization records for a publication MUST use one canonical object path whose leaf is its original provider-safe filename.
- **FR-002**: New logical-book changes MUST use `.omnia-reader/library/.../<filename>` and MUST NOT advertise the obsolete `.omnia-reader/v1/books/<digest>/publication.<format>` path.
- **FR-003**: Complete SHA-256 edition identity, declared size, format, and digest validation MUST remain unchanged.
- **FR-004**: Existing valid hash-addressed logical-book changes MUST remain readable until compatibility cleanup has safely retired their objects.
- **FR-005**: Object paths that escape the synchronization root, mismatch the publication identity or filename, or contain unsafe segments MUST be rejected.
- **FR-006**: The behavior MUST be provider-neutral and apply identically to GitHub/Git LFS and MEGA transport records.
- **FR-007**: Every full synchronization MUST inventory the previous `.omnia-reader/v1/` root, migrate every valid supported entry to `.omnia-reader/`, and delete every exposed previous-root entry only after all migrated destinations and the current synchronization pass have been verified.
- **FR-008**: Reconciliation MUST treat `.omnia-reader/v1/` as wholly obsolete and sync-owned, remove invalid or unsupported entries beneath it, and never delete content outside `.omnia-reader/`.
- **FR-009**: Failed or interrupted cleanup MUST fail the full synchronization and remain retryable on the next full synchronization; local reading and local durable state MUST remain available.
- **FR-010**: GitHub and MEGA transports MUST expose the same bounded provider-neutral inventory of documents and publication objects required for reconciliation.
- **FR-011**: The current format MUST contain no `v1` directory and all current manifest, library, state, logical-history, tombstone, catalog, and staging paths MUST be rooted directly beneath `.omnia-reader/`.
- **FR-012**: Migration MUST verify document content and publication size plus SHA-256 at the destination before deleting the only previous-root copy.
- **FR-013**: Cleanup MUST submit the complete bounded previous-root inventory as one provider-neutral batch. GitHub MUST remove that batch in one optimistic atomic commit, and any revision or branch-head conflict MUST preserve the remaining previous-root entries for retry.
- **FR-014**: The current format MUST store synchronized logical books in exactly one `.omnia-reader/logical-books/state.json` document, MUST NOT create new entries beneath `.omnia-reader/logical-books/changes/` or checkpoints, and MUST remove every other obsolete entry in the owned `logical-books/` subtree only after state verification.
- **FR-015**: The canonical logical state MUST contain validated current books, active variant descriptors, format preferences, membership reconciliations, causal heads, per-record deterministic version clocks, and deletion/clear tombstones sufficient to merge stale offline mutations without whole-document last-writer-wins data loss.
- **FR-016**: Migration MUST fold every valid historical logical change, write and reread the canonical state, verify semantic equality and the expected revision, and only then batch-delete the historical change entries.
- **FR-017**: Canonical-state writes MUST use optimistic revisions and a bounded read-merge-write retry when another device updates the document concurrently.
- **FR-018**: Invalid state, conflicting immutable identities, interrupted writes, or exhausted retries MUST preserve local authority, pending journal work, and any historical remote changes needed for retry.
- **FR-019**: A local change-aware synchronization checkpoint created before canonical logical state became authoritative MUST NOT bypass the first complete migration pass; after verified convergence, the current checkpoint format MAY restore the unchanged-revision fast path.

### Key Entities and Durable State

- **Publication object path**: Provider-neutral logical path for immutable EPUB or PDF bytes. New records use the canonical readable library path; complete content identity remains in the manifest and containing directory suffix.
- **Logical-book change**: Durable immutable record that may reference a publication object. New changes use the canonical path; existing valid legacy paths remain accepted.
- **Legacy publication object path**: Hash-addressed compatibility path accepted only for existing records and cleanup, not generated for new changes.
- **Destination layout**: The current provider-neutral `.omnia-reader/` tree plus previous-root artifacts discovered through provider-neutral inventory. A full sync converges it toward the current tree without treating content outside `.omnia-reader/` as owned.
- **Remote sync entry**: A bounded inventory record identifying a document or binary object by confined path and provider revision; object integrity is confirmed through the existing metadata endpoint before migration.

### Quality and Boundary Requirements

**Offline and recovery**

- Local import and reading remain authoritative when provider synchronization is unavailable. Interrupted work remains retryable from the durable journal.

**Security and trust**

- Filenames and synchronized records remain hostile input. Path confinement and identity matching are required before a record is accepted.

**Accessibility and interaction**

- No user-interface interaction changes. Provider-visible filenames improve human inspection without changing focus, keyboard, pointer, or announcement behavior.

**Platform and compatibility**

- The same provider-neutral record behavior applies to web/PWA and Tauri hosts. No renderer or browser-specific behavior changes.

**Lifecycle and performance**

- Path generation remains synchronous and bounded. No extra provider requests, hashing, storage, workers, or dependencies are introduced.

**Migration and compatibility**

- Existing valid previous-root records remain readable during migration. New writes use only `.omnia-reader/` and the canonical readable library path. Cleanup happens only after destination verification and the current pass, is retried after failure, and never weakens local authority. Older clients may recreate `v1`; the next current full pass migrates or removes it again.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% of newly created publication upsert records in focused tests reference a path ending with the expected original provider-safe filename.
- **SC-002**: Focused compatibility tests accept 100% of valid legacy-path fixtures and reject 100% of traversal and identity-mismatch fixtures.
- **SC-003**: The affected unit suites complete with zero regressions and no additional provider requests are introduced by path generation.
- **SC-004**: In focused reconciliation fixtures, 100% of valid previous-root documents and objects are verified at current paths before 100% of previous-root entries are removed, 100% of current records remain, and one simulated failure is retried successfully on the next pass.
- **SC-005**: Cleaning any supported number of previous-root GitHub entries uses one browser-to-gateway deletion request and one Git commit rather than one request and commit per entry.
- **SC-006**: After a successful focused migration, 100% of historical logical changes are represented by one verified canonical state document and zero entries remain under `logical-books/changes/`.
- **SC-007**: Focused concurrent, stale-device, deletion, preference-clear, malformed-state, and interrupted-migration fixtures converge deterministically with zero silent logical-book resurrection or accepted-state loss.
- **SC-008**: A focused browser fixture seeded with the prior checkpoint schema performs one complete cleanup, leaves only `logical-books/state.json`, rewrites the checkpoint to the current schema, and then completes the next unchanged sync with one revision request.

## Acceptance Evidence

- Focused synchronization-core tests cover canonical path generation, logical-change serialization, legacy acceptance, and unsafe-path rejection.
- Focused application import tests prove newly journaled logical changes use the same canonical path as the publication manifest.
- Focused synchronization service tests prove stable full-pass cleanup, current-record preservation, and retry after failure.
- Focused Chromium synchronization journeys prove the full-sync legacy listing occurs before the unchanged revision fast path and that the simulated provider receives the exact publication leaf filename.
- Credentialed live GitHub/MEGA, Firefox/WebKit, packaged native, emulator, and physical-device behavior remain separate unverified gates unless run.

## Assumptions

- `.omnia-reader/library/<readable-name>--<short-id>/<original-name>` is the canonical provider object layout.
- `.omnia-reader/v1/` is the previous sync-owned root and contains no valid current entries; content outside `.omnia-reader/` remains out of cleanup scope.
- Exact filename means the original leaf name when it is safe for the shared provider path contract; the existing deterministic confinement policy remains authoritative for hostile or non-portable names.
