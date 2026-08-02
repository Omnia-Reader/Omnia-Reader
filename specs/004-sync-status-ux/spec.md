# Feature Specification: Truthful Sync Status and Recovery

**Feature Directory**: `004-sync-status-ux`

**Created**: 2026-08-02

**Status**: Approved

**Input**: User description: "Improve synchronization UX so existing GitHub setup, account, destination, readiness, errors, and recovery are presented consistently instead of restarting onboarding or claiming success without a destination."

## Outcome and Scope _(mandatory)_

**Outcome**: A reader can understand the exact synchronization state from the global toolbar and Settings, retain or recover an existing GitHub destination after session renewal, and take only the next action actually required.

**In scope**:

- Repair GitHub repository discovery after the maintained GitHub client migration.
- Present gateway, GitHub App, account, repository, pending-work, active-work, last-success, offline, and error states consistently.
- Remember a successfully selected GitHub repository on this device and restore it after account reauthorization when it remains accessible.
- Recover the only writable accessible repository without forcing another redundant selection.
- Replace generic setup actions with state-specific status and actions.
- Restore synchronized publication variants before applying logical-book
  memberships that reference them.

**Non-goals**:

- Moving GitHub credentials or reusable provider sessions into browser storage.
- Selecting among multiple repositories without reader confirmation.
- Changing synchronized paths, merge rules, publication identity, or Git LFS transfer semantics.
- Adding another provider or redesigning MEGA authentication.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Resume an existing GitHub setup (Priority: P1)

A reader who already connected GitHub can reopen or reauthorize Omnia Reader and continue with the same accessible repository without repeating completed setup steps.

**Why this priority**: The current regression blocks repository discovery and makes a valid account appear unusable.

**Independent test**: Reauthorize an account with a remembered accessible repository, refresh the application, and observe the repository restored with synchronization ready.

**Acceptance scenarios**:

1. **Given** an authenticated GitHub account, **When** repositories are requested, **Then** every accessible writable repository is listed without a gateway error.
2. **Given** a remembered repository that remains accessible, **When** a renewed account session has no destination, **Then** that repository is restored automatically.
3. **Given** no remembered destination and exactly one writable repository, **When** Settings loads, **Then** that repository is selected and the initial synchronization is queued with an explanation.
4. **Given** multiple writable repositories and no remembered destination, **When** Settings loads, **Then** no repository is chosen automatically and the reader is asked to choose once.
5. **Given** synchronized logical membership for a publication not yet stored on this device, **When** synchronization runs, **Then** the publication variant is restored before that membership is applied.

---

### User Story 2 - See one truthful synchronization status (Priority: P1)

A reader can tell whether synchronization is unconfigured, disconnected, missing a destination, ready, active, paused, failed, or successfully completed without contradictory labels.

**Why this priority**: A stale “Synced” label currently hides missing account or destination state.

**Independent test**: Drive each connection/readiness state and verify the toolbar and Settings summary agree on the required action and never report success without a destination.

**Acceptance scenarios**:

1. **Given** a selected provider but no authenticated account, **When** the application renders, **Then** it asks to connect that account and does not say “Synced.”
2. **Given** an authenticated account without a destination, **When** an older successful synchronization exists, **Then** the application asks for a repository and does not present that historical success as current readiness.
3. **Given** an authenticated account and selected repository, **When** synchronization previously succeeded, **Then** the toolbar and Settings identify the repository and last successful time.
4. **Given** an unavailable gateway or repository-list failure, **When** status is refreshed, **Then** the reader sees a safe recovery message while local books remain usable.

---

### User Story 3 - Manage instead of restart setup (Priority: P2)

A configured reader sees the current provider, account, destination, pending changes, and last result on the main Settings page, with a “Manage” action instead of generic onboarding copy.

**Why this priority**: The current Settings card erases useful context and invites redundant setup.

**Independent test**: Open Settings in ready, account-only, and local-only states and verify the card summary and action match each state.

**Acceptance scenarios**:

1. **Given** a ready GitHub destination, **When** Settings opens, **Then** it names the account and repository and offers to manage synchronization.
2. **Given** an incomplete setup, **When** Settings opens, **Then** it names the completed steps and offers only the next required action.

### Edge Cases

