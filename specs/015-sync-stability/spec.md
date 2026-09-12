# Feature Specification: Production-Ready Synchronization

**Feature Directory**: `015-sync-stability`

**Created**: 2026-09-11

**Status**: Approved for implementation

**Input**: User description: "Finalize the synchronization feature to reach a stable, production-ready version."

## Outcome and Scope _(mandatory)_

**Outcome**: Readers can rely on GitHub synchronization as a stable feature in
production: two devices converge without data loss, local reading remains
authoritative during failures, authentication and provider disruptions recover
safely, and operators have repeatable evidence that the deployed service is
secure and recoverable. MEGA remains clearly identified as experimental until
its independent live-provider acceptance gates pass.

**In scope**:

- Promote the existing GitHub and Git LFS synchronization path from a tested
  implementation to a production-supported capability.
- Make complete two-device convergence, interruption, conflict, deletion, and
  recovery journeys mandatory release evidence on every supported browser.
- Validate authentication, authorization changes, provider throttling, large
  publication transfer, service restart, and shared-session behavior against a
  disposable live GitHub environment reached through HTTPS.
- Validate the supported desktop and Android hosts against the same observable
  synchronization contract before those packages advertise stable sync.
- Establish deployment, monitoring, canary, rollback, image-integrity, and
  incident-diagnostic evidence for the synchronization service.
- Present provider maturity and unavailable capabilities truthfully to readers.

**Non-goals**:

- Add new synchronized record types or change the current library, progress,
  bookmark, annotation, publication, or tombstone semantics.
- Require partial-transfer or byte-range resume; safe whole-transfer retry is
  sufficient for this stability milestone.
- Guarantee delivery after a browser or operating system forcibly terminates
  the application; durable pending work must instead resume on the next run.
- Promote MEGA to stable before its separate live account, quota, race,
  interruption, session, and production-image gates pass.
- Change reader rendering, library management, or the unrelated cross-platform
  performance feature except where a synchronization release gate directly
  exercises those surfaces.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Trust synchronization across devices (Priority: P1)

A reader connects a private GitHub destination, imports EPUB and PDF books, and
uses two devices. Publications, progress, bookmarks, highlights, notes, and
deletions converge without either device losing a valid contribution.

**Why this priority**: Cross-device convergence without loss is the core promise
that must be true before synchronization can be called stable.

**Independent test**: Start with two clean application profiles and a clean
private destination, create distinct changes on both profiles, synchronize in
both directions, and verify identical valid library state and exact publication
bytes on both profiles and at the remote destination.

**Acceptance scenarios**:

1. **Given** two clean devices connected to the same empty destination, **When**
   each device contributes different reading state and one device contributes
   an EPUB and a PDF, **Then** both devices converge on every valid contribution
   and restore publication bytes matching the original editions.
2. **Given** one device is offline while both devices edit different records,
   **When** the offline device reconnects and synchronization completes,
   **Then** deterministic merging preserves both contributions and no stale
   record resurrects a deletion tombstone.
3. **Given** a previously synchronized destination and a clean replacement
   device, **When** the reader reconnects that destination, **Then** the complete
   readable library and reading state can be restored without access to the
   original device.

---

### User Story 2 - Recover safely from real failures (Priority: P1)

A reader can continue reading and editing locally when authentication expires,
permissions change, the network disappears, the provider throttles requests, a
transfer is interrupted, or the synchronization service restarts. The reader
sees a safe next action, and pending work succeeds later without duplication or
data loss.

**Why this priority**: A feature that succeeds only on an uninterrupted path is
not production-stable and could undermine the offline-first product promise.

**Independent test**: Inject each supported failure into a live-provider
journey, confirm the local operation remains durable and usable, restore the
dependency or authorization, and verify one successful convergence without
dangling publication references or duplicated records.

**Acceptance scenarios**:

1. **Given** a publication upload is interrupted before publication, **When**
   the reader retries after connectivity returns, **Then** no incomplete remote
   reference is visible and the exact publication is eventually synchronized.
