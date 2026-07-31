# Data Model: Multi-Format Books

## Identity Vocabulary

- **Variant ID / existing `bookId`**: `sha256:<64 lowercase hex>`. It is the
  immutable identity of one exact EPUB or PDF and remains the key used by
  binaries, locators, progress, bookmarks, annotations, export, and exact-file
  synchronization.
- **Logical book ID**: `logical:sha256:<64 lowercase hex>`. It is an opaque,
  stable library identity and is never interpreted as a publication digest.
  Singleton migration/import derives it from a namespaced hash of the variant
  ID. If that deterministic ID is already occupied when detaching its anchor
  variant, derive a new ID from the variant ID and mutation/change ID.
- **Change ID**: a globally unique opaque ID used for idempotency, causal merge,
  and deterministic concurrent ordering. It is not a timestamp.

The explicit prefixes prevent accidental use of a logical ID where existing
validation requires an exact publication SHA.

## Entity: Publication Variant

The existing `BookRecord` persists unchanged and is treated as a publication
variant during migration.

| Field                                                     | Type                      | Rules                                                                             |
| --------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `id`                                                      | Variant ID                | Exact SHA-256 identity; immutable                                                 |
| `format`                                                  | `epub \| pdf`             | Must match media type, source validation, binary suffix, and every locator record |
| `fileName`                                                | bounded string            | Original user-visible filename; never used as trusted path input                  |
| `mediaType`                                               | bounded string            | Must agree with validated format                                                  |
| `size`                                                    | positive safe integer     | Must equal the durable binary size                                                |
| `title`, `authors`, `language`, `publisher`, `identifier` | existing bounded metadata | Extracted from this source and retained for lossless detach                       |
| `importedAt`, `lastOpenedAt`                              | canonical timestamps      | Audit and variant-specific activity; not merge authority                          |
| `coverState`                                              | existing cover state      | Describes the source-derived variant cover                                        |

Existing binary, cover, progress, progress-document, bookmark, and annotation
records remain keyed by this ID. No locator-bearing record gains a logical book
ID.

### Derived Variant Availability

Health is a device-local runtime result and is never stored in `BookRecord`, a
logical record, backup, or synchronization document.

| Status        | Required cause                                            | Meaning                                                                                   |
| ------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `checking`    | none                                                      | Lightweight inspection cannot yet claim that the exact bytes are healthy                  |
| `healthy`     | none                                                      | Metadata/reference/format validate; bytes are accessible, size-complete, and match ID SHA |
| `unavailable` | `missing \| evicted \| inaccessible \| incomplete`        | The active exact source cannot currently provide complete bytes                           |
| `quarantined` | `integrity-invalid \| unsupported \| malformed-reference` | Invalid active data was isolated before source use                                        |

`coverState` is cover-only and never participates. Eligibility uses `status`;
the required cause supplies the user-facing and diagnostic explanation. A valid
active replacement record supersedes historical quarantine evidence. Library-card
batching may return `checking` without hashing every source; only authoritative
open returns a source as `healthy`, and it quarantines digest/format mismatches
before any renderer receives bytes.

## Entity: Logical Book

`LogicalBookRecord` schema version 1 owns library-visible catalog presentation
and membership.

| Field                                 | Type                                  | Rules                                                                     |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `schemaVersion`                       | `1`                                   | Required                                                                  |
| `id`                                  | Logical book ID                       | Unique, immutable after creation                                          |
| `title`                               | bounded non-empty string              | Destination logical book remains authoritative during association         |
| `authors`                             | bounded string array                  | Same limits as current catalog metadata                                   |
| `language`, `publisher`, `identifier` | optional bounded strings              | Shared presentation, not source identity                                  |
| `importedAt`                          | canonical timestamp                   | Preserved from the destination/singleton catalog                          |
| `coverState`                          | `pending \| available \| unavailable` | Refers to the logical cover, independent of variant cover availability    |
| `variants.epub`                       | optional Variant ID                   | Must reference an EPUB variant and be globally unique among logical books |
| `variants.pdf`                        | optional Variant ID                   | Must reference a PDF variant and be globally unique among logical books   |
| `updatedAt`                           | canonical timestamp                   | Audit/presentation only; not concurrent merge authority                   |

Validation invariants:

1. At least one membership field is present.
2. No variant appears in more than one logical book.
3. A membership field's format matches its referenced variant.
4. Missing/quarantined binary data does not invalidate membership; it changes
   availability and remains recoverable.
5. Catalog metadata never changes implicitly during association.
6. A logical record and its cover are quarantined independently of healthy
   variants; a malformed aggregate cannot re-key or delete variant state.

## Entity: Logical Book Cover

A bounded cover blob keyed by logical book ID. Migration copies the current
singleton variant cover. Association keeps the destination logical cover.
Detachment copies the detached variant cover when available, while deletion of
a variant never implicitly removes the remaining logical cover.

