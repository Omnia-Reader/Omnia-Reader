# Review checklist

## Architecture and Nx

- Is behavior in the lowest owning project and exported through a public entry
  point?
- Do project tags and dependency direction remain valid?
- Did a shared API change update all callers and affected tests?
- Did renderer or gateway dependencies leak into the application shell?

## Angular and user experience

- Are loading, empty, error, retry, and cancellation states reachable and
  understandable?
- Are interactive controls keyboard-operable, labelled, focus-safe, and
  semantically appropriate?
- Does back/Escape behavior close transient UI before navigating?
- Are asynchronous state changes and listener cleanup deterministic?

## EPUB and PDF

- Are locators stable across reopen, resize, zoom, rotation, and direction?
- Are publication scripts, handlers, embeds, unsafe URLs, and external
  navigation contained?
- Are password and malformed-file errors handled without leaking sensitive
  values?
- Are engines, workers, object URLs, canvases, listeners, and decorations
  released?
- Does the change preserve lazy engine loading and bundle budgets?

## Persistence and backup

- Are record schemas validated on every trust-boundary read and write?
- Does a schema change include versioning, migration, valid-data preservation,
  corrupt-record quarantine, and upgrade tests?
- Are archive paths, sizes, declarations, CRC, SHA-256, and merge rules
  bounded and validated before mutation?
- Can a partial failure leave metadata without bytes or delete healthy data?

## Synchronization and gateway

- Does local persistence finish independently of network success?
- Are immutable bytes verified and published before manifests?
- Are conflicts deterministic, retries bounded, and tombstones preserved?
- Can stale remote data resurrect deleted bookmarks or annotations?
- Are credentials and reusable sessions absent from frontend state, URLs,
  documents, and logs?
- Do same-origin, CSRF, provider scope, path confinement, body limits, session
  rotation, and fail-closed configuration remain intact?

## Native surfaces

- Is privileged work behind a narrow command and minimal capability?
- Are native paths/URIs opaque to Angular and publication content?
- Is generated platform output being edited instead of its source?
- Are desktop, Android, and browser behavior differences explicitly tested or
  reported?

## Validation

- Is there a focused regression test that fails without the change?
- Is Playwright used where browser integration is the behavior?
- Are cross-browser, offline/PWA, migration, production-build, gateway,
  container, emulator, and physical-device gates included when relevant?
- Do the handoff claims match the exact commands that ran?
