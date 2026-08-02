# Synchronization Request Budget Contract

## Unchanged publication open

- Save device-local opened activity.
- Append zero `book` operations when manifest-represented values are unchanged.
- A legitimate metadata difference appends exactly one `book` upsert.

## Current-library publication pass

Given no pending `book` operation and a canonical valid remote manifest for every local publication:

- Active publication prefix listings: exactly one within the pass.
- Per-publication manifest reads/writes: zero.
- Per-publication object metadata/download/upload requests: zero.
- Local publication source opens and hashes: zero.
- Catalog may read its own document; it reuses the active manifest snapshot.

Missing-manifest, pending, excluded, deleted, malformed, or conflicting publications are outside this fast budget and retain full validation/recovery. A stable pass intentionally does not probe every LFS object; missing objects discovered while processing publication work retain repair behavior.

## Obsolete-layout cleanup

- Stable progress-only pass: zero obsolete-prefix listings.
- Publication pull or push work: at most one obsolete-prefix listing for compatibility cleanup.
- Failure or cancellation: cleanup remains pending and a later complete pass retries.
