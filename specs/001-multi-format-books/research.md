# Phase 0 Research: Multi-Format Books

## Superseding persistence decision (2026-08-20)

Feature 010 replaced Decisions 7 and 8 only at the provider-storage layer.
The schema-2 compatibility gate, causal merge rules, tombstones, preference
authority, reconciliation records, and object-before-state ordering remain.
Current clients fold those outcomes into one bounded, optimistic
`.omnia-reader/logical-books/state.json`; append-only change files and
checkpoint pages are accepted only for migration and are removed after verified
canonical-state convergence.

## Decision 1: Separate logical-book and publication-variant identity

**Decision**: Keep `BookRecord.id` as the immutable `sha256:<digest>` identity
of one exact EPUB/PDF and introduce a separate `LogicalBookRecord` aggregate.
All progress, progress documents, bookmarks, annotations, binary metadata,
reader routes, sync variant state, and integrity validation remain keyed by the
variant ID.

**Rationale**: Current validators, OPFS names, backup entries, sync manifests,
locators, and reader loading all rely on `bookId` being the exact publication.
Separating the aggregate adds one-card grouping without rewriting incompatible
EPUB CFI and PDF location state.

**Alternatives considered**:

- Reusing `BookRecord.id` as a logical ID was rejected because it breaks
  exact-content identity and every variant-scoped consumer.
- Expanding one `BookRecord` to contain both files was rejected because it
  conflates shared catalog data with source identity.
- Metadata-derived grouping was rejected because it is ambiguous and violates
  explicit association.

## Decision 2: Add a v9 logical aggregate without rewriting variant state

**Decision**: Bump IndexedDB 8→9, add logical-book, logical-cover,
synchronized preferred-format, and durable membership-reconciliation stores,
and create singleton aggregates for valid existing books inside the
version-change transaction. Retain the existing variant stores and keys
unchanged. Use sparse unique indexes for EPUB/PDF membership and
repository-level referential/format validation.

**Rationale**: The version-change transaction is restart-safe and preserves
existing bytes and location state. Separate logical catalog metadata and cover
ownership preserve the destination presentation even if its original variant is
later detached or deleted.

**Alternatives considered**:

- Lazy grouping only in the UI was rejected because it cannot guarantee stable,
  atomic membership across restart, backup, or sync.
- Adding only a catalog-source pointer was rejected because deletion/detachment
  could silently change or lose shared presentation.
- Rekeying progress and annotations was rejected as unnecessary and unsafe.

## Decision 3: Make every aggregate mutation atomic at the repository boundary

**Decision**: Add explicit `addVariant`, `associate`, `detachVariant`, and
`deleteVariant` operations. Existing-entry association/detachment changes only
logical records in one transaction. Add-format stages and validates bytes, then
commits variant/binary metadata plus membership together. Delete commits
metadata/state first and cleans unreachable OPFS bytes best-effort afterward.

**Rationale**: The current batch import journals sources sequentially and would
expose a transient standalone card. A dedicated boundary provides complete
before-or-after state and lets optional sync start only after local durability.

**Alternatives considered**:

- Calling the current import flow and associating afterward was rejected because
  a failure can expose or synchronize an intermediate standalone entry.
- Copying bytes during association/detachment was rejected because membership
  can change without moving content-addressed sources.

## Decision 4: Preserve variant-based reader routes and lazy engines

**Decision**: Keep `/reader/:bookId` targeting the chosen variant. Resolve the
default/explicit variant in the library; load sibling membership only for the
format control. Before switching routes, flush progress and resolve transient
annotation/panel state. Let current route recreation tear down the old engine
and lazily load the new one.

**Rationale**: `ReaderEngineRegistry` already selects EPUB/PDF from the active
variant and the route reuse strategy recreates the reader when the ID changes.
No engine, locator, canvas, iframe, or worker contract needs association logic.

**Alternatives considered**:

- A logical-book reader route was rejected because it obscures which exact
  source owns locators and complicates refresh/deep links.
- Keeping both engines alive for instant switching was rejected because it
  increases memory and lifecycle risk.

