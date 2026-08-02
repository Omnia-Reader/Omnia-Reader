# Feature Specification: Targeted Reading-State Synchronization

**Feature Directory**: `008-targeted-reading-sync`

**Created**: 2026-08-02

**Status**: Implemented; local verification complete

**Input**: A simple highlight still takes several seconds to synchronize even though the annotation is already durable locally.

## Outcome and Scope

Highlights and bookmarks begin remote synchronization after a short trailing quiet period. When the selected GitHub destination is known to be fully converged, a batch containing only progress, bookmark, or annotation work synchronizes only the affected records. Any uncertain state uses the complete library merge.

Provider-wide push delivery, webhooks, synchronized format changes, and weaker conflict or tombstone handling are out of scope.

## User Scenarios and Testing

### User Story 1 - Highlight without a library walk (Priority: P1)

Given a converged GitHub destination, when a reader creates a highlight, its local save remains immediate and its remote attempt starts within 50 ms after activity becomes quiet. A new record is created without a preflight document read and does not synchronize schema, publications, logical books, bookmarks, or progress.

### User Story 2 - Safe fallback under uncertainty (Priority: P1)

Given a stale or missing trusted destination checkpoint, mixed pending work, malformed operations, conflicts, cancellation, or provider failure, the optimization does not claim convergence. The existing complete synchronization, retry, tombstone, and local-first behavior remains authoritative.

### Edge Cases

- Multiple rapid edits to one highlight coalesce behind the trailing quiet boundary and operation journal.
- Mixed progress, bookmark, and annotation work runs only those represented reading-state domains.
- Work arriving during a targeted attempt remains pending and forces later complete reconciliation.
- A targeted push invalidates the global checkpoint so remote changes in other domains are discovered by the existing background revision check.

## Requirements

- **FR-001**: Highlight and bookmark synchronization MUST be scheduled 50 ms after the last interactive mutation unless provider backoff requires a longer delay.
- **FR-002**: Progress synchronization MUST retain its one-second quiet period to bound provider commits during reading.
- **FR-003**: A targeted attempt MUST require a selected GitHub provider, a supported destination revision, a non-empty reading-state-only journal batch, and equality between the current destination revision and the last trusted full checkpoint.
- **FR-004**: A new targeted highlight or bookmark MUST attempt optimistic creation without a preflight read. An existing or conflicting record MAY perform one exact-document read and MUST NOT list unrelated prefixes or run schema, publication, or logical-book workers.
- **FR-005**: Successful writes MUST be acknowledged only after the authoritative provider response. Conflicts, rejected operations, remaining work, and pushes MUST prevent the old global checkpoint from being treated as converged.
- **FR-006**: Missing or stale checkpoints and non-reading-state operations MUST use the complete synchronization path.
- **FR-007**: GitHub document writes MUST use the caller's optimistic revision directly and MUST NOT perform a redundant provider read before the write.
- **FR-008**: Local writes, deterministic merge rules, tombstones, bounded retries, cancellation behavior, and the gateway credential boundary MUST remain unchanged.

## Success Criteria

- **SC-001**: An eligible highlight waits at most 50 ms of local quiet time before its network attempt begins.
- **SC-002**: One new eligible highlight causes one destination revision probe and one document write at the browser-to-gateway boundary, with no document read, prefix listing, or complete verification pass.
- **SC-003**: The gateway performs one GitHub content mutation and no preflight content read for a document write carrying its optimistic revision.
- **SC-004**: Unit evidence covers targeted success, stale-checkpoint fallback, mixed-domain fallback, malformed input, request counts, and checkpoint invalidation.
- **SC-005**: With each provider operation delayed by 300 ms, a new eligible highlight completes its remote attempt in under one second including the 50 ms quiet boundary.

## Assumptions

- A trusted full checkpoint proves schema and publication compatibility at the revision probed immediately before the targeted attempt.
- Existing ten-second visible GitHub revision polling provides bounded background reconciliation after a targeted push invalidates the checkpoint.
