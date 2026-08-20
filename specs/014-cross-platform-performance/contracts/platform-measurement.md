# Platform Measurement Contract

## Common command contract

Each platform command accepts an explicit immutable profile, optional bounded
environment expectations, one approved unique JSON output name, and a bounded
timeout. Packaged commands additionally require one explicit artifact and
provenance file. No command discovers a package or device through a wildcard or
first-match rule.

Exit codes remain:

- `0`: structurally valid evaluator `PASS`
- `2`: structurally valid honest threshold `FAIL`
- `1`: unavailable, supplemental, mismatch, invalid input/result, crash,
  timeout, signal, disconnect, or cleanup failure

Only exits 0 and 2 may promote primary evidence. Promotion is atomic,
confined, bounded, and no-replace.

## Qualification protocol

1. Validate profile set, profile, workload, artifact/provenance, arguments, and
   output without launching a measurement runtime.
2. Reserve exact owned resources and reject ambiguity or foreign collisions.
3. Capture static host/artifact/emulator identity and require `READY`.
4. Launch only owned copies and establish an ownership-bound automation session.
5. Recapture complete source, locks, constraints, runtime, artifact, workload,
   and automation identity immediately before the first measured action.
6. Start sampling only when recapture equals the qualified profile.
7. Evaluate the complete raw result with the canonical evaluator.
8. Revalidate immutable runtime/artifact fields, clean owned resources, and
   promote final evidence only when every prior step succeeds.

No externally supplied environment record substitutes for live probes.

## Mobile-web adapter

- Uses one reviewed disposable AVD copy and exact `emulator-<port>` serial.
- Passes `-s <serial>` to every ADB command and rejects foreign/duplicate
  devices.
- Restores the named snapshot with `-no-snapshot-save` and never mutates the
  approved AVD.
- Disables guest external networking, owns one reverse to the production web
  server and one forward to the exact Chrome DevTools socket.
- Requires Chrome package version/code/APK digests and CDP product/protocol
  identity to agree immediately before sampling.
- Connects Playwright over CDP and uses the real viewport/DPR; device emulation
  is supplemental only.

## Packaged-desktop adapter

- Accepts one explicit release package plus provenance, copies/hashes it into
  owned storage, safely validates/extracts it, and launches only that copy.
- Rejects debug features, mismatched package metadata, changed bytes, duplicate
  application instances, stale endpoints, and processes outside the qualified
  constraint scope.
- Uses external `tauri-driver` only after proving it controls the unmodified
  release artifact. The embedded `native-e2e` WebDriver remains debug-only and
  cannot produce primary evidence.
- Binds the automation endpoint to the spawned application/session and verifies
  the running executable/resource identity before sampling.

## Packaged-Android adapter

- Accepts one explicit non-debuggable release APK plus provenance and one
  independently identified test instrumentation APK.
- Validates size/hash, application ID, version, SDK/ABI, manifest policy, and
  signer before boot; after install, re-reads the single installed `base.apk`
  and requires identical bytes.
- Uses the same disposable-emulator ownership contract as mobile web and
  verifies the active WebView provider plus page-observed runtime.
- Drives product semantics through bounded test instrumentation without
  enabling unrestricted release WebView debugging or changing the release APK.
- If this exact-artifact boundary cannot be established, qualification is
  `UNVERIFIED` and no sampling starts.

## Shared workload and evidence

Every adapter executes the same ordered fourteen management branches and five
unpooled final distributions. Setup and exactly 20 warm-ups per distribution
are excluded from final samples. Page-side `performance.now()` plus
paint-eligible semantic states own timing; host transport timings are diagnostic
only. The existing evaluator alone computes acceptance.

## Ownership and cleanup

Each session records its temporary roots, process groups, PIDs, serial, ADB
mappings, endpoints, pages/contexts, installed test/application package state,
and raw result path. Cleanup is idempotent and removes only those entries.

Broad cleanup such as `pkill`, `adb kill-server`, deleting a user AVD, choosing
the first device, or removing all forwards is forbidden. TERM then KILL is
bounded and scoped to an owned process group. Prior primary evidence is never
deleted or replaced.
