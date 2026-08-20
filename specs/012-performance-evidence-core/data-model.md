# Data Model: Fail-Closed Performance Evidence Core

## ProfileSetV1

- `schemaVersion`: exactly `1`
- `profileSetId`: exactly `multi-format-performance-v1`
- `profileSetDigest`: lowercase `sha256:<64 hex>` over canonical content with
  this field omitted
- `dataset`: immutable recipe ID, seed, 1,000 logical books, 2,000 exact
  variants, EPUB/PDF format set, and 500-change history bound
- `measurement`: acknowledgement/final thresholds, warm-up/minimum/maximum
  sample counts, fourteen ordered branch IDs, five ordered distribution IDs,
  and zero-tolerance counter names
- `profiles`: exactly one record for each approved profile ID

Validation rejects unknown keys, missing values, duplicates, non-canonical
identifiers, counts outside the fixed contract, and a digest mismatch.

## PerformanceProfileV1

- `id`: one of `desktop-web-v1`, `mobile-web-v1`,
  `packaged-desktop-v1`, `android-v1`
- `platform`: matching platform category
- `source`: required repository Node/lock identity
- `runtime`: exact browser/WebView/Tauri runtime identities
- `environment`: OS/device, architecture, CPU/memory constraint, power, display,
  and scale identities applicable to the profile
- `artifact`: required only for packaged desktop/Android; release kind and
  digest requirement
- `driver`: one exact approved driver ID

Profile records are immutable under v1. A changed accepted environment creates
a new profile-set version.

## EnvironmentRecordV1

- `schemaVersion`: exactly `1`
- `profileSetId`, `profileSetDigest`, `profileId`
- `intent`: `primary` or `supplemental`
- `availability`: `available` or `unavailable`
- `unavailableReasons`: bounded non-empty strings only when unavailable
- `git`: commit SHA and dirty state
- `source`, `runtime`, `environment`, `dataset`, `artifact`, `driver`: captured
  identities corresponding to the selected profile

### Preflight transitions

- structurally invalid -> rejected, no disposition
- unavailable exact environment -> `UNVERIFIED`, `mayMeasure=false`
- deliberate non-primary/dirty/unconstrained/emulated substitute ->
  `SUPPLEMENTAL`, `mayMeasure=false`
- available primary with any mismatch -> `UNVERIFIED`, `mayMeasure=false`
- exact available clean primary -> `READY`, `mayMeasure=true`

`READY` is a preflight state, not raw-result evidence and never counts as a
performance pass.

## PreflightReportV1

- `schemaVersion`, profile-set identity, profile ID
- `status`: `READY`, `UNVERIFIED`, or `SUPPLEMENTAL`
- `mayMeasure`: true only for `READY`
- `reasons`: bounded stable `{code, path, message}` records in deterministic
  order

## RawPerformanceResultV1

- profile-set/profile/source/environment identity
- `preflightStatus`: exact prior `READY`, `UNVERIFIED`, or `SUPPLEMENTAL`
- `command`, `recordedAt`
- `acknowledgements`: fourteen unique `{branchId, samplesMs}` records
- `distributions`: five unique records with `distributionId`, exactly twenty
  discarded `warmupsMs`, at least 200 `samplesMs`, and optional producer summary
- `counters`: exact zero-tolerance names with non-negative integer counts
- `statistics`: evaluator-produced per-distribution count, p50, p95, maximum,
  and within-target ratio
- `disposition`: evaluator-produced `PASS`, `FAIL`, `UNVERIFIED`, or
  `SUPPLEMENTAL`
- `reasons`: stable bounded evaluation failures

`UNVERIFIED` and `SUPPLEMENTAL` records may omit measurement collections only
when they explicitly record no claimed measurements. A `READY` result requires
the complete measurement matrix.

## AggregateReportV1

- one validated result slot per approved profile ID
- `status`: `PASS` only for four current primary passes, otherwise `INCOMPLETE`
- `results`: profile ID, disposition, evidence identity/path
- `blocking`: missing, duplicate, stale, failed, unverified, or supplemental
  profile reasons

The aggregate never combines timing arrays or recalculates a pooled statistic.
