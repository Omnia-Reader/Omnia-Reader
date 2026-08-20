# Data Model: Cross-Platform Performance Drivers

## ProfileSetDescriptor

- `schemaVersion`: allowlisted integer
- `profileSetId`: allowlisted immutable identifier
- `profileIds`: exact ordered platform identifiers
- `validator`: schema-specific validation function
- `compatibility`: evidence/result versions this set may consume

The registry rejects unknown versions/IDs and ambiguous descriptor matches.
The v1 descriptor preserves every current requirement and digest.

## PlatformQualificationProfileV2

- Common identity: profile ID, intent, source commit/clean state, lock and
  workload digests, finite CPU/memory constraints, power state, driver version
- Runtime identity: platform-specific browser, WebView, WebKit/Wry, viewport,
  density, display, OS/image, and tool versions
- Emulator identity when applicable: SDK image package/revision, emulator
  build, AVD configuration, named snapshot manifest/digest, device class,
  battery, and network policy
- Artifact identity when applicable: `ReleaseArtifactIdentityV2`
- Automation identity: transport, executable/test-package digest, protocol
  version, and ownership challenge

Every required field is exact and bounded. Null, placeholder, alias, duplicate,
or unapproved values cannot qualify a primary run.

## ReleaseArtifactIdentityV2

- `kind`: exact approved package kind
- `sha256`: canonical digest of the selected package bytes
- `sizeBytes`: bounded exact byte length
- `sourceCommit`: clean source revision
- `packageVersion` and application identifier
- `target`: OS/architecture/ABI and package format
- `releaseMode`: release only; debug is invalid
- `lockDigests`: package/Cargo locks and profile manifest
- `toolchain`: Node, Rust, Tauri, Java/Android build tools as applicable
- `signerSha256`: required for Android and signed release profiles

The owned launch/install copy must match this record immediately before use.

## EmulatorSnapshotIdentityV2

- Canonical SDK system-image package path and revision
- Emulator version/build
- AVD device/profile configuration and named snapshot
- Canonical tree-manifest algorithm and digest
- File-count and total-byte bounds
- Guest build fingerprint, ABI, cores, RAM, viewport, density, GPU mode
- Battery level/charging state/Battery Saver and external-network policy

The canonical tree rejects symlinks, special files, unknown volatile files, and
changes after the approved baseline is copied.

## AutomationSessionV2

- `platform`: mobile-web, packaged-desktop, or android
- Exact owned serial, PID/process group, endpoint/forward, and temporary roots
- Runtime/package identity observed through the automation boundary
- Bounded command and response schema
- State and deadline for each lifecycle transition
- Cleanup ledger containing only resources created by this session

State transitions:

```text
CREATED -> QUALIFIED -> LAUNCHED -> REVALIDATED -> SAMPLING
   |            |           |             |             |
   +----------> ABORTED <----+-------------+-------------+

SAMPLING -> EVALUATED -> PROMOTED
    |            |
    +-> ABORTED <-+
```

Only `REVALIDATED` may enter `SAMPLING`. `ABORTED` publishes no primary file.

## PlatformMeasurementResultV2

- Existing raw-result identity and frozen branch/distribution arrays
- Exact qualification profile and live recapture
- Artifact and automation identity where applicable
- Page-observed timings and four independent counters
- Canonical evaluator disposition

Platform samples remain separate. Adapter diagnostics are not acceptance data.

## AggregateReleaseResultV2

- Exact profile-set identity
- One independently validated result reference/disposition for desktop web,
  mobile web, packaged desktop, and Android
- Overall disposition

`PASS` requires four independent evaluator `PASS` values for the same source,
workload, and immutable profile set. Missing, unavailable, supplemental, failed,
or mixed-profile input is non-passing; raw samples are never pooled.

## Compatibility

No product record changes. V1 profiles/results retain existing validation and
meaning. V2 is additive and cannot upgrade or reinterpret v1 evidence.
