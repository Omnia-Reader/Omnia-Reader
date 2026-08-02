# Data Model: Draggable Book Progress

## Progress seek queue (ephemeral)

- **Latest pending percent**: optional finite number normalized to the inclusive 0..100 range.
- **Active drain**: at most one promise representing sequential renderer seeking.
- **State transition**: idle -> pending -> seeking -> pending (latest replacement) or idle.
- **Validation**: ignore non-finite input; do not begin a queued seek after component destruction.
- **Durability**: none. Existing relocation-driven progress persistence remains authoritative.

## Reader progress milestone (ephemeral)

- **Identity**: stable key unique within the open publication.
- **Kind**: `beginning` or `toc`.
- **Value**: normalized percentage for rail placement and status matching.
- **Label**: `Beginning` or the authored/numbered top-level TOC display label.
- **Target**: progression 0 for Beginning; exact publication locator and TOC item identity/index for a TOC entry.
- **Ordering**: Beginning first, followed by every depth-0 TOC entry in authored order.
- **Durability**: none; derived on each open from the current engine TOC.

No schema, migration, backup, synchronization, or rollback work applies.
