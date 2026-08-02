# Quickstart: Validate Synchronization Status and Recovery

## Focused checks

```sh
npx nx test sync-gateway --skip-nx-cache
npx nx test sync-git --skip-nx-cache
npx nx test sync-core --skip-nx-cache
npx nx test omnia-reader --skip-nx-cache --include=apps/omnia-reader/src/app/sync-connection-status.service.spec.ts --include=apps/omnia-reader/src/app/navigation/navigation.component.spec.ts --include=apps/omnia-reader/src/app/features/settings/settings-page.component.spec.ts --include=apps/omnia-reader/src/app/features/settings/sync-settings-page.component.spec.ts
npx nx run omnia-reader-e2e:e2e -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts
```

## Acceptance walkthrough

1. Run `npm run start:full` with configured local GitHub App variables.
2. Open Settings and verify the summary distinguishes account and repository readiness.
3. Authorize GitHub. Repository discovery must complete without a gateway 500.
4. Select a repository, reload, and verify the toolbar and Settings name it.
5. Renew the account session and verify the remembered accessible repository is restored.
6. Remove repository access and verify the UI asks for a destination without claiming “Synced.”

## Final gates

```sh
npx nx lint sync-gateway --skip-nx-cache
npx nx lint sync-git --skip-nx-cache
npx nx lint sync-core --skip-nx-cache
npx nx lint omnia-reader --skip-nx-cache
npx nx build sync-gateway --configuration production --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
git diff --check
```
