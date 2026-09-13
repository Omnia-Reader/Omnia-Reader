# Review-fix validation

## Changes

- Reader editor revisions invalidate queued formatting and autosave work after
  a context change. Older saves may finish persistence but cannot replace or
  close a newer editor. Pending note timers are cleared when editing another
  annotation.
- PDF helper waits require a new annotation ID, the requested page and style;
  multiple rectangles are accepted.
- Native error capture takes the screenshot first, then collects passive page
  metadata. It no longer imports the application entry point a second time.

## Evidence

- Regression-first reader test failed for the stale queued style action before
  the revision guard. Final focused reader test: 2 passed.
- `NX_DAEMON=false npx nx test omnia-reader --skip-nx-cache`: 197 passed in
  23 files. Covers unchanged-context formatting, cancel, selection replacement,
  reopening, annotation switching, delayed save completion and destruction.
- `NX_DAEMON=false npx nx run-many -t lint -p omnia-reader,omnia-reader-e2e`:
  both projects passed.
- `NX_DAEMON=false npx nx build omnia-reader --configuration production`:
  passed, including bundle budgets.
- `FIREFOX_E2E=1 PLAYWRIGHT_HTML_OPEN=never npx playwright test --config
apps/omnia-reader-e2e/playwright.config.ts --workers=1
reader-state-helpers.spec.ts native-failure-diagnostics.spec.ts`:
  12 passed across Chromium, Firefox and WebKit. Includes stale mark rejection,
  multiple rectangles, screenshot ordering, unchanged app bootstrap count and
  DOM, and diagnostic failure handling.
- `node --check` passed for both native diagnostic modules.
- `FIREFOX_E2E=1 PLAYWRIGHT_HTML_OPEN=never npx playwright test --config
apps/omnia-reader-e2e/playwright.config.ts --workers=1 example.spec.ts
accessibility.spec.ts epub-selection.spec.ts --grep 'imports, reads, and
resumes a PDF|imports an EPUB, navigates chapters|exports and restores a
complete portable library backup|PDF reader shell has no|keeps a highlight
while underlining'`: 15 passed across Chromium, Firefox and WebKit.
- Prettier check passed for all files changed for these fixes.
- `git diff --check`: passed. Final review found no remaining actionable issue
  among the three findings. The user subsequently authorized committing the
  reviewed changes, excluding personal Codex configuration.

Packaged Tauri/WebDriver execution was not run. Passive diagnostic JavaScript
was exercised in real browsers through a WebDriver-shaped adapter; this is not
packaged-native acceptance. No native host, persistence schema or sync provider
implementation changed.
