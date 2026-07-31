# Provider-Neutral Synchronization Contract: Root Schema 2

## Compatibility Gate

The root remains `.omnia-reader/v1/manifest.json` so every sync begins at the
same known gate.

Schema 2:

- declares `schemaVersion: 2` and the required `logical-books` capability;
- is rejected by schema-1 clients through the existing version check;
- may be created from schema 1 only by a new client that first verifies legacy
  exact objects, builds singleton logical state, publishes all v2 prerequisites,
  and compare-and-swaps the root;
- is re-read before publishing or applying membership changes.

Adding only an unknown feature string is not a compatibility gate.

## Safe Provider Layout

All paths remain confined beneath `.omnia-reader/v1/library/`:

```text
objects/<digest-prefix>/<digest>.<epub|pdf>
logical/changes/<change-id>.json
logical/checkpoints/<checkpoint-id>/page-<number>.json
logical/checkpoints/<checkpoint-id>/index.json
```

Variant objects are immutable, declared, size-bounded, SHA-256 verified, and
published before a referencing change. JSON paths never use user filenames.
Existing Git LFS matching and MEGA staging apply to EPUB/PDF objects without
expanding gateway path or credential authority.

Health and availability are device-local derived results, never provider
fields. A receiving device verifies downloaded exact bytes and derives its own
status; missing/evicted local bytes do not change remote membership or
preference.

The validated exact-variant descriptor may advertise `Retry synchronized
download` for a locally unavailable or quarantined variant. Retry downloads the
immutable object, verifies declared size, SHA-256, and detected format, then
passes it to the repository replacement boundary. It creates no logical change,
preference effect, or variant-state merge. Missing/malformed descriptors,
provider failure, or mismatch leave the prior local source/evidence unchanged.

Legacy v1 objects/manifests remain during migration but are not mutated into v2
association documents. A schema-1 sync already past its preflight cannot be
recalled; distinct roots prevent it from understanding new membership, and a
later upgraded client reconciles any legacy singleton it imported without
discarding exact data.

## Logical Change Document

An immutable schema-1 change contains the fields defined in
`data-model.md#entity-logical-book-change`. Additional wire rules:

- maximum serialized size: 256 KiB;
- at most 32 sorted unique parents;
- at most two resulting/removed logical books and two variant effects;
- at most two preferred-format effects and a bounded sorted set of resolved
  reconciliation IDs;
- all strings, metadata arrays, timestamps, identifiers, paths, and effect
  payloads use existing bounded validation;
- every upsert descriptor repeats variant ID, format, filename, media type,
  size, digest, object path, import audit data, and required catalog source
  metadata;
- every tombstone names exact variant/logical membership and the dominating
  change; deletion does not immediately erase immutable provider bytes;
- a preference-only change has kind `preference`, no membership/variant effects,
  one `{ logicalBookId, preferredFormat, previousPreferenceHeads }` effect, and
  parents containing its observed preference heads;
- a reconciliation change has kind `reconcile-membership`, complete resulting
  membership, every resolved conflict ID, and parents containing all conflicting
  changes plus current heads for every touched logical book;
- `createdAt` and device-local journal revision are audit fields only.

The change document is published last and is the commit marker. A missing,
partial, malformed, or object-incomplete change has no membership effect and
stays retryable.

## Causal Merge

1. Load and validate the latest complete checkpoint, then all reachable changes.
2. Reject cycles, missing required parents not covered by the checkpoint, unsafe
   paths, invalid objects, and bound violations before local mutation.
3. Topologically apply ancestors before descendants.
4. For concurrent ready changes, use lexicographically ordered change ID as the
   deterministic tie-break; timestamps and journal revisions never decide.
5. Apply each accepted change as a unit to the candidate graph.
6. If a concurrent change would assign one variant to two logical books or add a
   second same-format variant, the higher change ID selects the safe accepted
   projection. The loser remains in its last accepted membership and produces a
   deterministic durable `MembershipReconciliation` containing both proposals;
   it is never deleted, duplicated, silently reassigned, or dismissed by retry.
