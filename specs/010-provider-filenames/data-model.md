# Data Model: Provider Book Filenames

## Publication Object Reference

Fields remain part of existing manifest or logical-change records:

| Field                           | Rule                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `variant.id` / `bookId`         | Complete `sha256:<64 lowercase hex>` exact-edition identity                                              |
| `variant.format` / `format`     | `epub` or `pdf`                                                                                          |
| `variant.fileName` / `fileName` | Original user-visible filename retained in the book record                                               |
| `objectPath`                    | New records: canonical `.omnia-reader/library/<readable-name>--<short-id>/<provider-safe-original-name>` |

The short directory suffix prevents same-name collisions; it is not the publication filename and does not replace complete manifest integrity.

## Compatibility State

- **Current**: canonical library path produced from the complete validated book record.
- **Legacy accepted**: `.omnia-reader/v1/books/<digest>/publication.<format>`, where digest and format exactly match the record.
- **Rejected**: any other root, digest, format, filename mapping, traversal, or unsafe path.

Publication producers move from legacy generation to current generation. Logical-library persistence has the explicit state migration below.

## Destination Reconciliation State

- **Current-safe**: Current pull/push reconciliation has completed for this pass.
- **Legacy-cleanup pending**: The reserved legacy prefix has not yet been inspected or a prior deletion failed.
- **Converged**: The obsolete legacy prefix exposes no remaining entries or publication objects.

Cleanup state is not persisted as an authority flag. Every full book synchronization rechecks the bounded legacy prefix, so restart and multi-device behavior converge without trusting device-local state.

## Canonical Logical-Book State

`LogicalBookStateDocument` is the only current document beneath `logical-books/`:

| Field             | Rule                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `schemaVersion`   | Literal `1`                                                                    |
| `heads`           | Sorted unique compact causal frontier                                          |
| `books`           | Sorted current logical books, each with its accepting clock                    |
| `removedBooks`    | Sorted deletion tombstones, one winning clock per logical-book ID              |
| `variants`        | Sorted active `BookRecord` plus canonical `objectPath` and accepting clock     |
| `removedVariants` | Sorted publication tombstones containing variant ID, format, and winning clock |
| `preferences`     | Sorted logical-book preferences; `null` is retained as a clear tombstone       |
| `reconciliations` | Sorted current membership reconciliation records with deterministic provenance |

### Deterministic Clock

| Field       | Rule                                            |
| ----------- | ----------------------------------------------- |
| `changeId`  | Bounded unique immutable mutation ID            |
| `createdAt` | Valid ISO timestamp copied from the mutation    |
| `deviceId`  | Bounded device identity retained for provenance |

Clocks compare by `createdAt`, then `changeId`; equality means an idempotent replay. Conflicting content under one immutable `changeId` is invalid. A winning tombstone suppresses any active record at an older or equal clock.

### State invariants

- A logical-book ID cannot be both active and tombstoned at the winning clock.
- A variant ID/format cannot be both active and removed at the winning clock.
- Every active logical-book membership resolves to one active variant descriptor of the same format.
- One variant/format membership cannot be accepted by two logical books; competing proposals create deterministic reconciliation state using stored owner clocks.
- Every object path is canonical for its validated active variant, or an exact accepted legacy path during migration only.
- Preferences retain null entries so an older non-null preference cannot reappear.
- Arrays and object keys serialize in deterministic order; duplicate identities are rejected rather than silently overwritten.

## Logical persistence transition

```text
legacy changes only
  -> validate and deterministic fold
  -> construct state with clocks, variants, and tombstones
  -> conditional write
  -> reread and semantic verification
  -> batch-delete inventoried changes
  -> canonical state only
```

A state write without completed change cleanup is valid intermediate recovery state. The next synchronization reapplies the same changes idempotently, verifies the state, and retries cleanup. A failed write, malformed reread, semantic mismatch, or exhausted optimistic retry preserves remote changes and local journal entries.
