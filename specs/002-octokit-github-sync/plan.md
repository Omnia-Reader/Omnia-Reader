# Implementation Plan: Octokit GitHub Synchronization

**Feature Directory**: `002-octokit-github-sync` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-octokit-github-sync/spec.md`

## Summary

Replace application-owned GitHub REST, pagination, App JWT, installation-token, OAuth exchange/refresh, and token-revocation requests in `GitHubSyncGatewayAdapter` with the published `octokit` SDK. Keep the existing adapter, encrypted session lifecycle, safe error translation, explicit timeout behavior, and custom Git LFS transport. Use Octokit's provider-aware retry and throttling for safely replayable operations, prevent ambiguous replay of single-use and non-idempotent operations, and return unresolved limits to the existing scheduler contract.

## Technical Context

**Runtime**: Node v26.5.0; TypeScript 6.0.3; Nx 23.1.0; Fastify 5.10.0

**Primary dependencies**: New runtime dependency `octokit`; existing Fastify, Node fetch/streams, and gateway contracts

**Storage**: Existing encrypted memory, file, or Redis session envelopes; no schema change

**Testing**: Vitest through `npx nx test sync-gateway`; ESLint; production Nx build; fake provider fetch remains injectable

**Target platforms**: Node-hosted same-origin sync gateway used by web/PWA and Tauri clients

**Performance goals**: No buffering of publication streams; repository enumeration remains bounded to 10,000 documents; provider deadlines remain 60 seconds by default and separately bounded for LFS transfers

**Constraints**: Offline-first, credentials gateway-only, provider inputs hostile, explicit error mapping, bounded provider-aware retry, mutation replay safety, locked npm dependency set

**Scope**: `apps/sync-gateway`, root dependency metadata, sync gateway documentation, and feature artifacts; no Angular, reader, sync-core, sync-git, MEGA, or native implementation changes

## Constitution Check

_GATE: Passed before research and re-checked after design._

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged, or the approved scope change is documented.

No exceptions are required.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `GitHubSyncGatewayAdapter`, `GitHubAdapterOptions`, `githubJson`, `githubPaginated`, `appJwt`, `repositoryContext`, `exchangeAuthorizationCode`, `refreshUserToken`, `revokeUserAccessToken`, and `providerHttpError` in `apps/sync-gateway/src/github-adapter.ts`.
- **Owning project(s)**: `sync-gateway`.
- **Affected consumers**: gateway route registration and configuration instantiate the adapter without public API changes; `apps/sync-gateway/src/github-adapter.spec.ts` covers authentication, repositories, documents, LFS, errors, and deadlines.
- **Unchanged boundaries**: Angular same-origin client, sync provider contracts, durable sync records, Git LFS pointer format, MEGA adapter, reader engines, PWA, and Tauri hosts.

### Repository Paths

```text
apps/sync-gateway/src/github-adapter.ts       # GitHub provider integration
apps/sync-gateway/src/github-adapter.spec.ts  # provider contract and failure tests
package.json                                  # octokit runtime dependency
package-lock.json                             # locked dependency graph
docs/sync-gateway-api.md                      # implementation and operational contract
specs/002-octokit-github-sync/                # intent, design, tasks, and evidence
```

## Design

### Contracts and State

- Preserve `SyncGatewayAdapter`, all gateway routes, `GitHubAdapterOptions`, `GitHubSessionState`, session serialization, and public response shapes.
- Construct Octokit clients inside the adapter using the configured API base URL, user agent, injected fetch, API version, and request deadline.
- Use token-authenticated Octokit instances for user and installation REST requests. Use Octokit GitHub App authentication for app JWT and repository-scoped installation tokens.
- Keep Omnia's encrypted installation token fields and refresh margin so existing sessions and race behavior remain stable.
- No durable record, session envelope, route, synchronized document, or remote layout migration.

### User Interface and Accessibility

- N/A: no Angular templates, controls, navigation, focus, announcements, responsive behavior, or browser interactions change.

### Security and Failure Handling

- Keep OAuth state and PKCE verifier generation/validation in the gateway; delegate code exchange and refresh protocol requests to Octokit while committing returned credentials only through the existing encrypted session rules.
- Convert Octokit request failures to existing `GatewayHttpError` outcomes, preserving `Retry-After`, `X-RateLimit-Reset`, provider message bounding, and user-vs-App authentication distinctions.
- Enable Octokit retry and throttling with explicit callbacks and bounded retry counts. Allow replay only for safe/idempotent operations; set retry count to zero for OAuth code exchange, refresh-token rotation, repository creation, token revocation, installation-token creation, and repository content mutations where an ambiguous replay could duplicate authority or writes.
- Allow GitHub rate-limit responses to be retried once only when the provider delay fits the gateway's bounded request policy. Otherwise propagate the existing bounded `429 Retry-After` response to the scheduler.
- Keep custom Git LFS batch and action transfer requests on `providerFetch`; retain redirect rejection, URL/header validation, integrity transforms, content length, deadlines, and safe failures.

### Lifecycle and Performance

- Octokit clients are short-lived request facades over the adapter's injected fetch and provider-aware retry/throttle plugins; no new durable in-memory credential cache is authoritative.
- Existing coalesced user-token refresh and encrypted installation-token caching remain authoritative.
- Dependency composition changes require a production gateway build and npm audit. LFS bytes remain streamed.

## Verification Plan

| Requirement/story                     | Evidence                                                                               | Command or environment                                                 | Required locally?                 |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| FR-001–FR-005, FR-009–FR-010, US1–US2 | Focused adapter contract, safe retry, mutation replay, and bounded throttle assertions | `npx nx test sync-gateway --skip-nx-cache`                             | Yes                               |
| FR-007, US3                           | LFS success, interruption, unsafe action, timeout, and pointer-ordering assertions     | `npx nx test sync-gateway --skip-nx-cache`                             | Yes                               |
| Dependency and TypeScript integration | Lint                                                                                   | `npx nx lint sync-gateway --skip-nx-cache`                             | Yes                               |
| Dependency and production bundle      | Production build                                                                       | `npx nx build sync-gateway --configuration production --skip-nx-cache` | Yes                               |
| Runtime dependency risk               | Production dependency audit                                                            | `npm audit --omit=dev`                                                 | Yes                               |
| Formatting                            | Intentional files formatted and diff checked                                           | `npx prettier --check ...`; `git diff --check`                         | Yes                               |
| Live GitHub conformance               | Disposable credentialed GitHub App authorization, repository, document, and LFS flow   | Deployment-specific credentials                                        | No; report unavailable unless run |

## Delivery and Documentation

- **Vertical slices**: preserve authorization/repository/document behavior first; preserve failure/session semantics second; verify unchanged LFS behavior third.
- **Migration/rollout**: dependency and adapter changes deploy together; existing encrypted sessions and remote repositories remain valid. Rollback restores the previous adapter without data conversion.
- **Documentation**: update `docs/sync-gateway-api.md` to name Octokit ownership and the retained custom LFS boundary.
- **Residual gates**: live disposable GitHub App, multi-replica Redis HA, provider quota monitoring, container deployment, and production credentials remain separate operational gates.

## Complexity and Exceptions

No constitution violations or exceptions.
