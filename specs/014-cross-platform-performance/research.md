# Research: Cross-Platform Performance Drivers

## Decision: Add a backward-compatible profile-set registry

**Decision**: Keep `profiles-v1.json` immutable and add an allowlisted schema
registry capable of validating v1 and a separately reviewed v2 profile set.

**Rationale**: The current validator hard-codes `multi-format-performance-v1`,
while mobile browser, WebView, snapshot, and artifact identities are unresolved
or placeholders. Filling them in place would reinterpret existing evidence.

**Alternatives considered**: Editing v1 was rejected as an evidence-contract
break. Accepting arbitrary schema IDs was rejected because an unreviewed profile
could become primary evidence.

## Decision: Share qualification and lifecycle, not platform probes

**Decision**: Extract a platform-neutral qualified-process lifecycle and retain
small platform adapters for probes and automation.

**Rationale**: Preflight precedence, identity recapture, evaluator mapping,
bounded diagnostics, signal handling, owned cleanup, and evidence promotion are
common. ADB/CDP, Tauri WebDriver, and Android instrumentation have different
trust and teardown boundaries.

**Alternatives considered**: Copying `run-desktop-web.mjs` three times was
rejected because qualification and cleanup semantics would drift. One universal
controller was rejected because it would blur resource ownership.

## Decision: Use a disposable reviewed AVD for mobile web

**Decision**: Copy and canonically hash a reviewed AVD/snapshot, launch the copy
on an allocated exact serial with snapshot saving disabled, disable guest
external networking, and connect Playwright to the exact Chrome package through
an owned ADB reverse/forward and CDP endpoint.

**Rationale**: This uses a real mobile runtime while preventing Play Store,
browsing state, or failed runs from mutating the approved baseline. Package and
CDP identities can be compared immediately before sampling.

**Alternatives considered**: Playwright device emulation was rejected as not a
mobile runtime. Measuring a user-owned or mutable AVD was rejected as
nondeterministic and unsafe.

## Decision: Prove external desktop automation before implementing evidence

**Decision**: Spike external `tauri-driver` attachment to an unmodified Linux
release artifact. Implement primary measurement only after the spike proves
script execution, semantic actions, runtime ownership, and cleanup.

**Rationale**: The existing embedded `native-e2e` WebDriver changes the binary
and exposes a test-only loopback endpoint. Current Tauri documentation describes
external WebDriver for Linux/Windows, which can preserve exact artifact bytes,
but this repository has not yet proven the route against its release package.

**Alternatives considered**: Compiling the embedded endpoint into production
was rejected as both an identity and security violation. Treating the debug
native E2E as release evidence was rejected as a substitute artifact.

## Decision: Use separate Android instrumentation, fail closed until proven

**Decision**: Drive the exact non-debuggable release APK with a separately
profile-bound test instrumentation APK. Keep Node as workload/evaluator owner
and exchange only bounded canonical commands/results. Do not enable unrestricted
WebView debugging in release.

**Rationale**: Chrome CDP cannot prove packaged WebView behavior, and the
desktop-only embedded Tauri plugin is unavailable on Android. Android test
instrumentation can target release bytes without changing the production APK,
provided the boundary and test APK identity are independently reviewed.

**Alternatives considered**: Debug APK measurement and Mobile MCP were rejected
as non-release evidence. Shipping a general automation bridge was rejected as
an unsafe production capability.

## Decision: Bind artifacts through provenance and installed/running identity

**Decision**: Record size and SHA-256 plus source, locks, package metadata,
target, release mode, toolchain, and signing identity. Recopy/re-hash before
launch and prove installed or running bytes originate from that owned copy.

**Rationale**: A claimed artifact kind or pre-launch path digest alone does not
prevent debug-package substitution or time-of-check/time-of-use replacement.

**Alternatives considered**: Trusting a filename, profile string, CI archive,
or local bundle directory was rejected because none authenticates the launched
package.

## Decision: Promote primary evidence without replacement

**Decision**: Use unique approved filenames and atomic no-replace promotion.

**Rationale**: The current rename-based writer can replace an existing regular
file on Linux. Failed, rerun, or hostile platform automation must not destroy a
prior valid record.

**Alternatives considered**: Overwriting the per-platform v1 filename was
rejected because evidence history and interruption safety would be weaker.

## Decision: Add no dependency during the contract foundation

**Decision**: Use Node, Playwright, Tauri, and Android tools already present.
Any future library must be justified against current primary documentation and
added only in the platform slice that requires it.

**Rationale**: Existing modules already provide canonical JSON, workload,
evaluator, Playwright actions, and W3C protocol primitives.

**Alternatives considered**: Adopting a cross-platform automation framework
before proving each exact-artifact boundary was rejected as unnecessary risk.
