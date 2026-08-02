# Low-Latency Local-First Synchronization Contract

## Local activity

- A durable non-book operation restarts a 1,000 ms trailing timer.
- Multiple operations inside the window create one attempt.
- Book, background, online, startup, and destination events remain immediate.
- Provider `Retry-After` overrides shorter schedules.

## Remote discovery

- A visible, online GitHub client checks `GET /api/sync/github/revision` every ten seconds.
- Hidden, offline, stopped, and non-Git clients issue no periodic checks.
- Foregrounding a GitHub client performs one immediate recovery check.
- An unchanged trusted revision performs no document or Git LFS work.

## Unsupported notification surface

- No GitHub `push` event subscription is required.
- No public webhook endpoint or webhook secret is required for synchronization.
- No `/api/sync/github/events` route or browser `EventSource` contract exists.
- The existing authorization-revocation webhook remains a separate optional security feature.
