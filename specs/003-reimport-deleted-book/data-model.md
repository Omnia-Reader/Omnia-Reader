# Data Model: Re-import Deleted Books

No schema or durable record version changes are introduced.

## Publication Record

- **Identity**: Existing `sha256:<digest>` exact-edition ID.
- **State used by this feature**: metadata record plus valid binary reference.
- **Relationship**: May be owned by exactly one logical-book variant membership. A valid record with no owner is an orphan eligible for explicit re-import repair.

## Logical Book Membership

- **Identity**: Existing logical-book ID and format-to-variant mapping.
- **Visible state**: A publication is rendered in the library only while its ID appears in a logical book's variants.
- **Transition**: Ownerless retained publication → singleton logical owner after successful explicit import.

## Book Synchronization Exclusion

- **Identity**: Existing SHA-256 publication ID in the device-local exclusion set.
- **Deleted state**: Present before and after a successful logical variant deletion.
- **Restored state**: Removed after a successful explicit import or successful logical variant creation.
- **Failure transition**: If deletion fails, only exclusions newly added for that attempt are removed.

## Invariants

1. A visible duplicate has both a valid publication record and logical membership.
2. A successful deletion has neither local variant data nor synchronization eligibility for that exact edition.
3. An explicit successful re-import has valid local data, visible logical membership, and synchronization eligibility.
4. A failed re-import does not leave newly visible partial state.
