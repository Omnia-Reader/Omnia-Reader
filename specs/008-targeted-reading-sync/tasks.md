# Tasks: Targeted Reading-State Synchronization

- [x] T001 Record the eligibility, request budget, checkpoint invalidation, and complete-fallback contract.
- [x] T002 Add failing operation-dispatch, stale-checkpoint, unsupported-operation, and debounce tests.
- [x] T003 Add failing exact-record request-count tests for progress, bookmarks, and annotations.
- [x] T004 Implement targeted reading-state coordination and GitHub-only trusted dispatch in `libs/sync/core`.
- [x] T005 Implement exact-operation synchronization in progress, bookmark, and annotation services.
- [x] T006 Use 50 ms for new highlight/bookmark latency and 750 ms trailing progress coalescing with bounded targeted continuation.
- [x] T007 Remove the redundant GitHub provider content read and cover optimistic conflict behavior.
- [x] T008 Run full affected tests, lint, production builds, formatting, and diff checks.
- [x] T009 Perform repository-specific synchronization risk review and resolve actionable findings.
- [x] T010 Record browser/live-provider gates and commit the narrow change.

## Verification Evidence

- `npx nx test sync-core --skip-nx-cache`: 21 files, 169 tests passed, including the 50 ms highlight budget, 750 ms trailing progress collapse, a 20-page batch producing one remote write, authoritative progress-revision reuse, destination-scoped continuation, and targeted continuation until idle reconciliation.
- `npx nx test sync-gateway --skip-nx-cache`: 8 files, 116 passed and 1 optional Redis test skipped.
- Focused `omnia-reader` composition test: 1 passed.
- `npx nx run-many -t lint -p sync-core sync-gateway omnia-reader --skip-nx-cache`: passed.
- Production `omnia-reader` and `sync-gateway` builds: passed with application bundle budgets enforced.
- Chromium sync journey: unavailable because the repository Nx configuration reports a recursive `sync-gateway:serve:development -> omnia-reader-e2e:e2e` invocation before Playwright starts.
- Live credentialed GitHub timing, Firefox/WebKit, packaged Tauri, emulator, and physical-device gates: not run.
- Review finding resolved: targeted services now refresh the exact current local record before publishing, preventing a newer edit that arrives after the captured journal batch from being temporarily overwritten by an older payload.
- Public GitHub API baseline from the development host: five sequential requests completed in 254–285 ms each. This is network evidence only, not an authenticated repository SLA.
- New highlight request envelope: one revision probe plus one optimistic create and 50 ms quiet time; no file read, prefix listing, or verification pass. At the measured baseline this is approximately 0.56–0.62 seconds before local processing.
