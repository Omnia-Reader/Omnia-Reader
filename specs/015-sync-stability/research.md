# Research: Production-Ready Synchronization

## Stable provider boundary

**Decision**: Promote GitHub/Git LFS first. Keep MEGA visible but experimental;
retain its deterministic regression coverage and defer its live promotion gate.

**Rationale**: GitHub is already the documented priority path. Its browser,
gateway, OAuth, Git LFS, conflict, throttle, and recovery contracts are broadly
implemented, while MEGA still requires disposable-account MFA, quota,
duplicate/race, interruption, Redis, and signed bridge-image evidence.

**Alternatives considered**: Block the release on both providers. Rejected
because it conflates the stable product claim with a secondary provider whose
remaining official-SDK operations require separate external infrastructure.

## Fresh convergence failure

**Decision**: Treat the 2026-09-11 Chromium result as a stale acceptance-helper
defect and repair it before changing application or reader code.

**Rationale**: The production build passed, 16 of 18 sync journeys passed, and
both long cases remained on the first device's Library page. The test clicked
an inert title left over from the pre-multi-format UI. The current accessible
control is `Open <title> in its preferred format`; no reader engine or provider
sync path ran before failure.

**Alternatives considered**: Increase renderer timeouts or modify PDF/EPUB
mounting. Rejected because the failure artifacts prove navigation never began.

## Mandatory deterministic convergence

**Decision**: Move complete convergence into a dedicated CI matrix across
Chromium, Firefox, and WebKit. Cover EPUB and PDF through Git and MEGA, run once
per pull request, and repeat three times for release candidates.

**Rationale**: Ordinary browser CI does not enable `REMOTE_SYNC_E2E`; Firefox is
opt-in; and current long scenarios cover only Git/PDF and MEGA/EPUB. A dedicated
job avoids hiding skips while preventing expensive duplication in general
browser shards.

**Alternatives considered**: Enable the environment flag in all existing
browser shards. Rejected because it duplicates long scenarios and still leaves
coverage and skip visibility implicit.

## Live GitHub conformance

**Decision**: Add a protected staging workflow that drives the public HTTPS UI
and gateway using a disposable GitHub App and uniquely named private repository.
Bootstrap authorization outside the checkout; never add a production test-auth
route or upload authenticated browser state as an artifact.

**Rationale**: Unit and simulated-provider tests cannot prove OAuth redirects,
real installation permissions, Git LFS transfers, provider revisions, or public
cookie behavior. A protected workflow can test the exact production boundary
without exposing credentials to pull requests.

**Alternatives considered**: Run live tests on every pull request or introduce a
test-only authentication endpoint. Rejected for secret exposure, provider
request amplification, and trust-boundary weakening.

## Shared sessions and readiness

**Decision**: Exercise the existing encrypted Redis implementation against a
real pinned Redis service, including two gateway instances, atomic rotation,
current/previous keys, TTL preservation, webhook replay/invalidation, restart,
outage, backup, and restore. Keep liveness distinct from Redis-backed readiness.

**Rationale**: Deterministic tests cover the algorithms, but the only real Redis
test is opt-in and currently skipped. Production must not silently fall back to
process-local sessions when shared state is configured but unavailable.

**Alternatives considered**: Add Redis to the base Compose stack and call it HA.
Rejected because one bundled instance does not prove production replication,
backup, restore, or availability.

## Provider maturity presentation

**Decision**: Centralize provider presentation metadata and carry maturity into
provider cards, toolbar labels/descriptions, success, failure, and recovery.
Maturity is release policy, never inferred from a successful sync. Flip GitHub
to supported only in the final evidence-backed promotion change.

**Rationale**: Git currently shows only `Recommended`, MEGA has no maturity
label, and a prior MEGA success can appear generically as `Synced`.

**Alternatives considered**: Label only the setup cards. Rejected because status
outside Settings would continue to imply unsupported maturity after navigation
or restart.

## Packaged-host credential boundary

**Decision**: Add a narrow native synchronization broker for Tauri desktop and
Android. Browser/PWA retains same-origin HttpOnly cookies. The native broker
allowlists one HTTPS gateway, owns an opaque cookie/session jar and conditional
protected persistence, exposes typed sync operations only, streams/cancels
bodies, and uses a short-lived single-use deep-link authorization handoff.

**Rationale**: Packaged assets use a custom Tauri origin, so relative
`/api/sync/**` requests do not prove access to the hosted gateway. Allowing
cross-origin browser fetch would require weakening Origin, cookie, and callback
properties. A localhost asset server carries an explicit platform security
risk, and a generic webview HTTP surface could expose cookie-bearing response
metadata to JavaScript.

