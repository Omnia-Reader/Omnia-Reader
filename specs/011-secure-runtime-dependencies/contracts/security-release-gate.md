# Security Release Gate Contract

## Dependency graph

- The repository lock file is the only accepted production dependency graph.
- PDF runtime versions in `>=5.6.83 <6.2.108` are rejected.
- URL parser versions in `>=3.0.0 <3.1.5` or `>=4.0.0 <4.1.2` are rejected.
- A production audit must exit successfully with zero findings; no local
  allow-list or ignored advisory is part of this contract.

## PDF boundary

- The PDF runtime remains lazy and uses the separately copied worker asset.
- Publication JavaScript remains disabled; HTTP(S) navigation remains mediated.
- Password values remain shell-owned and ephemeral.
- Malformed or hostile input cannot leave a mounted viewer, worker, object URL,
  listener, or persisted partial import after failure/teardown.

## Gateway boundary

- Current HTTP routes, schemas, authentication, CSRF, sessions, rate limits,
  provider adapters, and error redaction remain compatible.
- Backslash authority introducers, traversal, encoded separators, NULs,
  malformed URLs, and unconfined provider paths are rejected before mutation.
- Provider-controlled errors never echo secrets or untrusted detail to clients.

## Evidence

Acceptance requires a clean locked install, a zero-finding production audit,
focused PDF and gateway suites, production application/gateway builds, required
Chromium and WebKit PDF journeys, and explicit disposition of unavailable
packaged/native/device gates.
