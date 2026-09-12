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

## 6. Protected live GitHub conformance

In the protected staging environment only:

```sh
LIVE_GITHUB_SYNC_E2E=1 BASE_URL=https://staging.example.invalid npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 sync-live-github.spec.ts
```

Replace the placeholder with the approved staging origin through protected
configuration, not by editing the command into source. The run must satisfy
[live-github-conformance.md](contracts/live-github-conformance.md), preserve
sanitized traces, clean up only its uniquely named disposable repository, and
emit a candidate evidence manifest conforming to
[sync-release-evidence.md](contracts/sync-release-evidence.md).

## 7. Promotion decision

GitHub maturity changes from experimental/recommended to supported only when one
immutable candidate evidence set is `accepted`. MEGA remains experimental even
when deterministic tests pass. Any failed or unavailable mandatory gate leaves
the candidate rejected and records the exact boundary for the next run.
