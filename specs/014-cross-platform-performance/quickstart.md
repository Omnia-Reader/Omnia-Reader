# Quickstart: Cross-Platform Performance Drivers

## Prerequisites

Use Node v26.5.0 and `npm ci` dependencies. Contract tests require no emulator
or release artifact. Live targets require the exact reviewed profile inputs;
missing AVDs, runtimes, artifacts, constraints, or automation boundaries must
return `UNVERIFIED` before sampling.

## Contract foundation

```sh
npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache
node --test \
  apps/omnia-reader-e2e/performance/platform-lifecycle.spec.mjs \
  apps/omnia-reader-e2e/performance/artifact-identity.spec.mjs
```

Expected: v1 remains compatible; v2 rejects unknown/missing/mismatched
identities; lifecycle failures clean only owned resources; evidence cannot
escape or replace an existing result.

The shared foundation accepts only a clean, non-debuggable release provenance
record and copies exact regular-file bytes into owned storage with size, digest,
source-identity, and exclusive-destination checks. Platform adapters add their
package-format, signer, installed/running-byte, and runtime checks.

## Mobile-web smoke and primary run

The emulator and runtime identity contracts run without a configured AVD:

```sh
node --test \
  apps/omnia-reader-e2e/performance/android-emulator-controller.spec.mjs \
  apps/omnia-reader-e2e/performance/mobile-web-environment.spec.mjs
```

Expected: canonical AVD copying, exact serial selection, owned ADB cleanup,
Chrome package/CDP agreement, viewport, battery, offline guest networking,
host constraints, and before/after sampling identity checks pass against
deterministic fixtures.

```sh
npx nx run omnia-reader-e2e:performance-mobile-web-smoke --skip-nx-cache
npx nx run omnia-reader-e2e:performance-mobile-web --skip-nx-cache
```

Expected smoke: the exact disposable AVD/Chrome identity reaches the real app
through ADB and CDP and executes a reduced supplemental workload.

Expected primary: full cardinality is canonically evaluated only on the frozen
profile. With no approved AVD/snapshot, the current host must exit non-zero
before Playwright and name the missing identity.

## Packaged-desktop spike and primary run

Build/select one explicit unmodified release package and provenance record,
then run:

```sh
npx nx run omnia-reader-e2e:performance-packaged-desktop-smoke --skip-nx-cache
npx nx run omnia-reader-e2e:performance-packaged-desktop --skip-nx-cache
```

Expected smoke: external WebDriver proves script execution and semantic product
actions against the exact owned release bytes. If the host lacks a supported
external WebDriver, the result is `UNVERIFIED`; debug `native-e2e` coverage is
not accepted.

## Packaged-Android smoke and primary run

Build/select one x86_64 non-debuggable release APK, provenance, reviewed test
APK, and approved AVD snapshot, then run:

```sh
npx nx run omnia-reader-e2e:performance-android-smoke --skip-nx-cache
npx nx run omnia-reader-e2e:performance-android --skip-nx-cache
```

Expected smoke: installed release bytes, signer/application identity, WebView,
snapshot, and bounded instrumentation all match. Until that test-only boundary
is implemented and reviewed, the command must remain `UNVERIFIED` before
sampling.

## Regression and static gates

```sh
npx nx run omnia-reader-e2e:performance-management-branch-smoke --skip-nx-cache
npx nx lint omnia-reader-e2e --skip-nx-cache
npx nx build omnia-reader --configuration production
git diff --check
```

Primary acceptance remains incomplete unless desktop web, mobile web, packaged
desktop, and Android independently pass the same immutable profile set. Physical
devices and additional desktop operating systems remain separate release gates.
