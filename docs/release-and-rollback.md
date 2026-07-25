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
npm run performance:e2e
npm run release:verify
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

Outputs are written under `dist/release/`:

```text
dist/release/npm.cdx.json
dist/release/rust.cdx.json
dist/release/bridge-source.cdx.json
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
- GitHub App, Git LFS, MEGA bridge, Redis, and session-encryption configuration
  have been validated without logging secrets.
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
   and session renewal.
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
