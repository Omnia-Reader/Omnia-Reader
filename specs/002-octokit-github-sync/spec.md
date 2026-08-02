# Feature Specification: Octokit GitHub Synchronization

**Feature Directory**: `002-octokit-github-sync`

**Created**: 2026-08-02

**Status**: Approved

**Input**: User description: "Use octokit.js for the synchronization feature."

## Outcome and Scope _(mandatory)_

**Outcome**: GitHub synchronization continues to behave identically for readers while its supported GitHub API and authentication operations rely on the maintained GitHub SDK instead of application-owned protocol plumbing.

**In scope**:

- GitHub App user authorization, refresh, revocation, installation access, repository discovery, repository creation, and repository content operations.
- Preservation of the same-origin gateway, provider-scoped session, rate-limit, timeout, optimistic-conflict, and safe-error contracts.
- Preservation of the existing Git LFS batch and streaming-transfer behavior.

**Non-goals**:

- Moving provider credentials or reusable sessions into Angular or Tauri frontend state.
- Replacing API-backed synchronization with a checked-out Git repository.
- Changing synchronized paths, records, merge rules, or user-facing GitHub setup.
- Replacing the existing Git LFS protocol implementation.
- Adding another Git provider.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Continue GitHub synchronization (Priority: P1)

A reader connects a GitHub App, selects or creates a repository, and synchronizes reading data without seeing a changed workflow or public gateway response.

**Why this priority**: Existing synchronization must remain usable while the provider integration is modernized.

**Independent test**: Exercise authorization, repository discovery and selection, then create, read, update, list, and delete a remote document through the existing gateway adapter contract.

**Acceptance scenarios**:

1. **Given** a configured GitHub App, **When** a reader completes authorization and selects an accessible repository, **Then** the gateway returns the same provider-scoped session and destination representations as before.
2. **Given** an existing selected repository, **When** synchronization reads or mutates a document, **Then** optimistic revision and conflict behavior remains unchanged.

---

### User Story 2 - Recover safely from provider failures (Priority: P2)

A reader remains locally productive when GitHub rejects, throttles, times out, revokes, or temporarily fails a provider operation.

**Why this priority**: Authentication and error handling protect credentials and prevent provider failures from affecting local reading.

**Independent test**: Inject authorization, refresh, rate-limit, timeout, malformed-response, and access-removal responses and assert the existing safe gateway outcomes and session transitions.

**Acceptance scenarios**:

1. **Given** an expiring user token, **When** concurrent gateway requests require refresh, **Then** one rotation is committed and a concurrent disconnect or revocation cannot restore authority.
2. **Given** a GitHub rate limit or provider timeout, **When** synchronization contacts GitHub, **Then** the gateway returns the bounded application-owned retry or timeout response without exposing credentials or unbounded provider details.
3. **Given** a revoked user grant or removed installation, **When** the gateway next validates authority, **Then** it consumes only the affected session or destination state according to the existing contract.

---

### User Story 3 - Preserve publication transfers (Priority: P3)

A reader uploads and downloads EPUB or PDF publication bytes through Git LFS with the same ordering, integrity checks, and recovery behavior.

**Why this priority**: Publication transfer is adjacent to GitHub API operations but has a separate protocol and stricter streaming boundary.

**Independent test**: Upload and download a fake LFS object, including verification, interrupted transfer, unsafe action, and concurrent pointer publication cases.

**Acceptance scenarios**:

1. **Given** valid publication bytes, **When** an upload completes, **Then** immutable bytes are verified before the LFS pointer becomes visible.
2. **Given** an interrupted, malformed, or unsafe LFS action, **When** a transfer is attempted, **Then** no pointer is published and the gateway returns a bounded safe error.

### Edge Cases

