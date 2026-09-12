# Packaged Synchronization Boundary Contract

## Browser/PWA path

Browser-readable synchronization continues to use relative same-origin HTTPS
gateway routes and provider-scoped HttpOnly cookies. Origin, request-forgery,
path, schema, size, digest, and content-type checks remain unchanged.

## Packaged path

Tauri desktop and Android use an application-owned native broker implementing
the existing logical synchronization transport. The broker:

- allowlists exactly one configured HTTPS gateway origin;
- exposes enumerated provider/session/document/object operations, never a
  generic URL/method/header request primitive;
- owns cookies, reusable sessions, request-forgery state, redirect policy, and
  conditional protected persistence outside webview-readable storage;
- rejects userinfo, fragments, non-HTTPS production origins, literal private or
  loopback destinations except explicit development profiles, cross-origin
  redirects, unknown response shapes, and unbounded bodies;
- streams publication bodies through bounded IPC chunks or opaque transfer
  handles with monotonic progress and cancellation;
- returns only validated domain data and application-owned error codes;
- deletes local authority before provider disconnect/revocation; and
- aborts active work and releases listeners, files, and in-memory secrets on
  teardown.

Reusable authority may survive restart only when a Rust-only encrypted store
proves host-protected bootstrap and canary secrecy on that platform. Otherwise
the broker uses session-only authority, clears it on exit, and exposes a
truthful reconnect-required state while preserving local data and pending work.
It must never fall back silently to plaintext files, webview storage, or a
hard-coded encryption secret.

## Authorization handoff

1. The packaged client asks the broker to begin authorization with a random
   native request binding.
2. The gateway returns an HTTPS authorization URL; the system browser owns the
   provider interaction.
3. The public callback creates a short-lived, single-use opaque handoff and
   opens the registered Omnia Reader deep link.
4. The native broker validates scheme, request binding, provider, expiry, and
   replay state, then redeems the handoff directly into its opaque session jar.
5. The webview receives only sanitized readiness state.

The handoff never contains provider tokens, gateway cookies, reusable session
material, account passwords, or publication content.

The system-browser flow uses a dedicated provider-scoped pending cookie, so it
does not overwrite an existing browser/PWA session. Successful callbacks move
the authenticated replacement session identifier directly into an encrypted
five-minute handoff record and clear the pending browser cookie. Redemption is
an atomic get-and-delete operation in memory, the single-node encrypted file
store, or Redis; a replay cannot produce another provider cookie.

## Proof-first gate

Before completing the full transport, a packaged Linux application and Android
emulator must prove that the current relative browser route does not reach the
gateway and that the broker:

- denies arbitrary hosts, paths, headers, and cross-origin redirects;
- keeps unique cookie/session canaries out of IPC, browser storage, response
  headers, redirects, logs, and crash diagnostics;
- rejects forged, replayed, mismatched, and expired handoffs;
- either preserves an authorized session across an ordinary app restart using
  proven protected storage or clears it and requires reauthentication according
  to the declared host capability; and
- streams, cancels, and safely retries a 25 MiB publication.
