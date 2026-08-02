# Research: Truthful Sync Status and Recovery

## Decision: Preserve response URL through bounded buffering

**Rationale**: Octokit's REST pagination normalizes wrapped `total_count` responses and uses the response URL for pagination edge cases. Reconstructing a buffered `Response` erased that URL and caused the observed live `Invalid URL` failure. Preserving the original validated URL retains bounded response-body handling and official pagination behavior.

**Alternatives considered**: Replace Octokit pagination with application-owned Link traversal; return an unread original response after consuming a clone. The first discards the maintained client benefit; the second retains a queued duplicate stream and less explicit memory ownership.

## Decision: Treat connection readiness separately from synchronization activity

**Rationale**: Scheduler history says whether work previously succeeded; it cannot prove that an account and destination are currently usable. A small application-owned readiness service can combine current gateway session state without changing provider-neutral scheduler contracts.

**Alternatives considered**: Add account/destination fields to `AutoSyncStatus`; duplicate gateway checks in each component. The first leaks provider onboarding into the scheduler, while the second caused the current contradictions.

## Decision: Remember only a validated destination hint

**Rationale**: Repository ID and display name are non-secret and let a renewed session recover after reauthorization. The gateway remains authoritative and revalidates access/write permission before selection.

**Alternatives considered**: Persist reusable provider sessions in Angular; keep a server-global user-to-repository mapping; require manual selection after every lost session. The first breaks the trust boundary, the second changes multi-user server state and revocation semantics, and the third repeats completed setup.

## Decision: Auto-select only an unambiguous destination

**Rationale**: A remembered authorized destination is explicit prior intent. Without memory, exactly one writable accessible repository is unambiguous; two or more require user choice.

**Alternatives considered**: Always pick the first repository or never recover automatically. The first can choose incorrectly; the second preserves unnecessary setup friction.
