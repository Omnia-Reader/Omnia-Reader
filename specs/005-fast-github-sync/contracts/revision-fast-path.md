# Contract: GitHub Destination Revision and Fast Path

## Gateway endpoint

`GET /api/sync/github/revision`

- Uses the existing provider-scoped HttpOnly session and selected repository.
- Is read-only and requires no CSRF mutation header.
- Returns `Cache-Control: no-store` and JSON:

```json
{ "revision": "opaque bounded destination revision" }
```

- Returns existing safe `401`, `403`, `404`, `429`, `502`, or `504` application
  errors for invalid session, lost access, no destination, quota, provider
  failure, or timeout. Provider-controlled messages are never forwarded.
- Empty selected repositories return a valid destination-scoped empty revision.
- No document content, blob, LFS metadata, or publication is read.

## Browser transport capability

```text
destinationRevision({ signal? }) -> Promise<string | null>
```

- Optional on the provider-neutral transport.
- GitHub implements it with exactly one gateway request.
- Cancellation aborts the browser request and does not update checkpoint state.
- The selected transport returns `null` for a provider without the optional
  capability; this means complete sync, never success-by-assumption.

## Checkpoint fast path

The wrapper may return
`{ pulled: 0, pushed: 0, conflicts: 0, rejected: 0, unchanged: true }` without
invoking its delegate if and only if all are true:

1. The selected provider is GitHub/Git.
2. The transport supports the revision capability.
3. The durable operation journal is empty.
4. The current destination revision equals a valid trusted checkpoint.

Every other state invokes the existing complete delegate. A successful complete
pass may establish a checkpoint only if:

1. its pre- and post-pass destination revisions are equal;
2. the journal is still empty afterward;
3. the result reports zero pushed, conflicted, and rejected records; and
4. it was not cancelled and did not fail.

When a successful pass reports a push or observes a changed revision, the
wrapper runs the complete delegate exactly once more in the same synchronization.
That bounded verification pass may establish the checkpoint only when its
pre/post revision is stable, it reports no push, conflict, or rejection, and the
journal remains empty. Continued instability falls back to no checkpoint rather
than scheduling an unbounded loop.

Checkpoint I/O failure is ignored. Probe or delegate failure is not converted to
success. Concurrent wrapper calls share one active promise. The internal
`unchanged` marker lets status consumers retain already-current provider views
without issuing their own document-list refresh; persisted history validates it
as an optional literal `true` for backward compatibility.
