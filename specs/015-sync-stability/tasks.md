# Tasks: Production-Ready Synchronization

**Input**: Design documents from `specs/015-sync-stability/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/`, and `quickstart.md`

**Tests**: Every behavioral task below places a failing or newly relevant test
before implementation. Documentation-only contract and runbook tasks are called
out explicitly.

**Organization**: Work is grouped by independently testable user story. GitHub
is the only provider eligible for stable promotion in this feature; MEGA remains
experimental while retaining deterministic regression coverage.

## Phase 1: Impact and Contract Preparation

**Purpose**: Lock shared evidence identities and dependency decisions before
behavioral implementation.

- [x] T001 Re-run `codegraph explore "Feature 015 synchronization stability callers tests and Nx owners"` and reconcile changed ownership in `specs/015-sync-stability/plan.md`
- [x] T002 [P] Define stable gate identifiers, mandatory-versus-reportable availability, and sanitized examples in `specs/015-sync-stability/contracts/sync-release-evidence.md`
- [x] T003 [P] Record primary-documentation review and exact versions for native HTTP, cookie, deep-link, and protected-storage crates in `specs/015-sync-stability/research.md`
- [x] T004 [P] Add sanitized valid, rejected, and unavailable evidence fixtures under `tools/release/fixtures/sync-evidence/`
- [x] T005 Run `npx prettier --check specs/015-sync-stability tools/release/fixtures/sync-evidence` and `git diff --check`, recording results in `specs/015-sync-stability/quickstart.md`

**Checkpoint**: Shared evidence vocabulary, dependency boundaries, and owning
projects are explicit.

---

## Phase 2: User Story 1 - Trust Synchronization Across Devices (Priority: P1) 🎯 MVP

**Goal**: Two clean browser profiles converge exact EPUB/PDF publications,
reading state, distinct contributions, conflicts, and tombstones through Git,
while deterministic MEGA coverage remains intact.

**Independent test**: Run the dedicated two-device suite from clean profiles
against a clean simulated destination and prove byte-identical restore and
identical valid logical state on both profiles.

### Tests for User Story 1

- [x] T006 [P] [US1] Add a failing regression for the current accessible library-open contract to `apps/omnia-reader-e2e/src/reader-state-helpers.spec.ts`
- [x] T007 [US1] Extend `apps/omnia-reader-e2e/src/sync.spec.ts` with missing Git/EPUB and MEGA/PDF two-device cases and explicit reader-route preconditions
- [x] T008 [US1] Add clean replacement-device restore assertions for publication bytes, progress, bookmarks, annotations, membership, and tombstones in `apps/omnia-reader-e2e/src/sync-convergence.spec.ts`
- [x] T009 [US1] Add concurrent create/update/delete and destination-switch isolation cases to `apps/omnia-reader-e2e/src/sync-convergence.spec.ts`
- [x] T010 [P] [US1] Add a current/legacy synchronization corpus plus restore, merge, future-schema, malformed pointer, digest, size, media-type, path, duplicate, root-ownership, and forward-compatibility cases to `apps/omnia-reader-e2e/src/fixtures/sync-compatibility/`, `libs/sync/core/src/lib/sync-root-reconciliation-service.spec.ts`, `libs/sync/core/src/lib/library-sync-manifest-service.spec.ts`, and `libs/sync/git/src/lib/github-gateway-client.spec.ts`

### Implementation for User Story 1

- [x] T011 [US1] Implement the accessible publication-open helper in `apps/omnia-reader-e2e/src/reader-state-helpers.ts` and replace stale title selectors in `apps/omnia-reader-e2e/src/sync.spec.ts` and `apps/omnia-reader-e2e/src/epub-selection.spec.ts`
- [x] T012 [US1] Split long convergence cases into `apps/omnia-reader-e2e/src/sync-convergence.spec.ts` while keeping shorter behavior in `apps/omnia-reader-e2e/src/sync.spec.ts`
- [x] T013 [US1] Extend `apps/omnia-reader-e2e/src/simulated-sync-gateway.ts` only for exact format coverage, hostile records, interruption ordering, and destination isolation required by T007–T010
- [ ] T014 [US1] Add the fixed staging profile and 20-warm-up/200-measurement two-device latency runner in `apps/omnia-reader-e2e/src/sync-performance-profile.json`, `apps/omnia-reader-e2e/src/sync-performance-runner.mjs`, and `apps/omnia-reader-e2e/src/sync-performance-runner.spec.mjs`
- [ ] T015 [US1] Add a dedicated Chromium/Firefox/WebKit convergence target and one-pass pull-request matrix to `apps/omnia-reader-e2e/project.json` and `.github/workflows/verify.yml`
- [ ] T016 [US1] Add a three-consecutive-pass release-candidate convergence matrix with traces and zero allowed skips to `.github/workflows/verify.yml`

