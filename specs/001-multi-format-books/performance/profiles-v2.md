# Performance Profile Set v2

Profile set v2 is an additive qualification contract for the same frozen
multi-format management workload and thresholds as v1. It exists so reviewed
mobile-browser, release-package, emulator-snapshot, WebView, and automation
identities can be recorded without editing or reinterpreting v1 evidence.

The implementation allowlists `multi-format-performance-v2` and the ordered
profile IDs `desktop-web-v2`, `mobile-web-v2`, `packaged-desktop-v2`, and
`android-v2`. This document is not a primary profile set and contains no live
identity values.

`profiles-v2.json` must not be created until all required values come from
reviewed real artifacts and qualification probes. Placeholder digests, debug
packages, mutable AVDs, browser emulation, and unresolved automation boundaries
are invalid. Until then, each new live platform command must stop before
sampling with an explicit `UNVERIFIED` outcome.
