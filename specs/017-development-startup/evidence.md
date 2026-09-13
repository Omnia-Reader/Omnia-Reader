# Startup regression evidence

## Changes

- `start:full` uses a dedicated Nx development target. Angular waits for a
  successful `/readyz` response from the target configured in proxy.conf.json.
  A 60-second deadline reports an actionable startup error.
- The gateway remains a direct continuous dependency of the long-running app
  target, as well as the readiness task, so its lifetime covers the app session.
- Gateway development bundles use CommonJS, avoiding the Nx ESM loader's
  deprecated `module.register()` call. The inspector is disabled by default.
- The redundant gateway `dependsOn: build` is removed: the existing Node
  executor already runs the watched build before launching the gateway.
- Development uses a separate output directory and skips generating deployment
  package/lockfile metadata. Production still builds ESM with deployment metadata.
  Type checking remains enabled. No dependency upgrades or warning suppression.

## Validation

- `NX_DAEMON=false npx nx build sync-gateway --configuration production`: passed.
- Formatting checks and `git diff --check`: passed.

- `NX_DAEMON=false npx nx run-many -t lint -p omnia-reader,sync-gateway`: passed.
- `NX_DAEMON=false npx nx build omnia-reader --configuration production`: passed
  in 11.5 seconds (single run, not a before/after speed comparison).

- `node --test tools/wait-for-gateway.spec.mjs`: four passed. Covers transient
  unready responses, wrong service identity, hanging requests, and connection
  refusal with a bounded diagnostic.
- `NX_DAEMON=false npm run start:full -- --port=4303`: watched gateway build
  completed, gateway listened on 3333, readiness succeeded, then Angular started.
  No `ECONNREFUSED`, `DEP0205`, or inspector banner in this run.
- `curl --max-time 3 -s -o /tmp/omnia-session-isolated.json -w '%{http_code}\n' http://localhost:4303/api/sync/github/session`:
  HTTP 200 through the Angular proxy.
- Temporary source probe in gateway main.ts: source edit rebuilt/restarted the
  gateway; restoring the original bytes rebuilt/restarted it again. `/readyz`
  returned HTTP 200 afterward. main.ts has no remaining diff.
- Headless Chromium opened the development Library and requested the proxied
  session endpoint: visible Library, HTTP 200, zero page or failed-request events.

Earlier experimental launchers exposed output-directory deletion, nested Nx
invocation, and leftover-process issues; those launchers are not in the final
change. The final implementation retains the original Nx Node executor. After
old test processes were cleared, final normal-port verification passed:

- `NX_DAEMON=false npm run start:full`: frontend HTTP ready on port 4300 after
  17.34 seconds in this run. Gateway readiness on 3333 and the proxied session
  endpoint both returned HTTP 200.
- Fresh headless Chromium: Library visible, zero page errors or failed requests.
- Readiness log precedes frontend availability. No `ECONNREFUSED`, `DEP0205`,
  debugger banner, or recursive Nx invocation in the final startup log.
- The test harness stopped its own process tree afterward. `ss -ltn
'( sport = :3333 or sport = :4300 or sport = :4301 )'` confirmed all three ports
  clear. This verifies harness cleanup; interactive Ctrl+C cleanup alone was
  not separately established.

Startup improvements remove known duplicate build and packaging work. No numeric
speedup is claimed: the exploratory runs overlapped stale watchers and do not
provide a controlled before/after timing comparison.

## References and boundaries

[Nx continuous-task configuration](https://nx.dev/docs/getting-started/tutorials/configuring-tasks)
explains continuous dependencies; application readiness is explicitly checked
rather than inferred from process launch.

Verified against Node v26.5.0 and the installed Nx 23.1.0 executor source. No
provider sign-in, remote publication transfer, Redis HA, packaged native, or
physical-device testing. Existing unrelated edits are preserved.
