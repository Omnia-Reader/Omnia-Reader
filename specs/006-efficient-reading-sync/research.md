# Research: Efficient Reading Synchronization

## Decision: Treat open activity as device-local

- **Decision**: Compare only manifest-represented publication identity and metadata before journaling an open-time book change; ignore `lastOpenedAt` by itself.
- **Rationale**: `lastOpenedAt` drives local recent-book ordering and is explicitly not merge authority. The synchronized record reconstructed from a manifest does not restore it, so using it as manifest revision creates write churn without cross-device value.
- **Alternatives considered**: Synchronize every open (current request burst); remove metadata refresh entirely (loses legitimate extracted metadata corrections); add a new durable metadata revision (unnecessary schema change).

## Decision: Reuse a validated remote publication snapshot

- **Decision**: Fetch active manifests once for a book pass, index only canonical valid manifests, and skip local publications already represented remotely when no durable book operation exists.
- **Rationale**: The journal is authoritative for local changes. Missing remote manifests remain discoverable from the snapshot and still trigger full verified seeding. This removes library-size-proportional source hashing and provider calls from progress-only fallbacks.
- **Alternatives considered**: Trust all remote entries (unsafe); remove snapshot seeding (breaks recovery from a lost/empty journal); add provider-specific batch APIs (unneeded boundary expansion).

## Decision: Make legacy cleanup mutation-triggered and retryable

- **Decision**: Schedule obsolete-layout cleanup after publication pull or push work, retain the pending state after failure or cancellation, and skip it during stable passes.
- **Rationale**: Supported versions no longer write the legacy layout. Tying the scan to actual publication reconciliation eliminates reading-time requests and naturally re-enables cleanup after work against a newly selected destination, without a destination identity cache or durable schema.
- **Alternatives considered**: Never clean legacy data (compatibility regression); cache one success for the service lifetime (incorrect after provider/repository switching); persist a destination-scoped browser marker (migration burden); change the provider manifest schema (too broad for the defect).

## Decision: Trust exact manifests during stable passes

- **Decision**: A parsed manifest at the exact canonical path is sufficient remote-presence evidence when no book operation is pending. Do not issue routine LFS metadata probes for every local publication.
- **Rationale**: Per-book LFS probes are the dominant size-dependent request cost. Pending and missing-manifest work still opens, hashes, probes, and repairs objects through the existing validation path.
- **Alternatives considered**: Probe every object every pass (current performance defect); add a periodic integrity sweep (separate feature with scheduling and UX requirements).