## Decision 5: Reuse the platform picker contract

**Decision**: Reuse `PlatformPort.pickPublications()` for add-format, accept one
candidate, treat zero as cancellation, and report multiple selections before
mutation. Do not add Tauri/Rust/Android picker commands.

**Rationale**: Browser and Tauri adapters already produce validated publication
sources. This preserves identical host behavior and avoids expanding privileged
filesystem capabilities.

**Alternatives considered**:

- A new single-format native picker API was rejected because it adds host and
  permission surface without changing the durable outcome.

## Decision 6: Upgrade backup archives to schema 4

**Decision**: Keep exact publication entries and variant-scoped state, add
logical records/covers, synchronized preferred-format registers, and durable
membership-reconciliation records, and require each variant to belong to
exactly one non-empty logical book with at most one EPUB and one PDF. Restore
schemas 1–3 as singleton logical books without synthesizing a preference.
Validate the entire archive, then collect every conflict against one consistent
current-library snapshot before staging or mutation. A conflict-free restore
uses one commit or complete before-image rollback.

**Rationale**: Existing archive schema 3 is exact-edition shaped and its current
rollback only removes newly added books. Schema 4 can remain backward-data
compatible while closing the atomicity gap required by association.

**Alternatives considered**:

- Duplicating logical metadata into each variant was rejected because metadata
  can drift and detach becomes nondeterministic.
- Writing schema 3 plus an optional sidecar was rejected because old restorers
  could silently flatten the library.

## Decision 7: Use a hard sync compatibility gate and atomic canonical state

**Decision**: Bump the root manifest from schema 1 to 2 and keep it at the
current `.omnia-reader/manifest.json` path. Publish verified variant objects
first, then write one optimistic canonical logical state document. Old clients
reject root schema 2; current clients may migrate schema 1 only before a
compare-and-swap upgrade.

**Rationale**: Adding a feature string is insufficient because old validation
accepts unknown feature names. A root version mismatch is already a hard gate,
and one revision-guarded canonical document is the atomic membership commit
across transports.

**Alternatives considered**:

- Adding `logicalBookId` to each old edition manifest was rejected because
  multiple mutable documents expose partial association.
- Timestamp last-write-wins was rejected because device clocks are not a
  deterministic authority.
- Provider-specific transactions were rejected because Git and MEGA must share
  one provider-neutral contract.

## Decision 8: Merge causally into bounded canonical state

**Decision**: Changes declare observed parent heads and complete resulting work
snapshots. Fold ancestors first; order concurrent changes by opaque change ID.
If a concurrent change violates unique membership or format cardinality, keep
the deterministic winner and preserve the losing variant in its last accepted
membership while creating a deterministic, durable reconciliation record.
Only an explicit child reconciliation change can resolve that record or change
the accepted association. Tombstones use the same order. Store accepted state,
preference heads, and open/resolved reconciliation authority in one bounded,
canonical document with per-record clocks; offline changes deterministically
reapply against the latest verified state.

**Rationale**: Device-local journal revisions and timestamps cannot order
devices. Causal parents plus a deterministic tie-break converge without data
loss, while one bounded document prevents an unbounded provider listing.

**Alternatives considered**:

- Coalescing by logical-book ID was rejected because it can erase causally
  distinct detach/delete operations.
- Deleting old history without verified canonical clocks/tombstones was
  rejected because it can resurrect membership or strand offline clients.

## Decision 9: Synchronize preferred format as an independent causal register

**Decision**: Persist `preferredFormat: 'epub' | 'pdf'` separately from logical
membership and synchronize it through preference effects in the immutable
logical-change stream. A successful explicit format choice emits a change only
when the preferred format changes. Descendant choices dominate ancestors;
concurrent choices use the existing lexicographic change-ID tie-break. A
locally unavailable winning format remains durable while this opening uses the
sole healthy variant, then EPUB, then PDF, without publishing the fallback.

