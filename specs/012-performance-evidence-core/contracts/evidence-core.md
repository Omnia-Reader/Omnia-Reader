# Evidence Core Contract

## Canonical profile identity

`profileSetDigest` is `sha256:` plus the lowercase SHA-256 of canonical UTF-8
JSON after omitting only the top-level claimed digest. Canonical JSON sorts
object keys recursively, preserves array order, uses JSON number/string/null
representation, contains no insignificant whitespace, and ends without a
newline for hashing.

Unknown fields are rejected; canonicalization is not permission to ignore
unreviewed contract data.

## Preflight command

```text
node apps/omnia-reader-e2e/performance/validate-profile.mjs \
  <profile-set.json> <profile-id> [--environment <environment.json>] [--json]
```

- Without `--environment`, the command captures bounded current Git, Node, OS,
  architecture, and available runtime evidence. Missing required constraint,
  power, display, device, snapshot, or artifact evidence remains a mismatch.
- JSON output is one canonical `PreflightReportV1` document.
- Exit `0` only for `READY`; `2` for valid `UNVERIFIED` or `SUPPLEMENTAL`; `1`
  for invalid input or command usage.
- A later driver MUST start sampling only after parsing a matching report with
  `status=READY` and `mayMeasure=true`.

## Raw-result evaluation command

```text
node apps/omnia-reader-e2e/performance/performance-evidence.mjs evaluate \
  <profile-set.json> <raw-result.json>
```

- Recomputes all statistics and rejects inconsistent producer summaries.
- Exit `0` only for a validated primary `PASS`; `2` for validated `FAIL`,
  `UNVERIFIED`, or `SUPPLEMENTAL`; `1` for invalid evidence/usage.
- Emits one canonical evaluated result; raw measurement arrays remain present.

## Aggregate command

```text
node apps/omnia-reader-e2e/performance/performance-evidence.mjs aggregate \
  <profile-set.json> <evaluated-result.json>...
```

- Validates each result again and accepts at most one per profile.
- Exit `0` only when all four current primary results are `PASS`; `2` for a
  valid incomplete aggregate; `1` for invalid/duplicate/stale evidence.
- Emits one canonical aggregate report and never pools samples.

## Stable status vocabulary

- `READY`: exact clean preflight; measurement may start; not acceptance evidence.
- `PASS`: exact clean primary measurement satisfies the full contract.
- `FAIL`: exact clean primary measurement is complete but violates at least one
  threshold or zero-tolerance condition.
- `UNVERIFIED`: exact named environment/artifact is unavailable or cannot match;
  no primary pass is claimed.
- `SUPPLEMENTAL`: deliberate dirty, faster, unconstrained, emulated, or otherwise
  non-primary evidence; useful diagnostically but never acceptance evidence.
- `INCOMPLETE`: aggregate lacks four current primary passes.

Invalid data receives no status from this vocabulary.

## Stable reason shape

```json
{
  "code": "PROFILE_MISMATCH",
  "path": "environment.memoryLimitBytes",
  "message": "Expected 8589934592 but received 17179869184"
}
```

Reasons are deterministically ordered by `path`, then `code`, then `message`;
no more than 256 are emitted.
