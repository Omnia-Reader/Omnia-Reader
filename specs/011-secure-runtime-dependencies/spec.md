# Feature Specification: Secure Runtime Dependencies

**Feature Directory**: `011-secure-runtime-dependencies`

**Created**: 2026-08-20

**Status**: Approved

**Input**: Production dependency audit reports high-severity malicious-document
execution and URL-authority confusion advisories in runtime components.

## Outcome and Scope

**Outcome**: Readers can open hostile or ordinary PDFs and use synchronization
gateway routes without exposure to the known high-severity runtime dependency
vulnerabilities, while existing reader, offline, and gateway behavior remains
compatible.

**In scope**:

- Remove every currently reported production dependency vulnerability.
- Preserve safe PDF rendering, password handling, links, search, selection,
  annotations, progress, worker isolation, and teardown.
- Preserve gateway path confinement, request validation, authentication,
  rate-limiting, and provider behavior.
- Keep dependency resolution deterministic and auditable from the locked
  dependency set.

**Non-goals**:

- Adding publication formats or changing the reader interface.
- Changing provider authentication, storage schemas, synchronization formats,
  or gateway routes.
- Suppressing or allow-listing a production advisory without removing its
  vulnerable runtime path.
- Treating development-only advisories as production release blockers in this
  slice.

## User Scenarios and Testing

### User Story 1 - Safely open PDF publications (Priority: P1)

A reader opens ordinary, encrypted, interactive, malformed, or hostile PDFs
without a known document-triggered code-execution path and without losing the
current reading experience.

**Why this priority**: Publication files are hostile input and are opened
directly by users; document-triggered code execution is the highest-impact
finding.

**Independent test**: Open the deterministic ordinary, encrypted, interactive,
malformed, and hostile PDF fixtures and observe the existing rendering,
password, link-consent, rollback, and cleanup outcomes while the production
audit reports no PDF-runtime advisory.

**Acceptance scenarios**:

1. **Given** a supported PDF, **When** the reader opens and navigates it,
   **Then** pages, text, search, links, annotations, progress, and teardown
   retain their established behavior.
2. **Given** a malformed or hostile PDF, **When** it is opened, **Then** no
   publication-controlled script executes, external navigation remains
   consent-gated, and failure leaves the local library usable.
3. **Given** an encrypted PDF, **When** the reader supplies, retries, or cancels
   a password, **Then** secrets are not retained and the existing safe outcome
   remains available.

---

### User Story 2 - Keep gateway validation trustworthy (Priority: P1)

A reader connects to a configured synchronization provider through gateway
request validation that is not affected by the known URL-authority confusion
vulnerability.

**Why this priority**: The same audit identifies a high-severity integrity issue
in the production request-validation graph.

**Independent test**: Exercise confined and backslash-confused path/URL inputs
against the gateway contract, observe valid requests retain their behavior and
ambiguous authority inputs remain rejected, and observe no production audit
finding for the validation graph.

**Acceptance scenarios**:

1. **Given** a valid authenticated gateway request, **When** it is validated,
   **Then** the request retains the same provider-neutral outcome.
2. **Given** a traversal, backslash-authority, malformed, oversized, or
   unauthenticated request, **When** it reaches the gateway boundary, **Then** it
   is rejected without credential disclosure or provider mutation.

### Edge Cases

- A dependency update changes a PDF worker or viewer contract while the main
  reader still compiles.
- A malicious PDF combines JavaScript actions, embedded links, forms,
  encryption, or malformed structures.
- A URL or path uses backslashes, encoded separators, mixed case, Unicode, or
  an apparent alternate authority.
- The audit service is unavailable or returns incomplete metadata.
- A clean install resolves a different dependency graph from the reviewed lock
  file.
- Browser, packaged-native, or Android hosts use the same updated reader asset
  through different packaging boundaries.

## Requirements

### Functional Requirements

- **FR-001**: The locked production dependency graph MUST contain zero known
  vulnerabilities at every severity.
