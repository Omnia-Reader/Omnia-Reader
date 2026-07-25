---
name: change-offline-sync
description: Implement or diagnose Omnia Reader persistence, backup, synchronization, provider, or gateway behavior. Use for IndexedDB or OPFS schemas and migrations, hashing, quarantine, backup archives, operation journals, merge rules, tombstones, auto-sync, Git/LFS, MEGA, Fastify gateway security, Redis sessions, or the native MEGA SDK bridge.
---

# Change Offline Sync

Preserve local-first reading, lossless migration, remote integrity, and the
credential boundary while changing storage or synchronization.

## Classify the boundary

1. Start from the failing archive, record, request, response, provider
   operation, or gateway log.
2. Use CodeGraph to trace both mutation and recovery/error paths.
3. Read [references/data-contracts.md](references/data-contracts.md).
4. Read `docs/sync-gateway-api.md` for HTTP or provider work and
   `docs/mega-sdk-bridge.md` for native bridge work.

Place the change in exactly one lowest owning layer when possible:

- browser library and backup in `libs/library/data-access`;
- provider-neutral documents, merges, and scheduling in `libs/sync/core`;
- Git/LFS client and journal in `libs/sync/git`;
- MEGA client in `libs/sync/mega`;
- secrets, authorization, sessions, and provider adapters in
  `apps/sync-gateway`;
- official SDK operations in `tools/mega-sdk-bridge`.

## Preserve data guarantees

- Complete the local write before journal, renderer, or network follow-up.
- Keep reading and local mutation usable when sync is absent or failing.
- Validate records at read, write, restore, download, and gateway boundaries.
- For schema changes, version the schema, add a forward migration, preserve
  valid old data, quarantine malformed data losslessly, and test both upgrade
  and recovery.
- Preserve exact-edition SHA-256 identity, declared-size checks, bounded archive
  extraction, path confinement, CRC checks, and immutable object ordering.
- Preserve deterministic merge rules. Represent bookmark and annotation
  deletion with tombstones so stale providers cannot resurrect data.
- Publish immutable bytes before a manifest can reference them.
- Preserve retry/coalescing behavior and avoid hot loops or provider request
  bursts.

## Preserve the trust boundary

- Keep GitHub and MEGA credentials, tokens, keys, and reusable sessions out of
  Angular storage, sync documents, URLs, and logs.
- Maintain same-origin and CSRF checks, provider-scoped HttpOnly sessions,
  bounded inputs, confined logical paths, and non-sensitive errors.
- Keep the MEGA bridge loopback/private; do not turn it into a public provider
  API or expose SDK session material.
- Fail closed when provider configuration is incomplete.

## Verify

Add tests for success, conflict, retry, interruption, corruption, stale data,
and authorization failure as applicable. Use `$verify-omnia-reader` and run the
rows for every touched layer. Treat live-provider, Redis HA, container,
credentialed, emulator, and physical-device checks as separate gates; report
them as unverified unless they actually ran.
