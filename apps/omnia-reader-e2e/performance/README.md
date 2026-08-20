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

## Fail-closed evidence core

The dependency-free Node evidence core validates the immutable
`multi-format-performance-v1` profile set before any acceptance measurement is
claimed. Run its contract suite with:

```sh
npx nx run omnia-reader-e2e:performance-evidence-test --skip-nx-cache
```

Preflight the current desktop host with:

```sh
node apps/omnia-reader-e2e/performance/validate-profile.mjs \
  specs/001-multi-format-books/performance/profiles-v1.json \
  desktop-web-v1
```

Only `READY` permits a profile driver to start sampling. `UNVERIFIED` and
`SUPPLEMENTAL` remain non-acceptance outcomes, and actual desktop-web,
mobile-web, packaged-desktop, and Android profile drivers and measurements are
still required before SC-004 can pass. The mobile-web and Android v1 identities
remain explicitly unresolved until exact AVD snapshot and Chrome/WebView
versions are frozen in a new profile-set version.
