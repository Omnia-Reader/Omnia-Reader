# Multi-format usability results

## Release study status

Status on 2026-08-20: **UNVERIFIED**.

The required 40-person study has not been executed in this development
environment. No participants, timings, success counts, median, p95, or failure
observations are available, so SC-001 is not claimed as passed. The fixed cohort
and input allocation in `quickstart.md` remains the release protocol:

- EPUB plus local PDF: 20 participants (8 pointer, 6 keyboard, 6 touch)
- PDF plus local EPUB: 20 participants (8 pointer, 6 keyboard, 6 touch)
- required threshold: at least 19/20 in each direction and 38/40 overall

Automated unit, Chromium, accessibility, offline, and performance evidence is
supplemental to this human acceptance gate and does not replace it.

## External host and provider gates

| Gate                                | Status     | Reason                                                    |
| ----------------------------------- | ---------- | --------------------------------------------------------- |
| Credentialed GitHub provider matrix | UNVERIFIED | no live provider credentials or destination were supplied |
| Credentialed MEGA provider matrix   | UNVERIFIED | no live provider credentials or destination were supplied |
| Packaged desktop host               | UNVERIFIED | package build and installed-host journey were not run     |
| Android emulator                    | UNVERIFIED | no configured emulator was available in this run          |
| Physical Android device             | UNVERIFIED | no device was attached for acceptance evidence            |

The simulated Git/MEGA browser suite passed the new exact-object recovery
journey, but simulated transports do not satisfy the credentialed matrix.
