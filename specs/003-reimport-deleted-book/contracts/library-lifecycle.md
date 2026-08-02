# Contract: Publication Visibility and Synchronization Lifecycle

## Import

- Snapshot visible variant IDs before processing the selected batch.
- An ID in that snapshot is a duplicate.
- An existing physical record absent from that snapshot is a recoverable addition.
- Successful import guarantees valid bytes, visible logical membership, and synchronization inclusion.
- Failed validation removes state created or repaired for an edition that was not visible before the attempt.

## Delete

- Resolve deletion target IDs from the current logical membership.
- Add device-local sync exclusions before attempting the atomic repository deletion.
- On repository failure, remove only exclusions that were absent before the attempt.
- On success, retain exclusions for every deleted variant, persist the logical change through the existing journal, and keep the local deletion authoritative if journaling fails.

## Compatibility

- Existing visible editions retain duplicate semantics.
- Existing public repository and UI contracts remain unchanged.
- Existing legacy book synchronization consumes the same exclusion contract and produces remote deletion convergence.
