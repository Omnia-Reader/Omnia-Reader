# Quickstart: Validate Production-Ready Synchronization

## Prerequisites

- Use the Node version from `.nvmrc` and the locked dependency set.
- Build from the exact candidate commit with no unreviewed source changes.
- Install Chromium, Firefox, and WebKit for the compatibility gates.
- Keep live provider credentials, session keys, signing identity, and staging
  configuration outside the checkout.
- Use disposable provider data and an explicitly scoped cleanup identity.

## 1. Current baseline and focused contracts

```sh
npx nx run-many -t test -p sync-core sync-git sync-mega sync-gateway --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
```

Fresh pre-implementation evidence on 2026-09-11:

- sync-core: 203 passed.
- sync-git: 38 passed.
- sync-mega: 10 passed.
- sync-gateway: 121 passed and one opt-in real Redis test skipped.
- sync-gateway with an ephemeral Redis 7.2.12 instance on 2026-09-12: 122
  passed, including the opt-in real Redis integration. The interrupted parent
  invocation briefly caused Nx to reject a retry as recursive; the exact
  underlying Vitest command completed the Redis run, and a subsequent clean Nx
  run passed 121 tests with the expected Redis skip. Multi-replica restart,
  outage, backup, and restore coverage remain open.
- production application build: passed, 398.48 kB initial raw and 88.31 kB
  estimated transfer.
- Chromium full sync: 16 passed and two long convergence cases failed because a
  stale test selector did not open the first publication. Treat this as the
  initial red acceptance gate; do not claim convergence until it passes after
  the test-harness repair.

Feature 015 preparation evidence on 2026-09-12:

- `npx prettier --check specs/015-sync-stability tools/release/fixtures/sync-evidence`:
  passed.
- The candidate, rejected, and unavailable synchronization evidence fixtures
  all parsed as JSON.
- `git diff --check`: passed.
- Native dependency review selected exact `reqwest` 0.13.4 and `url` 2.5.8,
  retained exact `tauri-plugin-deep-link` 2.4.9, rejected a generic webview HTTP
  plugin, and declared session-only native authority until protected bootstrap
  is proven.
- The accessible publication-open regression failed first because the helper
  was absent, then passed after the helper and stale selector replacements were
  implemented.
- The sandbox-enforcement classifier regression failed first because the
  classifier was absent, then passed with an exact Chromium diagnostic match;
  other sandbox and application errors remain failures.
- Focused Chromium helper verification passed 2 tests.
- The two existing long Chromium convergence scenarios passed 2 tests: exact
  PDF plus reader state through Git, and exact EPUB plus reader state through
  deterministic MEGA. This repairs the initial red baseline without claiming
  the missing format matrix, replacement-device, concurrent-mutation, or
  cross-browser gates.
- The provider/format closure regression then failed with Git/EPUB and MEGA/PDF
  absent. After deriving the cross-product and adding named reader-route
  preconditions, all 4 Chromium two-device convergence journeys passed in
  36.7 seconds. Replacement-device, concurrent-mutation, and cross-browser
  gates remain open.
- After moving the long journeys into `sync-convergence.spec.ts`, the combined
  Chromium short plus convergence run passed 21 tests in 1.0 minute. The split
  keeps the opt-in release journeys independently targetable without dropping
  the 16 shorter synchronization behaviors.
- Clean replacement-device coverage now hashes bytes read back from IndexedDB
  or OPFS and compares membership, progress, progress documents, bookmarks,
  annotations, and tombstones with an already-converged device. All 5 focused
  Chromium convergence tests passed in 46.4 seconds across the full Git/MEGA
  and EPUB/PDF matrix; each restored inventory contained one live and one
  tombstoned bookmark and annotation.
- Concurrent collision coverage updates a shared annotation on one disconnected
  device while deleting it on the other, then synchronizes in conflicting order
  and proves the tombstone wins without resurrection on the original and clean
  replacement devices. A held Git upload also proves provider selection is
  disabled while work is active and that no request, document, object, or
  success history leaks into MEGA. All 6 Chromium convergence checks passed in
  56.3 seconds.