**Rationale**: Format, rather than exact variant ID, expresses the approved
cross-device choice while remaining valid if an exact source is recovered or
replaced. Keeping preference in its own merge domain prevents harmless choices
from becoming membership conflicts and guarantees that preference folding does
not inspect or rewrite progress, bookmarks, annotations, or source state.

**Alternatives considered**:

- Device-local last-opened state was rejected by the clarified cross-device
  requirement.
- Storing preference inside complete logical-book snapshots was rejected
  because concurrent choices could overwrite membership.
- Timestamp last-write-wins was rejected because device clocks are not merge
  authority.
- Writing the healthy fallback was rejected because a temporary local outage
  must not overwrite the reader's synchronized choice.

## Decision 10: Use existing dependencies and boundaries

**Decision**: Use current hashing, archive, IndexedDB, journal, provider
transport, dialog, and engine facilities. `reader-core`, format engines,
platform adapters, gateway security, native commands, and provider credential
handling remain unchanged.

**Rationale**: The Nx graph already provides the necessary ownership and lazy
dependencies. Avoiding new dependencies preserves bundle and supply-chain
budgets.

**Alternatives considered**:

- A new grouping or merge library was rejected because the invariant set is
  small, project-specific, and already supported by existing primitives.

## Decision 11: Make the assistive-technology matrix a fixed release gate

**Decision**: Audit the complete multi-format management journey with NVDA and
Firefox on Windows, VoiceOver and Safari on macOS, and TalkBack with Android
WebView. The evidence record covers add, associate, choose, detach, delete,
synchronization reconciliation, all-variants-unavailable management, and
restore-conflict reporting. A combination that cannot be run is recorded as
unverified and never counted as passing.

**Rationale**: Automated accessibility checks establish semantic baselines but
cannot prove real screen-reader announcements, focus sequencing, or completion
without visual interpretation across the supported host classes. Fixing the
matrix makes SC-005 objective and preserves the constitution's distinction
between passed and unavailable platform gates.

**Alternatives considered**:

- Automated Chromium accessibility checks alone were rejected because they do
  not exercise screen-reader/browser interaction.
- An unspecified audit with any one screen reader was rejected because it would
  allow inconsistent release evidence and leave desktop or Android behavior
  unverified without saying so.

## Decision 12: Derive health locally at authoritative source boundaries

**Decision**: Do not persist or synchronize a healthy/available boolean. Return
a device-local discriminated `VariantAvailability` from repository resolution.
A variant is healthy only when its active metadata and binary reference
validate, detected EPUB/PDF format agrees with the record, bytes are accessible
and size-complete, and their SHA-256 equals the variant ID. Authoritative open,
ingestion, restore/download, and exact-source replacement perform exact verification; digest or
format mismatch quarantines the invalid active reference before renderer use.
Lightweight library listing may expose checking/unavailable status but cannot
claim unverified bytes are healthy.

Availability is a status-plus-cause result. Missing, evicted, inaccessible, or
incomplete bytes return `unavailable` with that cause. Invalid metadata/reference,
digest mismatch, or format mismatch is isolated and returns `quarantined` with
cause `malformed-reference`, `integrity-invalid`, or `unsupported`. Exact-source
replacement is always available; verified synchronized-download retry is
available only for a known exact remote object. Neither recovery path changes
identity, membership, reading state, preference, or logical sync history.

**Rationale**: Availability can change through OPFS eviction, permission loss,
corruption, or exact-source replacement without a logical-book mutation. A durable boolean would
be stale and would incorrectly become backup or synchronization authority.
Exact verification at trust/open boundaries protects the renderer while
avoiding an eager hash of every source during a 1,000-book library listing.

**Alternatives considered**:

- A durable `healthy` field was rejected because device-local storage state can
  change independently of that record.
- Trusting only a stored availability flag or byte length was rejected because
  same-size corruption and format mismatch would remain undetected.
- Opening the reader engine to determine health was rejected because unverified
  hostile bytes must not reach a renderer and engine creation is not a library
  selection probe.

## Decision 13: Use dual monotonic timings and immutable minimum profiles

