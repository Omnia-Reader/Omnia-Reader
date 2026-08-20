# Provider-Neutral Multi-Format Synchronization Contract

## Compatibility Gate and Current Layout

The current root is `.omnia-reader/`. Every synchronization validates
`.omnia-reader/manifest.json` before reading or writing child state. The root
manifest uses schema version 2 and requires the `logical-books` capability;
unsupported schemas fail closed without affecting the local library.

Logical-library state is authoritative in exactly one bounded document:

```text
.omnia-reader/logical-books/state.json
```

The state contains validated logical books, active exact-variant descriptors,
preferred-format registers, membership reconciliations, causal heads,
per-record deterministic clocks, and book/variant/preference tombstones.
Equivalent state serializes canonically. Current clients never create remote
`logical-books/changes/` or checkpoint pages.

The former `.omnia-reader/v1/` root and remote change/checkpoint entries are
compatibility inputs only. A full synchronization inventories them, validates
and folds supported changes into canonical state, verifies copied publications
and documents at their current paths, rereads and semantically verifies
`state.json`, and only then batch-deletes the legacy entries. Interrupted or
conflicting migration retains legacy input and local journal work for retry.

## Local Mutation and Journal Contract

`LogicalBookChange` remains the atomic local mutation and durable journal
payload. It contains complete resulting logical records, removals, exact
variant effects, preference effects, reconciliation resolutions, causal
parents, and an immutable change identity.

- Append the change only after the corresponding local repository transaction
  commits.
- Do not coalesce distinct logical changes by logical-book ID.
- Progress, bookmark, annotation, and exact-variant state remain keyed by the
  publication SHA-256 ID.
- A provider failure leaves the local result usable and the journal operation
  pending.
- A journal operation is acknowledged only after a reread canonical state
  proves that its complete effect is covered.

## Canonical Merge

1. Read and validate the canonical state and its optimistic provider revision.
2. Validate every pending local change, including bounds, paths, identities,
   membership cardinality, and immutable variant descriptors.
3. Apply ancestors before descendants. Concurrent records use the existing
   deterministic change-clock comparison; device clocks and journal revisions
   never decide authority.
4. Preserve safe accepted membership and create a deterministic durable
   `MembershipReconciliation` when concurrent proposals cannot both satisfy
   unique ownership or one-variant-per-format invariants.
5. Fold preferred-format changes in an independent causal register. A locally
   unavailable winning format remains durable and automatic fallback emits no
   preference change.
6. Apply deletion and preference-clear tombstones so a stale device cannot
   resurrect or regress accepted state.
7. Upload and verify missing immutable publication objects before writing a
   state that references them.
8. Write `state.json` with its expected revision, reread it, and verify
   canonical semantic equality. On conflict, reread, deterministically reapply
   pending work, and retry within the configured bound.
9. Atomically apply the accepted state locally and acknowledge only the journal
   operations proven present in the verified remote state.

Malformed state, conflicting immutable identities, exhausted retries, or an
interrupted transfer fails the pass while preserving local authority, pending
journal work, and any required legacy migration input.

## Exact Variant Descriptors and Recovery

Every active remote variant descriptor repeats the exact `BookRecord`, its
canonical provider object path, declared size, media type, and complete SHA-256
identity. Health is derived locally and is never synchronized.

For a locally unavailable or quarantined variant, the provider-neutral recovery
boundary may expose `Retry synchronized download` only after `headObject()`
returns a descriptor whose size and SHA-256 match that exact variant. Recovery:

1. recomputes the canonical object path from the validated `BookRecord`;
2. rereads and validates remote metadata immediately before transfer;
3. downloads with the declared-size bound and transfer cancellation/progress;
4. passes the downloaded source to `LibraryRepository.replaceVariantSource()`,
   which verifies detected format, size, and SHA-256 before replacing the
   device-local source/reference.

Recovery creates no logical change, preference effect, membership mutation, or
journal operation. Missing metadata, cancellation, provider failure, or any
identity/format mismatch leaves the previous local source/evidence unchanged.
Provider descriptor lookup and transfer remain in `sync-core`; browser
persistence never acquires provider or credential authority.

## Provider and Security Semantics

- Git/LFS and MEGA carry the same provider-neutral paths and state semantics.
- Credentials and reusable sessions remain in the same-origin gateway.
- Paths are confined beneath `.omnia-reader/`; filenames are treated as hostile
  and the shared canonical safe-name policy remains authoritative.
- Immutable objects are published before state references them and are verified
  by size and SHA-256 on upload and download.
- State writes use optimistic revisions. Conflicts are bounded and retryable.
- Provider switching, interruption, or restart never clears an open membership
  reconciliation or pending local mutation.
- Remote backup presentation distinguishes exact-variant deletion from
  whole-logical-book removal without changing local-first deletion semantics.

## Change-Aware Fast Path

The device-local Git revision checkpoint is performance evidence only. Schema 3
is the first checkpoint format that trusts canonical logical state. Older
checkpoint schemas are ignored once so the full migration and verification pass
runs before an unchanged revision may bypass provider listing. Any local pending
operation, untrusted checkpoint, provider without revision support, or requested
exact-object recovery uses the authoritative path rather than the fast path.

## Required Verification

- canonical-state parsing, bounds, deterministic serialization, clocks,
  tombstones, preference clears, reconciliation, and idempotent replay;
- legacy change folding, semantic verification, batch cleanup, interruption,
  and retry;
- optimistic conflict convergence and retry exhaustion without journal loss;
- remote-only variant restoration and locally missing-source restoration;
- exact-object recovery success, cancellation, provider failure, and
  descriptor/size/digest/format mismatch;
- identical Git and MEGA behavior plus explicit live-provider gates where
  credentials are available.
