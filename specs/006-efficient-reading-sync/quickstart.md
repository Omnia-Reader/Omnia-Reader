# Quickstart: Validate Efficient Reading Synchronization

## Prerequisites

- Node v26.5.0 from `.nvmrc` and the locked dependency installation.
- For the real-browser gate, `/usr/bin/google-chrome` or a compatible configured Playwright Chromium executable.

## Focused behavior

```sh
npx nx test omnia-reader --skip-nx-cache --include=apps/omnia-reader/src/app/features/reader/reader-page.component.spec.ts
npx nx test sync-core --skip-nx-cache --include=libs/sync/core/src/lib/book-sync-service.spec.ts --include=libs/sync/core/src/lib/book-sync-catalog.spec.ts
```

Expected: unchanged opens append no book operation; changed metadata appends one. Current-library publication synchronization meets [request-budget.md](contracts/request-budget.md), while missing/deleted/conflicted fixtures retain their outcomes.

## Browser request journey

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome \
  npx nx run omnia-reader-e2e:e2e --skip-nx-cache -- \
  --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts
```

Expected: the fake gateway observes no immediate publication sync caused only by opening an unchanged book, and stable complete passes do not request `.omnia-reader/v1/books`.

## Required gates

```sh
npx nx run-many -t lint -p sync-core omnia-reader omnia-reader-e2e --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
git diff --check
```

Live GitHub timing and request counts require credentials and a selected test repository; record that gate as unverified unless it actually runs.