**Decision**: Measure `acknowledgementMs` from the page activation event to the
first painted visible busy/progress/success/failure state, and
`finalResultMs` from the same event to an action-specific final result. Use the
page monotonic clock and one `requestAnimationFrame` after the qualifying state.
Run four immutable primary profiles—`desktop-web-v1`, `mobile-web-v1`,
`packaged-desktop-v1`, and `android-v1`—whose CPU, memory, power mode, OS,
browser/WebView, viewport, and fixture identities are frozen from a clean
`npm ci` installation of the committed lockfile in `performance/profiles-v1.json`.
Use separate drivers for desktop Playwright, mobile Chrome, packaged desktop,
and Android WebView; native profiles build release artifacts before preflight.
Faster/unconstrained results are supplemental. The acknowledgement denominator
is the closed 14-branch matrix: success and failure for add, associate, detach,
delete variant, reconcile, replace source, and restore conflict handling.

**Rationale**: Node-side Playwright timing includes dispatch and polling noise,
while a visible busy state is meaningful acknowledgement but not task
completion. Versioned minimum profiles make absolute thresholds comparable
between releases and prevent a fast developer machine from establishing the
release pass.

**Alternatives considered**:

- One activation-to-final interval was rejected because it cannot prove the
  separate one-second acknowledgement contract.
- Node-side timers were rejected because they do not share the page event/paint
  clock.
- Viewport emulation or CPU throttling alone was rejected because neither fixes
  host CPU, memory, OS, power, or runtime versions.
- Accepting any documented device was rejected because results would not remain
  comparable across releases.

## Decision 14: Make the two format badges the complete card-level format surface

**Decision**: Always render one EPUB badge and one PDF badge in a stable order.
A present-format badge displays that exact variant's canonical whole-number
progress and opens it when healthy. Valid normalized progress uses `100%` only
at completion and otherwise `min(99, round(100 * clamp(p, 0, 1)))%`; the card
does not expose a settled state until batched progress resolution completes.
Checking, unavailable, and quarantined badges remain focusable with
`aria-disabled="true"` and described status semantics but cannot open or trigger
recovery. A missing-format
badge displays `Add` and opens a named choice surface that reuses the existing
add-local and associate-existing flows for that format. Cancellation/failure
returns focus to the missing badge; success focuses the same slot after it
becomes present. Remove separate Read EPUB, Read PDF, Add format, and Associate
existing card buttons. Keep detach, delete, export, recovery, and reconciliation
management outside this compact format-choice row. Use the closed 48-row
settled-card matrix from the specification as the SC-007 denominator.

**Rationale**: The user wants one compact, predictable interaction surface. Two
stable badges make available and missing formats immediately comparable, keep
independent progress next to its owner, and avoid four competing card actions.
Reusing the established orchestration preserves atomic local writes, candidate
filtering, hostile-file validation, journaling, and dialog semantics without a
new durable or platform contract.

**Alternatives considered**:

- Hiding the missing format's badge was rejected because add/associate would
  need a separate card control again.
- Making badge activation immediately open the file picker was rejected because
  it would hide the existing-entry association path and make the two actions
  inaccessible or dependent on secondary gestures.
- Combining add and associate automatically from metadata was rejected because
  association must remain an explicit reader choice.
- Keeping separate Read/Add/Associate buttons beside decorative badges was
  rejected because it duplicates the format interaction surface and contradicts
  the requested compact design.

## Resolved Unknowns and Residual Risk

All technical clarifications are resolved for planning. The badge choice is
transient UI state and adds no durable entity, migration, sync field, host API,
or dependency. Implementation must
still prove: report-all restore preflight plus full rollback for pre-existing
records; v1→v2 provider compare-and-swap under interruption; already-running
old-client overlap; bounded canonical state that retains preference and
reconciliation authority; progress flush and annotation-draft handling during
format switch; exact-source health verification without eager library hashing;
v1 profile availability/version drift; and identical Git/MEGA membership,
preference, and reconciliation convergence. These are verification gates, not
unresolved design choices.
