# Data Model: Sync Connection Readiness

## Sync connection readiness

States:

- `local-only`: no provider selected.
- `checking`: current provider session is being inspected.
- `gateway-unavailable`: the selected provider gateway cannot be reached.
- `provider-unconfigured`: gateway reachable but provider credentials absent.
- `authorization-required`: provider configured but account session absent/expired.
- `destination-required`: authenticated account has no selected destination.
- `ready`: authenticated account and writable destination are confirmed.

Optional presentation fields are provider, account label, destination label, and safe recovery message. Credentials and opaque session identifiers are forbidden.

Transitions are last-refresh-wins. Scheduler state never promotes an incomplete connection to ready.

## Remembered GitHub destination

```text
schemaVersion: 1
repository:
  id: positive safe integer
  fullName: 1..512 character validated owner/name display value
```

Lifecycle:

1. Successful session/selection with a repository writes the preference.
2. Reauthorization with no server-selected repository may revalidate and restore it.
3. Inaccessible, malformed, or non-writable preference is discarded or ignored.
4. Explicit disconnect removes it.
5. Storage denial affects convenience only and never blocks synchronization.

No migration is required because absence means no remembered destination.
