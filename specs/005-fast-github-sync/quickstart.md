# Quickstart: Validate Fast GitHub Synchronization

## Prerequisites

```sh
nvm use
npm ci
```

Use the locked Node v26.5.0 dependency set. No GitHub credential is required for
the local contract and fake-gateway evidence.

## 1. Focused contract and behavior suites

```sh
npx nx test sync-gateway --skip-nx-cache
npx nx test sync-git --skip-nx-cache
npx nx test sync-core --skip-nx-cache
npx nx test omnia-reader --skip-nx-cache
```

Expected evidence:

- one bounded GitHub tree read produces the destination revision;
- a mutating sync performs its bounded verification internally, so the very next
  stable sync executes one revision request and no delegate worker;
- a fallback state pass reuses progress, bookmark, and annotation list results,
  with no individual reads for identical records and fresh reads only on
  conflict;
- GitHub list operations read provider blobs with at most eight concurrent
  requests rather than one sequential request per document;
- pending, changed, invalid, cancelled, failed, mutating, rejected, conflicted,
  and unstable cases use or preserve the complete path;
- checkpoint storage denial does not fail complete synchronization.

## 2. Real-browser fake-gateway journey

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome \
  npx nx run omnia-reader-e2e:e2e -- \
  --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts
```

After one successful sync, the immediately following repeat-sync assertion must
count exactly one revision request, no document or LFS requests, and show the
existing accessible zero-change success state.

## 3. Static and production gates

```sh
npx nx run-many -t lint -p sync-gateway sync-git sync-core omnia-reader --skip-nx-cache
npx nx build sync-gateway --configuration production --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
git diff --check
```

## 4. Optional live GitHub evidence

With a configured GitHub App and disposable selected repository, capture the
gateway/provider trace for a stable repeat sync. Confirm one revision route,
one lightweight GitHub tree request while the installation token is valid, zero
document/blob/LFS calls, zero mutations, and a successful zero-count result.

This credentialed gate is not satisfied by unit or fake-gateway tests and must be
reported unverified when credentials are unavailable.
