# Research: Low-Latency Local-First Synchronization

## Decision: revision polling is the local-first remote signal

- **Decision**: Poll the lightweight GitHub revision every ten seconds while visible and online.
- **Rationale**: GitHub offers no client-side repository change stream. A desktop or mobile process behind NAT cannot receive GitHub webhooks without a public relay. The existing revision checkpoint makes unchanged polls inexpensive and authoritative.
- **Alternatives rejected**: webhook/SSE fan-out requires a remote deployment; two-second polling consumes unnecessary quota; full-sync polling repeats document and LFS work; moving the timer to Rust does not change GitHub notification semantics.

## Decision: 750 ms trailing progress debounce

- **Decision**: Coalesce page-progress activity for 750 ms, keep interactive annotations/bookmarks on their separate latency budget, allow conflict-free targeted reading-state continuation until idle reconciliation, and remove the five-minute successful-sync floor.
- **Rationale**: The shorter trailing window reduces perceived latency. Targeted continuation prevents later page batches from re-entering the full-library pipeline, while active-sync queuing still collapses concurrent changes. Local progress remains durable immediately, and GitHub `Retry-After` remains the adaptive throttle.

## Decision: remove unused notification infrastructure

- **Decision**: Delete the push broker, repository-scoped SSE route, EventSource client, selected-destination key extension, and stream lifecycle tests.
- **Rationale**: They add configuration and lifecycle surface without working in the supported topology. The existing authorization-revocation webhook remains independent and unchanged.
