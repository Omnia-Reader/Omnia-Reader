# Quickstart: Validate Draggable Book Progress

## Prerequisites

- Use Node v26.5.0 from `.nvmrc` and the locked dependencies.
- Run from the repository root.

## Focused unit evidence

```bash
npx nx test omnia-reader --skip-nx-cache
```

Expected: rapid slider input starts before change/release, direct rail clicks map to their in-between percentage, renderer seeks never overlap, the final input wins, and milestones are Beginning, Preface, Chapter One, Chapter Two for the standard fixture model.

## Focused browser evidence

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npx playwright test --config apps/omnia-reader-e2e/playwright.config.ts --project=chromium --workers=1 --grep "scrubs and exposes every top-level milestone" apps/omnia-reader-e2e/src/example.spec.ts
```

Expected: the publication moves during input, forward and backward clicks land between adjacent milestones in persisted progression, the final reverse value wins, Beginning goes to 0, Preface remains visible, and all authored top-level entries navigate.

## Quality gates

```bash
npx nx lint omnia-reader --skip-nx-cache
npx nx lint omnia-reader-e2e --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
git diff --check
```

Run the focused Firefox and WebKit journey when their browser binaries are available; report an unavailable gate explicitly.
