# Storage and synchronization contracts

## Local library

`BrowserLibraryRepository` owns metadata, binary references, covers, progress,
bookmarks, annotations, preferences, and quarantine records. Publication bytes
prefer OPFS and fall back to byte-backed IndexedDB. Hashing is incremental and
worker-backed where available.

Relevant files:

- `libs/library/data-access/src/lib/browser-library-repository.ts`
- `libs/library/data-access/src/lib/publication-binary-storage.ts`
- `libs/library/data-access/src/lib/publication-fingerprint.ts`
- `libs/library/data-access/src/lib/library-backup.service.ts`

Use their colocated specs, including migration, binary-storage, fingerprint,
and backup cases.

## Provider-neutral sync

`libs/sync/core` owns book manifests, immutable object verification, progress,
bookmark and annotation synchronization, provider selection, coordination,
automatic scheduling, and merge behavior. It must not know provider
credentials.

Progress is mutable per device. Bookmarks and annotations are mutable records
with deletion tombstones. Publications are immutable objects keyed by exact
content identity.

## Provider clients

- `libs/sync/git`: indexed operation journal, Git/LFS pointer and path rules,
  Git sync service, merge helpers, and same-origin gateway client.
- `libs/sync/mega`: same-origin MEGA gateway client and provider tokens.

Provider clients transport the shared logical layout; they do not weaken
validation or invent provider-specific domain semantics.

## Gateway and native bridge

`apps/sync-gateway` owns authorization state, encrypted sessions, Redis-backed
shared sessions, request security, bounded provider routes, and GitHub/MEGA
adapters. Its executable contract is documented in
`docs/sync-gateway-api.md`.

`tools/mega-sdk-bridge` is a private, loopback official-SDK sidecar. Its
authentication, root confinement, transfer ordering, concurrency, and error
contract are documented in `docs/mega-sdk-bridge.md`.

## Required failure cases

Select applicable cases for every change:

- unavailable OPFS, worker, network, provider, or bridge;
- invalid schema, identity, size, digest, CRC, path, or content type;
- interrupted upload/download/restore and retry;
- optimistic conflict and stale remote data;
- duplicated provider objects or names;
- expired, rotated, replayed, or provider-mismatched session;
- missing or partial provider configuration;
- local success followed by sync failure;
- deleted bookmark or annotation meeting an older live copy.
