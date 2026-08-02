# Data Model: Efficient Reading Synchronization

No durable entity or schema changes.

## Existing publication record

- `lastOpenedAt` remains a canonical, device-local activity timestamp used for local ordering.
- Manifest-represented fields remain exact identity, format, file name, media type, size, digest-derived identity, title, authors, language, publisher, identifier, imported time, metadata revision, and application version.
- A change to `lastOpenedAt` alone does not create a manifest revision. A real manifest metadata change uses the open-time timestamp for its journal payload.

## Ephemeral remote snapshot

- One pass-local collection of validated remote publication documents keyed by canonical manifest path and book identity.
- Created from the already requested provider listing and discarded after the pass.
- Malformed or mismatched documents never enter the presence index.

## Ephemeral legacy cleanup state

- One boolean owned by a `BookSyncService` instance.
- `false` initially and after a successful cleanup.
- Publication pull or push work changes it to `true` before cleanup.
- Failure or cancellation leaves it `true` so a later complete pass retries.
- Not backed up, synchronized, migrated, or shared across provider/service lifetimes.