- The complete Chromium short plus convergence gate passed 22 tests in 1.4
  minutes. The first parallel Nx unit invocation exhausted Vitest worker startup
  capacity and ran no tests; the bounded serial retry
  (`--parallel=1 --skip-nx-cache`) passed sync-core 203/203, sync-git 38/38, and
  sync-mega 10/10 in 23.3 seconds.
- Firefox initially exposed two expected console diagnostics for remote EPUB
  fonts neutralized to `data:,`; an exact classifier regression preserves real
  font failures while accepting only that security-enforcement shape. The full
  Firefox convergence suite then passed 6/6 in 1.6 minutes. WebKit passed 6/6
  in 6.8 minutes. These are local browser-engine results, not CI or packaged-host
  evidence.
- The versioned synchronization corpus now records current v2, legacy v1,
  future v3, and five malformed Git LFS pointer inputs. The first clean-profile
  restore run rejected the incomplete corpus: it lacked the logical membership
  change and its placeholder bytes were correctly quarantined as an unsupported
  PDF. After adding the required logical record and canonical two-page PDF, the
  current restore, legacy migrate-and-restore, and rejection cases passed 3/3
  with exact 1,876-byte SHA-256 evidence. The combined corpus plus full
  convergence run passed 9/9 in 49.1 seconds across Git/MEGA and EPUB/PDF.
- Five intended reconciliation rejection cases failed before implementation:
  duplicate inventory, downloaded size, downloaded digest, legacy object path,
  and legacy media type. The identical-merge case initially supplied a
  noncanonical current JSON representation and was corrected to represent an
  actual prior migration result. After atomic inventory validation, streaming
  digest verification, strict format/media-type matching, and fail-closed
  legacy parsing, sync-core passed 211/211 and sync-git passed 40/40 in a serial
  no-cache run. The two new Git protocol regressions also reject escaped or
  duplicate inventory and mismatched read/upload identities.
- `npx nx run-many -t lint -p sync-core,omnia-reader-e2e --skip-nx-cache
--parallel=1` passed. An initial corpus test import crossed an Nx project
  boundary; the corrected provider-neutral corpus contract leaves production
  parsing in the owning sync library suites.
- The `sync-staging-v1` measurement contract fixes two logical CPUs, 4 GiB,
  100 ms RTT, 10,000 kbit/s symmetric bandwidth, zero packet loss, the
  one-second reading-state quiet period, and the ten-second revision poll. Its
  runner rejects qualification drift, discards exactly 20 warm-ups, retains 200
  raw two-device measurements, recomputes p95 and within-target ratio, requires
  visibility within 15 seconds, and fails any publication transfer. The four
  Node contract tests and E2E lint passed. This proves the runner contract only;
  no qualified staging latency measurement has run on this host.
- The dedicated `omnia-reader-e2e:sync-convergence` target builds the production
  app and runs the compatibility corpus plus all Git/MEGA EPUB/PDF convergence
  journeys with mandatory execution enabled. Its local Chromium invocation
  passed 9/9 in 1.6 minutes; the complete Nx target, including the production
  build, passed in 1 minute 51 seconds.
- Pull requests now receive one mandatory Chromium/Firefox/WebKit convergence
  matrix pass. Opt-in release-candidate dispatches run three uncached attempts
  consecutively per browser with separate failure-trace directories. An
  after-suite cardinality assertion turns any skipped convergence scenario into
  a failure. Workflow YAML parsing and Prettier validation passed locally; the
  new GitHub Actions jobs have not yet run remotely.
- Retry-deadline coverage now coalesces 300 mixed local-change notifications
  behind one 120-second provider deadline and proves exactly one retry starts at
  the deadline. Cancellation is shared by coalesced change-aware callers, a
  scheduler restart starts one clean attempt, and an unstable destination stops
  after one bounded verification pass. `npx nx test sync-core --skip-nx-cache`
  passed 214/214 tests.
