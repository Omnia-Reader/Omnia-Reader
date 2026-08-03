# Quickstart: Verify Provider Book Filenames

## Prerequisites

Use Node v26.5.0 from `.nvmrc` and the locked dependency tree.

## Focused validation

```sh
npx nx test sync-core --skip-nx-cache
npx nx test library-data-access --skip-nx-cache
npx nx test omnia-reader --skip-nx-cache
npx nx test sync-git --skip-nx-cache
npx nx test sync-mega --skip-nx-cache
npx nx test sync-gateway --skip-nx-cache
npx nx test mega-sdk-bridge --skip-nx-cache
npx nx lint sync-core --skip-nx-cache
npx nx lint library-data-access --skip-nx-cache
npx nx lint omnia-reader --skip-nx-cache
npx nx build omnia-reader --skip-nx-cache
npx nx build sync-gateway --skip-nx-cache
git diff --check
```

Expected outcomes:

- New manifest and logical-change fixtures use the same `.omnia-reader/library/.../<original-name>` object path.
- Existing exact legacy digest-path fixtures still parse.
- Traversal and mismatched path fixtures remain rejected.
- Provider-neutral inventory and raw confined entry deletion have GitHub and MEGA adapter/client coverage.
- Valid previous-root books/state are copied and verified before cleanup; conflicts retain their source; invalid `v1` entries are removed without accepting them as current data.
- Legacy logical changes migrate to one verified `.omnia-reader/logical-books/state.json`; no current write creates `logical-books/changes/` or checkpoints.
- Stale book, variant, and preference mutations lose to compact tombstones; active remote-only variants restore from state descriptors.
- Simulated concurrent writes reread, remerge, and converge within the bounded retry while exhausted retries preserve the journal and legacy migration inputs.
- Malformed, oversized, duplicate, or internally inconsistent state is rejected without replacing local logical state.

## Focused browser regression

```sh
npx nx run omnia-reader-e2e:e2e -- --project=chromium --grep "stable repeated Git sync|deletes a synchronized publication locally"
```

Local evidence on 2026-08-02 used the installed Chrome binary because the
bundled Playwright Chromium executable was unavailable:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx playwright test --project=chromium --grep "stable repeated Git sync|deletes a synchronized publication locally"
```

Result: 2 passed. Unit results: sync-core 173, sync-gateway 117 with 1 skipped,
sync-git 38, sync-mega 10, omnia-reader 164, library-data-access 56, and
reader-domain 37. All affected lints and both production builds passed. MEGA
bridge core tests passed; the full SDK bridge build is unavailable locally
because `libcrypto++` is not installed.

Credentialed GitHub/MEGA conformance remains a separate gate.

## Bounded cleanup regression evidence

Validated on 2026-08-03 after replacing per-entry cleanup with one bounded
batch request:

- `npx nx test sync-core --skip-nx-cache`: 173 passed.
- `npx nx test sync-git --skip-nx-cache`: 38 passed.
- `npx nx test sync-mega --skip-nx-cache`: 10 passed.
- `npx nx test sync-gateway --skip-nx-cache`: 120 passed, 1 optional test skipped.
- Affected lint for `sync-core`, `sync-git`, `sync-mega`, `sync-gateway`,
  `omnia-reader`, and `omnia-reader-e2e`: passed.
- Production builds for `omnia-reader` and `sync-gateway`: passed.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx playwright test --project=chromium --grep "stable repeated Git sync"`
  from `apps/omnia-reader-e2e`: 1 passed. The fixture proves two previous-root
  entries are removed by one `DELETE /entries` request before the unchanged
  revision fast path.
- `git diff --check`: passed.

After reproducing a real upgrade that still skipped cleanup, the change-aware
checkpoint schema was advanced from 2 to 3. Final regression evidence:

- `npx nx test sync-core --skip-nx-cache`: 182 passed, including rejection of a persisted schema-2 checkpoint.
- The focused Chromium journey was seeded with a matching schema-2 Git revision; it performed the migration, retained only `logical-books/state.json`, stored schema 3, and then completed the next unchanged sync with one revision request: 1 passed.
- The final production rebuild passed with a 386.50 kB initial bundle (85.97 kB estimated transfer).

The review also verified GitHub branch/revision conflict preservation, one
atomic tree commit including `.gitattributes` reconciliation, and MEGA
duplicate-node revision validation before removal. Live credentialed GitHub and
MEGA behavior remains an external gate.

## Canonical logical-state regression evidence

Validated on 2026-08-03 after replacing append-only logical changes and the
unused checkpoint scaffold with one canonical state document:

- `npx nx test sync-core --skip-nx-cache`: 182 passed across 22 files.
- `npx nx run-many -t test -p sync-core sync-git sync-mega omnia-reader --skip-nx-cache`: sync-core 181 at that run, sync-git 38, sync-mega 10, and omnia-reader 164 passed; the final focused sync-core rerun contains the added local-seed test and totals 182.
- `npx nx run-many -t lint -p sync-core sync-git sync-mega omnia-reader --skip-nx-cache`: passed; final `sync-core` and `omnia-reader-e2e` lint reruns passed.
- `npx nx build omnia-reader --configuration production --skip-nx-cache`: passed with a 386.50 kB initial bundle (86.00 kB estimated transfer).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx playwright test --project=chromium --grep "stable repeated Git sync"` from `apps/omnia-reader-e2e`: 1 passed. The fixture observes only `.omnia-reader/logical-books/state.json` beneath the logical-books subtree and the unchanged revision fast path performs one revision request.
- `git diff --check`: passed.

The initial Nx-wrapped focused E2E command was unavailable because its configured
gateway serve dependency recursively invoked the same E2E target; the direct
repository Playwright command above exercised and passed the intended Chromium
journey. Live credentialed GitHub/MEGA, Firefox/WebKit, packaged Tauri, Android
emulator, and physical-device behavior remain external gates.