2. **Given** a provider session expires or repository permission is removed,
   **When** synchronization runs, **Then** local reading continues, the user sees
   a provider-independent recovery action, and unrelated destination or library
   state is retained.
3. **Given** a provider throttles synchronization, **When** local changes keep
   arriving, **Then** automatic work observes the retry deadline without a
   request burst and later converges all pending changes.
4. **Given** the synchronization service is restarted during active use,
   **When** the user resumes synchronization, **Then** valid sessions and
   pending local work recover according to the documented availability policy.

---

### User Story 3 - Operate synchronization with confidence (Priority: P2)

An operator can deploy a specific synchronization release, verify its health
through the public HTTPS route, detect actionable failures without exposing
credentials, rotate service keys, restore shared session state, canary a new
version, and roll back application code without losing readers' local data.

**Why this priority**: Repeatable operational recovery is required to keep a
functionally correct feature dependable after deployment.

**Independent test**: Promote one immutable release through a staging canary,
run the complete readiness probe and credentialed smoke journey, rotate the
active session key, restart service replicas, restore a session-store backup,
and execute the documented rollback while local libraries remain usable.

**Acceptance scenarios**:

1. **Given** a candidate release and production-shaped staging environment,
   **When** the operator runs the release gate, **Then** the exact deployed
   artifacts, public security boundary, provider connection, session
   continuity, and recovery journey are verified before promotion.
2. **Given** a canary exposes an actionable synchronization regression, **When**
   the operator invokes rollback, **Then** service traffic returns to the last
   accepted version without rolling back durable local schemas or deleting
   pending reader work.
3. **Given** diagnostic logs and reports from successful and failed journeys,
   **When** they are inspected or exported, **Then** they contain sufficient
   correlation and outcome information but no credentials, reusable sessions,
   provider transfer URLs, publication contents, or provider-controlled error
   text.

---

### User Story 4 - Understand provider maturity (Priority: P2)

A reader can distinguish the supported GitHub synchronization path from the
experimental MEGA path before connecting a provider and whenever recovery help
is shown.

**Why this priority**: Truthful maturity labels prevent an implemented but
unproven provider from weakening the stable release claim.

**Independent test**: Exercise supported and experimental presentation metadata
in isolation across synchronization setup and recovery on every supported
viewport. Verify that each supplied maturity is announced consistently and that
historical success cannot change it. The production GitHub value remains
experimental until the final candidate evidence is accepted.

**Acceptance scenarios**:

1. **Given** a reader opens synchronization setup, **When** provider choices are
   displayed, **Then** the supported and experimental providers have distinct,
   accessible maturity labels and concise consequences.
2. **Given** an experimental-provider session has succeeded previously,
   **When** the reader returns after restart or sees an error, **Then** the
   experimental label remains truthful and historical success is not presented
   as production support.

### Edge Cases

- Two devices concurrently create, update, or delete the same logical record;
  deterministic conflict rules converge and deletion tombstones are not
  silently resurrected.
- A remote manifest, child record, pointer, publication, declared size, or
  digest is malformed, inconsistent, missing, duplicated, or from an unknown
  future schema; synchronization fails closed while valid local data remains
  usable and the unsafe remote material is not imported.
- A destination is switched while work is pending; work and success history
  remain scoped to the correct destination and never leak into the new one.
- Authentication is cancelled, refreshed concurrently, revoked by webhook, or
  invalidated during disconnect; no detached authority remains usable.
- A large transfer is cancelled, the browser closes, the service restarts, or
  the network fails at each publication-ordering boundary; retry never exposes
  an incomplete publication or acknowledges unfinished local work.
- The session store is temporarily unavailable or restored from backup; the
  gateway fails closed and the application remains locally usable.
- Narrow viewport, keyboard-only, touch, and screen-reader users can identify
  synchronization state, cancel a transfer, and reach the correct recovery
  action without relying on color or pointer hover.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Omnia Reader MUST synchronize exact EPUB and PDF editions,
  library membership, per-device progress, bookmarks, annotations, and their
  deletion tombstones between two devices through the supported provider.
