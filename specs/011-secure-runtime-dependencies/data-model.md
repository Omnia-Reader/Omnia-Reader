# Data Model: Secure Runtime Dependencies

This feature introduces no application durable state. It defines two evidence
records used to judge a release candidate.

## Locked Runtime Resolution

- **Identity**: package name plus resolved version and integrity digest.
- **Required members**: direct PDF runtime; all production gateway validation
  and serialization dependencies; their transitive production graph.
- **Validation**: every resolved version satisfies its parent range, every
  integrity digest is present, the graph is reproducible from the lock file,
  and no resolved production package is within an active advisory range.
- **Lifecycle**: reviewed when the lock file changes; replaced atomically by a
  clean install; never stored in user data.

## Security Verification Record

- **Identity**: source revision plus runtime/lockfile digest.
- **Fields**: audit command and result, PDF unit/browser results, gateway unit
  results, lint/build results, bundle observation, unavailable host gates.
- **State transitions**:
  - `VULNERABLE` -> audit identifies an affected production resolution.
  - `PATCHED_UNVERIFIED` -> lockfile is outside advisory ranges but functional
    gates are incomplete.
  - `VERIFIED` -> clean install, zero-finding audit, reader/gateway tests, and
    required builds/browser gates pass.
  - `REJECTED` -> audit, compatibility, security, build, or bundle gate fails.
- **Rollback**: no user data migration. A rollback into an affected range is
  `VULNERABLE` and cannot be promoted.