Cover duplication is intentional and bounded: it decouples catalog presentation
from the lifetime of any one source and preserves a usable cover after detach.

## Entity: Logical Book Format Preference

Schema version 1 is a synchronized register with a merge domain independent of
logical membership and every variant-scoped reading-state record.

| Field                   | Type                      | Rules                                                                             |
| ----------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `schemaVersion`         | `1`                       | Required                                                                          |
| `logicalBookId`         | Logical book ID           | Must identify a current logical book                                              |
| `preferredFormat`       | `epub \| pdf`             | Must name a current member format; local byte availability does not invalidate it |
| `winningChangeId`       | Change ID                 | Current causal winner and deterministic concurrent tie-break                      |
| `preferenceHeads`       | bounded sorted Change IDs | Surviving causal heads for descendant/concurrent comparison                       |
| `updatedAt`, `deviceId` | bounded audit fields      | Never determine merge authority                                                   |

A successful explicit activation of a present EPUB/PDF badge, or reader format
switch, emits a preference effect only when the chosen format differs. A
missing-format badge action, default/fallback open, failed open, or automatic
fallback never writes preference. Selection is: healthy preferred member, sole
healthy member, EPUB, PDF, then no reading action. If the preferred member is
locally unavailable, the durable preference remains and the fallback applies
only to that opening.

The always-visible badge row and its add-or-associate choice are transient
presentation state. A missing badge does not create a placeholder variant,
progress record, preference, or logical change. Durable state changes only after
the selected existing add/associate operation commits.

## Entity: Logical Book Change

One locally committed aggregate mutation and the atomic unit of optional sync.

| Field                                 | Type                                                                                                                                 | Rules                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `schemaVersion`                       | `1`                                                                                                                                  | Required                                                               |
| `changeId`                            | Change ID                                                                                                                            | Globally unique; idempotency and concurrent tie-break                  |
| `kind`                                | `bootstrap \| add-variant \| associate \| detach \| delete-variant \| delete-book \| metadata \| preference \| reconcile-membership` | Closed set                                                             |
| `parents`                             | bounded sorted Change ID array                                                                                                       | Heads observed before mutation; no duplicates or self-reference        |
| `resultingBooks`                      | 0–2 complete logical snapshots                                                                                                       | Complete after-state for every touched logical book that remains       |
| `removedLogicalBookIds`               | 0–2 logical IDs                                                                                                                      | Logical records absent in the after-state                              |
| `variantEffects`                      | bounded exact-variant upserts/tombstones                                                                                             | References verified immutable sources and preserves deletion knowledge |
| `preferenceEffects`                   | 0–2 complete preferred-format effects                                                                                                | Folded independently; never changes membership or variant state        |
| `resolvesConflictIds`                 | bounded sorted conflict ID array                                                                                                     | Present only for explicit reconciliation                               |
| `createdAt`, `deviceId`, `appVersion` | bounded audit fields                                                                                                                 | Never determine merge authority                                        |

The local journal adds the change only after the corresponding repository
transaction commits. The same complete change is validated and applied in one
transaction on pull.

A preference-only change has no logical snapshots, removals, or variant
effects. Its parents include the observed preference heads. Descendants win;
concurrent preferences use lexicographically greater change ID. If a membership
change removes the preferred format, that same change carries a valid remaining
preference or tombstones the register. A concurrently stale preference remains
dormant and cannot alter membership.

## Entity: Membership Reconciliation

A deterministic durable record created when concurrent membership changes
cannot both satisfy unique ownership or one-variant-per-format invariants.

| Field                  | Type                       | Rules                                                                |
| ---------------------- | -------------------------- | -------------------------------------------------------------------- |
| `schemaVersion`        | `1`                        | Required                                                             |
| `conflictId`           | canonical conflict ID      | Derived from conflict type, sorted change IDs, logical IDs, variants |
| `status`               | `open \| resolved`         | Open remains actionable until an explicit resolution change applies  |
| `conflictingChangeIds` | bounded sorted Change IDs  | Includes every competing proposal                                    |
| `affectedVariantIds`   | bounded sorted Variant IDs | Exact variants are retained                                          |
| `acceptedMembership`   | bounded membership tuples  | Deterministic safe projection currently shown                        |
| `rejectedMembership`   | bounded membership tuples  | Proposal preserved for reader review                                 |
| `resolvedByChangeId`   | optional Change ID         | Must causally descend from all conflicting/current heads             |
| `detectedAt`           | canonical timestamp        | Audit only                                                           |

Reconciliation choices may keep the accepted association, move the preserved
variant to the competing book, or make it standalone when cardinality remains
valid. A stale choice fails without clearing the open record. Checkpoints retain
open records and resolved authority so pruning cannot resurrect an action.