- Interrupted Git LFS coverage now proves the client resends every publication
  byte in a fresh `PUT`, while the gateway leaves both the pointer and
  `.gitattributes` unpublished after failure. A fresh readable then repeats the
  whole LFS upload, verifies it, and only afterward publishes the attributes and
  exact pointer. Uncached sync-git passed 41/41; sync-gateway passed 121 tests
  with its existing opt-in Redis test skipped.
- Against isolated Redis 7.2 (`redis:7.2-bookworm`, local image
  `bcdbeda69e6e`), the expanded real integration passed 124/124 tests. It proved
  two-replica sharing, atomic session movement, restart continuity,
  current/previous encryption-key rotation without extending the remaining
  TTL, encrypted-state backup/restore, fail-closed client outage, cross-replica
  webhook replay/invalidation, and readiness recovery. `/healthz` remains a
  dependency-independent liveness probe; `/readyz` now reflects the shared
  store without exposing connection details.
- The new `sync-native` Nx library implements the complete provider-neutral
  transport through enumerated Tauri commands. It verifies the broker's exact
  HTTPS origin, bounds documents, inventories, deletion batches, objects, and
  512 KiB transfer chunks, exposes monotonic progress, cancels failed or
  aborted requests, tears down active work, and maps only application-owned
  errors. Its focused contract passed 7/7 tests; the Nx project and inferred
  lint target were both discovered successfully. At that checkpoint this was
  TypeScript boundary evidence only; the Rust broker was added in the later
  T030/T031 checkpoint below.
- Application composition now keeps web/PWA synchronization on the existing
  relative same-origin GitHub and MEGA clients, while both Tauri desktop and
  Android select provider-scoped native transports. Angular destruction tears
  down both broker transports. The focused composition cases passed within the
  full application suite (185/185), and sync-native remained green at 7/7; the
  production application build passed at 411.33 kB raw / 91.03 kB estimated
  transfer. At that checkpoint, the Rust commands remained intentionally
  unavailable pending T030/T031.
- The native broker now owns the exact configured
  `OMNIA_SYNC_GATEWAY_ORIGIN`, a process-local cookie jar, same-origin redirect
  denial, enumerated provider routes and internally constructed headers. It
  bounds active work to 16 requests and eight transfers, accepts upload data as
  raw IPC bytes with four allowlisted metadata headers, caps IPC chunks at
  8 MiB before transfer lookup, streams uploads from owner-only temporary
  files, cancels response-body reads, and clears transfers, files, requests,
  and session authority on teardown. Missing or invalid origin configuration
  leaves that broker closed without preventing offline reader startup. Twelve
  focused broker tests and the complete Rust suite (15/15) passed. The updated
  native transport remained green at 7/7 with lint, the application suite
  passed 185/185, and the production build passed at 411.50 kB raw / 91.03 kB
  estimated transfer.
  `cargo clippy --all-targets --locked -- -D warnings` was unavailable because
  Clippy is not installed for Rust 1.89.0; this remains an explicit local gate
  rather than a claimed pass.
- Native authorization handoff tests failed first on the absent encrypted
  atomic-consume and route/native modules. The gateway now uses a dedicated
  pending browser cookie, five-minute encrypted handoff records, atomic
  memory/file/Redis consumption, exact provider/request binding, and sanitized
  denial outcomes. The Rust host validates the exact deep-link shape, consumes
  one pending request under a lock, redeems directly into its private cookie
  jar, and emits only application-owned outcomes. Gateway unit tests passed
  127/127 with two opt-in cases skipped; the same suite passed 128/128 against
  isolated Redis 7.2, including cross-replica redemption. Gateway lint and its
  production build passed. Native handoff tests passed 5/5 and the complete
  Rust suite passed 20/20. Native protected persistence and Settings handoff
  integration remained open at that checkpoint under T025/T034/T035.
