# Multi-format performance results

## 2026-08-20 deterministic run

- Source revision: `a648d28` plus the current feature-001 working tree
- Runtime: Node `v26.5.0`, Playwright `1.61.1`, Chromium for Testing
  `149.0.7827.55`
- Host: Linux `7.0.0-29-generic`, x86-64
- Command: `npx nx run omnia-reader-e2e:performance`

| Immutable profile               | Result | Evidence                                                                                |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| 180-page PDF lifecycle          | PASS   | virtualization, latency, long-task, cleanup, and retained-heap assertions passed        |
| 80-chapter EPUB lifecycle       | PASS   | incremental rendering, latency, long-task, cleanup, and retained-heap assertions passed |
| Large PDF+EPUB streaming backup | PASS   | bounded chunks, completed stream, and no final backup Blob URL assertions passed        |

Result: 3/3 Playwright Chromium profiles passed in 8.2 seconds. The first run
exposed stale title-text navigation in the harness; it was corrected to use the
public accessible format controls and the unchanged immutable profiles then
passed.

The 40-participant usability study, credentialed live-provider matrix,
packaged-native/Android performance, and manual assistive-technology matrix are
outside this automated result and remain `UNVERIFIED`.
