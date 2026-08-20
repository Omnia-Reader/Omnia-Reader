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