- Production session-store tests failed first while configured providers could
  still construct encrypted process-local stores. Production now requires a
  Redis URL before provider adapters are built, refuses implicit in-memory
  adapter stores, keeps liveness separate from Redis readiness, and fails
  startup on connection loss without a fallback. The pinned
  `sync-gateway:test-redis` Compose harness passed 134/134 tests against Redis
  7.2 and removed its isolated container and network after the run.
- Packaged Settings now uses provider-specific typed Tauri commands for GitHub
  repository and MEGA folder administration while sharing the broker-owned
  cookie jar with data synchronization. Authorization registers its listener
  before opening the system browser, binds the returned URL to the broker's
  validated origin and exact provider/request path, supports cancellation and
  timeout, and exposes only sanitized completion state. The Settings page
  refreshes provider state after authorization, preserves local data on
  cancellation, and restores focus to the connection action or page heading.
  The selected TypeScript suites passed 490/490 tests, including 12/12 native
  gateway tests and 190/190 application tests; affected lint targets passed
  without warnings. The production build passed at 422.15 kB raw / 93.15 kB
  estimated initial transfer. `cargo fmt -- --check`, `cargo check
--all-targets --locked`, and the complete Rust suite (22/22) passed. T035 is
  complete; protected-versus-session-only persistence remained open at that
  checkpoint under T025/T034, and packaged-host journeys remained open under
  T026/T038.
- The T025 native session checkpoint added a sealed Rust persistence state
  machine and made the current production factory explicitly `session-only`.
  Broker status now reports the mode, nullable version, and restart consequence
  as one strictly validated IPC shape. Five Rust tests prove protected-store
  restart recovery through the sealed test backend, process-only authority loss
  on restart, refusal of unproven or unavailable protection, fail-closed
  downgrade on store failure, and rejection of malformed, expired,
  wrong-origin, or unsupported-version records. The native TypeScript boundary
  rejects inconsistent status combinations. `cargo check --all-targets
--locked` passed without warnings, the complete Rust suite passed 27/27,
  sync-native passed 13/13, and the application suite passed 190/190. Affected
  lint targets and the production build passed; the latter remained within
  budget at 422.50 kB raw / 93.29 kB estimated initial transfer. T025 is
  complete. T034 remains open: no OS backend is enabled and no protected-host
  claim is made because current cross-platform keyring releases exceed the
  declared Rust baseline and still require packaged platform proof.
- T034 now selects exact, target-scoped `keyring` 3.6.3 backends without
  raising the Rust 1.77.2 baseline: persistent Secret Service/keyutils on
  Linux, Keychain on macOS, and Credential Manager on Windows. The production
  broker restores its bounded origin-bound cookie record only when the selected
  backend declares until-delete persistence; construction, load, write, clear,
  validation, or locking failures erase process authority and downgrade to
  `session-only`. Android has no compatible protected backend at this baseline
  and remains explicitly session-only. Cargo resolved no `keyring` package for
  `aarch64-linux-android` and resolved exactly `keyring v3.6.3` for
  `x86_64-unknown-linux-gnu`. `cargo test --locked` passed 28/28 Rust tests,
  `cargo check --all-targets --locked` and `cargo fmt -- --check` passed on
  Linux. The Android source check reached the existing `aws-lc-sys` build and
  then stopped because `aarch64-linux-android-clang`/the Android NDK is not
  installed; Windows/macOS compilation and every packaged restart proof remain
  unavailable locally and stay explicit under T040.
- The exact T039 cross-project command passed 423/423 tests across sync-core,
  sync-git, sync-gateway, sync-native, and platform; the gateway's two
  environment-gated Redis cases were explicitly skipped in this non-Redis run.
  The paired locked Rust command passed 27/27 tests. T039 is complete; this
  deterministic evidence does not replace the real-Redis and packaged-host
  gates in T040.