- GitHub returns malformed OAuth or REST response data.
- A user token expires during concurrent repository requests.
- Disconnect or webhook revocation races with token refresh.
- A selected repository becomes inaccessible to the GitHub App.
- GitHub responds with primary or secondary rate limiting.
- A REST request or response body stalls beyond its configured deadline.
- An LFS transfer action contains unsafe URLs, headers, redirects, or mismatched object identity.
- A publication stream ends early or fails after the provider accepted an upload request.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Omnia Reader MUST preserve the existing same-origin GitHub gateway routes and public request and response contract.
- **FR-002**: Omnia Reader MUST preserve the provider-scoped authorization URL, callback validation, encrypted session rotation, token refresh, disconnect, and webhook-revocation outcomes.
- **FR-003**: Omnia Reader MUST preserve repository discovery, private repository creation, destination selection, and installation-access behavior.
- **FR-004**: Omnia Reader MUST preserve document listing, reading, optimistic creation and update, and revision-based deletion behavior.
- **FR-005**: Omnia Reader MUST preserve safe mapping of GitHub authorization, permission, conflict, rate-limit, malformed-response, transport, and timeout failures.
- **FR-006**: Omnia Reader MUST keep local reading and durable local mutation independent of GitHub availability.
- **FR-007**: Omnia Reader MUST preserve Git LFS batch negotiation, safe action validation, streaming integrity verification, transfer deadlines, verification requests, and pointer publication ordering.
- **FR-008**: Omnia Reader MUST NOT send reusable GitHub credentials, refresh tokens, installation tokens, or private keys to the browser, synchronized documents, URLs, or logs.
- **FR-009**: Omnia Reader MUST use bounded provider-aware retry and throttling for safely replayable operations while preventing ambiguous replay of single-use authorization exchanges and non-idempotent mutations.
- **FR-010**: When automatic retry or throttling cannot complete within the gateway's bounded policy, Omnia Reader MUST return the existing safe provider error and retry delay to the synchronization scheduler.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- Local reading, imports, annotations, progress, and library writes remain usable with the gateway absent or GitHub unavailable. Interrupted remote work remains retryable through the existing journal and scheduler behavior.

**Security and trust**

- Credentials remain in encrypted gateway-owned sessions. Provider data remains validated before it becomes application state. LFS action URLs and headers remain hostile inputs.

**Accessibility and interaction**

- No user interface behavior, focus order, accessible name, announcement, pointer, or touch interaction changes are introduced.

**Platform and compatibility**

- The existing web/PWA and Tauri clients continue to use the same same-origin gateway contract. No browser-specific provider dependency is introduced.

**Lifecycle and performance**

- Provider requests retain configured deadlines. Repository enumeration remains bounded and publication transfers remain streaming rather than buffered. The gateway production bundle must remain within its existing build constraints.

**Migration and compatibility**

- Existing encrypted sessions and selected repositories remain readable without a data migration. Remote repository layout, revisions, LFS pointers, and `.gitattributes` behavior remain compatible.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: All focused GitHub gateway tests covering authorization, repositories, documents, rate limits, timeouts, concurrency, and LFS transfers pass against the migrated implementation.
- **SC-002**: The gateway lint and production build gates pass with the locked dependency set and configured Node version.
- **SC-003**: No browser-facing route, response shape, synchronized path, durable session field, or Git LFS transfer contract changes.
- **SC-004**: Provider failures remain bounded to the documented `401`, `403`, `409`, `429`, `502`, and `504` outcomes after at most the configured safe retry policy, with existing safe messages and retry delays.
- **SC-005**: Tests prove that safe reads can be retried, GitHub rate-limit delays are honored within policy, and non-idempotent or single-use operations are not replayed after an ambiguous failure.

## Acceptance Evidence _(mandatory)_

- Focused `sync-gateway` unit tests must cover every functional requirement and must assert both success and applicable failure paths.
- Gateway lint and a production gateway build are required because dependency and bundle composition change.
- `git diff --check` and formatting of intentionally changed files are required.
- Real-browser, PWA, EPUB/PDF renderer, native, emulator, and physical-device gates are not applicable because no browser or reader behavior changes.
- A credentialed disposable GitHub App conformance run remains a separate release gate and must be reported as unavailable unless it actually runs.

## Assumptions

- The existing gateway contract and current Git LFS implementation are authoritative compatibility baselines.
- The approved maintained GitHub SDK supports Node v26.5.0, injectable fetch, GitHub App authentication, REST requests, pagination, retry, and provider-aware throttling.
- Automatic retry and throttling can be configured per request so Omnia benefits from provider guidance without replaying unsafe operations.
