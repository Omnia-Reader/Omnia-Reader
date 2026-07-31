# Performance Profile and Evidence Contract

## Versioned Profile Set

Implementation creates immutable
`specs/001-multi-format-books/performance/profiles-v1.json` with schema version
1 and profile set `multi-format-performance-v1`. The file freezes dataset
hashes, thresholds, environment identity, and these primary profiles:

| Profile ID            | Minimum CPU and memory                                                                                   | OS and runtime                                                                                                              | Power and display                |
| --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `desktop-web-v1`      | Intel i7-10610U reference host; browser, server, and test runner in one 2-CPU/8-GiB systemd/cgroup scope | Ubuntu 26.04 LTS; Playwright 1.61.1 from `package-lock.json`; exact Chromium revision/version captured after clean `npm ci` | AC, balanced, 1366×768           |
| `mobile-web-v1`       | Pinned Pixel 4a-class AVD; 2 vCPU/4 GiB                                                                  | Android 36.1 x86_64 Play Store image revision 4; exact Chrome package/version and snapshot digest frozen in JSON            | simulated 75%, Battery Saver off |
| `packaged-desktop-v1` | Intel i7-10610U reference host; packaged app and fixture server in one 2-CPU/8-GiB scope                 | Ubuntu 26.04 LTS; release Tauri package; Tauri CLI 2.11.4; WebKitGTK 2.52.3                                                 | AC, balanced, 1366×768           |
| `android-v1`          | Same pinned Pixel 4a-class AVD; 2 vCPU/4 GiB                                                             | Android 36.1 image revision 4; release APK; exact Android System WebView package/version and snapshot digest frozen in JSON | simulated 75%, Battery Saver off |

The profile JSON also records the host kernel, CPU quota mechanism, memory cap,
storage class, device scale factor, AVD configuration and snapshot digest,
fixture filenames/SHA-256 values, and logical-change-history bound. T091 creates
v1 only after `npm ci`, confirms every Node package against `package-lock.json`,
and captures the exact installed Chromium/Chrome/WebView package versions and
revisions. A dirty or lock-drifted installation cannot create primary evidence.
Once committed, any environment/runtime/fixture change requires
`profiles-v2.json`; v1 is never edited in place.

An unconstrained run, viewport-only emulation, CDP throttling alone, or hardware
faster than the primary profile is `SUPPLEMENTAL`. It cannot establish SC-004.
An unavailable or non-matching primary profile is `UNVERIFIED`.

## Dataset and Thresholds

- Exactly 1,000 logical books and 2,000 exact variants, with one deterministic
  EPUB and PDF per book and a bounded 500-change history.
- Twenty discarded warm-ups and at least 200 measured samples for each final
  action/profile distribution.
- Every branch in the closed acknowledgement matrix below has at least 20
  samples per profile; every sample is at most 1,000 ms.
- Final distributions remain separate for filtering, EPUB open, PDF open,
  EPUB→PDF, and PDF→EPUB. Each independently has p95 at most 2,000 ms and at
  least 95% of samples at most 2,000 ms.
- Actions, formats, directions, profiles, warm-ups, and measured samples are
  never pooled. Wrong-book/format, missing acknowledgement, console error, or
  overlapping reader engine count must be zero.

## Measurement Boundaries

Install page-side capture before every sample and use one page monotonic time
origin:

1. Capture the trusted activation event (`click`, `change`, or `input`).
2. `acknowledgementMs` ends at the first visible semantic busy/progress/success/
   failure state after one `requestAnimationFrame` proves paint eligibility.
3. `finalResultMs` ends at the action-specific final state. A busy/loading state
   never satisfies this boundary.

Activation starts on missing-format badge activation for the choice surface,
file-input `change` after local selection, candidate confirmation `click` for
association, confirmation-button `click` for detach/delete/reconcile, search
`input`, or present-format badge activation for open/switch. Final add/associate
state includes the originating badge changing from `Add` to its percentage and
the updated one-card inventory; final filter state includes updated
summary/cards; final open/switch state includes the selected badge/control state
and visible first EPUB iframe content or PDF canvas.

Node-side timers around Playwright actions are diagnostic only and cannot
establish either acceptance interval.

## Closed Acknowledgement Matrix

The acknowledgement denominator is exactly these 14 branches; no
implementation-selected subset is permitted:

| Action                       | Success/expected-result branch     | Failure branch                               |
| ---------------------------- | ---------------------------------- | -------------------------------------------- |
| Add local from missing badge | valid opposite-format source       | corrupt or unsupported source                |
| Associate from missing badge | compatible standalone entry        | stale or occupied-format conflict            |
| Detach variant               | durable standalone result          | injected storage transaction failure         |
| Delete variant               | durable sibling-preserving result  | injected storage transaction failure         |
| Reconcile membership         | valid explicit child resolution    | stale-head rejection                         |
| Replace source               | exact verified replacement         | identity, size, or detected-format mismatch  |
| Restore conflict handling    | complete canonical conflict report | malformed archive or stale-library precommit |

Each branch uses its contract-defined activation event and first painted
busy/progress/success/failure state. Cancellation remains covered by functional
and recovery matrices but is not substituted for any injected-failure branch.

## Profile Drivers and Build Prerequisites

- `performance-desktop-web` uses the lockfile-installed Playwright Chromium
  through `apps/omnia-reader-e2e/performance/run-desktop-web.mjs`.
- `performance-mobile-web` uses the pinned AVD snapshot and its exact Chrome
  package through `apps/omnia-reader-e2e/performance/run-mobile-web.mjs`.
- `performance-packaged-desktop` first creates the release Tauri package, then
  drives that package through
  `apps/omnia-reader-e2e/performance/run-packaged-desktop.mjs`.
- `performance-android` first creates and installs a release APK on the pinned
  AVD, then drives its WebView through
  `apps/omnia-reader-e2e/performance/run-android.mjs`.

Each driver validates its own environment and writes the same raw-result schema.
The existing Chromium Playwright command cannot establish mobile-web, packaged-
desktop, or Android evidence. Release artifact path and digest are part of the
packaged profile preflight, so a debug build or an artifact built after preflight
cannot pass.

## Environment Preflight and Results

Preflight validates the profile ID, profile-set digest, dataset hashes, CPU and
memory limits, OS/kernel, power mode, runtime/package versions, viewport/device
scale, and AVD snapshot before sampling. Any mismatch fails closed.
Primary evidence also requires a clean Git worktree at the recorded commit; a
dirty tree may be sampled only as `SUPPLEMENTAL` and cannot establish SC-004.

Raw results are stored at:

```text
specs/001-multi-format-books/performance/results/
  <UTC-date>-<git-sha>-<profile-id>.json
```

Each result records profile identity, Git SHA/dirty state, exact command,
environment/runtime values, fixture hashes, every raw timing, p50/p95/max,
within-target ratio, error/wrong-result counts, and one of `PASS`, `FAIL`,
`UNVERIFIED`, or `SUPPLEMENTAL`. SC-004 passes only when all four primary
profiles are `PASS`.

- `PASS`: the exact clean primary profile passed preflight and every threshold
  and zero-tolerance condition.
- `FAIL`: the exact clean primary profile passed preflight but at least one
  threshold, required branch/sample, or zero-tolerance condition failed.
- `UNVERIFIED`: the named primary environment/runtime/artifact was unavailable
  or could not match preflight, so no acceptance sample was claimed.
- `SUPPLEMENTAL`: the run used a dirty tree, faster/unconstrained hardware,
  emulation/throttling in place of the named environment, or another deliberate
  non-primary configuration.
