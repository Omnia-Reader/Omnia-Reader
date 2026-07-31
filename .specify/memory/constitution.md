<!--
Sync Impact Report
- Version change: template -> 1.0.0
- Added principles: Offline-First Local Authority; Hostile-Input and Credential
  Boundaries; Explicit Ownership and Contracts; Test-First User Outcomes;
  Cross-Platform Accessibility; Bounded Lifecycle and Performance; Evidence-Based
  Delivery
- Added sections: Product and Technology Constraints; Spec-Driven Workflow
- Removed sections: none
- Follow-up TODOs: none
-->

# Omnia Reader Constitution

## Core Principles

### I. Offline-First Local Authority

Reading, importing, progress, bookmarks, annotations, preferences, and library
management MUST continue to work without a network connection. Local durable
writes MUST complete before best-effort synchronization or renderer follow-up.
Optional providers and gateways MUST fail without making the local library
unavailable. Merge behavior, tombstones, and device-local exclusions MUST be
deterministic and MUST NOT silently discard or resurrect user data.

### II. Hostile-Input and Credential Boundaries

Publication files, archive contents, persisted records, and synchronized data
MUST be treated as hostile at every trust boundary. Publication scripts and
unsafe navigation MUST remain blocked; schemas, declared sizes, paths, hashes,
and remote records MUST be validated before use. Provider credentials and
reusable sessions MUST remain in the same-origin gateway or a narrowly scoped
native boundary. Tauri commands MUST NOT expose general filesystem or shell
access to the webview.

### III. Explicit Ownership and Contracts

Every change MUST be placed in the owning Nx project defined by the repository
architecture. Format-neutral records belong in `libs/reader/domain`, engine
contracts in `libs/reader/core`, EPUB and PDF behavior in their engine
libraries, browser persistence in `libs/library/data-access`, host behavior in
`libs/platform`, synchronization in `libs/sync/*`, UI orchestration in
`apps/omnia-reader`, gateway secrets and provider HTTP in `apps/sync-gateway`,
and privileged native behavior behind narrow Tauri or bridge interfaces.
Libraries MUST be consumed through public entry points and MUST respect the
enforced Nx module boundaries.

### IV. Test-First User Outcomes

Each behavioral requirement MUST have measurable acceptance scenarios before
implementation. Implementation tasks MUST include a failing or newly relevant
test before the corresponding behavior is changed. Pure documentation or
mechanical configuration changes MAY omit a behavioral test when the plan
explains why. Unit tests MUST be colocated with their subjects. Real-browser
behavior involving navigation, iframe/canvas rendering, workers, IndexedDB,
OPFS, service workers, or user journeys MUST receive focused Playwright
coverage. Tests MUST assert observable behavior and failure paths rather than
private implementation details.

### V. Cross-Platform Accessibility

Web/PWA and supported Tauri hosts share one product contract. User-facing
features MUST define keyboard, focus, screen-reader, touch or pointer behavior
as applicable. Reader changes MUST consider Chromium, Firefox, and WebKit;
host-specific behavior MUST stay behind platform adapters. A platform gate MAY
be skipped only when it is genuinely unavailable, and the unverified boundary
MUST be reported rather than implied to pass.

### VI. Bounded Lifecycle and Performance

Reader engines MUST remain lazy and MUST release workers, object URLs,
canvases, event listeners, iframe resources, and pending asynchronous work on
teardown. Plans MUST identify bundle, memory, pagination, startup, storage, or
network consequences when relevant. Production bundle budgets, schema and
integrity checks, offline behavior, and security checks are release gates, not
informational warnings. New dependencies require an explicit need and current
primary-documentation verification.

### VII. Evidence-Based Delivery

Completion claims MUST cite exact commands and observed results. Validation
MUST start with the smallest test that proves the behavior and expand according
to CodeGraph blast radius, Nx dependencies, and the repository verification
matrix. Unavailable browser, provider, credentialed, native, emulator, or
physical-device checks MUST be listed explicitly. Specs, plans, tasks, tests,
and implementation MUST be reconciled when discoveries change the accepted
behavior or approach.

## Product and Technology Constraints

- The supported first-release formats are DRM-free EPUB and PDF. DRM/LCP, OCR,
  PDF reflow, AI features, plugin systems, iOS, and additional formats remain
  out of scope unless an approved specification changes product scope.
- Use the Node version in `.nvmrc` and the locked npm dependency set. Follow the
  repository's Angular standalone, dependency-injection, TypeScript, ESLint,
  Prettier, and Nx conventions.
- Preserve exact-edition SHA-256 identity, declared-size verification,
  quarantine behavior, deterministic merge rules, and backward-compatible
  backup and persistence migrations.
- `docs/universal-reader-plan.md` owns product direction, architecture decisions,
  verified implementation status, and release gates. Feature-specific intent,
  design, and execution state belong under `specs/`.
- Generated output under `dist/`, coverage, Nx caches, and `src-tauri/gen/` MUST
  remain untracked and MUST NOT be hand-edited unless a specification explicitly
  targets generated platform output.

## Spec-Driven Workflow

1. Use `$speckit-specify` to define prioritized, independently testable user
   journeys, requirements, non-goals, edge cases, and measurable outcomes.
2. Use `$speckit-clarify` for unresolved choices that materially affect scope,
   security, data integrity, or user experience. Human approval is required
   before planning when such choices remain.
3. Use `$speckit-plan` to identify owning Nx projects, CodeGraph/Nx impact,
   contracts, migrations, trust boundaries, lifecycle effects, and required
   verification.
4. Use `$speckit-checklist`, then `$speckit-tasks`; behavioral tasks MUST place
   focused tests before implementation and MUST remain independently
   verifiable by user story.
5. Use `$speckit-analyze` before implementation for every cross-project,
   persistence, synchronization, reader-engine, security, or native change.
6. Route implementation through `$develop-omnia-reader`,
   `$change-reader-engine`, or `$change-offline-sync` as appropriate. Run
   `$verify-omnia-reader` before completion and `$review-omnia-reader` for an
   independent risk review when the change is non-trivial.
7. Keep each commit narrow. Update `docs/universal-reader-plan.md` only when
   product scope, architecture, release gates, or verified implementation
   status materially changes.

Small regressions MAY use a reduced flow consisting of a short amended spec, a
reproducing test, implementation, and focused verification. Formatting,
documentation-only, or mechanical maintenance changes do not require a feature
spec when they introduce no behavioral or architectural decision.

## Governance

This constitution governs all feature specifications and plans. `AGENTS.md`
and the repository skills provide operational detail and MUST be followed when
they are more specific without weakening these principles. A specification
MUST record and justify any necessary exception in its Constitution Check.

Amendments require an explicit user-approved change, a Sync Impact Report, and
semantic versioning: MAJOR for removed or incompatible governance, MINOR for a
new principle or materially expanded obligation, and PATCH for clarification.
Every plan and review MUST check compliance. Unjustified violations block
implementation and acceptance.

**Version**: 1.0.0 | **Ratified**: 2026-07-31 | **Last Amended**: 2026-07-31
