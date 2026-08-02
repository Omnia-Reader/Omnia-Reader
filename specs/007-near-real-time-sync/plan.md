# Implementation Plan: Low-Latency Local-First Synchronization

**Feature Directory**: `007-near-real-time-sync` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

## Summary

Use one provider-neutral scheduler for both coalesced local commits and remote GitHub revision discovery. Page-progress activity uses a 750 ms trailing debounce, while interactive annotations and bookmarks use their separate latency budget. Consecutive conflict-free reading-state batches stay targeted until the next idle complete reconciliation. A visible, online GitHub client runs the existing change-aware worker every ten seconds; its trusted checkpoint reduces unchanged attempts to one `/revision` request.

Remove the remote-deployment notification path because the supported local, desktop, and mobile topology cannot receive GitHub webhooks behind NAT. This deletes the push broker, SSE route, EventSource contract, destination-key plumbing, stream lifecycle, and related tests/configuration while leaving the pre-existing authorization-revocation webhook unchanged.

## Ownership

- `libs/sync/core`: timer lifecycle, trigger coalescing, revision cadence, provider backoff.
- `libs/sync/git`: existing same-origin GitHub transport and revision request; no notification API.
- `apps/sync-gateway`: existing revision route and GitHub authorization security; no push/SSE fan-out.
- `apps/omnia-reader`: ordinary scheduler composition without provider-specific notification wiring.

## Design

- Default progress quiet interval: 750 ms.
- Default GitHub revision interval: 10,000 ms while started, visible, online, and Git-selected.
- Foreground transition: immediate revision check, then re-arm the periodic timer.
- Provider `Retry-After`: always overrides shorter local or revision schedules.
- Single-flight worker and trusted revision checkpoint: unchanged.
- Successful-sync minimum interval, persisted last-periodic timestamp, remote-change source, SSE connection, and push broker: removed.

## Security and Compatibility

- No provider credentials or repository identifiers move into frontend state.
- No new inbound network endpoint or secret is required.
- Existing authorization-revocation webhook behavior is not broadened or weakened.
- No durable schema migration is required; obsolete last-periodic localStorage entries are ignored.

## Verification

| Area       | Evidence                                                                                                                   | Command                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Scheduler  | 750 ms progress debounce, targeted continuation, interactive mutation budget, ten-second revision check, lifecycle/backoff | `npx nx test sync-core --skip-nx-cache`    |
| Git client | public client contract after EventSource removal                                                                           | `npx nx test sync-git --skip-nx-cache`     |
| Gateway    | provider and authorization webhook behavior after SSE removal                                                              | `npx nx test sync-gateway --skip-nx-cache` |
| App        | dependency injection and production composition                                                                            | focused app test and production build      |
| Static     | affected lint, formatting, whitespace                                                                                      | Nx lint, Prettier, `git diff --check`      |
