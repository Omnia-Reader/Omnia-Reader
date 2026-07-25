---
name: develop-omnia-reader
description: Implement scoped features, fixes, and refactors in the Omnia Reader Angular 22 and Nx 23 workspace. Use for work in the application shell, feature UI, platform adapters, reader-neutral libraries, Tauri host, or changes spanning several projects. Use change-reader-engine when EPUB or PDF rendering dominates, change-offline-sync for persistence or synchronization work, and verify-omnia-reader before declaring completion.
---

# Develop Omnia Reader

Deliver a narrow, tested change without weakening the reader's offline-first,
cross-platform, or content-security boundaries.

## Establish context

1. Read the applicable `AGENTS.md` and the exact request, failure, or artifact.
2. Inspect `git status --short`; preserve unrelated and uncommitted work.
3. If `.codegraph/` exists, use CodeGraph before text search or file-by-file
   reading. Trace the affected symbols and their callers.
4. Use Nx project information to identify owners, targets, and dependency
   impact. Use current framework documentation for version-sensitive APIs.
5. Read [references/architecture-map.md](references/architecture-map.md).
6. Read `docs/universal-reader-plan.md` when the task changes architecture,
   product scope, a release gate, or an implementation-status claim.

## Choose the owning layer

- Put format-neutral records and behavior in `libs/reader/domain`.
- Put format-neutral engine contracts and registry behavior in
  `libs/reader/core`.
- Put browser persistence and backup behavior in `libs/library/data-access`.
- Put host-specific behavior behind `libs/platform`.
- Keep EPUB and PDF implementation details in their engine libraries.
- Keep orchestration and user-visible state in `apps/omnia-reader`.
- Keep provider-neutral synchronization in `libs/sync/core`, provider clients
  in `libs/sync/git` or `libs/sync/mega`, and secrets in `apps/sync-gateway`.
- Keep privileged native operations in narrow Tauri commands. Do not expose a
  general filesystem or shell surface to the webview.
- Do not hand-edit generated output under `dist/`, coverage, Nx caches, or
  `src-tauri/gen/` unless the task explicitly targets generated platform
  output.

Respect the tag constraints in `eslint.config.mjs` and import libraries through
their public `src/index.ts` entry points.

## Implement

1. State the behavior and invariants that must remain true.
2. Make the smallest coherent change in the owning layer.
3. Follow local Angular standalone and dependency-injection patterns. Prefer
   accessible native semantics, explicit labels, keyboard behavior, and
   user-visible state assertions.
4. Keep local reading available when optional synchronization is unavailable.
5. Add or update colocated `*.spec.ts` tests for new branches. Add Playwright
   coverage when a user journey, browser integration, offline behavior, or
   renderer interaction changes.
6. Update contracts or the development plan only when behavior or verified
   project status materially changes.

Do not add or upgrade dependencies unless the request requires it. Verify any
new library API against current primary documentation and preserve the locked
dependency set.

## Verify and hand off

Use `$verify-omnia-reader` or follow its change matrix. Run focused checks first,
then broader gates in proportion to impact. Report the exact commands and
separate verified results from unavailable browser, native, credentialed, or
physical-device gates.
