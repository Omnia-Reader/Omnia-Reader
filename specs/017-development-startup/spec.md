# Reliable full development startup

Reduced regression workflow for development tooling; no provider, persistence,
reader, or production HTTP behavior changes.

- `npm run start:full` must wait for the configured proxy target's `/readyz`
  response identifying a ready Omnia gateway before starting Angular.
- Readiness failures must produce a bounded, actionable error rather than launch
  an application whose startup requests all encounter connection refusal.
- Gateway development must retain automatic rebuild/restart while avoiding the
  deprecated Nx ESM loader and its default inspector. Use CommonJS only for
  the development bundle; preserve production ESM. Remove the redundant
  pre-build because the Node executor already builds and watches its target.
- Nx must retain ownership of the continuous processes and shutdown cleanup.

Tests: readiness retry, refusal, wrong service, timeout; cold full startup,
proxied session response, watched rebuild, and shutdown. Preserve existing
working-tree edits and do not terminate unrelated running servers.
