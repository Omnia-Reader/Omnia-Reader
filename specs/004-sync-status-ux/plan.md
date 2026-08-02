# Implementation Plan: Truthful Sync Status and Recovery

**Feature Directory**: `004-sync-status-ux` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-sync-status-ux/spec.md`

## Summary

Repair the Octokit pagination regression by preserving buffered response metadata and consuming the official pagination plugin's normalized array contract. Add a device-local, schema-validated remembered GitHub destination to the existing gateway client. Introduce one application-owned connection-readiness service used by navigation and both Settings surfaces, while leaving scheduler activity in `sync/core`. Detailed Settings restores a remembered destination or the only unambiguous writable repository and publishes readiness changes through the shared service.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: Existing Angular signals/DI, Octokit 5.0.5, GitHub gateway client, auto-sync scheduler; no new dependency

**Storage**: Existing encrypted gateway session store plus one bounded versioned localStorage preference containing repository ID and display name

**Testing**: Vitest gateway/client tests; Angular component/service tests; focused Playwright Chromium journey

**Target platforms**: Web/PWA and Tauri webviews; provider journey validated in Chromium

**Performance goals**: One bounded readiness refresh per initialization or explicit provider-state notification; no polling; no additional provider request when the selected session is already ready

**Constraints**: Offline-first, gateway-only credentials, advisory local destination memory, accessible status, stale-response suppression, locked dependencies

**Scope**: GitHub repository discovery and restoration; provider-neutral readiness presentation for GitHub and MEGA; navigation and Settings UI. Reader engines, library storage, remote record layout, and LFS transfers are unchanged.

## Constitution Check

_GATE: Passed before research and after design._

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, storage, and request effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `GitHubSyncGatewayAdapter.githubPaginated`, `GitHubGatewayClient.session/selectRepository/disconnect`, `SyncSettingsPageComponent.refreshProvider`, `NavigationComponent.syncStatusLabel`, `SettingsPageComponent`.
- **Current callers/tests**: Gateway adapter routes and 45 adapter tests; application configuration and sync Settings use the GitHub client; navigation has a colocated component suite; Settings and sync Settings have colocated suites; `apps/omnia-reader-e2e/src/sync.spec.ts` owns browser sync journeys.
- **Owning projects**: `sync-gateway`, `sync-git`, `omnia-reader`, `omnia-reader-e2e`.
- **Affected consumers**: Angular application consumes the public GitHub gateway contract; navigation and both Settings routes consume the new application readiness service.
- **Unchanged boundaries**: `sync/core` scheduler result semantics, provider credentials, remote documents, Git LFS, MEGA gateway protocol, library persistence, and reader engines.

### Repository Paths

```text
apps/sync-gateway/src/github-adapter.ts
apps/sync-gateway/src/github-adapter.spec.ts
libs/sync/git/src/lib/github-gateway-client.ts
libs/sync/git/src/lib/github-gateway-client.spec.ts
apps/omnia-reader/src/app/sync-connection-status.service.ts
apps/omnia-reader/src/app/sync-connection-status.service.spec.ts
apps/omnia-reader/src/app/navigation/
apps/omnia-reader/src/app/features/settings/
apps/omnia-reader-e2e/src/sync.spec.ts
```

## Design

### Contracts and State

- Octokit pagination yields normalized arrays for wrapped `total_count` results. The buffered fetch response preserves its provider URL so pagination can derive a next page safely.
- `GitHubGatewayClient` remembers only `{ schemaVersion: 1, repository: { id, fullName } }`; reads validate size, identifier, and name. Session and selection responses refresh this preference. Disconnect clears it.
- `SyncConnectionStatusService` exposes `local-only`, `checking`, `gateway-unavailable`, `provider-unconfigured`, `authorization-required`, `destination-required`, and `ready` states with provider/account/destination summaries. A monotonically increasing refresh ID drops stale completions.
- Scheduler activity remains separate. Presentation reports scheduler success only when connection readiness is `ready`.

### User Interface and Accessibility

- Navigation renders state-specific labels: Set up sync, Checking sync, Connect GitHub/MEGA, Choose repository/folder, Sync unavailable, Sync ready, Syncing, or Synced.
- Main Settings summarizes provider, account, destination, pending/readiness state, and changes the action from Configure to Continue setup or Manage sync.
- Detailed Settings retains its existing stepper, does not render authorization actions for authenticated sessions, and explains automatic restoration.
- Status uses text plus icon/color, a descriptive title and accessible name, polite announcements, and no forced focus movement.

### Security and Failure Handling

- Browser storage never receives credentials or reusable session material. Remembered repository data is bounded, schema-validated, and reauthorized server-side before restoration.
- Invalid, inaccessible, or non-writable remembered destinations are cleared or ignored and fall back to explicit selection.
- Gateway errors preserve local use and do not render a historical success as current readiness.

### Lifecycle and Performance

- Readiness refreshes are event-driven. Overlapping requests use last-refresh-wins semantics; destroyed navigation cannot apply late results.
- No interval, worker, object URL, or global listener is introduced. Existing provider and scheduler subscriptions are released.
- Application and gateway production builds enforce bundle constraints.

## Verification Plan

| Requirement/story | Evidence | Command or environment | Required locally? |
| ----------------- | -------- | ---------------------- | ----------------- |
| FR-001 / US1 | Wrapped pagination and URL preservation regression | `npx nx test sync-gateway --skip-nx-cache` | Yes |
| FR-006–FR-010 / US1 | Remember, restore, reject, clear client preference | `npx nx test sync-git --skip-nx-cache` | Yes |
| FR-002–FR-005 / US2 | Readiness service and navigation/settings state matrix | Focused `npx nx test omnia-reader --skip-nx-cache --include=...` | Yes |
| US1–US3 | Browser-visible recovery and consistent labels | `npx nx run omnia-reader-e2e:e2e -- --project=chromium apps/omnia-reader-e2e/src/sync.spec.ts` | Yes |
| TypeScript boundaries | Affected lint | `npx nx lint sync-gateway --skip-nx-cache`; `npx nx lint sync-git --skip-nx-cache`; `npx nx lint omnia-reader --skip-nx-cache` | Yes |
| Bundle/runtime | Production builds | `npx nx build sync-gateway --configuration production --skip-nx-cache`; `npx nx build omnia-reader --configuration production --skip-nx-cache` | Yes |
| Live provider | Current configured GitHub App repository discovery | Browser/gateway live probe | When credentialed session is available |
| Formatting | Whitespace and formatting | Prettier intentional paths; `git diff --check` | Yes |

## Delivery and Documentation

- **Vertical slices**: Fix repository discovery; add durable restoration; add shared truthful status; enrich Settings; browser validate.
- **Migration/rollout**: Preference is additive and optional. Existing sessions work unchanged; malformed preference is ignored.
- **Documentation**: Update the gateway contract only for the buffered pagination correction and device-side recovery behavior. No product-plan status change.
- **Residual gates**: Firefox/WebKit, packaged native, emulator, physical device, provider quota, and Redis HA are outside this focused local gate.

## Complexity and Exceptions

No constitution exception is required.