- Provider maturity remains centrally and history-independently classified as
  experimental for both Git + LFS and MEGA. Settings cards and the global sync
  status expose the text label and consequence without relying on color, and
  preserve it through ready, active, success, failure, recovery, and restart
  states. The focused T065 commands passed 216/216 sync-core tests and 192/192
  application tests with the Nx cache disabled. The touch-sized 360 px
  accessibility journey passed Chromium, Firefox, and WebKit (1/1 each),
  covering Axe WCAG 2.0/2.1/2.2 A/AA checks, keyboard focus/activation, touch,
  restart persistence, provider consequences, and browser error monitoring.
  The production application build passed at 424.42 kB raw and 93.65 kB
  estimated initial transfer size.
- The synchronization evidence validator now rejects unsupported schemas,
  malformed or duplicate candidate artifact identities, confidential fields,
  unsafe report paths, duplicate run identities, invalid time intervals,
  missing or failed mandatory gates, unavailable mandatory gates, and fewer
  than three distinct passing attempts for each browser-convergence gate. Its
  seven focused Node tests passed; direct CLI validation of the rejected fixture
  returned a deterministic rejected decision and a non-zero exit status. This
  completes T041 and T046.
- The release verifier now accepts an explicit `--sync-evidence` path for the
  protected candidate gate, requires an explicitly accepted aggregate decision,
  binds its release and full commit to the package version and checked-out
  `HEAD`, requires a clean tracked and untracked source checkout, canonically
  checksums it with the release output, clears stale generated evidence before
  every invocation, and refuses to reuse the generated output as an input. Five
  focused red-to-green integration tests
  cover acceptance, draft/rejected identity failure, dirty-source rejection,
  strict CLI parsing, checksummed inclusion, and stale-output removal. This
  completes T047 without treating the source-only verifier used by ordinary CI
  as promotion evidence.
- A clean clone of commit `7da630b` accepted a synthetic contract-only evidence
  manifest bound to that exact commit and package version, produced a 133-file
  release manifest containing the canonical evidence SHA-256, and then returned
  to a 132-file source-only manifest with the generated evidence absent. This
  proves the T047 integration mechanics only; it is not real candidate gate
  evidence.
- The artifact canary scanner now requires non-empty trace, IPC, log, report,
  redirect, evidence, and synchronized-record target classes and scans literal,
  percent-encoded, form-encoded, Base64, Base64url, and bounded ZIP contents. It rejects
  missing targets, symbolic links, unsafe archive paths, malformed archives,
  and bounded-size violations. Its fourteen Node tests passed, including one
  leak case per target class, compressed Playwright-style trace detection, and
  a CLI check proving that clean scans exit zero, detections exit non-zero, and
  neither output repeats the protected canary value. This completes T045 and
  T048; protected-workflow collection and execution remain T051/T052.
- Digest-only promotion now uses a protected absolute-path deployment driver
  and immutable requests containing only candidate identity, logical artifact
  names, and SHA-256 digests. Staging must pass before canary, production
  acceptance requires both a passing canary checkpoint and fully accepted sync
  evidence, and rollback selects a distinct previously accepted candidate.
  Driver failures are sanitized, receipts must match every requested digest,
  and the tool never exposes a build or tag operation. Six focused tests
  passed for staging, canary, identity drift, acceptance, failed-canary
  rollback, and invalid rollback targets. This completes T043/T050 at the
  orchestration contract layer; actual protected staging and production
  execution remains T052/T057.
- The gateway contract now gives operators exact liveness and readiness bodies,
  routing behavior during Redis outage/recovery, client-safe failure mapping,
  whole-prefix Redis backup/restore requirements, TTL and encryption-key
  handling, cross-replica recovery checks, and a fail-safe key replacement rule
  when restored revocation state cannot be proven current. Existing endpoint,
  native handoff, rotation, and provider route tables were reconciled against
  the implementation. This completes T054 as documentation evidence; a real
  production backup/restore exercise remains a release gate.