### Verification for User Story 1

- [x] T017 [US1] Run `npx nx run-many -t test -p sync-core sync-git sync-mega --skip-nx-cache` and record exact totals in `specs/015-sync-stability/quickstart.md`
- [x] T018 [US1] Run `PLAYWRIGHT_HTML_OPEN=never REMOTE_SYNC_E2E=1 npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 sync.spec.ts sync-convergence.spec.ts`; record Firefox/WebKit evidence separately in `specs/015-sync-stability/quickstart.md`

**Checkpoint**: User Story 1 is independently demonstrable in Chromium and has
mandatory, non-skipped cross-browser release gates.

---

## Phase 3: User Story 2 - Recover Safely From Real Failures (Priority: P1)

**Goal**: Browser and packaged clients preserve local work and recover safely
from authentication, authorization, throttle, transfer, restart, session-store,
and native-boundary failures.

**Independent test**: Inject each failure while local mutations continue, then
restore the dependency and prove one complete convergence with no leaked
authority, duplicate acknowledgement, or dangling publication reference.

### Tests for User Story 2

- [ ] T019 [P] [US2] Add retry-deadline, coalescing, cancellation, restart, and no-hot-loop assertions to `libs/sync/core/src/lib/auto-sync-scheduler.spec.ts` and `libs/sync/core/src/lib/change-aware-sync-worker.spec.ts`
- [ ] T020 [P] [US2] Add Git/LFS interrupted-upload ordering and whole-transfer retry assertions to `libs/sync/git/src/lib/github-gateway-client.spec.ts` and `apps/sync-gateway/src/github-adapter.spec.ts`
- [ ] T021 [P] [US2] Extend real Redis coverage for two instances, restart, key rotation, unchanged TTL, webhook replay/invalidation, outage, backup, restore, and readiness in `apps/sync-gateway/src/shared-session-stores.spec.ts` and `apps/sync-gateway/src/app.spec.ts`
- [ ] T022 [P] [US2] Add exact-origin, typed-operation, bounded-body, redirect-denial, sanitization, cancellation, and teardown tests in `libs/sync/native/src/lib/native-sync-transport.spec.ts`
- [ ] T023 [P] [US2] Add cookie-opacity, header-filtering, secret-canary, queue-bound, stream-progress, cancellation, and cleanup tests in `src-tauri/src/sync_broker/tests.rs`
- [ ] T024 [P] [US2] Add handoff binding, provider, expiry, atomic-use, replay, forgery, and sanitized-failure tests in `apps/sync-gateway/src/native-handoff.spec.ts` and `src-tauri/src/native_handoff/tests.rs`
- [ ] T025 [P] [US2] Add protected-versus-session-only persistence, fail-closed downgrade, and restart tests in `src-tauri/src/sync_session/tests.rs`
- [ ] T026 [P] [US2] Add packaged Linux/Windows/macOS/Android proof journeys for relative-route failure, broker connection, offline reading, restart, reauthentication, 25 MiB retry, 8 MiB buffer, 64 MiB RSS, and canary absence in `apps/omnia-reader-e2e/src/native/run-native-sync-e2e.mjs`

### Implementation for User Story 2

