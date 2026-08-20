# Research: Fail-Closed Performance Evidence Core

## Decision 1: Use dependency-free ECMAScript modules

**Decision**: Implement the evidence core with the Node standard library and
the built-in test runner inside `apps/omnia-reader-e2e/performance/`.

**Rationale**: The repository already pins the required Node runtime. Avoiding
a schema/statistics dependency keeps release evidence available after a locked
offline install and avoids adding supply-chain or bundle risk to application
code.

**Alternatives considered**: A general JSON-schema validator was rejected
because this narrow, bounded contract still needs semantic checks that schema
alone cannot express. TypeScript compilation was rejected for CLIs that must run
directly before Nx/browser setup.

## Decision 2: Canonical hash excludes only its claimed digest

**Decision**: Recursively sort object keys, preserve array order, serialize
without insignificant whitespace, omit the top-level `profileSetDigest` field,
and hash the remaining UTF-8 bytes with SHA-256.

**Rationale**: The digest can be independently recomputed without a recursive
self-hash. Object formatting/order changes do not create false drift, while
array order and every semantic value remain identity-bearing.

**Alternatives considered**: Hashing file bytes would make harmless formatting
identity-bearing. Leaving the digest blank during hashing is less explicit and
can produce multiple equivalent representations.

## Decision 3: Separate invalid input from evidence disposition

**Decision**: Reject malformed, unknown, unbounded, or inconsistent documents as
invalid. Assign `PASS`, `FAIL`, `UNVERIFIED`, or `SUPPLEMENTAL` only to
structurally valid evidence with the prerequisites for that disposition.

**Rationale**: Treating corrupt data as `UNVERIFIED` would preserve it as if it
were trustworthy evidence of environmental absence. Treating threshold failure
as invalid would hide a real regression.

**Alternatives considered**: One catch-all failure status was rejected because
release reviewers must distinguish absent evidence, deliberate supplementary
data, measured regression, and corrupt evidence.

## Decision 4: Recompute deterministic nearest-rank statistics

**Decision**: Sort each raw finite millisecond distribution ascending; use the
middle value/average for median, nearest-rank p95 at
`ceil(0.95 × count) - 1`, the last value for maximum, and the exact fraction of
samples at or below the target for `withinTargetRatio`.

**Rationale**: This rule is deterministic, transparent, and does not depend on
producer/library interpolation choices. Raw arrays remain authoritative.

**Alternatives considered**: Linear interpolation and producer-supplied
statistics were rejected because they can vary by library and permit a summary
to disagree with the evidence.

## Decision 5: Bound every hostile collection

**Decision**: Limit input to 8 MiB, nesting to 32, profiles to four,
acknowledgement branches to fourteen, distributions to five, samples to 10,000
per collection, reasons to 256, and strings/numbers according to their fields.

**Rationale**: Evidence files are repository-controlled in normal use but may
come from external runners. Explicit bounds prevent memory amplification and
make failure output predictable without constraining the approved minimum
sample sizes.

**Alternatives considered**: Trusting checked-in files was rejected because raw
CI/native evidence crosses host boundaries. Streaming JSON was unnecessary
within the fixed 8 MiB contract.

## Decision 6: Keep output atomic and path-confined

**Decision**: Evidence writes resolve beneath
`specs/001-multi-format-books/performance/results/`, reject traversal/symlink
escape, create an exclusive temporary sibling, and rename only after complete
canonical serialization. CLIs default to stdout and need no filesystem write.

**Rationale**: Interrupted writers must not replace valid evidence with partial
JSON, and hostile result metadata must not choose an arbitrary output path.

**Alternatives considered**: Direct writes and unrestricted `--output` paths
were rejected as avoidable durability/security risks.
