# Quickstart: Validate Re-import of Deleted Books

## Prerequisites

- Use Node v26.5.0 from `.nvmrc` and the locked dependency set.
- Preserve unrelated worktree changes, especially the existing logical-book synchronization edits.

## Focused validation

```sh
npx nx test library-data-access --skip-nx-cache
npx nx test omnia-reader --skip-nx-cache
npx nx lint library-data-access --skip-nx-cache
npx nx lint omnia-reader --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
git diff --check
```

## Expected outcomes

- Importing exact bytes for an ownerless retained record repairs one visible logical entry and reports it as added.
- Importing an already visible exact edition remains a duplicate.
- Deletion exclusions are applied before repository deletion, rolled back on failure, and retained when journaling is unavailable.
- Successful re-import or variant creation restores synchronization eligibility.
- No IndexedDB schema version, synchronized path, browser interaction, or native contract changes.