- The release runbook now documents the exact digest-only
  staging/canary/accept/rollback sequence, accepted-evidence binding, default
  alert semantics, fixed-profile performance and transfer thresholds,
  unavailable-gate rejection, mandatory canary scanning, sanitized diagnostic
  correlation, and explicit accepted/rejected/trace retention periods. This
  completes T055 as an operator contract; the protected workflow executions
  remain T052/T057.

## 2. Deterministic browser convergence

Run each command from the repository root after a fresh production build:

```sh
PLAYWRIGHT_HTML_OPEN=never REMOTE_SYNC_E2E=1 npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 sync.spec.ts
PLAYWRIGHT_HTML_OPEN=never FIREFOX_E2E=1 REMOTE_SYNC_E2E=1 npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=firefox --workers=1 sync.spec.ts
PLAYWRIGHT_HTML_OPEN=never REMOTE_SYNC_E2E=1 npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=webkit --workers=1 sync.spec.ts
```

The release workflow repeats the dedicated convergence scenarios three times
per browser. Expected results are exact EPUB/PDF bytes, two-device contribution
convergence, durable tombstones, conflict/interruption recovery, no browser
console errors, and no skipped mandatory scenario.

## 3. Real Redis boundary

Start the repository-pinned loopback Redis test service, then run:

```sh
OMNIA_SYNC_REDIS_TEST_URL=redis://127.0.0.1:6379/15 npx nx test sync-gateway --skip-nx-cache
```

The gate must exercise two service instances, restart, current/previous key
rotation, unchanged TTL, webhook replay/invalidation, outage, backup, restore,
and fail-closed readiness. A skipped Redis test is not production evidence.

## 4. Static, production, container, and release gates

```sh
npx nx run-many -t lint --all --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
npx nx build sync-gateway --configuration production --skip-nx-cache
npm audit --omit=dev
npm run container:smoke
npm run release:test
npm run release:verify
npm run release:verify -- --sync-evidence <accepted-manifest.json>
git diff --check
```

Container promotion additionally requires the protected workflow to record,
scan, sign, and canary the exact immutable web and gateway digests. Rollback
must select previously accepted digests without rebuilding.

Current host evidence on 2026-09-12: `npm run container:smoke` could not reach a
Dockerfile stage. The sandboxed attempt first failed while updating Buildx
activity metadata; approved retries with both the Buildx/Bake path and
`COMPOSE_BAKE=false` remained live but silent until bounded termination. No
Omnia containers were created, Compose reports no residual project resources,
and the six-week-old local images are not evidence for the current checkout.
Treat the container smoke as unavailable on this host until the Docker builder
session is repaired and the complete health/header/proxy gate runs to
completion.

The T042/T049 smoke contract was expanded on 2026-09-12 before another runtime
attempt. `node --test deployment/smoke.spec.mjs` passed 11/11 tests covering a
credential-free public HTTPS origin with HSTS, the complete security-header
set, exact sanitized readiness states, immutable local image ID plus release
and revision identity, fixed telemetry labels, injected alert thresholds,
Redis failure/recovery evidence, and graceful exit rejection. `bash -n
deployment/smoke.sh`, `shellcheck deployment/smoke.sh`, and `docker compose
--file deployment/compose.yaml config --quiet` also passed. The local script
now uses bounded requests, rejects a public `/metrics` route, validates private
metrics, verifies both running image identities, and checks a zero-exit
SIGTERM shutdown. Strict mode disables rebuilding by default and additionally
requires expected image IDs, a public HTTPS origin, and an absolute protected
Redis driver that supports idempotent `fail` and `recover` operations.

The updated `npm run container:smoke` still did not reach a Dockerfile stage.
The sandboxed call failed with `failed to update builder last activity time`
because the Buildx activity directory was read-only. The approved retry emitted
no output for three minutes and was terminated by its live execution handle.
A subsequent approved read-only Compose/Buildx inspection also emitted no
output for one minute and was terminated. A host process-table inspection then
found no residual Docker client, Buildx, BuildKit, or smoke process. Because
daemon state could not be queried, this run does not assert that no container
resources exist. Local container runtime, public HTTPS, and Redis failure
injection therefore remain unavailable evidence rather than passing gates.

