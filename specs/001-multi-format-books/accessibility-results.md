# Multi-format assistive-technology results

Status on 2026-08-20: the required 24 manual cells remain **UNVERIFIED**.
The named OS, screen-reader, browser/WebView, and device combinations were not
available in this development run. Automated axe-core WCAG A/AA checks passed
in Chromium for the library (including unavailable-source recovery focus),
settings, PDF shell, and EPUB shell; that evidence does not replace this matrix.

| Journey                               | NVDA + Firefox | VoiceOver + Safari | TalkBack + Android WebView |
| ------------------------------------- | -------------- | ------------------ | -------------------------- |
| Add another format                    | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |
| Associate existing entries            | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |
| Choose or switch format               | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |
| Detach a variant                      | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |
| Delete a variant                      | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |
| Reconcile a synchronization conflict  | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |
| Manage all variants unavailable       | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |
| Review the full restore-conflict list | UNVERIFIED     | UNVERIFIED         | UNVERIFIED                 |

Before release, each cell must record the build, tester, platform and AT/browser
versions, fixture, announcement transcript, focus sequence/restoration target,
result, and defect or blocker link exactly as required by `quickstart.md`.
