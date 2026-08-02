# Implementation Plan: Targeted Reading-State Synchronization

## Summary

Add a provider-neutral reading-state coordinator in `sync-core`, dispatch its first batch from the change-aware GitHub worker at a matching trusted checkpoint, continue conflict-free batches only within the same destination scope until idle reconciliation, give mutable-state services exact-operation methods, shorten interactive debounce, and remove the GitHub adapter's redundant preflight read.

## Constitution Check

- [x] Local durable writes remain authoritative and independent of network success.
- [x] Initial targeted dispatch requires a trusted full checkpoint; continuation is destination-scoped and preserves complete fallback.
- [x] Credentials remain in `apps/sync-gateway`; no synchronized schema changes.
- [x] Tombstones, deterministic merge selection, optimistic conflicts, bounded retry, and cancellation remain intact.
- [x] Exact request counts and fallback behavior receive focused tests before completion.

## Ownership and Design

- `libs/sync/core`: operation-aware dispatch, exact-record synchronization, debounce policy, checkpoint invalidation.
- `apps/omnia-reader`: compose the full and targeted coordinators from the same state workers.
- `apps/sync-gateway`: submit optimistic GitHub Contents writes directly; GitHub maps stale or create-existing writes to conflict.

The fast lane is GitHub-only because it relies on the existing authoritative repository revision checkpoint. Its first batch requires all pending operations to be progress, bookmark, or annotation work and the probed revision to equal the trusted checkpoint. After a conflict-free, unrejected result, later reading-state batches may remain targeted only while the probed repository and branch scope is unchanged. Services coalesce their supplied operations; existing records use only the exact target document before merge/write. Any push clears the global checkpoint; the first idle revision attempt performs a complete reconciliation. This avoids falsely checkpointing concurrent changes in unrelated domains.

For a first annotation or bookmark operation, the targeted service optimistically creates the UUID-addressed document without a preflight read. A create-existing conflict falls back to the bounded exact-read merge. This reduces the common new-highlight path to two sequential GitHub operations while preserving deterministic collision and recovery behavior.

Progress retains the exact remote document returned by a successful read/write only for the lifetime of the sync service. A later targeted progress write uses that authoritative revision directly and falls back to an exact read on optimistic conflict. After a targeted push invalidates the global checkpoint, conflict-free reading-state batches may continue on the exact-document lane; the first idle revision attempt performs the complete reconciliation and re-establishes a trusted checkpoint.

## Verification

- Focused and full `sync-core` tests; exact targeted list/read/write counters.
- Focused and full `sync-gateway` tests; no preflight GitHub content read.
- `omnia-reader` composition test, affected lint, production builds, formatting, and `git diff --check`.
- Chromium request evidence and live credentialed GitHub timing are separate gates and are reported if unavailable.