The three synchronization release suites passed 27/27 tests, and `npm run
release:test` passed 15/15 tests. The initial `npm run release:verify` passed
both production builds before correctly rejecting 13 production dependency
vulnerabilities: seven high and six moderate. The remediation advances the
Angular runtime to 22.1.1, Fastify to 5.12.4, and the two locked `fast-uri`
lines to 3.1.7 and 4.1.4. A strict `npm ci --ignore-scripts` passed and `npm
audit --omit=dev` now reports zero production vulnerabilities. The application
and gateway tests passed 192/192 and 136/138 with only the two expected
environment-gated Redis skips; both lint and production build targets passed.
The application initial bundle remains within budget at 424.83 kB raw and
93.88 kB estimated transfer. A broader Angular 22.1.6 candidate was rejected
before commit because it increased the initial bundle to 620.38 kB raw and
151.02 kB estimated transfer.

With a writable task-local Cargo cache, the release verifier next rejected
seven locked Rust TLS dependencies whose five distinct compound or CDLA license
expressions had not yet been reviewed by the fail-closed allowlist. The exact
crate manifests and bundled license texts were inspected before adding those
five expressions; the policy still rejects any unreviewed composite expression.
The focused release suite passed 16/16 tests, and the no-build verifier then
passed for 68 production npm components, 527 Rust components, four pinned
bridge inputs, four pinned CI actions, and 132 release files. T056 remains open
for the unavailable container gates even though the deterministic release
verifier boundary is now clear.

## 5. Packaged-host proof and compatibility

Run focused TypeScript/Rust contracts first:

```sh
npx nx test platform --skip-nx-cache
npx nx test sync-native --skip-nx-cache
cargo test --manifest-path src-tauri/Cargo.toml
```

Then execute the packaged sync journey against an HTTPS simulated gateway on
Linux, Windows, macOS, and an Android emulator. Prove provider connection,
EPUB/PDF synchronization, restart continuity, offline local reading,
authorization/network recovery, broker allowlisting, handoff replay rejection,
secret-canary absence, declared protected-versus-session-only restart behavior,
and 25 MiB cancellation/retry. Report unavailable physical-device evidence
separately.

T026 now uses the protected driver contract in
[`native-sync-conformance.md`](contracts/native-sync-conformance.md). The
repository runner binds each report to the exact candidate, packaged artifact
digest, host, and run ID; refuses canary-bearing or non-canonical output; and
requires positive evidence for relative-route failure, broker use, local-first
offline/restart recovery, persistence-consistent reauthentication, whole 25 MiB
retry, cancellation, monotonic progress, the 8 MiB buffer and 64 MiB RSS limits,
single acknowledgement, no dangling reference, canary absence, and scoped
cleanup. Its focused Node suite passed 7/7 on 2026-09-12, including forced
cleanup after an intermediate driver failure; a direct unprotected invocation
failed before driver discovery with `A protected packaged runner is required.`
The existing native
desktop journey conditionally invokes it through `OMNIA_NATIVE_SYNC_E2E=1`, and
the direct `npm run native:sync:e2e` entry supports Android platform control.
T038 remains open until the protected host targets are added without overwriting
the separate Feature 014 edits in `apps/omnia-reader-e2e/project.json`.

The isolated real-Redis target was refreshed on 2026-09-12 and passed 138/138
gateway tests across 10 files, including the cross-replica lifecycle cases. Its
Compose trap removed the dedicated Redis container and network. This proves the
Redis half of T040 only; no packaged binary, Windows/macOS host, configured
Android emulator, protected conformance driver, or staging origin was available
for the packaged half, so T040 remains open.

