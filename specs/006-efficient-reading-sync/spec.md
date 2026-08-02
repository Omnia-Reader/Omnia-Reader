# Feature Specification: Efficient Reading Synchronization

**Feature Directory**: `006-efficient-reading-sync`

**Created**: 2026-08-02

**Status**: Approved for implementation

**Input**: User report that opening or reading an EPUB makes Git/Git LFS synchronization take too long and issue too many requests, including repeated reads of the obsolete `.omnia-reader/v1/books` prefix.

## Outcome and Scope

**Outcome**: Opening and reading an already synchronized publication does not masquerade as a publication change, and the fallback synchronization path avoids legacy-layout and per-publication verification requests while preserving full validation whenever publication work is required.

**In scope**:

- Distinguish device-local open activity from sync-relevant publication metadata changes.
- Reuse one remote publication snapshot across a publication synchronization pass.
- Avoid revalidating already-present publications when no durable publication operation is pending.
- Check and clean the obsolete publication layout after publication reconciliation work, with retry after failure or cancellation.
- Add request-count and behavior regression evidence for EPUB reading and provider-neutral publication synchronization.

**Non-goals**:

- Changing progress, bookmark, annotation, logical-book, checkpoint, merge, or Git LFS formats.
- Weakening publication integrity checks for new, changed, missing, deleted, or conflicted publications.
- Changing MEGA credentials, GitHub authentication, gateway routes, or reader-engine rendering.

## User Scenarios and Testing

### User Story 1 - Open without publication resync (Priority: P1)

A reader opens an already synchronized EPUB and starts reading without changing its extracted publication metadata. The local recent-opened state updates, but synchronization does not enqueue a publication upload or start the immediate book-change path.

**Why this priority**: It removes the false mutation that starts the expensive request burst during the primary reading journey.

**Independent test**: Open an existing EPUB whose extracted title, authors, language, publisher, and identifier match the stored record and observe that no `book` operation is appended, while local opened state and later reading progress remain durable.

**Acceptance scenarios**:

1. **Given** an existing EPUB with unchanged sync-relevant metadata, **When** it is opened, **Then** its device-local open activity is saved without appending a publication operation.
2. **Given** an existing EPUB whose extracted sync-relevant metadata changed, **When** it is opened, **Then** exactly one publication operation containing the updated metadata is appended.
3. **Given** synchronization is unavailable, **When** the EPUB is opened and read, **Then** local open activity and progress remain usable and durable.

---

### User Story 2 - Bound fallback publication requests (Priority: P2)

A reader produces progress-only work and the safe complete synchronization fallback runs. Publication reconciliation uses a shared remote snapshot, skips per-publication verification for already-present publications without publication operations, and does not repeatedly scan the obsolete layout.

**Why this priority**: It bounds the remaining safe fallback without altering merge or checkpoint correctness.

**Independent test**: Synchronize a local library whose current remote publication manifests already exist while only progress is pending, and assert one active publication listing per publication pass, no per-publication document/object reads, and no obsolete-layout listing until publication work requires compatibility cleanup.

**Acceptance scenarios**:

1. **Given** current remote manifests and no pending publication operation, **When** publication synchronization runs, **Then** it reuses one active-publication snapshot and performs no per-publication read, object metadata, upload, or manifest write.
2. **Given** a new, changed, missing, deleted, excluded, or conflicted publication, **When** synchronization runs, **Then** existing integrity, tombstone, conflict, and retry behavior still applies.
3. **Given** a stable progress-only pass, **When** publication synchronization runs, **Then** it does not list the obsolete layout; publication work schedules one compatibility cleanup, and a failed or cancelled cleanup remains eligible for retry.

### Edge Cases

- Multiple open events with unchanged metadata do not accumulate publication operations.
- A metadata change followed by an unchanged reopen produces only the required metadata operation.
- Restricted storage does not affect the optimization because no new durable marker is introduced.
- Cancellation or provider failure during legacy cleanup leaves cleanup pending for a later complete pass.
- Concurrent synchronization calls continue to share the existing active worker promise.
- Hostile or malformed remote manifests remain rejected and never qualify as already-present current publications.