7. Only an explicit `reconcile-membership` child that observes every conflicting
   and current head may change that association and mark the record resolved. A
   stale choice fails while leaving the action open.
8. Variant/logical tombstones follow the same dominance rules. Reimport is
   allowed only as an explicit later child change.
9. Validate the complete candidate graph and referenced objects, then apply the
   whole accepted batch in one local repository transaction.

Repeated pull or retry is idempotent and yields byte-equivalent logical state on
all providers/devices given the same valid change set.

Provider outage, provider retry, transport replacement, or switching between
configured providers never dismisses an open reconciliation. The next
provider-neutral fold carries the same open record or its causally valid
resolution; a provider switch cannot manufacture resolution authority.

### Preferred-format fold

Preferred format is an independent causal register per logical book. Descendant
effects dominate ancestors; concurrent effects choose lexicographically greater
change ID. Timestamp, device ID, journal revision, progress, and locator state
never decide or participate. The winner remains durable when its member is
locally unavailable; opening a healthy fallback emits no preference change. A
membership change that removes the preferred format must carry a valid
remaining preference or tombstone. A concurrently stale preference is dormant
and cannot change membership or any variant state.

## Checkpoints and Bounds

- Create a checkpoint after 500 accepted logical changes or before provider
  listing/document bounds would be exceeded.
- Partition canonical state into immutable pages no larger than the existing
  validated JSON-document limit; sort by logical ID and include page size/digest
  in the index.
- Publish/verify all pages before the immutable index. The index contains folded
  heads, preferred-format winners/heads, open reconciliation records, resolved
  authority, and retained tombstone/membership authority and is the checkpoint
  commit marker.
- A client ignores incomplete checkpoints. Once a checkpoint is accepted,
  pending local changes with pruned parents are revalidated/rebased against its
  heads rather than applied as stale ancestors.
- Delete obsolete change pages only after the checkpoint and every retained
  descendant are verified. Keep the newest prior complete checkpoint until a
  subsequent full sync proves recovery.
- If safe compaction cannot complete before hard provider bounds, stop optional
  remote association sync with an actionable error while preserving local
  library operation and pending journal entries.

## Journal and Provider Semantics

- Add `logical-book-change` to the closed sync entity set.
- `entityId` is the change ID; do not coalesce by logical ID.
- Append only after local durable commit. Acknowledgement names the exact
  operation/change and cannot acknowledge another format's pending work.
- Existing progress/bookmark/annotation operations remain keyed by exact variant
  ID. Existing exclusions remain exact-variant exclusions.
- Preference-only and reconciliation changes use the same immutable change
  transport and acknowledgement rules. A repeated same-format open creates no
  operation. Losing membership proposals remain represented until their durable
  reconciliation authority is checkpoint-visible.
- Whole-book and membership deletion use logical changes; remote backup UI must
  distinguish variant deletion from logical-book deletion.
- Git and MEGA transports remain opaque carriers and must pass identical
  interruption, retry, conflict, object-before-change, and convergence fixtures.

## Migration Sequence

1. Read root schema 1 and acquire its provider revision.
2. Verify legacy exact manifests and objects without changing local membership.
3. Create deterministic singleton logical state and v2 object descriptors. Do
   not infer synchronized preference from legacy last-opened timestamps.
4. Upload/verify missing v2 objects and bootstrap checkpoint pages/index.
5. Compare-and-swap the root to schema 2.
6. If the compare-and-swap loses, discard no objects; reload and reconcile.
7. Only after observing schema 2 may the client publish logical changes.

Any interruption before step 5 leaves schema-1 behavior authoritative; orphaned
immutable v2 objects are safe and retryable. No legacy object is garbage
collected as part of this feature rollout.
