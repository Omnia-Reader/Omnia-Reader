# Tasks: Targeted Reading-State Synchronization

- [x] T001 Record the eligibility, request budget, checkpoint invalidation, and complete-fallback contract.
- [x] T002 Add failing operation-dispatch, stale-checkpoint, unsupported-operation, and debounce tests.
- [x] T003 Add failing exact-record request-count tests for progress, bookmarks, and annotations.
- [x] T004 Implement targeted reading-state coordination and GitHub-only trusted dispatch in `libs/sync/core`.
- [x] T005 Implement exact-operation synchronization in progress, bookmark, and annotation services.
- [x] T006 Reduce highlight/bookmark trailing debounce to 150 ms while retaining one second for progress.
- [x] T007 Remove the redundant GitHub provider content read and cover optimistic conflict behavior.
- [x] T008 Run full affected tests, lint, production builds, formatting, and diff checks.
- [x] T009 Perform repository-specific synchronization risk review and resolve actionable findings.
- [x] T010 Record browser/live-provider gates and commit the narrow change.

## Verification Evidence

- `npx nx test sync-core --skip-nx-cache`: 21 files, 162 tests passed.
- `npx nx test sync-gateway --skip-nx-cache`: 8 files, 116 passed and 1 optional Redis test skipped.
- Focused `omnia-reader` composition test: 1 passed.
- `npx nx run-many -t lint -p sync-core sync-gateway omnia-reader --skip-nx-cache`: passed.
- Production `omnia-reader` and `sync-gateway` builds: passed with application bundle budgets enforced.
- Chromium sync journey: unavailable because the repository Nx configuration reports a recursive `sync-gateway:serve:development -> omnia-reader-e2e:e2e` invocation before Playwright starts.
- Live credentialed GitHub timing, Firefox/WebKit, packaged Tauri, emulator, and physical-device gates: not run.
- Review finding resolved: targeted services now refresh the exact current local record before publishing, preventing a newer edit that arrives after the captured journal batch from being temporarily overwritten by an older payload.
