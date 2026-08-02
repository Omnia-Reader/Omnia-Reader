# Tasks: Low-Latency Local-First Synchronization

## Implementation

- [x] T001 Record the local/desktop/mobile topology and revision-polling boundary in the specification and plan.
- [x] T002 Implement a two-second trailing progress debounce, preserve the separate interactive mutation budget, and remove the five-minute successful-sync floor.
- [x] T003 Implement visible, online, Git-only revision polling.
- [x] T004 Reduce the revision interval to ten seconds for low remote-change latency.
- [x] T005 Remove persisted last-periodic scheduling state while preserving provider `Retry-After` persistence.
- [x] T006 Remove the GitHub push broker, SSE route, EventSource client, selected-destination key plumbing, and associated tests.
- [x] T007 Preserve the existing authorization-revocation webhook unchanged.
- [x] T008 Update GitHub setup, gateway documentation, contracts, and research decisions.

## Verification

- [x] T009 Run focused sync-core, sync-git, and sync-gateway tests after cleanup.
- [x] T010 Run focused application composition and Sync Settings tests.
- [x] T011 Run affected lint, production builds, formatting, and `git diff --check`.
- [x] T012 Review the final diff for lifecycle, request amplification, security, and unrelated-work preservation.

## Current evidence

- `npx nx test omnia-reader --skip-nx-cache`: 22 files, 164 tests passed.
- `npx nx test sync-core --skip-nx-cache`: 21 files, 149 tests passed.
- `npx nx test sync-git --skip-nx-cache`: 4 files, 37 tests passed.
- `npx nx test sync-gateway --skip-nx-cache`: 8 files, 116 tests passed and 1 skipped.
- `npx nx test library-data-access --skip-nx-cache`: 6 files, 56 tests passed.
- `npx nx run-many -t lint --all --skip-nx-cache`: all 12 projects passed.
- `npx nx build omnia-reader --configuration production --skip-nx-cache`: production bundle and budgets passed.
- Chromium `sync.spec.ts` and `accessibility.spec.ts`: 17 tests passed and 2 provider-gated cases skipped.
- Chromium `example.spec.ts`: 12 tests passed in the complete run; the 3 repaired journeys then passed focused.
- `git diff --check`: passed.

## Completion boundaries

- Local reading remains authoritative and independent of network success.
- Unchanged periodic checks cost one revision request and no document/LFS work.
- Hidden, offline, stopped, and non-Git states have no revision timer.
- Existing settings visibility and efficient-reading-sync work remain preserved.
- Live GitHub, packaged Tauri, Android emulator, and physical-device gates are reported rather than inferred.
