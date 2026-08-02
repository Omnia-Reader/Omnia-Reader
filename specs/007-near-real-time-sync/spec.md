# Feature Specification: Low-Latency Local-First Synchronization

**Feature Directory**: `007-near-real-time-sync`

**Created**: 2026-08-02

**Status**: Implemented; verification in progress

**Input**: Make synchronization effectively invisible while keeping Omnia Reader local, desktop, and mobile first with no remote deployment requirement.

## Outcome and Scope

Durable local reading changes reach GitHub after a one-second quiet boundary. Changes made by another device are discovered through a lightweight GitHub revision check within ten seconds while the application is visible and online.

The supported topology does not require a public callback service. GitHub push webhooks, server-sent events, browser notification streams, replay brokers, and webhook secrets are outside this feature.

## User Stories

### Local changes disappear into sync (P1)

1. Progress, bookmark, and annotation writes complete locally before network work.
2. Clustered non-book operations create one synchronization attempt one second after the latest write.
3. Book changes, destination selection, backgrounding, startup, and reconnect remain immediate.
4. Offline and provider-rate-limited states retain durable work and retry without blocking reading.

### Another device changes the repository (P2)

1. A visible, online GitHub client checks the selected repository revision every ten seconds.
2. An unchanged revision performs no document listing, merge, publication, or Git LFS work.
3. A changed revision enters the existing validated synchronization worker.
4. Hidden, offline, stopped, or non-Git clients perform no periodic revision checks.

## Requirements

- **FR-001**: Local durable writes MUST complete before automatic synchronization is scheduled.
- **FR-002**: Clustered reading-state changes MUST start one attempt no later than two seconds after the last change, unless offline or subject to provider `Retry-After`.
- **FR-003**: The successful-sync five-minute floor and its persisted timestamp state MUST be removed.
- **FR-004**: A visible, online GitHub client MUST check the remote revision at least once every ten seconds.
- **FR-005**: Revision checks MUST stop while hidden, offline, stopped, or using another provider.
- **FR-006**: Automatic work MUST remain single-flight and coalesce triggers received during active work.
- **FR-007**: Existing journals, checkpoints, merge rules, tombstones, integrity checks, encrypted sessions, and provider `Retry-After` handling MUST remain authoritative.
- **FR-008**: The feature MUST NOT require GitHub push event subscription, a public webhook endpoint, a webhook secret, SSE, or a remote deployment.

## Success Criteria

- **SC-001**: Deterministic scheduler tests start clustered local work after one second.
- **SC-002**: Deterministic scheduler tests perform one visible GitHub revision check every ten seconds and none while hidden or stopped.
- **SC-003**: A stable repeated Git sync performs only `GET /revision`.
- **SC-004**: Offline, rate-limited, and active-sync cases do not create overlapping work or hot loops.
- **SC-005**: Git client and gateway public contracts contain no remote-change EventSource or SSE surface.

## Acceptance Evidence

- `sync-core` scheduler tests cover debounce, revision timing, visibility, offline recovery, provider backoff, single-flight behavior, and teardown.
- `sync-git` tests cover the remaining GitHub gateway client contract.
- `sync-gateway` tests cover the remaining provider and authorization webhook contract without push fan-out.
- Browser request-bound evidence distinguishes the lightweight `/revision` check from a changed-state full synchronization.
- Live GitHub, packaged Tauri, Android emulator, and physical-device behavior remain separate gates unless actually run.
