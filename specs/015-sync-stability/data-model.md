# Data Model: Production-Ready Synchronization

Feature 015 preserves every existing synchronized and local-library schema. The
models below describe release policy and evidence plus the existing state whose
lifecycle must be proven; they do not add reader data to the remote layout.

## Provider maturity

| Field           | Meaning                     | Validation                            |
| --------------- | --------------------------- | ------------------------------------- |
| `provider`      | Stable provider identity    | Existing `git` or `mega` identity     |
| `maturity`      | Product support level       | `experimental` or `supported`         |
| `label`         | User-visible provider name  | Non-empty, application-owned text     |
| `maturityLabel` | Accessible support label    | Non-empty, not inferred from history  |
| `consequence`   | Concise support implication | Application-owned, provider-text-free |

State transition:

```text
experimental --all release evidence accepted--> supported
supported --release policy withdrawal----------> experimental
```

A successful synchronization does not change maturity. MEGA remains
`experimental` in this feature. GitHub changes to `supported` only in the final
promotion slice.

## Synchronization release evidence

| Field                       | Meaning                     | Validation                                                                  |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `schemaVersion`             | Evidence contract version   | Exact supported integer                                                     |
| `candidate`                 | Source and release identity | Full commit plus release identifier                                         |
| `artifacts`                 | Tested deployable bytes     | Named artifacts with immutable digest                                       |
| `environments`              | Where evidence ran          | Sanitized identity and configuration profile                                |
| `runs`                      | Scenario results            | Provider, platform, browser/host, attempt, outcome, duration, artifact link |
| `unavailableGates`          | Evidence not executed       | Non-empty reason and owning gate                                            |
| `startedAt` / `completedAt` | Evidence interval           | Valid UTC timestamps, ordered                                               |
| `result`                    | Aggregate decision          | `candidate`, `accepted`, or `rejected`                                      |

Transitions:

```text
candidate --all required gates pass----> accepted
candidate --failure/missing required----> rejected
accepted  --new candidate or policy gap-> candidate
```

An unavailable mandatory gate yields `rejected`; it cannot be treated as a
pass. The evidence set contains no account identifiers, credentials, reusable
sessions, provider URLs containing authority, publication content, or raw
provider error bodies.

## Native authorization handoff

| Field             | Meaning                                | Validation                                |
| ----------------- | -------------------------------------- | ----------------------------------------- |
| `handoffId`       | Opaque single-use authorization result | Cryptographically random and non-semantic |
| `provider`        | Intended provider                      | `git` for the stable slice                |
| `nativeRequestId` | Binds initiating app request           | Opaque and exact-match validated          |
| `expiresAt`       | Maximum redemption time                | Short, bounded, server-enforced lifetime  |
| `consumedAt`      | Replay marker                          | Absent before one atomic redemption       |
| `redirectScheme`  | Approved application return            | Exact configured Omnia Reader scheme      |

Transitions:

```text
issued -> authorized -> redeemed
   |          |            |
 expired    expired       terminal
   |          |
 terminal   terminal
```

The deep link carries only `handoffId` and the request binding. Provider tokens,
cookies, and reusable sessions remain server/native-owned.

## Native synchronization session

| Field                     | Meaning                               | Validation                                               |
| ------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `gatewayOrigin`           | Sole remote authority                 | Configured HTTPS origin; exact allowlist match           |
| `provider`                | Session scope                         | Exact provider identity                                  |
| `cookieJar`               | Opaque server session material        | Native-only, never serialized over IPC                   |
| `csrfState`               | Mutation binding                      | Native-only and origin scoped                            |
| `createdAt` / `expiresAt` | Local lifecycle                       | Bounded and cleared on disconnect/expiry                 |
| `persistenceMode`         | Host security capability              | `protected` or `session-only`; never silently downgraded |
| `persistenceVersion`      | Protected-storage schema when enabled | Exact supported version; fail closed otherwise           |

The native transport exposes typed results and sanitized errors, never this
entity. Disconnect deletes local native authority before remote revocation. A
host may use `protected` only after the Rust boundary proves protected bootstrap
and restart recovery. Otherwise `session-only` clears authority on exit and
requires reauthentication without clearing local or pending data.

## Existing pending operation

Feature 015 does not change its schema. The required lifecycle remains:

```text
local write complete -> pending -> active -> remotely confirmed -> acknowledged
                          |          |
                          + failure/cancel/restart -> pending
```

Destination identity scopes every operation, checkpoint, and history record.
No error, cancellation, throttle, browser close, host restart, or gateway
restart may acknowledge unfinished work.
