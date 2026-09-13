# Stress validation — 2026-09-13

Environment: Node v26.5.0, existing locked dependencies, Linux development
checkout. Pre-existing reader, E2E, and Codex configuration edits were preserved.
No commits, publishing, dependencies, schemas, or native changes.

## Reproduced and fixed

1. A rejected `findLogicalBookByVariant` after successful enrichment reached
   validation rollback: the local book was removed while the result still
   contained it in `added`. The optional sync metadata read now fails without
   deleting the successfully imported local publication. The regression also
   imports the same source again and verifies duplicate classification.
2. A throwing import observer rejected a completed import and prevented later
   observers from being notified. Notifications now isolate synchronous observer
   failures. Existing validation rollback tests continue to pass.
3. Logical-card sorting rebuilt records and temporary arrays twice per comparison.
   Sort records are now computed once per matching card per selection, with no
   persistent cache or stale-data risk. A 10,000-card test verifies all four sort
   modes, search, and unchanged input ordering against the existing book selector.

## Exact commands and results

- `NX_DAEMON=false npx nx run-many -t test -p omnia-reader,reader-domain,reader-core,reader-epub,reader-pdf,library-data-access,platform,sync-core,sync-git,sync-mega,sync-gateway --parallel=2 --skip-nx-cache`
  — ten library/gateway projects passed 599 tests, with two gateway tests skipped.
  The app picked up the newly added fault-injection tests while this command was
  running and failed those two expected regressions (194 others passed).
- `NX_DAEMON=false npx nx test omnia-reader --include='**/publication-import.service.spec.ts' --skip-nx-cache`
  — before implementation: 2 failed, 10 passed, reproducing both faults.
- `NX_DAEMON=false npx nx test omnia-reader --skip-nx-cache`
  — after implementation: 23 files, 197 tests passed. The first attempt caught a
  template-literal ID type error in the new stress fixture; corrected before rerun.
- `NX_DAEMON=false npx nx lint omnia-reader` — passed.
- `NX_DAEMON=false npx nx build omnia-reader --configuration production`
  — passed, initial bundle 432.48 kB, EPUB and PDF remain lazy chunks.
- `node specs/016-library-stress-regressions/benchmark.mjs /tmp/omnia-library-view-before.ts`
  — nine measured samples after three warmups, alternating old/new order, no
  other task validation running. Median 159.05 ms before and 60.98 ms after,
  approximately 62% less time. Raw samples are in `benchmark-results.json`.
  The baseline was copied from the unmodified library-view.ts before editing.
  This measures Node sorting CPU time, not browser rendering or native performance.

- `FIREFOX_E2E=1 PLAYWRIGHT_HTML_OPEN=never npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts example.spec.ts --grep 'filters, sorts|reports exact-edition duplicate' --workers=1`
  — 6 passed in 1.4 minutes: filtering/sorting/preference persistence and
  duplicate/mixed imports in Chromium, Firefox, and WebKit.
- `PERFORMANCE_E2E=1 PLAYWRIGHT_HTML_OPEN=never npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 performance.spec.ts`
  — 3 passed in 12.8 seconds: 180-page PDF virtualization and cleanup,
  80-chapter EPUB incremental rendering and cleanup, and streamed large backup.
  Existing import/open, long-task, retained-heap, canvas/iframe, and chunk-size
  budgets passed unchanged.
- `npx prettier --check` over the four changed application files and all files
  in this specification directory — passed.
- `git diff --check` — passed.

Benchmark baseline SHA-256:
`59663863737acc2028927db17b002bcd9facd1bbfe341be928cc4f936e15845c`.
Changed module SHA-256:
`2f0daec60763b3a5cad50769a3d4e8968553ceef8dda9ad8eec095f687943bcc`.

## Review and boundaries

Focused review checked that sorting still uses exactly the same keys and
comparators, retains card identity, and creates no long-lived cache. Import
changes leave malformed-file cleanup and existing-duplicate protection intact.
Optional sync metadata failure can still delay synchronization; this fix proves
local preservation, not remote recovery or convergence under storage outages.
Observer isolation covers synchronous exceptions, matching the callback contract.

Live providers, Redis HA, installed PWA, packaged desktop, Android/emulators, and
physical devices were not exercised. This is a bounded stress pass, not evidence
that every feature or platform is free of defects.
