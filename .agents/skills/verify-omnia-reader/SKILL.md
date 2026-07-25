---
name: verify-omnia-reader
description: Select and run evidence-based validation for Omnia Reader changes. Use after implementation, before handoff or pull request, when reproducing a failure, or when deciding which Nx, Vitest, Playwright, PWA, gateway, Tauri, Rust, C++, formatting, security, and build checks are required by a changed area.
---

# Verify Omnia Reader

Run the smallest suite that truthfully proves the change, then expand for
cross-project or release risk.

## Determine impact

1. Inspect `git status --short` and the relevant diff without modifying it.
2. Use CodeGraph blast radius and Nx project dependencies for source changes.
3. Map each touched area through
   [references/change-matrix.md](references/change-matrix.md).
4. Include tests for changed public APIs and all affected consumers, not only
   the project containing the edited file.

## Run checks

1. Run the closest focused unit test or project test first.
2. Run lint for every affected TypeScript project.
3. Run a production build when application code, lazy loading, worker/assets,
   service-worker configuration, styles, dependencies, or bundle composition
   changes.
4. Run Playwright when behavior depends on a real browser, renderer, worker,
   iframe, canvas, IndexedDB/OPFS, drag/drop, service worker, or navigation
   journey.
5. Run native, container, credentialed, or physical-device gates only when
   relevant and available. Never replace them with a weaker check while
   claiming equivalent coverage.
6. Run `git diff --check` after file edits.

Use Node from `.nvmrc` and the locked dependency set. Do not repair unrelated
working-tree changes or rewrite caches to make validation appear clean.

## Interpret results

- Distinguish a new regression from a pre-existing or environment-only failure
  with focused evidence.
- Treat bundle budgets, security checks, schema migration tests, and offline
  tests as gates, not informational output.
- Record skipped tests and unavailable browsers, credentials, native
  toolchains, emulators, or devices.
- Report exact commands, pass/fail counts when available, and the unverified
  boundary. Do not say "all tests pass" after running only a focused subset.
