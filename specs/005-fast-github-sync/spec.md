# Feature Specification: Fast GitHub Synchronization

**Feature Directory**: `005-fast-github-sync`

**Created**: 2026-08-02

**Status**: Approved for implementation

**Input**: User description: "Improve GitHub sync to be faster and smoother. Expecially when GitHub sync is already up to date and therefore not needed at all."

## Outcome and Scope _(mandatory)_

**Outcome**: Readers get an almost immediate successful result when their local
library and selected GitHub destination are already synchronized, without
re-reading or rewriting the synchronized library.

**In scope**:

- Detecting an unchanged selected GitHub destination before expensive document
  and publication synchronization begins.
- Remembering only enough device-local checkpoint state to prove that a later
  unchanged check is safe.
- Falling back to the complete existing merge and transfer behavior whenever
  local work is pending, the remote destination changed, or the checkpoint is
  unavailable or untrustworthy.
- Preserving automatic, startup, reconnect, background, and manual synchronization
  behavior while making their no-change outcome lightweight.

**Non-goals**:

- Changing synchronized document formats, paths, merge rules, tombstones, or
  publication identity.
- Changing GitHub authentication, permissions, repository selection, Git LFS
  transfer semantics, or credentials.
- Optimizing MEGA synchronization in this feature.
- Hiding provider failures or reporting a skipped check as a successful sync.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Finish an up-to-date sync immediately (Priority: P1)

A reader whose selected GitHub destination has not changed since the last
stable successful synchronization can open the app, return online, or request
synchronization without waiting for every synchronized record to be inspected
again.

**Why this priority**: Repeated no-change synchronization is the common case and
currently creates delay and unnecessary provider traffic without changing user
data.

**Independent test**: Complete one stable synchronization, repeat it with no
local or remote changes, and observe a successful zero-change result after a
single lightweight remote-state check with no document, publication, or mutation
requests.

**Acceptance scenarios**:

1. **Given** a stable successful GitHub synchronization checkpoint and no pending
   local operations, **When** the selected destination still has the same remote
   state, **Then** synchronization completes successfully without running the
   document and publication workers.
2. **Given** the same state after an application restart, **When** startup
   synchronization runs, **Then** the durable checkpoint enables the same
   lightweight zero-change result.
3. **Given** local reading remains available but the remote-state check fails,
   **When** synchronization runs, **Then** it reports the existing safe provider
   failure and does not claim success or alter local data.

---

### User Story 2 - Never skip real synchronization work (Priority: P2)

A reader continues to receive changes from another device and publish durable
local changes even when a previous synchronization checkpoint exists.

**Why this priority**: The optimization is useful only if it cannot conceal real
work or weaken deterministic synchronization.

**Independent test**: Starting from a checkpoint, independently introduce a
pending local operation, a changed remote destination, an unstable full sync,
and an invalid checkpoint; each case must run the complete existing
synchronization path. A mutating or unstable pass may establish a checkpoint
only after an immediate bounded verification pass proves convergence.

**Acceptance scenarios**:

1. **Given** one or more pending local operations, **When** synchronization runs,
   **Then** it performs the complete merge and transfer path regardless of the
   remembered remote state.
2. **Given** no pending local operation but a changed remote destination, **When**
   synchronization runs, **Then** it performs the complete merge path and makes
   the remote changes available locally.
3. **Given** the remote destination changes during a full synchronization or the
   synchronization publishes changes, **When** that pass completes, **Then** the
   pass does not establish a checkpoint that could hide concurrent remote work.

### Edge Cases

- A first synchronization or missing checkpoint always uses the complete path.
- A checkpoint for a different provider, repository, or destination must never
  match the selected GitHub destination.
- Malformed, oversized, inaccessible, or storage-blocked checkpoint state is
  ignored without blocking synchronization or local reading.
- Cancellation during either the lightweight check or complete sync preserves
  pending local operations and does not advance the checkpoint.
- Repository recreation, default-branch replacement, or history rewrite appears
  as changed remote state and triggers a complete sync.
- An empty new repository can become a stable checkpoint only after a complete
  pass confirms no local publish work remains.
- Durable progress operations written by the early EPUB locator implementation
  may contain `position: -1` as an unknown-position sentinel. A fallback pass
  must preserve the locator, normalize that sentinel to an omitted position,
  and acknowledge the operation only after remote convergence.
- Valid remote progress for a publication that is unavailable on this device is
  ignored until the publication is available; it is not malformed remote work
  and must not permanently veto a stable checkpoint.
- This change adds no visible controls, focus behavior, or pointer/touch behavior.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Omnia Reader MUST obtain a bounded, opaque state identifier for
  the currently selected GitHub synchronization destination without listing or
  downloading synchronized documents or publications.
- **FR-002**: Omnia Reader MUST persist a device-local checkpoint only after a
  successful complete synchronization that performed no remote mutations and
  observed a stable remote state for the duration of the pass.
- **FR-003**: When there are no pending local operations and the current remote
  state matches the trusted checkpoint, Omnia Reader MUST return a successful
  zero-change result without invoking document, merge, or publication workers.
