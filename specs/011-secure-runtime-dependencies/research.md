# Research: Secure Runtime Dependencies

## Decision 1: Upgrade PDF.js to 6.2.108

**Decision**: Replace `pdfjs-dist` 6.1.200 with 6.2.108, the current registry
release and first release outside GHSA-hq66-cqwq-w95j's affected
`>=5.6.83 <6.2.108` range.

**Rationale**: The advisory describes arbitrary JavaScript execution from a
malicious PDF. PDF files are a primary hostile-input boundary; mitigation by
configuration alone is not accepted by the release contract. Node v26.5.0
satisfies the package's `>=22.13.0 || >=24` engine requirement.

**Alternatives considered**: Pinning the vulnerable version with advisory
suppression was rejected. Downgrading below 5.6.83 was rejected because it
would discard current compatibility/security fixes and expand API drift.

## Decision 2: Refresh both fast-uri major lines

**Decision**: Resolve the 3.x dependency line to 3.1.5 and the 4.x dependency
line to 4.1.2, outside GHSA-7p8r-x3mc-p8w7.

**Rationale**: The locked production graph currently contains 3.1.4 through
the validation compiler and 4.1.1 through response serialization. Existing
semver ranges admit the patched versions, so a lock refresh removes the finding
without changing gateway APIs or adding an override.

**Alternatives considered**: A root override was reserved as fallback because
normal compatible resolution is simpler and preserves package ownership.
Upgrading Fastify from 5.10.0 to 5.12.1 may be used only if the lock refresh
cannot produce a clean supported graph.

## Decision 3: Treat zero production findings as the acceptance boundary

**Decision**: `npm audit --omit=dev` must report zero findings after a clean
locked install; no advisory exceptions are added.

**Rationale**: The release plan already defines a clean production audit as a
fail-closed gate. The observed audit contained eight high findings, but six are
dependency-chain effects of the two vulnerable packages rather than six
independent remediation decisions.

**Alternatives considered**: Severity-only filtering and audit allow-lists were
rejected because both root advisories affect hostile-input integrity.

## Decision 4: Preserve current public contracts and lazy assets

**Decision**: Adapt only private PDF integration details if 6.2.108 changes
types or runtime APIs; keep engine contracts, gateway routes, durable state,
worker URL, and asset layout unchanged.

**Rationale**: This keeps the security patch independently reversible without
data migration and allows existing hostile, encrypted, interactive, malformed,
large, and lifecycle fixtures to serve as regression evidence.

PDF.js 6.2.108 no longer exposes the earlier `isEvalSupported` document-load
option. The integration therefore retains the supported data-only load,
explicit worker asset, and absence of a scripting manager; inert publication
JavaScript is proven by the Chromium and WebKit hostile-document journey.

**Alternatives considered**: A PDF engine redesign or gateway schema migration
was rejected as unrelated risk.