- **FR-002**: The PDF reader MUST use a runtime version that is outside the
  affected malicious-document execution range.
- **FR-003**: PDF parsing and rendering MUST keep publication-controlled code
  disabled and external navigation explicitly mediated.
- **FR-004**: PDF rendering, password handling, forms, links, search,
  selections, annotations, locators, progress, worker isolation, and teardown
  MUST remain compatible with the current reader contract.
- **FR-005**: The synchronization gateway validation graph MUST use URL parsing
  dependencies outside every affected host-confusion range.
- **FR-006**: Gateway path confinement MUST reject backslash-authority,
  traversal, encoded-separator, malformed, and oversized inputs before any
  provider mutation.
- **FR-007**: Gateway authentication, credentials, sessions, rate limits,
  GitHub behavior, and MEGA behavior MUST remain unchanged.
- **FR-008**: The reviewed dependency graph MUST be reproducible from the lock
  file on the repository-defined runtime.
- **FR-009**: Security remediation MUST NOT move reader engines or workers into
  the initial application bundle.
- **FR-010**: If an affected production dependency cannot be removed safely,
  the release gate MUST fail rather than suppressing the advisory.

### Quality and Boundary Requirements

**Offline and recovery**

- Local import, PDF reading, and existing library state remain usable without a
  gateway or network connection. A renderer failure must not mutate stored
  publication bytes or reading state.

**Security and trust**

- PDFs, gateway URLs, paths, headers, bodies, sessions, and provider responses
  remain hostile input. No advisory exception may replace a patched runtime.

**Accessibility and interaction**

- The update introduces no new controls. Existing keyboard navigation,
  password-dialog focus, accessible form names, link consent, and error
  announcements remain unchanged.

**Platform and compatibility**

- Web/PWA and shared Tauri hosts use the same safe reader contract. Chromium is
  required locally; WebKit covers reader compatibility. Packaged desktop and
  Android remain separate gates when their toolchains are unavailable.

**Lifecycle and performance**

- Reader workers, canvases, object URLs, listeners, and pending tasks remain
  bounded and are released on teardown. The production initial bundle remains
  within its configured budget and reader code remains lazy.

**Migration and compatibility**

- No durable schema or provider contract changes. Rolling back the dependency
  update restores the prior runtime without data migration, but is not an
  acceptable release state while the advisory remains active.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A clean production dependency audit reports zero vulnerabilities
  and exits successfully.
- **SC-002**: 100% of existing PDF engine and shell tests pass without reducing
  fixture coverage or weakening assertions.
- **SC-003**: Ordinary, encrypted, interactive, malformed, hostile, and large
  PDF browser fixtures retain their required outcomes in every locally
  available required browser.
- **SC-004**: 100% of gateway unit, confinement, authentication, rate-limit, and
  provider-adapter tests pass, including explicit backslash-authority cases.
- **SC-005**: Production application and gateway builds pass their configured
  budgets and security checks, with PDF engine code still absent from the
  initial application bundle.
- **SC-006**: Two clean locked installs resolve byte-identical dependency lock
  state and neither introduces a production vulnerability.

## Acceptance Evidence

- Focused PDF engine and reader-shell unit evidence covers API compatibility,
  passwords, links, selection, annotations, locators, teardown, and failure.
- Chromium and WebKit journeys cover real PDF rendering, hostile input,
  encrypted documents, forms/links, malformed rollback, and large-document
  lifecycle behavior.
- Gateway unit and production-build evidence covers request validation,
  backslash/encoded path confinement, sessions, rate limits, and both provider
  adapters.
- A clean locked install plus production-only audit proves the resolved graph;
  lockfile inspection records the patched dependency versions.
- Packaged desktop, Android emulator, physical-device, and live credentialed
  provider checks remain explicit external gates when unavailable.

## Assumptions

- The first non-affected compatible runtime releases are available from the
  configured package registry.
- Existing deterministic PDF and gateway fixtures are sufficient to expose
  contract regressions; no production credentials are required.
- No durable data migration is necessary because this feature changes runtime
  dependencies only.