- A remembered repository is no longer accessible or writable.
- GitHub returns wrapped paginated results and multiple pages.
- The gateway restarts while the Angular application remains open.
- Repository discovery fails after account authentication.
- An older successful result exists for a provider with no current destination.
- Browser storage is restricted or contains malformed remembered destination data.
- Status refreshes overlap or the component is destroyed before a request finishes.
- Status text and actions remain available to keyboard and screen-reader users at narrow widths.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Omnia Reader MUST enumerate GitHub App repositories through the maintained GitHub client without losing pagination response metadata or rejecting valid wrapped results.
- **FR-002**: Omnia Reader MUST distinguish provider selection, gateway configuration, account authentication, and destination selection as separate states.
- **FR-003**: Omnia Reader MUST report “Synced” only when the currently selected provider has an authenticated account, a selected destination, and a recorded successful synchronization.
- **FR-004**: The toolbar and Settings MUST derive their labels, descriptions, icons, emphasis, and next action from the same connection-readiness contract.
- **FR-005**: Omnia Reader MUST show the current GitHub account and repository when available and MUST not offer account authorization again while the account is authenticated.
- **FR-006**: Omnia Reader MUST remember a successfully selected GitHub repository identifier and safe display name on the current device without storing provider credentials.
- **FR-007**: After reauthorization, Omnia Reader MUST restore a remembered repository only when the gateway confirms it remains accessible and writable.
- **FR-008**: When no destination is remembered and exactly one writable repository is accessible, Settings MUST select it, explain the recovery, and queue synchronization; multiple choices require explicit reader selection.
- **FR-009**: Gateway, account, repository, offline, rate-limit, and synchronization failures MUST preserve local reading and expose a specific recovery action without contradictory onboarding content.
- **FR-010**: Disconnect MUST clear the remembered destination and current provider selection only after local session authority is removed.
- **FR-011**: Overlapping status refreshes MUST not allow an older response to overwrite a newer provider or connection state.
- **FR-012**: Synchronization MUST restore publication variants before applying logical-book membership that references those variants.

### Key Entities and Durable State _(include when data changes)_

- **Connection readiness**: Device-local presentation state combining selected provider, gateway availability/configuration, authenticated account, selected destination, and safe recovery reason.
- **Remembered GitHub destination**: A versioned device-local preference containing only the repository numeric identifier and validated display name; it is advisory and never overrides gateway authorization.
- **Synchronization activity**: Existing scheduler phase, pending count, last attempt, last success, and last result; success is meaningful only when connection readiness is complete.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- Local books and mutations remain available in every connection state. Historical success and pending work remain visible but cannot masquerade as current readiness.

**Security and trust**

- Credentials, refresh tokens, installation tokens, private keys, and reusable sessions remain gateway-only. Remembered destination data is schema-validated, bounded, non-secret, and treated as advisory.

**Accessibility and interaction**

- Status has a concise visible label, descriptive accessible name, non-color icon/text distinction, polite updates, and keyboard-accessible state-specific actions. Existing focus is not moved on background refresh.

**Platform and compatibility**

- Web/PWA and Tauri webviews share the same presentation contract. Chromium is the required browser journey; Firefox and WebKit remain compatibility gates for release rather than this provider-specific regression.

**Lifecycle and performance**

- Status inspection uses bounded gateway calls, coalesces overlapping refreshes, and adds no polling loop. The application production bundle remains within configured budgets.

**Migration and compatibility**

- Existing provider selection, encrypted sessions, remote layout, and scheduler history remain readable. Missing or malformed remembered-destination data behaves as no preference and never blocks manual setup.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: All valid repositories from a two-page provider fixture are discoverable, and malformed or cross-origin pagination is rejected safely.
- **SC-002**: Across at least eight defined connection/activity combinations, the toolbar and Settings identify the same readiness state and no incomplete state displays “Synced.”
- **SC-003**: A remembered accessible repository is restored in one application visit without repeating authorization or manual selection; multiple choices are never selected implicitly.
- **SC-004**: A reader can identify provider, account, destination, pending work, last success, and next action from Settings without entering the detailed sync page when the information exists.
- **SC-005**: Focused unit suites, the Chromium sync journey, affected lint, and production builds complete without a new regression.

## Acceptance Evidence _(mandatory)_

- Gateway contract tests cover wrapped pagination, response metadata, multiple pages, malformed responses, and unsafe next links.
- Client and app unit tests cover remembered destination validation/restoration, every readiness state, stale refresh suppression, disconnect, and state-specific copy/actions.
- A focused Chromium journey covers main Settings, detailed Settings, toolbar status, and destination recovery.
- Gateway and application lint plus production builds are required. Live credentialed GitHub behavior is probed when available and reported separately from deterministic fixtures.
- Native, emulator, physical-device, EPUB/PDF renderer, and PWA-offline gates are not required because no reader or offline-cache contract changes.

## Assumptions

- The selected synchronization provider remains a device-local preference.
- A repository numeric identifier is stable enough to serve as an advisory recovery key and is revalidated by the gateway before use.
- Automatically selecting the only writable accessible repository is unambiguous; two or more writable choices require reader confirmation.
