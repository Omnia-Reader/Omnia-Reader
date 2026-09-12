# Live GitHub Conformance Contract

## Boundary

The conformance journey uses a production-shaped HTTPS application and gateway,
a disposable GitHub App installation, a uniquely named private repository, Git
LFS, shared production-shaped sessions, and isolated client profiles. It does
not call test-only authentication or provider-control routes.

Credentials and authenticated browser/native state are injected only by the
protected execution environment. They are never committed, printed, uploaded
as test artifacts, or made available to untrusted pull-request code.

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
