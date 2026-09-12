# Implementation Plan: Production-Ready Synchronization

**Feature Directory**: `015-sync-stability` | **Date**: 2026-09-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/015-sync-stability/spec.md`

**Note**: This template is filled by `$speckit-plan`.

## Summary

Promote GitHub/Git LFS synchronization to a production-supported capability
without changing the provider-neutral record schema or local-first merge
semantics. First repair the stale browser acceptance harness revealed by the
fresh 16/18 Chromium run, then make complete convergence mandatory across
Chromium, Firefox, and WebKit. Add truthful provider maturity UI, real Redis
lifecycle evidence, a protected live-GitHub staging gate, and immutable
container promotion/rollback evidence. Packaged desktop and Android use a
narrow native synchronization broker with an opaque native session jar; the
browser/PWA keeps the existing same-origin HttpOnly-cookie boundary. MEGA
remains experimental and its deterministic regressions remain mandatory.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing Angular/CDK/RxJS application composition;
Playwright; Fastify; Octokit; Redis client; Tauri 2 and its deep-link boundary;
the existing Git/LFS and MEGA transports. No new browser runtime dependency is
planned. Native HTTP and cookie-jar dependencies are version-pinned. Desktop
hosts use `keyring` 3.6.3 platform backends for protected reusable sessions;
Android remains session-only and requires reauthentication after restart.

**Storage**: Existing IndexedDB journal and synchronized records, OPFS or
IndexedDB publication bytes, browser provider selection/history, encrypted
gateway sessions in Redis, and conditional protected native session state for
packaged hosts. No synchronized schema migration is planned.

**Testing**: Vitest/Angular unit tests; Playwright for real-browser journeys;
Rust tests and packaged WebDriver/emulator journeys for the native broker;
container smoke and real Redis integration; protected credentialed GitHub
conformance; release scan/sign/canary/rollback gates. The pinned MEGA bridge
core/container tests remain regression gates but live MEGA promotion is out of
scope.

**Target platforms**: Web/PWA on Chromium, Firefox, and WebKit; supported Tauri
desktop packages; Android Tauri on an emulator; physical-device evidence is a
separate distribution gate.

**Performance goals**: Under the specification's two-CPU, 4 GiB, 100 ms RTT,
10 Mbit/s staging profile, 95% of targeted manual reading-state synchronization
finishes within 2 seconds and remote changes become visible on a second active
device within 15 seconds. Unchanged passes transfer no publications. A 25 MiB
native transfer is cancellable, reports monotonic progress, retains at most
8 MiB of unacknowledged body data, and adds at most 64 MiB RSS over the
post-session idle baseline in controlled Linux and Android profiles.

**Constraints**: Offline-first, hostile publication/sync data, accessible
interaction, bounded renderer lifecycle, locked dependencies

**Scope**: Stable GitHub/Git LFS synchronization of EPUB/PDF publications,
membership, progress, bookmarks, annotations, exclusions, and tombstones;
provider maturity UI; browser and packaged-host routing; gateway session
continuity; CI, staging, deployment, and release evidence. MEGA behavior stays
implemented but experimental.

## Constitution Check

_GATE: Must pass before research and be re-checked after design._

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

Pre-design gate: PASS. Post-design gate: PASS. The native broker preserves the
credential boundary through narrow typed commands rather than weakening the
browser gateway for cross-origin use. No constitutional exception is required.

Record every exception in **Complexity and Exceptions**. An unjustified
exception blocks task generation.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `SyncSettingsPageComponent`,
  `SyncConnectionStatusService`, `NavigationComponent`, `AutoSyncScheduler`,
  `ChangeAwareSyncWorker`, `GitHubGatewayClient`, `MegaGatewayClient`,
  `GatewaySessionStore`, `gatewaySessionStoresFromEnvironment`,
  `GitHubSyncGatewayAdapter`, `SimulatedSyncGateway`, the Tauri command registry,
  and the release verifier/workflows. The fresh failure is owned by stale
  `sync.spec.ts` library-opening selectors and does not reach a reader engine.
- **Owning project(s)**: `omnia-reader`, `omnia-reader-e2e`, `sync-core`,
  `sync-git`, `sync-mega`, `sync-gateway`, `platform`, the new `sync-native`
  adapter, the Tauri host, deployment tooling, and release tooling.
- **Affected consumers**: Settings and persistent toolbar presentation;
  application DI composition; Git/MEGA logical transport consumers; production
  browser/PWA and packaged hosts; GitHub Actions release gates and deployment
  operators.
- **Unchanged boundaries**: EPUB/PDF engine contracts, synchronized record and
  tombstone schemas, local library persistence, backup format, merge ordering,
  MEGA wire protocol, and reader rendering remain unchanged unless a focused
  failing test proves otherwise.

### Repository Paths

```text
apps/omnia-reader/                 # Angular UI and orchestration, if affected
apps/omnia-reader-e2e/             # Real-browser journeys, if affected
apps/sync-gateway/                 # Provider HTTP, credentials, sessions
libs/platform/                     # Browser/Tauri host abstraction
libs/sync/core/                    # Provider-neutral synchronization
libs/sync/git/                     # Git/LFS journal and gateway client
libs/sync/mega/                    # MEGA gateway client
libs/sync/native/                  # Packaged-host typed sync transport
src-tauri/                         # Narrow privileged native commands
deployment/                        # Production topology and executable gates
tools/release/                     # Evidence, integrity, and promotion checks
.github/workflows/                 # Mandatory CI and protected release jobs
docs/                              # Gateway, native boundary, and release runbook
```

Delete unaffected paths from the feature plan and list the concrete files or
directories that own the change.

## Design

### Contracts and State

- Keep `LibrarySyncTransport`, provider-neutral records, root manifest, hashes,
  tombstones, and journal acknowledgement semantics unchanged. Browser clients
  continue using the same-origin gateway implementations.
- Add a `sync-native` implementation of the existing logical transport using
  narrow typed Tauri commands. Rust owns the allowlisted HTTPS origin, cookies,
  reusable session state, request headers, redirects, streaming, cancellation,
  and error sanitization; none are exposed through a generic webview HTTP API.
  Reusable state survives restart only when the host proves a Rust-only
  encrypted store whose bootstrap secret is platform-protected; otherwise the
  broker clears authority on exit and requires safe reauthentication.
- Add single-use, short-lived native authorization handoff routes. GitHub OAuth
  still terminates at the public HTTPS gateway; the callback opens a validated
  application deep link containing only an opaque one-use handoff code, which
  the native broker redeems into its private session jar. Browser routes remain
  unchanged.
- Add provider presentation metadata with `experimental` and `supported`
  maturity. Maturity is build/release policy, never inferred from historical
  success. GitHub flips to `supported` only in the final promotion slice; MEGA
  remains `experimental`.
- Add a versioned, sanitized synchronization release-evidence manifest that
  binds candidate commit, artifact digests, environments, platforms, providers,
  scenarios, results, unavailable gates, and timestamps. It contains no user or
  credential material.
- Existing synchronized and browser-durable schemas remain byte-compatible.
  Rollback changes executable artifact digests only and is forbidden if a
  candidate introduces unreadable durable state.

### User Interface and Accessibility

- Sync Settings provider cards show explicit accessible maturity labels and a
  concise consequence. The toolbar carries experimental maturity through ready,
  syncing, successful, error, and recovery descriptions so success cannot imply
  support.
- Preserve existing live regions and add focused assertions for keyboard order,
  cancellation/error focus restoration, screen-reader names/descriptions, touch
  operation, and narrow viewports. Maturity may not rely on color.
- Native authorization opens in the system browser and returns through the
  registered deep link; cancellation, replay, expiry, and an unavailable system
  browser return focus to a safe Sync Settings recovery action.

### Security and Failure Handling

- Preserve schema, path, size, digest, media-type, root-confinement, same-origin,
  CSRF, provider-error sanitization, and fail-closed configuration checks at
  every existing browser/gateway boundary.
- The native broker allowlists one configured HTTPS origin and an enumerated set
  of methods/paths/headers. It rejects redirects outside the origin, arbitrary
  webview request construction, forged/replayed/expired handoffs, and response
  cookie/header exposure. Unique canary credentials verify absence from IPC,
  browser storage, synchronized data, redirects, logs, and evidence artifacts.
- Native persistence fails closed: unsupported or unavailable protected storage
  clears reusable authority and reports that reconnection is required while
  retaining all local books and pending operations.
- Redis unavailability is a readiness failure, not a reason to fall back to a
  process-local production session store. Key rotation accepts current and
  bounded previous keys without extending TTL; backup/restore and multi-replica
  invalidation are exercised with real Redis.
- Cancellation, network loss, app/gateway restart, provider throttling, and
  optimistic conflict preserve the local journal and publish no dangling
  manifest. Teardown aborts active broker requests and removes listeners.

### Lifecycle and Performance

- Repair the stale acceptance helper using the current accessible open-button
  contract and assert reader navigation before renderer-specific state. This is
  test-only; no reader lifecycle change is justified by the observed failure.
- Isolate long convergence tests in a dedicated job/file so ordinary browser
  shards do not duplicate them. Pull requests run one complete matrix pass;
  release candidates run three consecutive passes per browser and preserve
  traces on failure.
- The native broker streams bounded chunks/events across IPC, emits monotonic
  progress, supports cancellation, retains no completed response bodies, bounds
  concurrency and queues, and clears sensitive in-memory state on disconnect.
- Extend current request-count, no-op fast-path, bundle-budget, 25 MiB transfer,
  container shutdown, and no-hot-loop evidence. Do not add provider-native
  partial resume in this feature.
- Add a versioned synchronization performance profile and runner with 20 warm-up
  and at least 200 measured attempts. Preserve raw sanitized timings so the 95th
  percentile and within-target ratio can be independently recomputed.
- Emit low-cardinality synchronization outcome/latency, readiness, renewal,
  throttle, cancellation, and recovery telemetry. Exercise alert rules with
  injected staging failures; never use account, repository, path, publication,
  credential, or session identity as metric labels.

## Verification Plan

List the exact smallest-to-broadest commands required by
`.agents/skills/verify-omnia-reader/references/change-matrix.md`.

| Requirement/story      | Evidence                                                                                       | Command or environment                                                                                                                                                       | Required locally?                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| US1, FR-001–FR-008     | Core, Git, MEGA merge/journal/integrity regressions                                            | `npx nx run-many -t test -p sync-core sync-git sync-mega --skip-nx-cache`                                                                                                    | Yes                                                                                        |
| Fresh red gate         | Correct current library-open contract reaches the reader before convergence                    | `REMOTE_SYNC_E2E=1 npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 sync.spec.ts`                                      | Yes                                                                                        |
| US1, FR-017            | Complete Git/MEGA EPUB/PDF two-device convergence                                              | Dedicated Chromium, Firefox, and WebKit CI matrix; release candidate uses `--repeat-each=3`                                                                                  | Chromium locally; all in CI                                                                |
| SC-003                 | Two-device visibility and manual synchronization latency under the fixed staging profile       | Versioned profile plus dedicated performance runner with 20 warm-up and at least 200 measured attempts                                                                       | Protected staging                                                                          |
| US2, FR-009–FR-014     | Gateway security, auth lifecycle, throttling, session rotation, and fail-closed behavior       | `npx nx test sync-gateway --skip-nx-cache`                                                                                                                                   | Yes                                                                                        |
| FR-014                 | Real Redis multi-replica, restart, key rotation, webhook, TTL, outage, backup/restore          | Pinned loopback Redis plus `OMNIA_SYNC_REDIS_TEST_URL=redis://127.0.0.1:6379/15 npx nx test sync-gateway --skip-nx-cache`                                                    | When container runtime is available                                                        |
| US4, FR-011, FR-020    | Provider maturity and accessible status/card behavior                                          | `npx nx test omnia-reader --skip-nx-cache`; focused sync accessibility journeys                                                                                              | Yes                                                                                        |
| FR-019                 | Browser accessibility and compatibility                                                        | Chromium/Firefox/WebKit Playwright matrix for sync and accessibility specs                                                                                                   | CI required                                                                                |
| FR-012, FR-013, FR-019 | Native broker allowlist, handoff replay/expiry, secret-canary, streaming and restart contracts | `cargo test --manifest-path src-tauri/Cargo.toml`; `npx nx test platform`; `npx nx test sync-native`                                                                         | Yes where toolchain is available                                                           |
| FR-019                 | Packaged provider connection, sync, offline restart, recovery                                  | Linux, Windows, and macOS packaged journeys plus Android emulator using HTTPS simulated/staging gateway                                                                      | Release environment                                                                        |
| US1, US2, FR-018       | Credentialed GitHub two-device/live failure conformance                                        | Protected `LIVE_GITHUB_SYNC_E2E=1 BASE_URL=https://<staging>` Playwright workflow                                                                                            | Protected staging                                                                          |
| US3, FR-012–FR-016     | Production container, public HTTPS, Redis readiness, scan/sign, canary and rollback            | `npm run container:smoke`, release verifier, protected immutable-digest workflow and deployment scripts                                                                      | Smoke when a functioning container runtime is available; mandatory for candidate promotion |
| All                    | Affected lint, builds, dependency audit, formatting and diff integrity                         | `npx nx run-many -t lint --all --skip-nx-cache`; production app/gateway builds; `npm audit --omit=dev`; `npm run release:test`; `npm run release:verify`; `git diff --check` | Yes except unavailable external tooling                                                    |

