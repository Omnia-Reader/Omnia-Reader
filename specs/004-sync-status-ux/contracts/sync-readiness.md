# Contract: Synchronization Readiness and Activity

## Readiness precedence

The product evaluates connection readiness before scheduler activity:

1. No provider -> setup required.
2. Gateway unavailable/unconfigured -> gateway recovery required.
3. Account absent -> account authorization required.
4. Destination absent -> destination selection required.
5. Ready -> scheduler phase and history may be presented.

“Synced” is valid only in state 5 with a successful timestamp. A historical success may be shown as history in incomplete states but not as the current label.

## GitHub destination recovery

- A gateway-selected repository is authoritative and refreshes device memory.
- A remembered repository is advisory and must pass the same gateway access/write validation as manual selection.
- Without memory, only one writable repository may be selected automatically.
- Multiple writable choices require explicit selection.
- Disconnect clears device memory.

## Presentation

- Toolbar and Settings use the same readiness snapshot.
- Main Settings shows provider/account/destination summaries and a state-specific action.
- Detailed Settings shows completed onboarding steps and never offers authorization to an authenticated account.
- Errors explain the failed boundary and preserve local-library availability.
