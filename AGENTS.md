# Repository Guidelines

## Project Structure & Module Organization

This is an Nx workspace containing an Angular EPUB reader. Application code lives in `apps/omnia-reader/src`; routes and the application shell are under `app/`, while feature UI belongs in focused folders such as `app/components/viewer/` and `app/navigation/`. Keep unit tests beside their subjects as `*.spec.ts`. Static files that should be copied unchanged belong in `apps/omnia-reader/public/`, and global styles live in `src/styles.scss`. Playwright tests and configuration are in `apps/omnia-reader-e2e/`. Generated build, coverage, and Nx cache output must remain untracked.

## Build, Test, and Development Commands

Use Node `v26.5.0` from `.nvmrc`, then install the locked dependency set with `npm ci`.

- `npm start` serves the development app at `http://localhost:4300`.
- `npx nx build omnia-reader` creates a production build in `dist/apps/omnia-reader/` and enforces configured bundle budgets.
- `npx nx test omnia-reader` runs Angular unit tests with Vitest.
- `npx nx lint omnia-reader` checks application TypeScript with ESLint.
- `npx nx e2e omnia-reader-e2e` starts the dependent app and runs Playwright browser tests.
- `npx nx graph` displays project and target dependencies.

## Coding Style & Naming Conventions

Follow `.editorconfig`: UTF-8, two-space indentation, final newlines, and no trailing whitespace. Prettier is configured for single-quoted strings; format changed files with `npx prettier --write <paths>`. ESLint also enforces Nx module boundaries. Use Angular standalone components and dependency injection patterns already present in the app. Name classes and interfaces in `PascalCase`, methods and variables in `camelCase`, and selectors with the `omnia-` prefix. Keep templates and SCSS beside their component.

## Testing Guidelines

Add or update a colocated `*.spec.ts` for behavioral changes. Prefer user-visible assertions and isolate file parsing or browser APIs where practical. Put end-to-end journeys in `apps/omnia-reader-e2e/src/*.spec.ts`. No coverage minimum is currently configured; nevertheless, new parsing, navigation, and error-handling branches should receive focused tests. Run unit tests and lint before opening a pull request, plus Playwright when UI flows change.

## Commit & Pull Request Guidelines

Recent history uses concise, task-focused subjects such as `EPUB Render (init)` and `Viewer routerLink`; keep each commit narrow and describe the outcome in the imperative mood. Pull requests should explain the change, list verification commands, and link any relevant issue. Include screenshots or a short recording for visual changes, and call out bundle-size, accessibility, or EPUB compatibility impacts.