Always include `git diff --check`. Include lint for each affected TypeScript
project and a production build when application, worker, asset, style,
dependency, service-worker, or bundle composition changes.

## Delivery and Documentation

- **Vertical slices**: (1) repair the stale acceptance harness and expose any
  downstream defect; (2) complete Git/MEGA format coverage and mandatory browser
  convergence; (3) add provider maturity and accessibility; (4) prove real
  Redis continuity/readiness; (5) implement and prove the native broker and
  authorization handoff; (6) add protected live GitHub conformance and
  production-shaped staging; (7) automate immutable scan/sign/canary/rollback;
  (8) run the complete candidate matrix and only then promote GitHub maturity.
- **Migration/rollout**: No synchronized schema migration. Deploy additive
  gateway native-handoff support first, then packaged clients. Browser routes
  remain compatible. Rotate session encryption keys using current-plus-previous
  acceptance before removing old keys. Promote exact image digests from staging
  to canary to production; rollback restores prior digests only.
- **Documentation**: Update `docs/sync-gateway-api.md`, add the packaged native
  boundary, update `docs/release-and-rollback.md`, and reconcile
  `docs/universal-reader-plan.md` only when verified status or release gates
  materially change.
- **Residual gates**: Disposable live GitHub App/repository, real HTTPS staging,
  Redis HA/backup infrastructure, registry signing authority, Windows/macOS
  packaged execution, Android emulator, and physical-device acceptance may be
  unavailable locally and must be reported independently. MEGA live conformance
  remains a later promotion gate.

## Complexity and Exceptions

No exceptions. The additional native boundary is narrower than a generic HTTP
plugin and exists to preserve, rather than relax, the credential contract on
packaged origins.
