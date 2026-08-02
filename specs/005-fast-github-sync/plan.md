# Implementation Plan: Fast GitHub Synchronization

**Feature Directory**: `005-fast-github-sync` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-fast-github-sync/spec.md`

## Summary

Add a cheap selected-repository revision probe to the existing GitHub gateway
contract and wrap the shared library sync coordinator with a provider-aware,
journal-aware checkpoint worker. A repeated GitHub sync with no pending local
operations compares one opaque revision with its last trusted stable revision
and returns zero counts immediately. Any uncertainty executes the current full
coordinator unchanged; a checkpoint is established only when the remote
revision is stable across a successful mutation-free pass.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing Fastify gateway, Octokit GitHub adapter,
Angular dependency injection, sync-core transport/coordinator, sync-git gateway
client, and IndexedDB operation journal; no new dependency

**Storage**: Bounded schema-versioned browser localStorage checkpoint; existing
IndexedDB operation journal remains authoritative

**Testing**: Vitest/Angular unit tests; Playwright fake-gateway sync journey;
credentialed live GitHub remains a separate gate

**Target platforms**: Web/PWA plus shared Chromium, Firefox, WebKit, desktop
Tauri, and Android Tauri web client behavior; no native code change

**Performance goals**: Trusted no-change sync performs one browser-to-gateway
revision request, one lightweight provider tree request while the installation
token remains valid, no document/blob reads, no LFS operations, and completes
under 100 ms against the local fake provider

**Constraints**: Offline-first, hostile remote/checkpoint input, no credential
movement, no merge/layout changes, cancellation-aware async work, older stored
checkpoint corruption must fail open to a full sync

**Scope**: GitHub gateway/client, provider-neutral transport and checkpoint
worker, Angular composition, focused browser journey, and sync contract docs;
MEGA execution and all reader engines remain unchanged

## Constitution Check

_GATE: Passed before research and re-checked after design._

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included
      where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged, or the approved scope change is
      documented.

Post-design check: passed. The checkpoint is discardable convenience state,
the journal remains authoritative, the gateway retains credentials, and every
uncertain state falls back to the existing complete merge.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `SyncGatewayAdapter`, `registerProviderRoutes`,
  `GitHubSyncGatewayAdapter.listDocuments`, `GitHubGatewayClient`,
  `LibrarySyncTransport`, `LibrarySyncCoordinator`, `SyncWorker`,
  `IndexedDbOperationJournal.pending`, `SelectedLibrarySyncTransport`, and
  `createLibrarySyncService`.
- **Owning project(s)**: `sync-gateway`, `sync-git`, `sync-core`, and
  `omnia-reader`; `omnia-reader-e2e` owns browser acceptance.
- **Affected consumers**: The optional transport revision capability is consumed
  only by the new checkpoint worker. Existing MEGA and in-memory transports need
  no implementation. The shared `LIBRARY_SYNC_SERVICE` remains the manual and
  automatic entry point.
- **Unchanged boundaries**: Reader engines, library persistence/backup, sync
  record schemas, merge rules, remote paths, LFS transfers, authentication,
  sessions, MEGA, and native hosts.

### Repository Paths

```text
apps/omnia-reader/src/app/app.config.ts
apps/omnia-reader-e2e/src/sync.spec.ts
apps/sync-gateway/src/gateway-contract.ts
apps/sync-gateway/src/provider-routes.ts
apps/sync-gateway/src/github-adapter.ts
apps/sync-gateway/src/github-adapter.spec.ts
apps/sync-gateway/src/app.spec.ts
libs/sync/core/src/lib/library-sync-transport.ts
libs/sync/core/src/lib/change-aware-sync-worker.ts
libs/sync/core/src/lib/change-aware-sync-worker.spec.ts
libs/sync/core/src/lib/sync-provider-selection.ts
libs/sync/core/src/index.ts
libs/sync/git/src/lib/github-gateway-client.ts
libs/sync/git/src/lib/github-gateway-client.spec.ts
docs/sync-gateway-api.md
specs/005-fast-github-sync/
```

## Design

### Contracts and State

- `SyncGatewayAdapter` gains an optional selected-destination revision
  capability. Provider routes expose `GET /revision` only for capable adapters.
  GitHub returns `{ revision }`, where the bounded opaque value scopes the
  selected repository, default branch, and current tree SHA (or empty state).
- `LibrarySyncTransport` gains an optional cancellation-aware
  `destinationRevision` capability. `GitHubGatewayClient` validates and returns
  it; `SelectedLibrarySyncTransport` forwards it only for the active provider.
- `BrowserSyncCheckpointStore` persists `{ schemaVersion: 1, git: string }`
  under one bounded localStorage key. Invalid/oversized state reads as absent;
  read/write denial is isolated.
- `ChangeAwareSyncWorker` receives the delegate coordinator, selected transport,
  journal, provider selection, and checkpoint store. It serializes concurrent
  calls like the coordinator.
- A trusted fast path requires provider `git`, supported revision probe, an empty
  journal, and equality between the current and stored revision.
- A full pass records the pre-pass revision, runs the unchanged delegate, checks
  the journal again, and probes the post-pass revision. A no-op stable pass stores
  the checkpoint immediately. A mutating or unstable successful pass runs one
  immediate complete verification pass and stores the resulting revision only
  when that pass is stable, mutation-free, and leaves no pending, conflicted, or
  rejected work. Continued instability clears the checkpoint.
- Progress, bookmark, and annotation workers reuse the remote documents already
  returned by their pull list as the optimistic push snapshot. Conflict retries
  re-read only the affected path. The coordinator starts those three independent
  state workers concurrently after schema, publication, and logical-book
  dependencies finish.
- The GitHub gateway resolves document-list blobs with a fixed concurrency of
  eight and preserves tree order, replacing the former one-by-one provider
  waterfall without allowing an unbounded request burst.
- No existing durable record or schema migrates. Removing the feature leaves
  harmless bounded localStorage state and restores full synchronization.

### User Interface and Accessibility

- No new component or interaction. Existing manual/automatic status shows the
  same accessible successful zero-count outcome and existing cancellation/error
  states.

### Security and Failure Handling

- Repository authorization and installation tokens remain in the gateway. The
  browser receives only an opaque bounded revision already scoped to its selected
  authenticated repository.
- The adapter validates GitHub tree responses and maps authorization, rate-limit,
  timeout, and protocol errors through existing safe error handling.
- Invalid local checkpoints fall back to full sync. Probe failure, cancellation,
  delegate failure, conflicts, rejected data, post-pass pending work, or
  instability that remains after the bounded verification pass never advances
  the checkpoint.
- Checkpoint persistence is best effort and cannot change a successful full-sync
  result. Offline behavior and automatic retry remain unchanged.

### Lifecycle and Performance

- The no-change path replaces six sequential worker scans and their tree/blob
  calls with one lightweight revision request. It allocates no worker, listener,
  timer, or background task.
- The wrapper coalesces concurrent sync calls and forwards the existing abort
  signal. Its storage record is capped at 2 KiB.
- A first pass and every uncertain pass deliberately retain safe full-sync
  behavior. Mutating or unstable success performs at most one immediate
  convergence pass, avoiding both a concurrent-remote-change race and a second
  user-triggered full sync. Fallback state synchronization removes redundant
  per-record reads, uses concurrency bounded to three independent workers, and
  caps provider blob reads at eight per document listing.

## Verification Plan

| Requirement/story               | Evidence                                                                             | Command or environment                                                                                                                                    | Required locally?        |
| ------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| FR-001, US1                     | GitHub revision adapter/route bounded response, empty repository, safe errors        | `npx nx test sync-gateway --skip-nx-cache`                                                                                                                | Yes                      |
| FR-001, FR-007                  | Client revision validation, cancellation, and safe gateway error                     | `npx nx test sync-git --skip-nx-cache`                                                                                                                    | Yes                      |
| FR-002–FR-009, US1–US2          | Fast path, durable checkpoint, all fallbacks, instability, cancellation, concurrency | `npx nx test sync-core --skip-nx-cache`                                                                                                                   | Yes                      |
| Shared composition/status       | Angular provider composition and existing sync status suites                         | `npx nx test omnia-reader --skip-nx-cache`                                                                                                                | Yes                      |
| SC-001–SC-003                   | Fake-gateway browser request count and repeat sync journey                           | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx nx run omnia-reader-e2e:e2e -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts` | Yes if browser available |
| TypeScript boundaries           | Affected project lint                                                                | `npx nx run-many -t lint -p sync-gateway sync-git sync-core omnia-reader --skip-nx-cache`                                                                 | Yes                      |
| Production integration          | Gateway and application builds                                                       | `npx nx build sync-gateway --configuration production --skip-nx-cache` and `npx nx build omnia-reader --configuration production --skip-nx-cache`         | Yes                      |
| Live latency/provider semantics | Credentialed repeat synchronization request trace                                    | Live GitHub App and selected test repository                                                                                                              | No; external credentials |
| Repository hygiene              | Whitespace/error check                                                               | `git diff --check`                                                                                                                                        | Yes                      |

## Delivery and Documentation

- **Vertical slices**: (1) revision contract from GitHub through transport; (2)
  checkpoint worker fast path and safe fallback; (3) Angular/browser integration
  and complete verification.
- **Migration/rollout**: Deploy gateway and browser client together. Until both
  are updated, the old full-sync behavior remains. Checkpoint absence after
  upgrade intentionally causes one safe full pass and, only after mutation or
  observed instability, at most one immediate convergence pass.
- **Documentation**: Add the lightweight revision endpoint/checkpoint semantics
  to `docs/sync-gateway-api.md`. Product direction is unchanged, so
  `docs/universal-reader-plan.md` needs no status edit unless live acceptance
  materially changes a release gate.
- **Residual gates**: Credentialed live GitHub timing/request trace, provider
  quota behavior, packaged Tauri hosts, emulator, and physical device remain
  unverified unless run explicitly; no host-specific code changed.

## Complexity and Exceptions

No constitution exceptions.