- **FR-002**: Omnia Reader MUST converge distinct valid contributions from two
  devices deterministically without silently discarding data or resurrecting a
  stale deletion.
- **FR-003**: A clean replacement device MUST be able to restore the complete
  synchronized library and reading state from the configured destination.
- **FR-004**: Local imports, reading, progress, bookmarks, annotations, and
  library management MUST remain available when synchronization is absent,
  offline, throttled, unauthorized, interrupted, or unavailable.
- **FR-005**: Local durable work MUST be recorded before synchronization is
  attempted and MUST remain pending until the corresponding remote outcome is
  confirmed.
- **FR-006**: Remote records and publication bytes MUST be rejected before
  import when their schema, identity, declared size, digest, path, media type,
  or root ownership is invalid.
- **FR-007**: Publication bytes MUST become remotely referenceable only after
  the complete immutable object has been uploaded and a provider read-after-write
  check confirms its declared size and SHA-256 digest. Only then may the
  manifest or pointer referencing it be published.
- **FR-008**: Interrupted, cancelled, or timed-out synchronization MUST preserve
  a retryable local operation and MUST NOT leave a dangling remote publication
  reference.
- **FR-009**: Authentication cancellation, expiry, revocation, refresh failure,
  disconnect, and destination-permission loss MUST expose a safe recovery action
  without clearing unrelated reader data or displaying provider-controlled
  error text.
- **FR-010**: Provider throttling MUST delay automatic retries according to a
  bounded retry deadline and MUST coalesce new local work rather than producing
  a request burst. At most one automatic synchronization may be active per
  destination, and no retry may start before a valid `Retry-After` deadline.
- **FR-011**: Synchronization success, failure, cancellation, offline state,
  pending work, active transfer progress, provider maturity, and next action
  MUST remain truthful after navigation and application restart.
- **FR-012**: Browser-readable code MUST reach the production synchronization
  service only through the application's authenticated HTTPS origin. Packaged
  hosts MUST use a narrow privileged platform boundary that is restricted to
  the configured HTTPS service and does not expose reusable authority to the
  application webview. Both paths MUST fail closed when required provider or
  session configuration is incomplete.
- **FR-013**: Reusable provider authority and service secrets MUST never be
  stored in browser-readable application data, synchronized documents, URLs,
  publication metadata, or diagnostic output.
- **FR-014**: A production deployment MUST preserve active session continuity
  across the supported service restart and replica lifecycle and MUST define a
  tested recovery procedure for shared session-state loss.
- **FR-015**: Every production artifact MUST have an immutable identity and MUST
  pass the required integrity, vulnerability, and authenticity checks before
  promotion.
- **FR-016**: Operators MUST be able to canary and roll back a synchronization
  service release without reversing durable local schemas or deleting local
  libraries and pending operations.
- **FR-017**: Complete simulated two-device synchronization and recovery
  journeys MUST run as mandatory release gates rather than optional tests.
- **FR-018**: Live credentialed GitHub conformance MUST pass through the same
  public HTTPS boundary and provider permissions used by the release
  environment. Production-shaped staging means the release container images,
  public reverse proxy, HTTPS, shared Redis session store, and disposable private
  GitHub destination are used without test-only authentication or provider
  control routes.
- **FR-019**: The stable synchronization contract MUST be verified on Chromium,
  Firefox, WebKit, Linux, Windows, and macOS packaged desktop hosts, and an
  Android emulator;
  any unavailable physical-device gate MUST be reported explicitly before a
  distribution claim is made.
- **FR-020**: GitHub synchronization MUST be presented as supported only after
  all mandatory release evidence passes; MEGA MUST remain labeled experimental
  until its independent completion gates pass.

### Key Entities and Durable State _(include when data changes)_