## 6. Protected live GitHub conformance

In the protected staging environment only:

```sh
LIVE_GITHUB_SYNC_E2E=1 \
LIVE_GITHUB_PROTECTED_RUNNER=1 \
LIVE_GITHUB_AUTH_STATE=/run/secrets/github-storage-state.json \
LIVE_GITHUB_CONTROL_DRIVER=/opt/omnia/live-github-control \
LIVE_GITHUB_RUN_ID=<unique-lowercase-run-id> \
OMNIA_SYNC_SECRET_CANARIES='<protected-json-with-live-github-secret>' \
LIVE_GITHUB_THROTTLE_AVAILABLE=0 \
LIVE_GITHUB_CANDIDATE_COMMIT=<40-lowercase-hex-commit> \
LIVE_GITHUB_CANDIDATE_RELEASE=<release-identifier> \
LIVE_GITHUB_ARTIFACT_DIGEST=sha256:<64-lowercase-hex-digest> \
BASE_URL=https://reader-staging.example.com \
npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 sync-live-github.spec.ts
```

Replace the placeholder with the approved staging origin through protected
configuration, not by editing the command into source. The run must satisfy
[live-github-conformance.md](contracts/live-github-conformance.md), preserve
sanitized traces, clean up only its uniquely named disposable repository, and
emit a candidate evidence manifest conforming to
[sync-release-evidence.md](contracts/sync-release-evidence.md).

T044 was implemented on 2026-09-12 as an opt-in Playwright journey plus a
strict control-driver boundary. The five local harness tests passed, Playwright
listed the protected journey successfully, and the existing Chromium
convergence smoke passed 2/2 with its four extended provider cases explicitly
skipped. An enabled run without `LIVE_GITHUB_PROTECTED_RUNNER=1` was also
confirmed to exit non-zero before discovering or running tests. No protected
GitHub browser state, staging origin, control driver, or cleanup identity is
available in this checkout, so the live journey itself remains unavailable
evidence under T057 and GitHub maturity remains experimental.

T051 was implemented on 2026-09-12 as a manual-default-branch workflow with a
trusted-ancestor preflight, a protected ephemeral staging runner, secrets scoped
only to the execution step, exact candidate/deployment binding, zero Playwright
retries or traces, raw-output canary scanning, redundant transient cleanup, and
sanitized JSON-only artifact upload. Safe throttle absence becomes unavailable
evidence rather than a passing run. The release suite passed 31/31 tests,
focused ESLint passed, the workflow YAML parsed, and Playwright listed the live
journey. The workflow was not dispatched because the protected staging runner,
environment secrets, immutable deployed digest, and GitHub control driver are
not available here; that execution gate remains T057.

T052 was implemented on 2026-09-12 as a separate manual-default-branch release
workflow. Its `build-canary` path builds the web and gateway images exactly once,
records their registry digests, generates CycloneDX image SBOMs, retains both
vulnerability decisions, publishes registry provenance, signs and verifies both
digests with keyless identities, and passes only those digests through protected
staging and canary drivers. The `promote` and `rollback` paths download evidence
and receipts by immutable GitHub artifact ID plus originating run ID; neither
path contains an image build or retag operation. Production promotion requires
an accepted manifest for the dispatched commit and release, while rollback
requires rejected active evidence plus a different previously accepted record.
All third-party actions are pinned to full commits. Local workflow-contract,
candidate-writer, evidence-binding, formatting, and YAML validation are recorded
with the implementation commit. The workflow itself was not dispatched because
the protected registry, OIDC signing, staging/canary/production runners,
deployment driver, and complete accepted evidence are unavailable here; these
remain explicit T057 gates.

## 7. Promotion decision

GitHub maturity changes from experimental/recommended to supported only when one
immutable candidate evidence set is `accepted`. MEGA remains experimental even
when deterministic tests pass. Any failed or unavailable mandatory gate leaves
the candidate rejected and records the exact boundary for the next run.
