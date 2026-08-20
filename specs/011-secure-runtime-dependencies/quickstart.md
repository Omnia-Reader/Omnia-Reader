# Quickstart: Verify Secure Runtime Dependencies

## Prerequisites

Use Node v26.5.0 from `.nvmrc`. Start from a clean worktree except for this
feature and use the checked-in lock file.

## Resolve and inspect

```sh
npm install --package-lock-only --ignore-scripts
npm ci
npm ls pdfjs-dist fast-uri fastify fast-json-stringify ajv ajv-formats --all
npm audit --omit=dev
```

Expected: PDF.js is at least 6.2.108; every production `fast-uri` 3.x/4.x
resolution is at least 3.1.5/4.1.2; the audit reports zero vulnerabilities.

## Focused reader gates

```sh
npx nx test reader-pdf --skip-nx-cache
npx nx lint reader-pdf --skip-nx-cache
npx nx run omnia-reader-e2e:e2e -- --project=chromium --grep "encrypted PDF|interactive PDF|malformed PDF|hostile PDF|PDF document JavaScript"
npx nx run omnia-reader-e2e:e2e -- --project=webkit --grep "encrypted PDF|interactive PDF|malformed PDF|hostile PDF|PDF document JavaScript"
npx nx run omnia-reader-e2e:performance
```

Expected: existing PDF behavior, safe failure, link mediation, worker teardown,
large-document virtualization, and memory/long-task budgets pass. Record any
browser installation limitation rather than inferring a pass.

## Focused gateway gates

```sh
npx nx test sync-gateway --skip-nx-cache
npx nx lint sync-gateway --skip-nx-cache
npx nx build sync-gateway --configuration production --skip-nx-cache
```

Expected: valid provider requests remain compatible; backslash-authority,
encoded-separator, traversal, authentication, CSRF, session, rate-limit, and
redaction fixtures pass.

## Production and cross-cutting gates

```sh
npx nx lint omnia-reader-e2e --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
git diff --check
```

Inspect the build output: PDF code must remain outside the initial bundle and
the initial bundle must remain within configured budgets. Packaged desktop,
Android emulator/device, and live credentialed-provider checks remain separate
external gates when unavailable.
