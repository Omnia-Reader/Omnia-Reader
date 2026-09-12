# Omnia Reader Release and Rollback Runbook

This runbook applies to web/PWA, sync gateway, Tauri desktop, Android, and the
private MEGA SDK bridge. A release is a coordinated set of immutable artifacts
with one semantic version. Publication data and reading state remain
local-first throughout deployment and rollback.

## Release invariants

- `package.json`, the root entries in `package-lock.json`,
  `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the MEGA bridge
  `CMakeLists.txt` have the same version.
- The lockfiles are committed and release builds use `npm ci` and
  `cargo --locked`.
- Web, gateway, native, and bridge artifacts are built from one reviewed commit.
- Generated artifacts are immutable. Promotion copies the same bytes between
  environments; it does not rebuild them.
- Signing keys, provider credentials, session-encryption keys, and registry
  tokens are supplied by the release environment and never committed.
- A release that changes local or remote data formats documents backward
  compatibility before promotion. A destructive or non-backward-compatible
  migration requires a tested backup and restore path.

## Required verification

Use Node `v26.5.0` from `.nvmrc`, a writable Cargo cache, and the locked
dependencies:

```sh
nvm use
npm ci
npm run release:test
npx nx run-many -t test --all --skip-nx-cache
npx nx run-many -t lint --all --skip-nx-cache
npx nx run omnia-reader-e2e:e2e
PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts
npm run performance:e2e
npm run release:verify
npm run release:verify -- --sync-evidence <accepted-manifest.json>
npm run container:smoke
```

`npm run release:verify` is the release-specific fail-closed gate. It:

1. Checks version coherence and semantic-version syntax.
2. Builds the production web/PWA and sync gateway with Nx cache disabled.
3. Enforces the Angular production bundle budgets.
4. Requires a zero-vulnerability production npm audit.
5. Generates normalized CycloneDX 1.5 SBOMs for production npm dependencies,
   the locked Rust graph, and the pinned MEGA bridge source inputs.
6. Rejects missing or previously unreviewed dependency license expressions.
7. Requires immutable Git commits and a digest-pinned bridge base image.
8. Writes a deterministic artifact manifest and SHA-256 checksums.

The no-argument command verifies source-built release artifacts and is suitable
for ordinary CI, but it does not constitute synchronization release acceptance.
Before staging or promotion, pass `--sync-evidence` with the accepted manifest
for the candidate. The verifier requires the manifest's release to equal the
package version, its full commit to equal the checked-out `HEAD`, and the Git
checkout to contain no tracked or untracked source changes. Keep the supplied
manifest outside the checkout or under an ignored evidence directory. The
verifier then writes canonical `sync-evidence.json` into the checksummed release
output. Candidate, rejected, mismatched, malformed, dirty-source, or stale
evidence fails closed. Every invocation removes any earlier generated
synchronization evidence before validation, and the generated output path is
not accepted as an input, so a failed or source-only run cannot accidentally
carry an accepted decision forward.

`npm run container:smoke` independently builds the digest-pinned runtime
images, starts their hardened Compose topology, verifies the same-origin
gateway route and web response headers, and removes the stack afterward. It is
required before promoting either the web or gateway image.

Outputs are written under `dist/release/`:

```text
dist/release/npm.cdx.json
dist/release/rust.cdx.json
dist/release/bridge-source.cdx.json
dist/release/sync-evidence.json # only when accepted evidence was supplied
dist/release/release-manifest.json
dist/release/SHA256SUMS
```

The checksum manifest covers the web/PWA files, sync gateway bundle, and all
three source/dependency SBOMs. The bridge source SBOM records its pinned Git
inputs and base image; the post-build image scan remains authoritative for
operating-system packages actually installed in the container. Review any
license-gate failure; add a new expression to the reviewed set only after
confirming the package, selected features, transitive use, and distribution
obligations.

## Synchronization evidence and protected promotion

The synchronization evidence manifest follows
`specs/015-sync-stability/contracts/sync-release-evidence.md`. A draft candidate
may enter staging and canary, but production acceptance requires an explicit
`accepted` result for the same full commit, release, and artifact digests. A
failed, missing, or unavailable mandatory gate makes the aggregate decision
`rejected`; an operator may not convert it to a skip or manually override it.
The reportable physical Android-device gate is non-blocking unless the release
claims physical-device support.

The protected job supplies `OMNIA_SYNC_PROMOTION_DRIVER` as an absolute
executable path and persists each sanitized JSON receipt outside the checkout.
Run the phases in order:

```sh
node tools/release/sync-promotion.mjs stage candidate.json > staging-receipt.json
node tools/release/sync-promotion.mjs canary candidate.json staging-receipt.json > canary-receipt.json
node tools/release/verify-sync-evidence.mjs accepted.json
npm run release:verify -- --sync-evidence accepted.json
node tools/release/sync-promotion.mjs accept accepted.json canary-receipt.json > production-receipt.json
```

The driver receives only the phase, mode, full candidate identity, and logical
artifact names with SHA-256 digests. It must deploy those exact digests without
building or retagging and return the same identities in its receipt. A failed
receipt stops the sequence. To recover a failed active candidate, pass its
`rejected` evidence and the different, previously accepted evidence record:

```sh
node tools/release/sync-promotion.mjs rollback rejected.json previous-accepted.json > rollback-receipt.json
```

Rollback is valid only when the driver confirms the previously accepted
digests. Never synthesize an accepted manifest from receipts or reuse a receipt
from another commit, release, or artifact set.

## Canary thresholds and decision window

Record the injected alert policy with the candidate. The checked-in defaults
require at least 20 observed gateway requests, then activate
`sync-error-ratio` when server-error outcomes exceed 5 percent and
`sync-latency-p95` when the bounded request sample p95 exceeds 2,000 ms.
`sync-readiness` activates while readiness is unavailable or when consecutive
readiness failures exceed the configured allowance; the checked-in allowance
is zero. These values come from `OMNIA_SYNC_ALERT_MIN_REQUESTS`,
`OMNIA_SYNC_ALERT_MAX_FAILURE_RATIO`, `OMNIA_SYNC_ALERT_MAX_P95_MS`, and
`OMNIA_SYNC_ALERT_MAX_READINESS_FAILURES`; an invalid value prevents startup.

The canary passes only when all of the following are true:

- Public readiness and the private `omnia_sync_readiness` gauge remain healthy
  throughout the steady observation window.
- Every `omnia_sync_alert{alert=...}` gauge is zero after the representative
  minimum request count, with no credential, integrity, data-loss, or sandbox
  failure at any time.
- The separate `sync-staging-v1` evidence retains 200 measured attempts after
  20 warm-ups, with at least 95 percent of targeted reading-state changes
  visible within 15 seconds and at least 95 percent of manual targeted syncs
  completing within 2 seconds.
- The no-change path transfers no publication, and the 25 MiB cancellation,
  retry, monotonic-progress, 8 MiB unacknowledged-buffer, and 64 MiB incremental
  RSS limits pass on every claimed packaged host.
- An isolated injected readiness failure and elevated error/latency exercise
  activates the expected alerts, records recovery, and returns to a clean
  steady state before the real canary window begins.

Any security, integrity, or local-data failure rejects the candidate
immediately. A readiness or alert threshold breach fails the canary receipt and
keeps production acceptance disabled; use rollback when the candidate is
already serving traffic.

## Sanitized diagnostics and evidence retention

Before uploading evidence, assemble non-empty `trace`, `ipc`, `log`, `report`,
`redirect`, `evidence`, and `synchronized-record` directories under one bounded
scan root. Inject secret canaries only through the protected
`OMNIA_SYNC_SECRET_CANARIES` environment variable and run:

```sh
node tools/release/scan-sync-evidence.mjs /protected/path/to/scan-root
```

The scan must pass before any artifact leaves the protected runner. Preserve
the manifest's gate ID, attempt, sanitized environment profile, relative
artifact name, and workflow run identity as the diagnostic correlation; do not
substitute account, repository, path, publication, session, or provider error
text. Limit access to failed traces and internal logs to release and security
operators.

Retention policy:

- Keep each accepted manifest, release checksum manifest, SBOM, provenance,
  vulnerability decision, signatures, promotion receipts, rollback receipts,
  and immutable artifact digests for the entire supported lifetime of that
  release plus one year.
- Keep the complete previous accepted evidence set and deployable artifacts
  online until at least one newer candidate is accepted and the documented
  rollback window closes; archive them under the longer accepted-record policy.
- Keep rejected manifests and their sanitized aggregate reports for 90 days so
  repeated failures can be diagnosed. Keep bulky sanitized traces, IPC captures,
  and logs for 30 days unless an active incident hold requires longer.
- Delete test canary values immediately after scanning. Never retain provider
  credentials, reusable sessions, transfer URLs, publication contents, or raw
  provider-controlled errors as release evidence.

Record unavailable gates in `unavailableGates` with a bounded
application-owned reason, retain that rejected manifest under the same 90-day
policy, and rerun only the missing environment against the same immutable
candidate when it becomes available. A changed commit or artifact digest starts
a new evidence set.

## Native and bridge artifacts

Build native artifacts on supported, isolated runners for each target:

```sh
npm run native:build
npm run android:build -- --apk --aab --ci
npx nx run mega-sdk-bridge:container --skip-nx-cache
npx nx run mega-sdk-bridge:container-smoke --skip-nx-cache
```

Before publication:

- Run packaged desktop smoke tests on Windows, macOS, and Linux.
- Run Android intent, hardware-back, offline reopen, EPUB, and PDF journeys on
  an emulator and at least one physical device.
- Sign desktop installers and Android artifacts with the target platform's
  protected release identity.
- Scan the MEGA bridge image and all distributable archives with the
  organization-approved scanner.
- Sign the bridge image by digest and record its SBOM, signature, base-image
  digest, source commit, and verification result in release provenance.
- Append native and bridge digests to the release record. Do not edit the
  generated web/gateway checksum file after verification.

An unsigned, unscanned, or untested native artifact is a development artifact,
not a release candidate.

## Pre-deployment checklist

- Tag and commit point to the reviewed source.
- All required verification above is green on that commit.
- Artifact hashes match the release record after upload.
- Production CSP and security headers match the repository policy.
- GitHub App, signed authorization webhook, Git LFS, MEGA bridge, Redis, and
  session-encryption configuration have been validated without logging
  secrets.
- Redis persistence/HA and restore have been tested for the target environment.
- Current gateway/bridge images and web assets remain available for rollback.
- Provider layout and local IndexedDB/backup schema changes are backward
  compatible, or the release is explicitly marked forward-fix only.
- Operational owners and the rollback decision maker are identified.

## Promotion order

1. Deploy the MEGA bridge, if changed, without removing the prior image.
2. Deploy the sync gateway. Its health endpoint and provider-disabled behavior
   must pass before traffic is shifted.
3. Exercise a canary Git and MEGA connection with non-production test
   repositories/folders. Verify object SHA-256, optimistic conflict handling,
   session renewal, configured provider deadlines, and GitHub authorization
   revocation across every gateway replica.
4. Deploy versioned web assets and the service-worker manifest.
5. Run web/PWA smoke journeys in a clean profile and an upgraded profile:
   import/open EPUB and PDF, navigate, resume, work offline, and synchronize.
6. Promote signed desktop and Android artifacts only after the compatible web
   and gateway versions are healthy.
7. Monitor error rate, sync failures, session renewal, provider throttling,
   service-worker activation, and client-side recovery/quarantine signals.

Use a staged rollout for native stores. Do not force upgrades while the prior
client remains protocol-compatible.

## Rollback triggers

The release owner should stop promotion and evaluate rollback when any of these
occurs:

- Publication bytes, progress, bookmarks, highlights, or notes can be lost or
  corrupted.
- Downloaded object size or SHA-256 verification can be bypassed.
- Provider credentials or reusable sessions can be exposed.
- EPUB publication content escapes its sandbox or makes unauthorized requests.
- The gateway has sustained elevated errors or cannot renew sessions.
- Web/PWA startup, offline reopen, or either reader format has a material
  regression.
- Crash-free native sessions or sync success fall below the agreed release
  threshold.

Security or data-integrity failures require an immediate traffic freeze and
credential/session review, not only an application rollback.

## Rollback procedure

### Sync gateway and MEGA bridge

1. Stop rollout and preserve logs, metrics, release digests, and failing request
   identifiers without copying credentials or publication content.
2. If writes may corrupt provider state, temporarily disable provider mutation
   at the gateway while keeping local reading available.
3. Shift traffic to the exact previous gateway and bridge image digests.
4. Keep all session-decryption keys needed by unexpired sessions during the
   rollback window. Do not rotate away the prior key until recovery is proven.
5. Verify health, authentication, repository/folder discovery, one immutable
   object transfer, one progress update, and conflict retry.
6. Re-enable writes gradually and replay only journal operations whose
   idempotency and object hashes are known.

Do not delete remote objects as part of rollback. Immutable publication objects
and tombstones make an additive recovery safer than attempting to reconstruct
prior provider state in place.

### Web/PWA

1. Restore the previous immutable web artifact and its matching service-worker
   manifest.
2. Purge only CDN entries for the failed version; keep hashed assets for active
   clients.
3. Verify a clean install and an already-open client. A service worker may keep
   the failed version until its next activation, so keep the compatibility
   window open and provide a user-visible reload only when safe.
4. Confirm that locally stored books and reading state remain accessible
   offline before closing the incident.

Never clear IndexedDB, OPFS, caches containing user-selected local assets, or
application data as a rollback mechanism.

### Desktop and Android

- Pause store rollout or installer publication.
- For directly distributed desktop installers, republish the prior signed
  artifact only when its updater and data schema accept the current local
  state.
- App stores generally require a higher-version corrective build. Use a
  forward hotfix rather than attempting a version downgrade.
- Preserve application data during repair or reinstall instructions. Ask for a
  `.omnia-backup` export before any exceptional reset workflow.

## Data compatibility and forward-fix rule

Browser schema upgrades and provider documents are designed to preserve data,
but an older binary is not automatically able to read a newer schema. Before a
release changes IndexedDB, backup, journal, locator, or provider schema:

- Prove upgrade from the oldest supported version.
- Prove the prior production version can safely ignore or read the new fields.
- Back up production Redis and provider metadata where applicable.
- Record whether binary rollback is supported.

If the prior version cannot safely consume the new state, do not deploy it
during rollback. Disable the affected network feature if needed, keep local
data intact, and ship a higher-version forward fix with a tested migration.

## Recovery completion

A rollback or forward fix is complete only when:

- EPUB/PDF local reading and resume work in upgraded and clean profiles.
- Git and MEGA can round-trip a book and reading state with matching hashes.
- Queued local operations drain without duplication or loss.
- No unexplained quarantine growth, authentication loop, or service-worker
  version split remains.
- The incident record contains affected versions, artifact digests, scope,
  cause, recovery evidence, and follow-up tests.
