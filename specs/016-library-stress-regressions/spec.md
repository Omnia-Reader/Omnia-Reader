# Library stress regressions

Use the constitution's reduced regression workflow. Preserve existing import,
validation, duplicate, synchronization, and sorting contracts.

## Acceptance scenarios

- After publication validation succeeds, a failed optional logical-book lookup
  for synchronization must not delete the local book or report it as failed.
- A throwing import observer must not reject a completed import or prevent
  subsequent observers receiving the successful books.
- Sorting 10,000 logical cards must preserve deterministic order and input
  identity without rebuilding each card's sort record on every comparison.
- Invalid new publications must still be removed; existing duplicates must
  remain protected. No schema, public API, or product-scope changes.

## Verification plan

Add failing fault-injection tests before implementation. Exercise all sort
modes on a deterministic large dataset. Run application tests, application
lint, production build, and focused existing browser library journeys.
Record broad project test results and unavailable gates separately in evidence.md.
