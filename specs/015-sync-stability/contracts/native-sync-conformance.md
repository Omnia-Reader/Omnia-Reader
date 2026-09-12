# Packaged Synchronization Conformance Driver

## Boundary

`run-native-sync-e2e.mjs` is the repository-owned fail-closed verifier for the
Linux, Windows, macOS, and Android-emulator packaged synchronization journey.
The protected host supplies an absolute `OMNIA_NATIVE_SYNC_CONTROL_DRIVER` for
platform lifecycle, public-HTTPS fault injection, process memory measurement,
and scoped cleanup. The driver is a test adapter, not application runtime code,
and may not replace the packaged artifact with a browser build or mock the Tauri
IPC boundary.

The runner refuses unprotected execution, mutable candidate identities, relative
driver paths, unknown hosts, malformed or additional report fields, secret
canary output, and replacement of an existing evidence file. The canary value is
inherited only through the protected process environment; it is never included
in the JSON request or retained evidence.

## Required driver behavior

The runner invokes the driver once for each ordered operation below. Each
invocation reads one bounded JSON request from standard input and writes only
that operation's canonical bounded result to standard output. The runner, not
the driver, assembles and validates the final evidence report. The driver must:

1. Launch the exact packaged artifact bound by `candidate` and
   `artifactDigest`, then exercise its real Tauri webview and Rust broker.
2. Prove that a packaged relative `/api/sync/**` route does not reach the public
   gateway before using the broker.
3. Complete broker connection and one synchronization through the configured
   public HTTPS gateway without exposing cookie or handoff authority to the
   webview.
4. Keep a publication readable, a local mutation durable, and its pending
   operation recoverable while the gateway is unavailable and after restart.
5. Match restart behavior to the broker's declared `protected` or
   `session-only` mode and complete reauthentication when required.
6. Interrupt and cancel a 25 MiB transfer, retry the whole transfer, emit
   monotonic progress, retain at most 8 MiB of unacknowledged data, add no more
   than 64 MiB RSS, acknowledge exactly once, and publish no dangling reference.
7. Scan IPC, storage, headers, logs, reports, and synchronized records for the
   protected canary, then stop all owned processes and remove only its scoped
   remote destination.

The exact operation order is `relative-route-failure`, `broker-connection`,
`offline-reading`, `restart-continuity`, `reauthentication`,
`bounded-transfer-retry`, `secret-canary-scan`, and `scoped-cleanup`. The runner
invokes cleanup from `finally`, including after an earlier failure. The platform
driver must return `passed` for every required check. Unavailable toolchains,
emulators, public staging, or protected drivers are reported by the release
workflow as unavailable gates; the driver must not encode them as a passing
result.

## Invocation

```sh
OMNIA_NATIVE_SYNC_E2E=1 \
OMNIA_NATIVE_SYNC_PROTECTED_RUNNER=1 \
OMNIA_NATIVE_SYNC_CONTROL_DRIVER=/absolute/protected/native-sync-driver \
OMNIA_NATIVE_SYNC_HOST=linux \
OMNIA_NATIVE_SYNC_RUN_ID=native-linux-1 \
OMNIA_NATIVE_SYNC_CANDIDATE_COMMIT=<40-lowercase-hex-commit> \
OMNIA_NATIVE_SYNC_CANDIDATE_RELEASE=<release-identifier> \
OMNIA_NATIVE_SYNC_ARTIFACT_DIGEST=sha256:<64-lowercase-hex-digest> \
OMNIA_NATIVE_SYNC_SECRET_CANARY=<protected-unique-value> \
OMNIA_NATIVE_SYNC_EVIDENCE=dist/native-sync-evidence/linux.json \
npm run native:e2e
```

Use `OMNIA_NATIVE_SYNC_HOST=windows`, `macos`, or `android-emulator` only on the
corresponding protected host. Android may invoke `npm run native:sync:e2e`
directly after its platform driver launches the installed APK and exposes the
same evidence contract.
