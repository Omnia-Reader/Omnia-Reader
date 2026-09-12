# Synchronization Release Evidence Contract

## Purpose

One sanitized manifest binds a synchronization release decision to the exact
candidate, deployable artifact digests, environments, and observed gates. It is
operational evidence, not synchronized reader data.

## Required top-level fields

```json
{
  "schemaVersion": 1,
  "candidate": {
    "commit": "40 lowercase hexadecimal characters",
    "release": "non-empty release identifier"
  },
  "artifacts": [
    {
      "name": "web",
      "digest": "sha256:64-lowercase-hex-characters"
    }
  ],
  "environments": [],
  "runs": [],
  "unavailableGates": [],
  "startedAt": "UTC timestamp",
  "completedAt": "UTC timestamp",
  "result": "candidate"
}
```

`result` is `accepted` only when every mandatory Feature 015 gate has a passing
run for the same candidate and artifact digests. A failure, missing artifact
identity, or unavailable mandatory environment yields `rejected`.

## Run identity

Each run records a stable gate identifier, provider, scenario, platform,
browser or packaged host when applicable, attempt number, start/completion UTC
timestamps, duration, pass/fail result, and a relative artifact reference.
Release-candidate browser convergence requires three distinct passing attempts
per supported browser.

## Stable gate identifiers

The following identifiers are mandatory for a candidate whose GitHub maturity
is `supported`:

| Gate ID                          | Required evidence                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `deterministic-sync`             | Provider-neutral, Git/LFS, MEGA, journal, merge, tombstone, integrity, and compatibility-corpus contracts |
| `browser-convergence-chromium`   | Three complete Git/MEGA EPUB/PDF attempts in Chromium                                                     |
| `browser-convergence-firefox`    | Three complete Git/MEGA EPUB/PDF attempts in Firefox                                                      |
| `browser-convergence-webkit`     | Three complete Git/MEGA EPUB/PDF attempts in WebKit                                                       |
| `sync-performance-staging`       | Fixed-profile latency, no-op request count, 25 MiB progress/cancellation, and memory limits               |
| `gateway-redis-lifecycle`        | Multi-replica restart, rotation, TTL, invalidation, outage, backup, restore, and readiness                |
| `packaged-sync-linux`            | Packaged Linux connection, synchronization, restart, offline use, recovery, and native-boundary checks    |
| `packaged-sync-windows`          | The equivalent packaged Windows journey                                                                   |
| `packaged-sync-macos`            | The equivalent packaged macOS journey                                                                     |
| `packaged-sync-android-emulator` | The equivalent Android emulator journey                                                                   |
| `live-github-conformance`        | Protected public-HTTPS GitHub App and Git LFS contract                                                    |
| `sync-observability`             | Sanitized telemetry plus injected readiness/failure alert exercises                                       |
| `container-security`             | Current-image smoke, public route, headers, readiness, scan, and clean shutdown                           |
| `artifact-integrity`             | Immutable digests, SBOM, provenance, vulnerability decision, and signatures                               |
| `canary-rollback`                | Same-digest canary promotion and rollback to a previously accepted digest                                 |
| `sync-accessibility`             | Keyboard, touch, narrow-viewport, screen-reader, focus, and automated accessibility evidence              |

An unavailable mandatory gate is recorded in `unavailableGates` and forces
`result: rejected`; it is never converted to a skipped or passing run. A physical
Android-device gate is reportable but does not block desktop, web, or emulator
claims. It becomes mandatory only for a physical-device distribution/support
claim. Live MEGA conformance is outside this feature and remains the independent
prerequisite for changing MEGA from `experimental`.

## Confidentiality

The manifest and linked artifacts must not contain names or identifiers of real
accounts, cookies, OAuth codes, access or refresh tokens, native session state,
provider transfer URLs, publication contents, raw provider errors, or secret
environment values. Test canaries must be reported only by identifier and
present/absent result, never by secret value.

### Canary scan input

The protected release environment supplies canary values only through the
`OMNIA_SYNC_SECRET_CANARIES` environment variable as a JSON object whose keys
are sanitized canary identifiers. The scan root contains non-empty `trace`,
`ipc`, `log`, `report`, `redirect`, `evidence`, and `synchronized-record`
directories. Regular files and bounded ZIP contents are scanned for literal,
percent-encoded, form-encoded, Base64, and Base64url representations. Symbolic links,
missing target classes, unsafe archive paths, malformed archives, and bounded
size violations fail closed.

Scanner output contains only canary identifiers, present/absent results,
target classes, opaque file identifiers, and encoding names. It never repeats
the canary value or source path. Any detection produces a failed result and a
non-zero command exit status.

## Immutability

Evidence is append-only for one candidate. A changed commit, image digest,
packaged artifact, environment contract, or required gate creates a new
candidate record. Promotion and rollback consume exact recorded digests and may
not rebuild them.
