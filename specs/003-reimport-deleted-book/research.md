# Research: Re-import Deleted Books

## Decision 1: Define duplicate state by visible membership

- **Decision**: Snapshot logical-book variant membership before import and classify only those exact editions as duplicates.
- **Rationale**: Library cards are rendered from logical books, so raw book metadata without an owner is recoverable orphan state rather than a user-visible duplicate.
- **Alternatives considered**: Continue using all book records, which reproduces the bug; change only the status message, which would leave the book invisible.

## Decision 2: Repair retained records lazily during explicit import

- **Decision**: When an existing exact-edition record has usable or replaceable bytes but no logical owner, recreate its singleton logical membership during import.
- **Rationale**: The user has supplied the exact file and expressed restoration intent. Lazy repair avoids a database migration or potentially surprising startup scan.
- **Alternatives considered**: Delete all orphan records on startup, which risks data loss; add a schema migration, which is unnecessary because records remain valid; always overwrite the record, which duplicates work and can discard metadata.

## Decision 3: Mirror logical variant lifecycle into legacy sync exclusions

- **Decision**: Exclude deletion targets before the local mutation, roll back newly introduced exclusions on failure, and reconcile created/deleted variant IDs after every successful logical mutation.
- **Rationale**: The legacy book synchronizer already treats exclusions as durable local deletion intent and converts excluded remote manifests into tombstones. Updating it at the application orchestration boundary prevents pull races without changing provider-neutral merge rules.
- **Alternatives considered**: Disable legacy book synchronization, which expands scope and migration risk; append only a legacy deletion journal record, which leaves a pull race before journaling; change remote merge semantics, which is unnecessary.

## Decision 4: Preserve user-owned concurrent sync work

- **Decision**: Do not modify the existing uncommitted `logical-book-sync-service.ts` and its spec; integrate only through the published exclusion contract.
- **Rationale**: Those changes are unrelated and the exclusion contract already owns the compatibility boundary.
- **Alternatives considered**: Fold deletion handling into the logical sync service, which would overlap the user’s work and broaden the regression.
