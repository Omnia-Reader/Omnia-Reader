# Data Model: Production-Ready Synchronization

Feature 015 preserves every existing synchronized record and local-library
schema while adding one backward-compatible reader-preference document and a
local durability migration. The models below describe that additive state plus
the release policy and evidence whose lifecycle must be proven.

## Reader preference synchronization state

Canonical path: `.omnia-reader/preferences/state.json`

```text
ReaderPreferenceSyncState {
  schemaVersion: 1
  epub: { <known EPUB field>: PreferenceRegister }
  pdf: { <known PDF field>: PreferenceRegister }
}

PreferenceRegister {
  value: validated field-specific value
  revision: non-negative safe integer
  deviceId: stable non-empty device identity
  changeId: immutable non-empty change identity
}
```

The EPUB field set is `theme`, `fontFamily`, `fontSizePercent`, `lineHeight`,
`paragraphSpacingRem`, `marginPercent`, `maxLineWidthRem`, `flow`, and `spread`.
The PDF field set is `zoomMode`, `zoomPercent`, and `rotation`. Unknown,
duplicate, invalid, oversized, malformed-revision, and future-schema input is
rejected before persistence.

Registers merge independently. A register wins by lexicographic comparison of
`revision`, `deviceId`, then `changeId`; wall-clock time is diagnostic only and
never merge authority. Canonical serialization emits the fixed EPUB/PDF field
order and rejects duplicate JSON properties before parsing.

The root manifest advertises the additive, backward-compatible
`reader-preferences` capability. Older clients may ignore the capability and
document without losing any existing synchronized data.

### IndexedDB version 11 durability

Version 11 adds a preference-change outbox and preference synchronization
metadata. A local preference value and its typed outbox entry commit in the
same transaction. The outbox relays to the existing journal only after that
transaction commits, and remains recoverable until a remote reread verifies the
corresponding winning register.

| Starting state                                   | Migration result                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Version 10 and remote preference state exists    | Adopt remote registers as the baseline; do not publish legacy local values           |
| Version 10 and no remote preference state exists | Seed stored non-default preferences once; unchanged defaults create no work          |
| Version 11 local edit                            | Atomically persist value plus outbox, then relay a typed `preference` journal change |

Incoming registers are persisted immediately. A mounted EPUB/PDF engine keeps
its current preference snapshot; the new values apply when the next publication
is opened or the current publication is explicitly reloaded.

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

The existing reserved `preference` entity receives a typed preference-change
payload. Other operation entities and acknowledgement semantics remain
unchanged. The required lifecycle remains:

```text
local write complete -> pending -> active -> remotely confirmed -> acknowledged
                          |          |
                          + failure/cancel/restart -> pending
```

Destination identity scopes every operation, checkpoint, and history record.
No error, cancellation, throttle, browser close, host restart, or gateway
restart may acknowledge unfinished work.
