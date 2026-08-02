# Data Model: Fast GitHub Synchronization

## Browser GitHub synchronization checkpoint

Device-local, disposable performance state.

| Field           | Type        | Rules                                                            |
| --------------- | ----------- | ---------------------------------------------------------------- |
| `schemaVersion` | literal `1` | Unknown versions read as absent.                                 |
| `git`           | string      | Non-empty, at most 1,024 UTF-16 code units; opaque to sync-core. |

The serialized record must not exceed 2 KiB. It contains no credentials,
library content, document paths, timestamps, counts, or provider responses.

### State transitions

```text
absent/invalid
  -> full sync stable, no pending work or pushes, no conflict/rejection -> trusted(revision)
  -> full sync push/instability -> one immediate verification pass
  -> verification stable, no pending work or pushes, no conflict/rejection -> trusted(revision)

trusted(revision A)
  -> no pending work + current A -> trusted(A), fast success
  -> pending work/current B/probe unsupported -> full sync
  -> full sync stable at B -> trusted(B)
  -> full sync push/instability -> one immediate verification pass
  -> verification still unstable/failure/cancel/conflict/rejection -> absent
```

Storage read/write denial never changes the synchronization result. Disconnect
or provider change cannot create a false match because the opaque revision is
destination-scoped; explicit history clearing may also discard it.

## Remote destination revision

Opaque browser-facing string assembled only by the authenticated gateway from:

- selected repository stable identity;
- selected default branch;
- current Git tree SHA, or an explicit empty-repository marker.

The gateway validates every component and bounds the final string. It never
contains access tokens, installation tokens, user tokens, session identifiers,
private keys, arbitrary paths, document content, or GitHub error messages.

## Existing authoritative entities

- **Sync operation journal** remains the sole durable authority for unsent local
  work. Its schema and acknowledgement semantics do not change.
- **Synchronized documents and immutable objects** retain their existing paths,
  schemas, hashes, revisions, merge rules, and tombstones.
- **Provider session** retains its repository selection and cached installation
  token. No session migration is required.
