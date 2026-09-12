# Live GitHub Conformance Contract

## Boundary

The conformance journey uses a production-shaped HTTPS application and gateway,
a disposable GitHub App installation, a uniquely named private repository, Git
LFS, shared production-shaped sessions, and isolated client profiles. It does
not call test-only authentication or provider-control routes.

Credentials and authenticated browser/native state are injected only by the
protected execution environment. They are never committed, printed, uploaded
as test artifacts, or made available to untrusted pull-request code.

## Protected runner inputs

The Playwright journey is disabled unless `LIVE_GITHUB_SYNC_E2E=1`. An enabled
run fails closed unless all of these protected inputs are present:

- `LIVE_GITHUB_PROTECTED_RUNNER=1` confirms that trust policy was evaluated by
  the caller. The protected workflow must still reject pull-request execution.
- `BASE_URL` identifies a non-loopback, non-placeholder HTTPS deployment. The
  Playwright configuration does not start or substitute a local web server.
- `LIVE_GITHUB_AUTH_STATE` is an absolute path to Playwright storage state that
  contains `github.com` cookies/origins only. Application and gateway session
  state is deliberately rejected so every isolated client uses the public
  authorization boundary.
- `LIVE_GITHUB_CONTROL_DRIVER` is an absolute path to an operator-supplied
  executable. Its credentials stay in the runner environment and are never
  passed to the application or committed test code.
- `LIVE_GITHUB_RUN_ID` is a unique 8-40 character lowercase identifier. The
  journey creates only `omnia-reader-live-<run-id>`.
- `LIVE_GITHUB_SECRET_CANARY` is a unique 20-256 character protected value used
  to detect unsafe provider-error disclosure.
- `LIVE_GITHUB_THROTTLE_AVAILABLE` is exactly `0` or `1`. A zero value permits
  only the throttle step to return `unavailable`; it does not weaken any other
  live gate.

The control executable accepts
`--operation <name> --run-id <id> --repository <name>` and prints one JSON value
to stdout. The envelope is
`{"schemaVersion":1,"operation":"...","runId":"...","repository":"...","outcome":"ok|unavailable","evidence":{...}}`.
Every identity field must match the request. Non-zero exit, malformed output,
or `unavailable` for a required operation fails the run without echoing driver
stdout/stderr. Supported operations are `prepare`, `restart-gateway`,
`interrupt-lfs-once`, `force-conflict-once`, `expire-provider-token`,
`revoke-authorization`, `remove-repository-access`,
`restore-repository-access`, `inject-provider-error-once`, `throttle-once`,
`inspect`, and `cleanup`.

`expire-provider-token` expires the provider access token while retaining a
valid refresh grant; the next ordinary application request must refresh it
without user interaction. `revoke-authorization` revokes that grant and
invalidates its gateway session so the next ordinary application request
requires the public authorization flow again.

`inspect` evidence reports `privateRepository`, `publications` (exact `sha256`,
`size`, and `pointerPublished`), `danglingPointers`,
`acknowledgedWithoutPointer`, and `authorizationOrphans`. Successful cleanup
reports `repositoryDeleted` and `authorizationRevoked`. The driver must scope
every mutation to both the supplied run ID and exact repository name; a mismatch
is a refusal, never a discovery or wildcard cleanup. Cleanup is idempotent and
reports successful absence when a partially failed journey did not create the
repository.

## Required journeys

1. Connect through the public authorization flow, select or create the private
   destination, and verify session continuity after gateway replica restart.
2. Synchronize exact EPUB and PDF bytes plus progress, bookmarks, annotations,
   membership, and deletion tombstones between two isolated clients.
3. Restore the complete library and reading state on a clean replacement
   client.
4. Interrupt a large Git LFS upload before pointer publication, retry, and
   verify there is no dangling pointer or acknowledged local operation.
5. Produce an optimistic document conflict and prove deterministic retry.
6. Refresh an expiring session, revoke authorization, remove and restore
   repository permission, disconnect, and reconnect without orphaned authority.
7. Observe provider throttling through a safe staging mechanism when available;
   otherwise retain deterministic rate-limit coverage and record the live gate
   as unavailable rather than manufacturing provider traffic.
8. Delete the temporary repository and authorization through an explicitly
   scoped cleanup identity after evidence has been captured.

## Assertions

- Remote and restored publication digests and sizes equal the imported editions.
- Both clients converge on every distinct valid contribution and tombstone.
- Local reading and mutation remain usable during every induced failure.
- Pending work remains until remote confirmation and converges exactly once.
- Browser-visible and captured diagnostic surfaces contain none of the unique
  secret canaries.
- Every observed error and recovery instruction is application-owned and
  contains no raw provider response text.

## Failure policy

Cleanup failure does not turn a failed conformance run into a pass. It creates a
separate operator-action result and must not cause broader deletion. Provider
outage, quota, credential unavailability, or protected-runner unavailability is
reported as an unavailable production gate.
