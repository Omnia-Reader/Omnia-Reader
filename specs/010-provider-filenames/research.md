# Research: Provider Book Filenames

## Decision 1: Reuse the canonical readable object path

**Decision**: Generate new logical-book object references with `bookObjectPath(BookRecord)`, the same path already used by publication manifests and actual uploads.

**Rationale**: One provider-neutral function prevents GitHub/MEGA drift and makes the object leaf the original provider-safe filename while retaining collision-safe edition identity in the containing directory.

**Alternatives considered**: A flat filename-only provider root would collide for different editions with the same name. A second filename algorithm would recreate the current inconsistency.

## Decision 2: Accept, but never generate, the legacy digest path

**Decision**: Logical-change validation accepts both the canonical current path and the exact legacy `.omnia-reader/v1/books/<digest>/publication.<format>` path.

**Rationale**: Immutable changes already stored by users must remain readable. Exact recomputation from the validated variant prevents broadening path authority.

**Alternatives considered**: Rejecting old records causes synchronization data loss. Rewriting immutable changes breaks causal identity and is not safe.

## Decision 3: Keep provider APIs and add a canonical logical-state schema

**Decision**: Keep gateway routes, provider adapters, and the transport interface unchanged. Add a provider-neutral version 1 logical-state document at `.omnia-reader/logical-books/state.json` and use existing conditional document writes and batch entry deletion.

**Rationale**: Both providers already support confined document reads, optimistic writes, inventory, and deletion. A new remote data schema is required because the current immutable history is the behavior being replaced, but no provider-specific protocol is required.

**Alternatives considered**: Reusing an unversioned snapshot would prevent safe evolution and validation. Adding provider-specific compaction endpoints would duplicate merge policy and weaken provider neutrality.

## Decision 4: Reconcile legacy files on every full book sync

**Decision**: Run confined previous-root migration/reconciliation around every full synchronization. Inventory all entries below `.omnia-reader/v1/`, migrate supported data to `.omnia-reader/`, verify destination content and object integrity, then raw-delete every exposed previous-root entry without maintaining per-version stale-file allowlists.

**Rationale**: Mutation-triggered cleanup can leave old files indefinitely after restart or when the current destination is already up to date. Always checking the reserved prefix guarantees eventual convergence and naturally retries failures. The opaque GitHub revision fast path still avoids the full worker when nothing changed.

**Alternatives considered**: A device-local cleanup flag is not authoritative across devices or restarts. A new provider API is unnecessary because the existing document/object deletion contract can remove known legacy files; Git virtual directories disappear with their contents and provider-specific empty-directory pruning remains transport-owned.

## Decision 5: Store record clocks and tombstones, not mutation history

**Decision**: Store current books, active variant descriptors, preferences, reconciliations, causal heads, and a deterministic clock on every mutable identity. Retain book and variant deletion tombstones and null preference clocks in the same document.

**Rationale**: Compact provenance lets a stale offline mutation be compared with the accepted record without retaining every historical change. Active variant descriptors replace the remote restoration data formerly available only in `variantEffects`. Tombstones prevent deleted books, removed variants, and cleared preferences from being resurrected.

**Alternatives considered**: A plain current-state snapshot or whole-document timestamp loses concurrent edits. Retaining the existing changes plus checkpoints does not meet the requested simple provider layout and still grows indefinitely.

## Decision 6: Use deterministic per-record reduction with optimistic retry

**Decision**: Convert each pending immutable mutation into record-level proposals and merge them with the current canonical state using a total clock order. Read the state revision, merge, write conditionally, reread and verify; on a revision conflict, repeat from the latest state within a fixed retry bound.

**Rationale**: Existing provider revisions detect concurrent writers but cannot merge their semantic updates. Deterministic record reduction makes retry order-independent while keeping journal acknowledgement after durable verification.

**Alternatives considered**: Blind replacement loses concurrent work. Server-side merge would move domain policy into GitHub/MEGA gateways. Unlimited retry could make synchronization hang indefinitely.

## Decision 7: Migrate legacy changes transactionally and idempotently

**Decision**: Inventory the complete owned `logical-books/` subtree, validate and fold legacy change documents, construct canonical clocks/provenance and active variants, write and reread `state.json`, compare semantic results, and only then batch-delete every inventoried entry other than `state.json`, including obsolete checkpoints. If cleanup was interrupted, replaying retained changes against the verified state is a no-op.

**Rationale**: This ordering keeps the only recoverable remote history until the replacement is proven. Idempotence handles a crash between state publication and cleanup without creating duplicates or regressions.

**Alternatives considered**: Deleting changes before state verification risks irreversible remote loss. Keeping both representations permanently preserves the complexity and cost the user asked to remove.

## Decision 8: Invalidate the previous unchanged-revision checkpoint

**Decision**: Advance the device-local change-aware checkpoint from schema 2 to schema 3. Treat schema-2 values as untrusted so the first upgraded Git synchronization runs the complete coordinator even when the provider revision is unchanged.

**Rationale**: The checkpoint is only performance evidence, but retaining its old compatibility let the fast path skip the newly required remote-format migration indefinitely. After one verified full pass, schema 3 restores the same one-revision-request optimization.

**Alternatives considered**: Asking users to clear local storage is fragile and does not upgrade other devices. Disabling the fast path permanently would regress stable synchronization performance.