- [ ] T027 [P] [US2] Scaffold `libs/sync/native/project.json`, its TypeScript configs, `libs/sync/native/src/index.ts`, and Nx tags matching existing sync libraries
- [ ] T028 [US2] Implement the typed `LibrarySyncTransport` adapter and sanitized errors in `libs/sync/native/src/lib/native-sync-transport.ts`
- [ ] T029 [US2] Select the packaged transport without changing browser/PWA clients in `apps/omnia-reader/src/app/app.config.ts` and `apps/omnia-reader/src/app/app.config.spec.ts`
- [ ] T030 [US2] Pin reviewed native dependencies in `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, then implement HTTPS origin validation, typed routes, redirect denial, 8 MiB bounded streaming, cancellation, and opaque cookies in `src-tauri/src/sync_broker.rs`
- [ ] T031 [US2] Register only narrow synchronization commands in `src-tauri/src/lib.rs` and `src-tauri/capabilities/default.json`
- [ ] T032 [US2] Implement single-use native handoff storage and routes in `apps/sync-gateway/src/native-handoff.ts`, `apps/sync-gateway/src/provider-routes.ts`, and `apps/sync-gateway/src/app.ts`
- [ ] T033 [US2] Implement deep-link validation and direct handoff redemption into the native jar in `src-tauri/src/native_handoff.rs` and `src-tauri/src/lib.rs`
- [ ] T034 [US2] Implement Rust-only protected session persistence with explicit session-only fallback in `src-tauri/src/sync_session.rs`
- [ ] T035 [US2] Integrate reconnect, cancellation, expiry, permission-loss, and focus restoration in `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.ts`, `.html`, and `.spec.ts`
- [ ] T036 [US2] Make Redis-backed production readiness fail closed without memory fallback in `apps/sync-gateway/src/shared-session-stores.ts`, `apps/sync-gateway/src/configuration.ts`, and `apps/sync-gateway/src/app.ts`
- [ ] T037 [US2] Add a pinned loopback Redis harness in `deployment/compose.redis-test.yaml` and `apps/sync-gateway/project.json`
- [ ] T038 [US2] Wire packaged synchronization for Linux, Windows, macOS, and Android into `apps/omnia-reader-e2e/src/native/run-linux-package-e2e.mjs`, `apps/omnia-reader-e2e/src/native/run-native-e2e.mjs`, `apps/omnia-reader-e2e/src/native/run-native-sync-e2e.mjs`, and `apps/omnia-reader-e2e/project.json`

### Verification for User Story 2

- [ ] T039 [US2] Run `npx nx run-many -t test -p sync-core sync-git sync-gateway sync-native platform --skip-nx-cache` and `cargo test --manifest-path src-tauri/Cargo.toml`, recording results in `specs/015-sync-stability/quickstart.md`
- [ ] T040 [US2] Run `OMNIA_SYNC_REDIS_TEST_URL=redis://127.0.0.1:6379/15 npx nx test sync-gateway --skip-nx-cache` plus packaged Linux, Windows, macOS, and Android targets; record unavailable host/emulator gates in `specs/015-sync-stability/quickstart.md`

**Checkpoint**: User Story 2 is independently recoverable in browser and every
available packaged host, with unavailable evidence explicit.

---

## Phase 4: User Story 3 - Operate Synchronization With Confidence (Priority: P2)

**Goal**: Operators promote and roll back one immutable candidate using public
HTTPS, real shared sessions, sanitized evidence, scans, signatures, and canary
results.

**Independent test**: Exercise staging against one candidate, rotate and restore
sessions, detect a canary regression, and restore accepted digests without a
rebuild.

### Tests for User Story 3

- [ ] T041 [P] [US3] Add schema, confidentiality, candidate-identity, browser-attempt, unavailable-gate, and aggregate-decision tests to `tools/release/verify-sync-evidence.spec.mjs`
- [ ] T042 [P] [US3] Add public HTTPS, headers, readiness, Redis failure, graceful shutdown, image identity, low-cardinality telemetry, and injected alert-threshold assertions to `deployment/smoke.spec.mjs` and `apps/sync-gateway/src/sync-observability.spec.ts`
- [ ] T043 [P] [US3] Add staging canary and digest-only rollback tests to `tools/release/sync-promotion.spec.mjs`
- [ ] T044 [P] [US3] Add protected GitHub OAuth, LFS EPUB/PDF, two-client, restore, conflict, interruption, permission, revocation, replica-restart, fixed-profile latency sampling, and scoped-cleanup journeys to `apps/omnia-reader-e2e/src/sync-live-github.spec.ts`
- [ ] T045 [P] [US3] Add trace, IPC, log, report, redirect, evidence, and synchronized-record canary tests to `tools/release/scan-sync-evidence.spec.mjs`