**Alternatives considered**: Configurable browser-visible HTTPS base URL;
localhost/custom-protocol proxy; generic HTTP plugin. Rejected because none
preserves the current credential boundary as narrowly across desktop and
Android. The implementation starts with a packaged Linux and Android proof that
the current relative route misses the gateway and the broker keeps canary
authority out of IPC, storage, headers, and logs.

Reusable session persistence is conditional, not assumed: it is enabled only
after a Rust-only encrypted store proves that its bootstrap secret is protected
by the host platform. A host without that facility keeps authority process-local
and requires safe reauthentication after restart while retaining local data and
pending operations.

The implemented authorization handoff reuses the encrypted gateway session
stores with an atomic consume operation rather than adding a second plaintext
authority store. OAuth completion places only the random replacement session
identifier, provider, native request binding, sanitized outcome, and expiry in
the encrypted handoff. A dedicated pending browser cookie avoids replacing an
existing browser/PWA session; the callback clears it before opening the exact
`omnia-reader://sync-auth/<provider>` deep link.

Primary platform references: [Tauri localhost plugin](https://v2.tauri.app/plugin/localhost/),
[HTTP client plugin](https://v2.tauri.app/plugin/http-client/),
[HTTP guest-JS source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts),
[Content Security Policy](https://v2.tauri.app/security/csp/),
[Capabilities](https://v2.tauri.app/security/capabilities/),
[calling Rust from the frontend](https://v2.tauri.app/develop/calling-rust/),
[deep linking](https://v2.tauri.app/plugin/deep-linking/), and
[Stronghold](https://v2.tauri.app/plugin/stronghold/). The deep-link contract
treats custom-scheme input as forgeable, and the implementation must not treat
encrypted storage alone as proof of OS-keystore-grade protection.

### Exact native dependency decision

The implementation proof uses the versions already resolved by the locked Tauri
dependency graph where possible:

- add direct `reqwest = "=0.13.4"` with default features disabled and only the
  `cookies`, `json`, `stream`, and `rustls` features. Its Rust-owned
  [`cookie::Jar`](https://docs.rs/reqwest/0.13.4/reqwest/cookie/struct.Jar.html)
  remains private to the broker. `ClientBuilder` supplies HTTPS-only operation,
  explicit connect/read/whole-request timeouts, a custom same-origin redirect
  policy, and bounded response streaming;
- add direct `url = "=2.5.8"` for canonical scheme, user-info, host, port,
  fragment, relative-path, and exact-origin validation;
- add direct `tokio = "=1.53.1"` using only `fs`, `macros`,
  `rt-multi-thread`, and `time`. Tauri already resolves this exact runtime; the
  direct declaration exposes disk-backed async request bodies so acknowledged
  IPC chunks are streamed without accumulating whole publications in memory,
  and supplies the native broker test runtime without adding another executor;
- retain the existing exact `tauri-plugin-deep-link = "=2.4.9"`. Treat every
  `on_open_url` value as hostile and validate the native request binding,
  provider, expiry, and one-use handoff before redemption; and
- add no generic Tauri HTTP plugin and no protected-persistence crate in the
  first broker slice. The current Stronghold setup derives its vault key from a
  password/hash policy supplied by the application, which does not itself prove
  an OS-protected bootstrap secret. Until a platform-specific proof establishes
  that property, the declared capability is `session-only`: the Rust process
  owns the cookie jar and clears reusable authority on exit while preserving
  local books and pending operations.

This selection adds no JavaScript network authority and no new browser runtime
dependency. Cargo must pin all three direct declarations exactly (only
`reqwest` and `url` add newly resolved crate families) and preserve the lockfile
checksums before the native broker implementation begins.

## Release artifacts and promotion

**Decision**: Build web and gateway images once, bind source/runtime SBOM and
provenance to exact registry digests, scan and sign those digests, and promote
the identical artifacts through staging, canary, production, and rollback.
Extend the existing release verifier and use full-commit pins for every CI
action. Add no application runtime dependency for release automation.

**Rationale**: Current source/runtime verification and hardened containers are
strong, but CI does not run the container smoke, identify OCI digests, scan,
sign, publish, canary, or execute rollback. Rebuilding during promotion would
break artifact identity.

**Alternatives considered**: Rebuild at each environment or document manual
commands only. Rejected because neither produces reproducible, auditable
evidence that the tested bytes are the deployed bytes.

## Durable compatibility

**Decision**: Do not change synchronized record schemas, merge ordering,
tombstone semantics, backup format, or journal acknowledgement. Add a versioned
release-evidence format only; it is operational metadata and contains no reader
data.

**Rationale**: The deterministic core is healthy (203 sync-core, 38 sync-git,
10 sync-mega, and 121 gateway tests passed in the fresh baseline). Stability is
blocked by acceptance and deployment evidence, not a missing domain redesign.

**Alternatives considered**: Introduce a new sync schema for the stable release.
Rejected because it adds migration risk without addressing any observed gap.
