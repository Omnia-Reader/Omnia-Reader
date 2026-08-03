# Canonical Logical-Book State Contract

The current synchronization format stores logical-library metadata in exactly one document:

```text
.omnia-reader/logical-books/state.json
```

The version 1 document MUST contain deterministically ordered current logical books, active publication variant descriptors and their canonical object paths, format preferences including null clears, membership reconciliations, compact causal heads, per-record clocks, and book/variant tombstones. It MUST be sufficient to restore remote-only active publications and to reject stale offline resurrection without reading historical mutations.

Each clock contains `changeId`, `createdAt`, and `deviceId`. Implementations compare `createdAt` and then `changeId`; the same change ID and content is idempotent, while the same change ID with different content is invalid. Tombstones win over active values at an older or equal clock. No merge may replace the whole document based only on a document timestamp.

Readers MUST reject unknown schema versions, oversized documents or record sets, malformed nested domain records, duplicate identities, inconsistent active/tombstone pairs, unsafe object paths, and conflicting immutable identities before changing local state.

Writers MUST:

1. read the current state and provider revision;
2. upload any missing immutable publication objects;
3. deterministically merge pending journal mutations into the validated state;
4. write `state.json` with the expected revision, using create-only semantics when absent;
5. reread and semantically verify the written state and revision;
6. acknowledge covered journal entries only after verification.

An optimistic conflict MUST cause a bounded reread/remerge/retry. Exhaustion or any validation failure preserves local state and pending journal entries.

For migration, readers MAY consume exact validated legacy entries beneath:

```text
.omnia-reader/logical-books/changes/
```

They MUST fold all inventoried immutable changes, publish and verify equivalent canonical state, and only then delete every other inventoried entry in the owned `logical-books/` subtree, including changes and checkpoints, as one provider-neutral batch. Replaying legacy changes after interrupted cleanup MUST be idempotent. Current writers MUST NOT create a change entry or checkpoint. Content outside the `logical-books/` subtree is not a target of this cleanup.