### Implementation for User Story 3

- [ ] T046 [US3] Implement the evidence validator and aggregator in `tools/release/verify-sync-evidence.mjs`
- [ ] T047 [US3] Integrate sync evidence into `tools/release/verify-release.mjs` and `tools/release/verify-release.spec.mjs`
- [ ] T048 [US3] Implement the artifact canary scanner in `tools/release/scan-sync-evidence.mjs`
- [ ] T049 [US3] Implement sanitized low-cardinality sync telemetry in `apps/sync-gateway/src/sync-observability.ts` and `apps/sync-gateway/src/app.ts`, then extend `deployment/smoke.sh` with bounded health, headers, proxy, Redis readiness, alert, and shutdown checks
- [ ] T050 [US3] Implement digest-only staging, canary, acceptance, and rollback in `tools/release/sync-promotion.mjs` and document protected inputs in `deployment/gateway.env.example`
- [ ] T051 [US3] Add a protected live GitHub workflow that rejects untrusted PR execution and uploads only sanitized evidence in `.github/workflows/sync-live-github.yml`
- [ ] T052 [US3] Add build-once OCI digest, SBOM, provenance, scan, signing, canary, and rollback jobs pinned by full commits in `.github/workflows/sync-release.yml`
- [ ] T053 [US3] Add deterministic container smoke and evidence gates to `.github/workflows/verify.yml`
- [ ] T054 [US3] Document routes, readiness, native handoff, Redis rotation/restore, and safe errors in `docs/sync-gateway-api.md`
- [ ] T055 [US3] Document promotion, canary thresholds, rollback, evidence retention, unavailable gates, and diagnostics in `docs/release-and-rollback.md`

### Verification for User Story 3

- [ ] T056 [US3] Run `npm run container:smoke`, `npm run release:test`, `npm run release:verify`, and new evidence/promotion tests; record a persistent Docker blocker in `specs/015-sync-stability/quickstart.md`
- [ ] T057 [US3] Run protected GitHub and immutable release workflows for the exact candidate or record unavailable staging, credential, registry, signing, and deployment gates in `specs/015-sync-stability/quickstart.md`

**Checkpoint**: User Story 3 produces a reproducible decision for one candidate
and supports digest-only rollback.

---

## Phase 5: User Story 4 - Understand Provider Maturity (Priority: P2)

**Goal**: Readers see GitHub's evidence-backed support status and MEGA's
experimental status in setup, activity, success, failure, restart, and recovery
without relying on color.

**Independent test**: Supply supported and experimental presentation metadata
to the provider/status surfaces across keyboard, touch, screen-reader, and
narrow-viewport journeys; each value remains stable after success, failure, and
restart. Production GitHub stays experimental until T074.

### Tests for User Story 4

- [ ] T058 [P] [US4] Add maturity-policy and history-independence assertions to `libs/sync/core/src/lib/sync-provider-selection.spec.ts`
- [ ] T059 [P] [US4] Add card label, consequence, screen-reader, keyboard, touch, and narrow-viewport assertions to `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.spec.ts`
- [ ] T060 [P] [US4] Add ready/syncing/success/error/recovery maturity assertions to `apps/omnia-reader/src/app/navigation/navigation.component.spec.ts` and `apps/omnia-reader/src/app/sync-connection-status.service.spec.ts`
- [ ] T061 [P] [US4] Add axe, keyboard, focus, touch, restart, and color-independent journeys to `apps/omnia-reader-e2e/src/sync-accessibility.spec.ts`

### Implementation for User Story 4

- [ ] T062 [US4] Add centralized provider presentation metadata with both providers initially experimental in `libs/sync/core/src/lib/sync-provider-selection.ts` and `libs/sync/core/src/index.ts`
- [ ] T063 [US4] Render maturity labels and consequences in `apps/omnia-reader/src/app/features/settings/sync-settings-page.component.ts` and `.html`
- [ ] T064 [US4] Carry maturity through toolbar and recovery status in `apps/omnia-reader/src/app/sync-connection-status.service.ts`, `apps/omnia-reader/src/app/navigation/navigation.component.ts`, and `.html`