- **Synchronization destination**: The provider-scoped remote root selected by
  a reader. Readiness, pending work, history, and recovery state belong to one
  destination and must not transfer implicitly to another.
- **Pending synchronization operation**: Durable evidence that a completed
  local mutation still requires a confirmed remote outcome. It survives
  failure, cancellation, restart, and provider throttling until acknowledged.
- **Provider session**: Server-held authority for one provider and reader
  session. Its lifecycle includes creation, rotation, revocation, expiry,
  restart continuity, and fail-closed recovery.
- **Release evidence set**: The immutable collection of automated, browser,
  live-provider, deployment, security, and recovery results that authorizes a
  specific synchronization release and provider-maturity label.
- **Existing synchronization records**: Current manifests, publications,
  progress, bookmarks, annotations, exclusions, and tombstones retain their
  existing identities and merge semantics; this feature introduces no new
  synchronized record type or incompatible schema.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- Every failure exercise must prove that the local library remains readable and
  editable, unfinished work remains recoverable, and a later valid attempt
  converges exactly once without manual data repair.
- Service, browser, and network restart tests must cover interruption before
  upload, after object upload but before publication, during document conflict,
  and before local acknowledgement.

**Security and trust**

- Live and simulated tests must treat provider responses and synchronized data
  as hostile and verify path, schema, size, digest, content-type, authorization,
  origin, and request-forgery boundaries before state changes.
- Credential scans must cover browser storage, synchronized data, generated
  reports, application and gateway logs, redirect locations, and transfer
  metadata using unique test-only canaries.
- Production promotion requires a reviewed vulnerability result, signed release
  artifacts, immutable artifact identities, and non-sensitive externally
  observable errors.

**Accessibility and interaction**

- Provider labels, synchronization status, transfer progress, cancellation, and
  recovery actions must expose accessible names and state, remain keyboard and
  touch operable, announce meaningful state changes, preserve focus after
  cancellation or errors, and not rely on color alone.

**Platform and compatibility**

- Mandatory browser evidence covers current supported Chromium, Firefox, and
  WebKit engines with isolated persistent profiles and exact publication-byte
  assertions.
- Packaged desktop and Android evidence covers provider connection, one complete
  synchronization, restart, offline local use, and recovery from one
  authorization or network failure. Physical-device evidence is required for a
  physical-device support claim and otherwise remains explicitly unverified.
- Provider-specific capabilities may have different maturity labels, but they
  must preserve the same local-first data and security guarantees.

**Lifecycle and performance**

- The synchronization staging profile uses two logical CPUs, 4 GiB of memory,
  100 ms round-trip latency, 10 Mbit/s symmetric bandwidth, no injected packet
  loss, the one-second reading-state quiet period, and the ten-second active
  remote-revision poll. It records 20 warm-up and at least 200 measured targeted
  reading-state attempts per candidate.
- Under the documented staging network profile, 95 percent of targeted
  reading-state synchronization attempts complete within 2 seconds after their
  configured quiet period, and an unchanged synchronization performs no
  publication transfer.
- A 25 MiB publication synchronization must expose monotonic progress, remain
  cancellable, and leave no dangling reference after cancellation. The native
  broker may retain at most 8 MiB of unacknowledged body data per transfer and
  its additional resident memory must remain within 64 MiB of the post-session
  idle baseline in the controlled Linux and Android profiles.
- Visible polling, throttling, queued work, navigation, and teardown must not
  create duplicate concurrent synchronization, unbounded timers, or request
  bursts.

**Migration and compatibility**

- The existing synchronization schema and valid persisted provider selections,
  pending operations, histories, and sessions must remain compatible through
  the stabilization release.
- Release rollback may revert application or service code only when the prior
  version can safely read all durable state produced by the candidate. Durable
  schemas use forward repair rather than destructive rollback.
- A corpus representing every supported current and legacy synchronization
  schema must pass restore, merge, rejection, and forward-compatibility checks
  before promotion.

**Operations and monitoring**