## Requirements

### Functional Requirements

- **FR-001**: Omnia Reader MUST keep `lastOpenedAt` device-local and MUST NOT treat it alone as a sync-relevant publication metadata change.
- **FR-002**: Opening a publication MUST append a `book` synchronization operation only when a field represented in its publication manifest changed.
- **FR-003**: A publication synchronization pass MUST reuse one successfully fetched active-publication snapshot for pull, push planning, and catalog generation whenever that pass performs no publication mutation.
- **FR-004**: With no pending publication operation, an already-present valid remote manifest MUST NOT trigger publication source hashing, object metadata lookup, upload, or manifest read/write.
- **FR-005**: Missing remote publications MUST still be seeded from the local library even if the durable publication journal is empty.
- **FR-006**: Pending publication changes, exclusions, deletions, malformed records, conflicts, and missing manifests MUST retain existing validation, retry, tombstone, and recovery behavior. Missing objects discovered while processing pending or missing-manifest publication work MUST retain existing recovery behavior; routine progress-only passes MUST NOT probe every LFS object.
- **FR-007**: Obsolete-layout cleanup MUST run after publication pull or push work, MUST remain pending after failure or cancellation, and MUST NOT run during a stable progress-only pass.
- **FR-008**: The optimization MUST NOT change synchronized record schemas, provider routes, checkpoint safety, credential handling, or MEGA behavior.

### Quality and Boundary Requirements

**Offline and recovery**

- Local metadata, opened state, and reading progress remain authoritative offline. Journal append or provider failure cannot prevent reading. Failed legacy cleanup is retried by a later complete pass.

**Security and trust**

- Remote manifests and object metadata remain hostile input and receive existing path, identity, size, digest, and schema validation. GitHub credentials remain in the gateway.

**Accessibility and interaction**

- No visual or interactive control changes. Existing reader keyboard, pointer, touch, and assistive-technology behavior is unchanged.

**Platform and compatibility**

- The behavior applies to the shared web/PWA and Tauri web client for EPUB and PDF. No engine-specific or native implementation changes are required.

**Lifecycle and performance**

- An unchanged publication open appends zero `book` operations.
- A progress-only complete publication pass over an already-current library performs one active publication list and zero per-publication document/object requests.
- A stable progress-only pass performs zero listings of the obsolete `.omnia-reader/v1/books` prefix; publication work may trigger one retryable compatibility listing.
- No new listener, worker, timer, dependency, durable record, or bundle-bearing runtime is introduced.

**Migration and compatibility**

- Existing schema-v1 cleanup remains supported. No backup, IndexedDB, provider, or manifest schema changes occur. Removing the optimization restores redundant requests without making stored data unreadable.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Reopening an unchanged synchronized EPUB creates zero publication synchronization operations while preserving its recent-opened ordering.
- **SC-002**: A progress-only fallback against an already-current 100-publication library performs zero publication file/object validations and a constant number of publication-list requests independent of library size.
- **SC-003**: Two consecutive stable progress-only complete passes issue zero obsolete-layout listings in total.
- **SC-004**: New, changed, deleted, missing, and conflicted publication regression tests retain their existing outcomes with no data loss or silent rejection.

## Acceptance Evidence

- Focused reader-page tests prove unchanged open versus changed metadata journaling.
- Focused sync-core tests assert exact list/read/head/upload/write counts for progress-only publication fallback and mutation-triggered legacy cleanup retry.
- The existing fake-gateway Chromium sync journey records the reading-triggered request boundary when a browser executable is available.
- Live credentialed GitHub timing and request counts remain a separate optional gate and must be reported unverified unless run.
- Sync-core and application lint, focused tests, production application build, and `git diff --check` are required.

## Assumptions

- Every local publication import, metadata change, or deletion that requires synchronization is represented by a durable `book` operation.
- A valid remote manifest at the exact expected path is sufficient to identify an already-present publication when no local publication operation is pending; new/missing remote manifests are still seeded.
- Obsolete-layout writers are no longer produced by supported Omnia Reader versions; publication pull or push work schedules compatibility cleanup.
