# Quickstart: Qualified Desktop Performance Driver

## Prerequisites

Use Node v26.5.0 and the locked dependencies. Contract tests require no browser.
The smoke gate requires installed Playwright Chromium. Primary measurement also
requires the exact clean constrained `desktop-web-v1` environment.

## Workload and matrix contracts

```sh
node --test \
  apps/omnia-reader-e2e/performance/management-workload.spec.mjs
```

Expected: deterministic 1,000-book/2,000-variant recipe identity, exactly 500
logical changes, fourteen unique branches, five distributions, strict invalid
input rejection, and bounded output all pass without starting Angular or a
browser.

## Reduced browser orchestration

```sh
npx nx run omnia-reader-e2e:performance-management-smoke --skip-nx-cache
```

Expected: a serial Chromium journey uses labelled product controls and page
timing observers to prove representative success/failure acknowledgement and
open/switch final states. This reduced run is supplemental smoke evidence, not
primary performance acceptance.

## Driver contract

```sh
node --test apps/omnia-reader-e2e/performance/run-desktop-web.spec.mjs
```

Expected: qualification refusal, child-process lifecycle, evaluator exit
mapping, signal cleanup, and confined result promotion pass without requiring a
qualified host.

## Primary desktop run

```sh
npx nx run omnia-reader-e2e:performance-desktop-web --skip-nx-cache
```

Expected on an exact clean profile: one complete desktop result is evaluated
and written under `specs/001-multi-format-books/performance/results/`; exit 0
only for `PASS` and 2 for threshold `FAIL`.

Expected on the current unconstrained or mismatched development host: preflight
exits non-zero before Playwright and reports the exact `UNVERIFIED` or
`SUPPLEMENTAL` reasons. No desktop acceptance result is created.

## Static quality

```sh
npx nx lint omnia-reader-e2e --skip-nx-cache
git diff --check
```

Mobile-web, packaged-desktop, Android emulator, and physical-device profiles
remain separate unverified gates.