## Entity: Association Checkpoint

A materialized, immutable fold of accepted logical changes:

- checkpoint ID and included causal heads;
- complete validated logical-book records;
- synchronized preferred-format registers and their causal heads;
- open reconciliation records and resolved-conflict authority;
- exact variant descriptors and durable membership/deletion tombstones;
- deterministic page paths, byte sizes, and SHA-256 digests;
- creation audit fields and schema version.

Pages are written and verified before the checkpoint index. The index is the
commit marker. A client with pruned parents rebases its still-local mutation on
the latest checkpoint; it never recreates a deleted membership from missing
history.

## Relationships

```text
LogicalBookRecord 1 ── owns ── 1..2 PublicationVariant
LogicalBookRecord 1 ── has  ── 0..1 LogicalBookCover
LogicalBookRecord 1 ── has  ── 0..1 synchronized LogicalBookFormatPreference
PublicationVariant 1 ── has  ── 1 binary metadata/object
PublicationVariant 1 ── has  ── 0..n progress documents/bookmarks/annotations
LogicalBookChange n ── folds into ── AssociationCheckpoint
MembershipReconciliation n ── concerns ── 1..n PublicationVariant
```

## State Transitions

### Import standalone

`no variant` → validate/hash/stage source → commit variant + binary metadata +
singleton logical book → append optional sync change.

Failure before commit removes staged bytes. Failure after local commit only
leaves synchronization pending.

### Add format

`singleton or one-format logical book` → validate different-format source →
reject duplicate/conflict or stage → commit variant + membership atomically →
append change.

### Associate existing books

`two non-overlapping logical books` → select destination → validate format and
membership invariants → update destination with union and remove source logical
record in one transaction. Variant bytes and location state do not move.

### Detach variant

`two-format logical book` → update original to one member + create a new
singleton logical book with copied source metadata/cover in one transaction.
If the canonical singleton logical ID is occupied by the original aggregate,
derive the detached ID from the mutation ID without re-keying the original.

### Delete variant

`two-format logical book` → confirm format → update logical membership + remove
only that variant metadata/state in one transaction → best-effort remove
unreachable binary. A final variant follows whole-book deletion.

### Unavailable or quarantined variant

`checking` → exact local verification → `healthy`.

`healthy` → missing/evicted/inaccessible/incomplete bytes → `unavailable` with
the matching cause.

`healthy` → malformed active reference, digest mismatch, or format mismatch →
`quarantined` after isolating invalid active data, with cause
`malformed-reference`, `integrity-invalid`, or `unsupported`, respectively.
Membership remains in every non-delete state. Exact-source replacement or a
verified sync download may return an unavailable/quarantined variant to
`healthy` without rebuilding the logical book, changing its variant ID, or
rewriting membership, reading state, or preference. Cancellation or mismatch
leaves the prior status/evidence and active source unchanged.

### Change preferred format

`current or absent preference` → explicitly open a healthy member format →
commit the local register and append a preference-only change. Concurrent
choices converge by causal ancestry then change ID. A fallback caused by local
unavailability does not create a change and never touches variant state.

### Reconcile concurrent membership

`open reconciliation` → reader reviews accepted and competing proposals →
validate against current heads/cardinality → atomically commit an explicit
child membership change and resolve the conflict. Cancellation or stale state
leaves the record open.

## Migration and Compatibility

### IndexedDB 8 → 9

1. Create logical-book, logical-cover, synchronized preference, and membership
   reconciliation stores plus membership indexes in the version-change
   transaction.
2. Validate each existing `books` row.
3. Create one deterministic singleton logical record per valid variant and copy
   its catalog metadata/cover.
4. Leave variant, binary, progress, document, bookmark, annotation, operation,
   and exclusion keys unchanged. Do not synthesize a preference from singleton
   `lastOpenedAt`; absence uses deterministic sole-format fallback.
5. Quarantine malformed records losslessly in the same transaction.
6. Abort the whole version change on unexpected failure; a retry starts from
   the intact v8 database.

### Backup 1–3 → 4

Wrap every validated exact book as a singleton logical book in memory. Schema 4
restore validates the complete relationship graph, collects every conflict
against one consistent current-library snapshot, and aborts without staging or
mutation when any conflict exists. A conflict-free restore rechecks the local
revision at commit and atomically restores synchronized preferences and
reconciliation authority. Unknown newer schemas fail before mutation.

### Sync root 1 → 2

Verify legacy exact manifests/objects, construct deterministic singleton state,
publish v2 objects/checkpoint, then compare-and-swap the root manifest. New
association changes are forbidden until schema 2 is confirmed. Schema-1 clients
reject schema 2 on their next preflight; distinct roots prevent them from
interpreting v2 membership documents.