### Verification for User Story 4

- [ ] T065 [US4] Run `npx nx test sync-core --skip-nx-cache`, `npx nx test omnia-reader --skip-nx-cache`, and the Chromium/Firefox/WebKit `sync-accessibility.spec.ts` matrix; record results in `specs/015-sync-stability/quickstart.md`

**Checkpoint**: User Story 4 identifies maturity on every relevant surface and
remains independently accessible.

---

## Final Phase: Cross-Cutting Acceptance and Promotion

- [ ] T066 Reconcile all artifacts under `specs/015-sync-stability/` with implementation discoveries
- [ ] T067 Run `npx nx run-many -t lint --all --skip-nx-cache` and record results in `specs/015-sync-stability/quickstart.md`
- [ ] T068 Run production builds for `omnia-reader` and `sync-gateway` with `--skip-nx-cache`, recording evidence in `specs/015-sync-stability/quickstart.md`
- [ ] T069 Run `npm audit --omit=dev`, `npm run release:test`, `npm run release:verify`, and `git diff --check`, recording results in `specs/015-sync-stability/quickstart.md`
- [ ] T070 Run `$verify-omnia-reader` and preserve exact deterministic, browser, Redis, native, container, provider, and release evidence in `specs/015-sync-stability/quickstart.md`
- [ ] T071 Run `$review-omnia-reader` across sync, gateway security, native authority, accessibility, CI, deployment, and release changes and resolve findings
- [ ] T072 Update `docs/universal-reader-plan.md` only with verified status, architecture, release gates, and unavailable external evidence
- [ ] T073 Validate one immutable candidate against `specs/015-sync-stability/contracts/sync-release-evidence.md`; leave GitHub experimental when any mandatory gate fails or is unavailable
- [ ] T074 Change GitHub maturity to `supported` in `libs/sync/core/src/lib/sync-provider-selection.ts` only after T073 accepts the evidence; keep MEGA experimental

## Dependencies and Execution Order

- Phase 1 freezes gate identities, native dependency choices, and evidence
  fixtures before behavior changes.
- US1 and US2 are P1. Start US1 first because its known red selector is the
  smallest proof; native US2 may proceed after Phase 1.
- US3 consumes US1 browser evidence and US2 session/native evidence, though its
  validator and workflow tests may be authored earlier.
- US4 is independently testable after Phase 1, but GitHub's final `supported`
  value is deferred to T074.
- Tests precede corresponding implementation. Tasks sharing a file run
  sequentially even if surrounding work is parallel.
- Final acceptance depends on all story checkpoints. T074 depends on T073.

## Parallel Opportunities

- After Phase 1, T006/T010, T019/T021/T022/T024/T026, T041/T044/T045, and
  T058/T061 own distinct test paths.
- US1 convergence and US4 presentation can progress in parallel until final
  promotion.
- US2 TypeScript, Rust, and gateway handoff work can split after the native
  contract and dependency decisions are fixed.
- US3 evidence validation, container smoke, and protected workflow work own
  different paths; promotion waits for all three.

## Parallel Example: User Story 2

```text
T022: TypeScript transport contract in libs/sync/native/
T023: Rust broker contract in src-tauri/src/
T024: gateway/native handoff contract in apps/sync-gateway/ and src-tauri/src/
T026: packaged black-box journey in apps/omnia-reader-e2e/src/native/
```

## Implementation Strategy

1. Complete Phase 1.
2. Complete US1 through T018 as the MVP and re-run the known red Chromium gate.
3. Complete US2, then US3 and US4 without advertising GitHub as supported.
4. Run cross-cutting acceptance and change maturity only after T073 accepts one
   immutable candidate.

## Completion Rules

- Mark a task `[x]` only after its artifact or exact command is complete.
- Preserve unrelated Feature 014 changes; do not stage or rewrite them here.
- Keep commits narrow and aligned with verified vertical slices.
- Do not change synchronized schemas, merge ordering, tombstones, backup
  format, or journal acknowledgement without an approved amendment.
- Report unavailable browser, provider, credentialed, native, emulator,
  physical-device, registry, signing, and deployment gates explicitly.