- **FR-004**: When local operations are pending, remote state differs, or the
  checkpoint is absent, invalid, inaccessible, or belongs to another
  destination, Omnia Reader MUST perform the complete existing synchronization
  path.
- **FR-005**: Omnia Reader MUST NOT advance a checkpoint after cancellation,
  failure, conflict, rejected work, remote mutation, or a remote state change
  observed during the complete pass.
- **FR-006**: Checkpoint persistence failure MUST NOT turn a successful complete
  synchronization into a failure or prevent future complete synchronization.
- **FR-007**: Provider errors and rate limits from the remote-state check MUST
  retain the existing safe retry, status, and local-first behavior.
- **FR-008**: The optimization MUST apply to manual and automatic GitHub
  synchronization through their shared worker path and MUST leave MEGA behavior
  unchanged.
- **FR-009**: The lightweight result MUST remain compatible with current sync
  status counts and history, reporting zero pulled, pushed, conflicted, and
  rejected items.
- **FR-010**: A fallback pass MUST normalize the legacy EPUB unknown-position
  sentinel in durable progress operations without discarding reading progress,
  and MUST distinguish valid unavailable-book progress from malformed records
  so neither condition permanently prevents convergence.

### Key Entities and Durable State _(include when data changes)_

- **GitHub synchronization checkpoint**: A bounded, device-local convenience
  record containing its schema version and opaque selected-destination state.
  It contains no credentials or synchronized library data, may be discarded at
  any time, and is replaced only after a stable successful complete pass.
- **Remote destination state**: An opaque value scoped to the selected
  repository and branch whose equality means the GitHub destination has not
  changed between checks. Its internal provider identifiers are not shown to
  users or synchronized to another device.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- Local reading and durable mutations remain fully available offline. Failed or
  interrupted checks leave the journal and last trusted checkpoint unchanged;
  normal automatic retry remains authoritative.

**Security and trust**

- The gateway remains the credential boundary. Remote identifiers and local
  checkpoint input are bounded and validated, and neither contains reusable
  credentials, provider responses, or user-controlled paths.

**Accessibility and interaction**

- Existing accessible sync status and cancellation behavior remain unchanged;
  the optimization introduces no new interaction or visual state.

**Platform and compatibility**

- Web/PWA and Tauri-hosted web clients share the same behavior. No renderer,
  browser-engine-specific, Android-native, or desktop-native behavior changes.

**Lifecycle and performance**

- A trusted no-change synchronization performs exactly one lightweight remote
  state request, zero synchronized-document or publication transfers, and zero
  remote mutations. Under a local fake-provider test it completes in under
  100 ms; live latency remains provider/network dependent.
- A fallback pass reuses its fetched progress, bookmark, and annotation
  snapshots instead of issuing one read per local record. Only an optimistic
  conflict may trigger a fresh individual read, and the three independent state
  workers run with bounded concurrency after publication restoration.
- GitHub document listings fetch matching provider blobs with concurrency
  bounded to eight while preserving deterministic result order.
- The checkpoint is bounded to at most 2 KiB and creates no background loop,
  worker, listener, or unbounded cache.

**Migration and compatibility**

- No synchronized record, backup, session, or remote layout migration occurs.
  During an ordinary fallback pass, legacy durable progress operations using
  the former EPUB `position: -1` sentinel are normalized in memory and removed
  from the journal only after the current remote document is confirmed or
  updated. Older clients and gateways remain data-compatible; deployment must
  update the browser client and gateway together before the optimization is
  available.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Repeating a stable, already up-to-date GitHub synchronization uses
  one remote request and transfers zero synchronized documents and publications.
- **SC-002**: The focused no-change test completes in under 100 ms and reports
  zero pulled, pushed, conflicted, and rejected items.
- **SC-003**: Every tested pending-local, changed-remote, missing/invalid
  checkpoint, cancellation, failure, and unstable-pass case runs or preserves
  the complete safe synchronization behavior without data loss.
- **SC-004**: Existing GitHub gateway, Git client, sync-core, and application
  synchronization suites pass without changing synchronized formats or user
  interaction.

## Acceptance Evidence _(mandatory)_

- Focused gateway contract tests prove the opaque remote-state response uses one
  bounded GitHub read, handles empty repositories, and preserves safe errors.
- Focused Git client tests prove response validation and the exact single-request
  no-change path.
- Focused sync-core tests prove checkpoint establishment, restart persistence,
  no-change short-circuiting, all fallback conditions, cancellation, and
  concurrent-change safety.
- Application integration tests prove manual and automatic sync share the
  optimized worker and continue to report accessible zero-change status.
- A real-browser GitHub journey is required with a fake same-origin gateway;
  credentialed live GitHub timing and request-count evidence is a separate gate
  and must be reported unavailable unless it actually runs.
- Lint and production builds are required for every affected Nx project and the
  application/gateway bundles.

## Assumptions

- Every durable local change that requires synchronization is represented in the
  existing operation journal before automatic synchronization is requested.
- Equality of the selected repository's branch state is an authoritative signal
  that its synchronized content did not change.
- Provider network latency is outside the local 100 ms test threshold; the
  production outcome is bounded primarily by one remote round trip.
