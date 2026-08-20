# Multi-format performance profiles

The executable profiles live in
[`src/performance.spec.ts`](../src/performance.spec.ts) and run serially through
the `omnia-reader-e2e:performance` Nx target. Their fixture sizes and budgets
are constants in that test and must not be reduced to obtain a pass.

| Profile          | Fixture                            | Required evidence                                                                 |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| PDF lifecycle    | 180 generated pages                | import/open latency, bounded canvases, long-task budget, post-close retained heap |
| EPUB lifecycle   | 80 generated chapters, over 750 KB | import/open latency, bounded iframes, long-task budget, post-close retained heap  |
| Streaming backup | both large publications            | bounded write chunks, no final archive object URL, completed stream               |

Run with `npx nx run omnia-reader-e2e:performance`. Record results in
`specs/001-multi-format-books/performance/results.md`; a browser or metric gate
that cannot run is `UNVERIFIED`, never `PASS`.

## Deterministic management evidence

The dependency-free Node evidence core validates the immutable
`multi-format-performance-v1` profile set, deterministic 1,000-logical-book /
2,000-variant workload, fourteen management branches, five unpooled
distributions, page-owned timing, sampling identity, and launcher lifecycle.
Run the complete contract suite with:

```sh
npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache
```

The real-browser supplemental smoke drives one sample for every management
branch and distribution through labelled product controls:

```sh
npx nx run omnia-reader-e2e:performance-management-branch-smoke \
  --skip-nx-cache --outputStyle=stream
```

This smoke includes the production build but does not satisfy primary sample
cardinality and must never be reported as SC-004 evidence.

Preflight the current desktop host without starting Playwright with:

```sh
node apps/omnia-reader-e2e/performance/validate-profile.mjs \
  specs/001-multi-format-books/performance/profiles-v1.json \
  desktop-web-v1
```

Only `READY` permits the desktop driver to start sampling. Run the primary
driver with:

```sh
npx nx run omnia-reader-e2e:performance-desktop-web --skip-nx-cache
```

On a qualified host, pass a reviewed environment record when the default host
capture cannot supply browser/display fields:

```sh
npx nx run omnia-reader-e2e:performance-desktop-web --skip-nx-cache -- \
  --environment /absolute/path/to/desktop-web-environment.json
```

The launcher rechecks Git, Chromium, viewport, device scale, effective cgroup
CPU/memory limits, and AC power mode before sampling. It then runs 20 real
samples for every acknowledgement branch and, for each distribution, 20
discarded warm-ups plus 200 measured samples. Setup is outside timed intervals.
Only evaluator-valid `PASS` or `FAIL` evidence is atomically promoted beneath
`specs/001-multi-format-books/performance/results/`.

Verified on 2026-08-20: the evidence contracts passed 43/43, the focused
library suite passed 36/36, both affected lint targets passed, and the complete
branch smoke passed its one active Chromium journey with three expected mode
skips. The clean current host returned `UNVERIFIED` before Playwright because
the frozen constraint, power, viewport, device-scale, and Chromium runtime
values were not supplied; no primary desktop result was written.

`UNVERIFIED` and `SUPPLEMENTAL` remain non-acceptance outcomes. Mobile-web,
packaged-desktop, and Android drivers and qualified measurements remain
required, and all four profiles must pass independently before aggregate
SC-004 can pass. Mobile-web and Android v1 identities remain unresolved until
the exact AVD snapshot and Chrome/WebView versions are frozen in a new profile
set.
