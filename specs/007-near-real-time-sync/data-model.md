# Data Model: Low-Latency Local-First Synchronization

No durable schema changes.

## Revision check timer

- One process-local handle owned by `AutoSyncScheduler`.
- Active only while started, visible, online, and GitHub-selected.
- Cleared on hidden, offline, provider change, or stop.
- Fires every ten seconds and enters the existing single-flight change-aware worker.

## Existing authority

- The operation journal determines unsent local work.
- The trusted GitHub revision checkpoint determines whether remote work changed.
- Provider `Retry-After` determines backoff.
- Merge records, tombstones, and publication integrity records remain unchanged.

There is no remote-change hint, gateway subscriber, EventSource, or push replay entry.
