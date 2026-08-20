# Quickstart: Verify the Performance Evidence Core

## Prerequisites

Use Node v26.5.0 from `.nvmrc` and the checked-in dependency lock. No browser,
provider, credential, package, emulator, device, or network is required.

## Contract tests

```sh
node --test apps/omnia-reader-e2e/performance/validate-profile.spec.mjs
node --test apps/omnia-reader-e2e/performance/performance-evidence.spec.mjs
npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache
```

Expected: canonical identity, hostile bounds, preflight classifications,
statistics, threshold failures, dispositions, CLI exits, and aggregate
completeness all pass without starting a measurement runtime.

## Current desktop preflight

```sh
node apps/omnia-reader-e2e/performance/validate-profile.mjs \
  specs/001-multi-format-books/performance/profiles-v1.json \
  desktop-web-v1
```

Expected: `READY` only if the clean checkout and every approved constrained
host/runtime/dataset field match. Otherwise the command exits non-zero with an
honest bounded `UNVERIFIED` or `SUPPLEMENTAL` report. This command is not a
desktop performance pass and starts no Playwright process.

## Invalid and incomplete evidence

```sh
node apps/omnia-reader-e2e/performance/performance-evidence.mjs evaluate \
  specs/001-multi-format-books/performance/profiles-v1.json \
  apps/omnia-reader-e2e/performance/fixtures/raw-result-incomplete.json
```

Expected: invalid structural evidence exits 1; a complete qualified result that
misses a performance threshold exits 2 as `FAIL`. No producer summary can
override recomputed raw timings.

## Aggregate evidence

```sh
node apps/omnia-reader-e2e/performance/performance-evidence.mjs aggregate \
  specs/001-multi-format-books/performance/profiles-v1.json \
  <desktop-result.json> <mobile-result.json> \
  <packaged-result.json> <android-result.json>
```

Expected: only four current primary `PASS` results produce aggregate `PASS` and
exit 0. Missing, stale, duplicated, failed, unverified, or supplemental evidence
produces `INCOMPLETE` or invalid output and never pools timings.

## Static quality

```sh
npx nx lint omnia-reader-e2e --skip-nx-cache
git diff --check
```

Application builds and Playwright are not part of this evidence-core slice
because no application or browser behavior changes. All four actual performance
profile runs remain separate `UNVERIFIED` gates until their drivers run in the
exact approved environments.
