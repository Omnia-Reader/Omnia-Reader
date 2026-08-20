# Implementation Plan: Secure Runtime Dependencies

**Feature Directory**: `011-secure-runtime-dependencies` | **Date**: 2026-08-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-secure-runtime-dependencies/spec.md`

## Summary

Upgrade the lazy PDF runtime from `6.1.200` to the first available release
outside GHSA-hq66-cqwq-w95j, refresh both locked `fast-uri` lines to patched
3.x/4.x releases outside GHSA-7p8r-x3mc-p8w7, and retain the existing PDF and
gateway contracts through focused hostile-input tests, production builds, and a
zero-finding production audit. No durable state, route, or public reader
contract changes.

## Technical Context

**Runtime**: Node v26.5.0; Angular 22; TypeScript 6; Nx 23

**Primary dependencies**: `pdfjs-dist` 6.2.108; Fastify 5.x with patched
`fast-uri` 3.1.5 and 4.1.2 resolution; no new dependencies

**Storage**: N/A; dependency and generated worker assets only

**Testing**: Vitest/Angular unit tests for `reader-pdf` and `sync-gateway`;
Playwright Chromium/WebKit PDF journeys; production audit and builds

**Target platforms**: Web/PWA, Chromium, WebKit, shared desktop/Android Tauri
assets; packaged native and Android remain external gates

**Performance goals**: Preserve lazy PDF chunks, configured initial bundle
budget, 180-page virtualization, six-canvas bound, and teardown heap budget

**Constraints**: Offline-first, hostile PDFs and gateway input, explicit link
consent, bounded renderer lifecycle, deterministic lockfile

**Scope**: PDF rendering runtime and worker assets; gateway request validation
dependency graph; package manifest and lockfile; no API or durable schema change

## Constitution Check

_GATE: Passed before research and re-checked after design._

- [x] Local reading and durable writes remain authoritative offline.
- [x] Hostile inputs and credential boundaries are identified and preserved.
- [x] Owning Nx projects and public contracts are explicit.
- [x] Behavioral tests precede implementation tasks; browser gates are included
      where browser behavior matters.
- [x] Accessibility and applicable platform behavior have acceptance criteria.
- [x] Lifecycle, bundle, memory, storage, and performance effects are bounded.
- [x] Required and unavailable verification gates are distinguishable.
- [x] Product exclusions remain unchanged.

No exceptions are required. Post-design check remains PASS: the design changes
only locked runtime versions, adds hostile boundary coverage, and requires all
existing lazy-loading, offline, credential, lifecycle, and accessibility
contracts to remain intact.

## Impact and Ownership

### CodeGraph and Nx Impact

- **Entry points/symbols**: `PdfReaderEngine`, dynamic `import('pdfjs-dist')`,
  `GlobalWorkerOptions.workerSrc`, copied PDF worker/viewer assets,
  `buildSyncGateway`, Fastify schema compilers, `requireSameOriginMutation`, and
  confined provider route inputs.
- **Owning project(s)**: `reader-pdf`, `omnia-reader`, `omnia-reader-e2e`, and
  `sync-gateway`.
- **Affected consumers**: `ReaderEngineRegistry`, `ReaderPageComponent`, PDF
  thumbnails and E2E fixtures, gateway GitHub/MEGA routes, Docker/release builds.
- **Unchanged boundaries**: reader-domain/core contracts, EPUB engine,
  IndexedDB/OPFS schemas, backup formats, sync wire paths, provider credentials,
  Tauri commands, and MEGA native bridge protocol.

### Repository Paths

```text
package.json
package-lock.json
apps/omnia-reader/project.json
apps/omnia-reader-e2e/src/
apps/sync-gateway/src/
libs/reader/pdf/src/
specs/011-secure-runtime-dependencies/
```

## Design

### Contracts and State

- The shared `ReaderEngine` contract and PDF locators remain unchanged.
- Gateway HTTP routes, schemas, errors, and provider adapter interfaces remain
  unchanged.
- No durable record, migration, hash, tombstone, backup, or sync schema change.
- `package-lock.json` is the authoritative reviewed resolution; both vulnerable
  `fast-uri` major lines must resolve to patched releases.

### User Interface and Accessibility

- No new interface. Preserve PDF password focus/retry/cancel behavior,
  accessible form names, explicit external-link consent, keyboard navigation,
  progress, selections, annotations, and readable failures.

### Security and Failure Handling

- Upgrade `pdfjs-dist` to 6.2.108 or later within the reviewed compatible line,
  outside the advisory range ending below 6.2.108.
- Resolve `fast-uri` 3.x to at least 3.1.5 and 4.x to at least 4.1.2.
- Add explicit backslash-authority and encoded-separator rejection coverage at
  gateway route/adaptor boundaries; do not rely on package version alone.
- Production audit is fail-closed: no allow-list or severity suppression.
- Preserve PDF JavaScript disablement, link mediation, worker isolation, and
  gateway credentials/sessions in server-side boundaries.

### Lifecycle and Performance

- Keep PDF imports dynamic and worker source copied to
  `assets/pdfjs/pdf.worker.min.mjs`.
- Run production build and inspect initial/lazy chunks so PDF code remains lazy.
- Retain large-PDF virtualization, long-task, canvas, and teardown gates.
- Dependency refresh must not add a network request or persistent storage.

## Verification Plan

| Requirement/story      | Evidence                                                        | Command or environment                                                                                                                            |         Required locally? |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------: | ------------- | ------------- | --- |
| US1, FR-002–FR-004     | PDF engine API, malformed failure, links, password and teardown | `npx nx test reader-pdf --skip-nx-cache`                                                                                                          |                       Yes |
| US1, SC-003            | Real encrypted, interactive, malformed and hostile PDF journeys | `npx nx run omnia-reader-e2e:e2e -- --project=chromium --grep "encrypted PDF                                                                      |           interactive PDF | malformed PDF | hostile PDF"` | Yes |
| US1 compatibility      | WebKit PDF rendering/security subset                            | Same E2E grep with `--project=webkit`                                                                                                             |        Yes when installed |
| US1 lifecycle          | 180-page virtualization and cleanup                             | `npx nx run omnia-reader-e2e:performance`                                                                                                         |                       Yes |
| US2, FR-005–FR-007     | Gateway confinement/auth/provider behavior                      | `npx nx test sync-gateway --skip-nx-cache`                                                                                                        |                       Yes |
| US1/US2                | Affected lint                                                   | `npx nx run-many -t lint -p reader-pdf sync-gateway omnia-reader-e2e --skip-nx-cache`                                                             |                       Yes |
| FR-009, SC-005         | Application/gateway production builds and bundle inspection     | `npx nx build omnia-reader --configuration production --skip-nx-cache` and `npx nx build sync-gateway --configuration production --skip-nx-cache` |                       Yes |
| FR-001, FR-008, FR-010 | Clean locked graph and zero production findings                 | `npm ci` then `npm audit --omit=dev`                                                                                                              |                       Yes |
| Cross-cutting          | Whitespace                                                      | `git diff --check`                                                                                                                                |                       Yes |
| Host boundary          | Packaged desktop and Android regression                         | Documented package/emulator/device gates                                                                                                          | No; record if unavailable |

## Delivery and Documentation

- **Vertical slices**: First remove the hostile-PDF advisory and prove reader
  compatibility; then remove gateway validation advisories and prove
  confinement; finally run the combined audit/build/browser gate.
- **Migration/rollout**: Lockfile-only runtime rollout. No data migration;
  rollback is technically simple but security-invalid until a patched
  alternative is available.
- **Documentation**: Record exact advisory disposition and verification in this
  feature. Update `docs/universal-reader-plan.md` only after the clean audit and
  compatibility gates pass.
- **Residual gates**: Packaged desktop, Android emulator/device, and live
  credentialed providers remain explicit external evidence.

## Complexity and Exceptions

No constitution violations or exceptions.
