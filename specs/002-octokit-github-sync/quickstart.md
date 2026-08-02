# Quickstart: Validate Octokit GitHub Synchronization

## Prerequisites

- Use Node from `.nvmrc` (`v26.5.0`).
- Install the locked dependency set.
- No live GitHub credentials are required for local fake-provider verification.

## Focused validation

```sh
npx nx test sync-gateway --skip-nx-cache
npx nx lint sync-gateway --skip-nx-cache
npx nx build sync-gateway --configuration production --skip-nx-cache
npm audit --omit=dev
git diff --check
```

Expected outcomes:

- Adapter tests cover authorization, refresh races, revocation, repository creation and discovery, document operations, rate limits, timeouts, and unchanged Git LFS behavior.
- Lint and the production gateway build pass using the locked Octokit dependency.
- The production dependency audit reports no unresolved vulnerability that blocks delivery.
- No formatting errors or whitespace defects remain in intentional changes.

## Credentialed release gate

With a disposable configured GitHub App, exercise authorization, repository creation or selection, document synchronization, publication upload/download, disconnect, and reconnect through `npm run start:full`. Record this separately; local fake-provider tests do not prove live GitHub conformance.
