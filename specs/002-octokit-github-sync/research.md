# Research: Octokit GitHub Synchronization

## Decision: Use the published `octokit` package

**Rationale**: The package is the maintained all-batteries-included GitHub SDK for Node and composes the official API client, App client, OAuth support, pagination, typed REST endpoints, request errors, retry, throttling, and webhooks. Its current package metadata supports Node 20 and newer, covering the repository's Node v26.5.0 runtime.

**Alternatives considered**:

- Focused `@octokit/*` packages: provide tighter dependency selection but require application-owned composition equivalent to the umbrella package. The user explicitly selected Octokit.js, and the server-only gateway does not have a browser bundle constraint.
- `isomorphic-git`: implements Git repository operations rather than GitHub App and REST workflows, requires filesystem/HTTP orchestration, and does not replace the security-sensitive LFS action boundary.
- `simple-git` or libgit2 bindings: require Git/native tooling, temporary repositories, credential plumbing, and a separate Git LFS executable without improving the current API-backed model.

## Decision: Use bounded Octokit retry and throttling with mutation safety

**Rationale**: Octokit's retry plugin excludes common permanent client failures and its throttling plugin implements GitHub's recommended primary and secondary rate-limit handling. Safe reads benefit from transient retry, and a short provider-directed throttle can complete without waking the application scheduler. Single-use OAuth exchanges, refresh-token rotation, repository creation, token revocation, installation-token creation, and repository content mutations must opt out of ambiguous server-error replay. Limits outside the bounded in-request policy remain visible as Omnia's `429 Retry-After` contract.

**Alternatives considered**:

- Disable both plugins: rejected because it duplicates maintained GitHub retry guidance and gives up safe transient recovery.
- Enable defaults indiscriminately: rejected because a lost response after a non-idempotent mutation can cause duplicate repositories, orphaned tokens, or confusing conflicts.
- Redis-clustered throttling: deferred because it changes deployment state ownership and is unnecessary for the current migration; the existing scheduler remains the durable cross-restart rate-limit authority.

## Decision: Preserve Omnia-owned session state and token races

**Rationale**: Octokit can cache and refresh installation or user tokens, but the gateway already has encrypted restart-persistent or Redis-backed sessions, webhook authorization generations, refresh coalescing, disconnect ordering, and orphan-token revocation. These are application security semantics rather than HTTP client mechanics.

**Alternatives considered**:

- Make Octokit's in-memory cache authoritative: rejected because it would not preserve encrypted restart behavior or multi-replica session ownership.
- Replace session fields with SDK objects: rejected because SDK instances are not durable session records and could expose or duplicate credential authority.

## Decision: Keep custom Git LFS transport

**Rationale**: Git LFS batch and provider-supplied transfer actions are not generated GitHub REST endpoints. The existing implementation validates HTTPS targets and bounded headers, rejects redirects/private literal targets, streams bytes through SHA-256 and size verification, and publishes pointers only after verified upload.

**Alternatives considered**:

- Send LFS requests through generic Octokit request APIs: rejected because it provides no typed LFS contract and risks conflating API authentication and signed transfer actions.
- Run `git-lfs`: rejected because it requires a working tree, subprocess tooling, credential helpers, and a different deployment model.
