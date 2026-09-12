# Synchronization compatibility corpus

These immutable fixtures represent every synchronized root schema supported by
the stabilization release. `current-v2.json` must restore directly,
`legacy-v1.json` must migrate before restore, and `future-v3.json` must be
rejected without mutation. Publication content is the repository's canonical
two-page PDF fixture; its exact bytes and SHA-256 digest are embedded in each
accepted bundle.

The corpus is intentionally provider-neutral. Git/LFS pointer rejection cases
are recorded separately in `malformed-lfs-pointers.json` because pointers are a
Git transport concern, not synchronized reader data.

Corpus expectations are enforced at the owning boundaries by:

- `library-sync-manifest-service.spec.ts` for current, legacy, future, and
  forward-compatible root manifests;
- `sync-root-reconciliation-service.spec.ts` for restore, merge, object
  integrity, media type, path, duplicate, and root-ownership behavior;
- `git-lfs-pointer.spec.ts` and `github-gateway-client.spec.ts` for pointer and
  provider-response validation.

Do not update an accepted fixture in place after release. Add a new named schema
fixture so prior-version compatibility remains observable.
