# Feature Specification: Re-import Deleted Books

**Feature Directory**: `003-reimport-deleted-book`

**Created**: 2026-08-02

**Status**: Approved

**Input**: User description: "When trying to import a previously deleted book I get 'The X Book is already in your library,' but no book is rendered in the library."

## Outcome and Scope _(mandatory)_

**Outcome**: A publication that was removed from the visible library can be imported again and immediately appears as a normal library entry rather than being reported as an invisible duplicate.

**In scope**:

- Prevent a removed publication from being restored by an older synchronization record.
- Repair a locally retained publication record that has no visible library membership when the user imports the same exact edition again.
- Preserve exact-edition identity, local-first deletion, and remote deletion convergence.

**Non-goals**:

- Changing duplicate behavior for a publication that is already visible in the library.
- Changing publication identity, remote paths, merge rules, or the library layout.
- Adding a general storage repair interface or changing deletion confirmation UI.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Re-import a removed publication (Priority: P1)

A reader removes a publication, later selects the same file for import, and gets a visible, usable library entry again.

**Why this priority**: The current mismatch blocks the reader from restoring a book even though the library appears empty.

**Independent test**: Create a publication, remove its visible membership while retaining a recoverable local publication record, import the same bytes, and verify that the result is added and visible rather than duplicate.

**Acceptance scenarios**:

1. **Given** an exact edition was removed and no visible library entry owns it, **When** the reader imports the same file, **Then** it is reported as added and appears in the library.
2. **Given** a retained publication record has lost its visible membership, **When** re-import validation fails, **Then** no incomplete visible entry remains and the failure is reported safely.

---

### User Story 2 - Keep deleted publications deleted during synchronization (Priority: P2)

A reader removes a publication while synchronization is configured, and an older remote book record cannot silently recreate a hidden local duplicate.

**Why this priority**: Preventing resurrection keeps local deletion authoritative and avoids recreating the same mismatch.

**Independent test**: Delete a logical-book variant, verify that its exact edition is excluded from legacy book restoration before the local deletion commits, and verify rollback if local deletion fails.

**Acceptance scenarios**:

1. **Given** a visible synchronized publication, **When** the reader removes it, **Then** its exact edition remains excluded from older remote book restoration while deletion converges.
2. **Given** local deletion fails, **When** the operation aborts, **Then** any newly added exclusion is rolled back and the still-visible publication continues to synchronize normally.
3. **Given** the reader successfully imports a previously excluded exact edition, **When** the import commits, **Then** synchronization includes that edition again as an intentional restoration.

### Edge Cases

- The stale local record has publication bytes but no logical-book membership.
- The stale local record is missing publication bytes and importing the same file repairs both bytes and membership.
- A logical book contains both EPUB and PDF variants and only one format is removed.
- A whole logical book is removed by deleting all variants together.
- Synchronization or its journal is unavailable after the local deletion commits.
- Publication validation fails after an orphaned record is tentatively repaired.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Omnia Reader MUST classify an exact edition as a duplicate only when it already belongs to a visible logical library entry at the start of import.
- **FR-002**: Importing a retained publication record without visible membership MUST restore a valid singleton membership without duplicating publication bytes or metadata.
- **FR-003**: Removing a logical-book variant MUST exclude every deleted exact edition from legacy book restoration before the local deletion can race with synchronization.
- **FR-004**: If local deletion fails, Omnia Reader MUST roll back only the exclusions introduced by that failed operation.
- **FR-005**: A successful import or logical variant creation MUST include the exact edition in synchronization again.
- **FR-006**: Local deletion and import MUST remain successful when the synchronization journal is unavailable, while reporting synchronization as pending where the existing UI already does so.
- **FR-007**: Existing visible exact editions MUST retain the current duplicate result and MUST NOT be destructively rewritten.

### Key Entities and Durable State _(include when data changes)_

- **Publication record**: Exact-edition metadata and bytes identified by its SHA-256 book ID; it may require membership repair if retained without a logical owner.
- **Logical book membership**: The visible relationship between a publication variant and its library card.
- **Book synchronization exclusion**: Device-local intent preventing an older remote publication record from resurrecting a locally deleted exact edition.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- Deletion, re-import, membership repair, and exclusion updates must work without a provider or network connection. A journal failure must not roll back a completed local mutation.

**Security and trust**

- Re-imported bytes and retained records remain subject to the existing format, SHA-256, size, metadata, and renderer validation boundaries.

**Accessibility and interaction**

- Existing import status announcements and library controls retain their keyboard, focus, accessible-name, pointer, and touch behavior; only the added-versus-duplicate outcome changes for invisible orphaned records.

**Platform and compatibility**

- The behavior applies to the shared web/PWA and Tauri library repository. No browser-specific provider behavior or native contract changes are introduced.

**Lifecycle and performance**

- Re-import performs at most one bounded logical membership lookup per pre-existing publication and does not duplicate publication storage.

**Migration and compatibility**

- No durable schema migration is required. Existing valid records, backups, exact-edition identifiers, synchronized paths, and visible duplicate behavior remain compatible.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In 100% of focused tests, re-importing a removed exact edition produces one visible library entry and an added outcome.
- **SC-002**: In 100% of focused tests, a successful variant deletion prevents legacy synchronization from restoring that edition, while a failed deletion restores its previous synchronization eligibility.
- **SC-003**: Existing visible duplicate imports continue to produce one duplicate outcome and zero additional library entries.
- **SC-004**: Focused application and persistence tests, lint, and the production application build pass without a durable schema version change.

## Acceptance Evidence _(mandatory)_

- Focused persistence tests must reproduce an orphaned publication record and prove that exact-edition import repairs its visible membership without duplicating storage.
- Focused import and association-service tests must cover added-versus-duplicate classification, exclusion ordering, rollback, successful re-inclusion, and journal failure.
- Application unit tests and lint must pass; a production application build is required because application orchestration changes.
- A real-browser test is not required because the regression is deterministic repository and service orchestration with no changed browser interaction contract.
- Provider, PWA, native packaging, emulator, and physical-device gates are not applicable to this local regression; live synchronization remains covered by the existing provider release gates.

## Assumptions

- A publication is visible only when a logical library entry owns its exact-edition variant.
- The legacy book synchronizer remains active during the logical-book transition and honors persistent device-local exclusions.
- Re-importing the same bytes is an explicit user intent to restore that exact edition and therefore clears its deletion exclusion after the local import succeeds.