- The staging and canary environments must expose low-cardinality counts and
  latency distributions for synchronization outcomes, readiness failures,
  session renewal, provider throttling, cancellation, and recovery. Metrics and
  alerts must not contain account, repository, path, publication, credential, or
  session identifiers.
- Release evidence must prove that alert thresholds detect an injected readiness
  failure and elevated synchronization failure rate, and that the linked
  diagnostic correlation identifier resolves to sanitized application-owned
  logs.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In three consecutive release-candidate runs per supported browser,
  two clean devices synchronize an EPUB and a PDF plus distinct progress,
  bookmark, annotation, and deletion changes with 100 percent byte identity and
  no lost or resurrected record.
- **SC-002**: Every required interruption, conflict, authentication,
  authorization, throttling, restart, and corrupt-remote scenario preserves
  local usability and completes a successful retry without manual data repair.
- **SC-003**: In the documented staging network profile, at least 95 percent of
  targeted reading-state changes become visible on the second active device
  within 15 seconds, and at least 95 percent of manual targeted synchronizations
  finish within 2 seconds.
- **SC-004**: A 25 MiB publication can be synchronized, cancelled at each
  publication boundary, and retried successfully with zero incomplete remote
  references and monotonic user-visible progress.
- **SC-005**: Restarting or replacing synchronization service instances during
  a release exercise causes zero loss of valid shared sessions, local libraries,
  or pending operations under the documented availability policy.
- **SC-006**: Test-canary scans find zero credentials, reusable sessions,
  transfer URLs, provider-controlled messages, or publication contents in
  browser storage, synchronized records, redirects, logs, and release reports.
- **SC-007**: Keyboard, touch, narrow-viewport, and screen-reader acceptance
  journeys complete provider setup, status inspection, transfer cancellation,
  and recovery with no serious or critical accessibility violation.
- **SC-008**: One immutable candidate completes all mandatory deterministic,
  browser, packaged-host, credentialed-provider, deployment, security, canary,
  and rollback gates before GitHub synchronization is labeled stable.

## Acceptance Evidence _(mandatory)_

- Focused contract evidence for deterministic merges, tombstones, operation
  acknowledgement, immutable publication ordering, input validation, retry
  deadlines, session rotation, and destination isolation.
- Mandatory two-device simulated-provider journeys for Git and MEGA on Chromium,
  Firefox, and WebKit, repeated three times against isolated profiles.
- Credentialed GitHub App and Git LFS journeys through a production-shaped HTTPS
  deployment, including setup, two-device convergence, clean-device restore,
  cancellation, conflict, token refresh, revocation, permission loss, rate
  limiting, large objects, disconnect, and service restart.
- Shared production-shaped session-store evidence for multiple service
  instances, key rotation, webhook invalidation, backup, restore, failover, and
  fail-closed unavailability.
- Packaged desktop and Android-emulator synchronization, offline restart, and
  recovery journeys; unavailable physical-device results must be listed rather
  than inferred.
- Container and release evidence for public-route security, streaming, health,
  shutdown, immutable artifact identity, vulnerability scanning, signing,
  canary promotion, monitoring, rollback, and post-rollback synchronization.
- A release report mapping every requirement and success criterion to an exact
  artifact, command, environment identity, observed result, and remaining
  unavailable boundary.

## Assumptions

- GitHub and Git LFS are the supported priority synchronization provider for
  this milestone; MEGA remains available only with an experimental maturity
  label until a later promotion decision.
- The existing provider-neutral schema, merge rules, tombstones, operation
  journal, same-origin credential boundary, and safe whole-transfer retry are
  the behavioral baseline and do not require redesign.
- Disposable provider accounts, a private GitHub repository, HTTPS staging,
  multiple synchronization service instances, a production-shaped shared
  session store, supported browser engines, packaged desktop hosts, and an
  Android emulator can be made available for release acceptance.
- Provider outages and platform gates that cannot be exercised during a local
  run remain unverified; deterministic substitutes support development but do
  not satisfy the corresponding production gate.
