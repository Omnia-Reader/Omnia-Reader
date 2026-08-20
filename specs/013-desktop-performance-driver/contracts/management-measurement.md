# Management Measurement Contract

## Closed branch matrix

The ordered branch IDs are:

1. `add-local-success`
2. `add-local-failure`
3. `associate-success`
4. `associate-failure`
5. `detach-success`
6. `detach-failure`
7. `delete-success`
8. `delete-failure`
9. `reconcile-success`
10. `reconcile-failure`
11. `replace-success`
12. `replace-failure`
13. `restore-success`
14. `restore-failure`

No alias, subset, duplicate, or extension is valid for v1. Each branch defines
the trusted activation event, first painted semantic acknowledgement, exact
final state, and deterministic success/failure setup.

## Page timing protocol

For each sample:

1. Install the branch/distribution observer before activation.
2. At the trusted `click`, file-input `change`, or search `input`, record
   `performance.now()` in the page.
3. Observe the first matching semantic busy/progress/success/failure state.
4. Resolve acknowledgement only after a `requestAnimationFrame` confirms that
   state remains connected and visible.
5. Observe the branch-specific inventory, conflict, error, or renderer final
   state and resolve it after the same paint-eligibility rule.
6. Store elapsed finite non-negative milliseconds; enforce a per-sample timeout.

Playwright/Node elapsed time is diagnostic and MUST NOT populate acceptance
arrays.

## Final distributions

The exact unpooled IDs are `filter`, `open-epub`, `open-pdf`,
`switch-epub-to-pdf`, and `switch-pdf-to-epub`. Each has exactly 20 discarded
warm-ups and at least 200 final samples. No action, direction, format, warm-up,
profile, or failed attempt may be pooled into another distribution.

## Reduced smoke mode

Reduced fixtures MAY prove orchestration, visible boundaries, counters, and
result shape. Smoke output MUST identify itself as non-primary, MUST NOT meet the
fixed sample cardinality, MUST NOT be written beneath the primary results
directory, and MUST NOT be reported as SC-004 evidence.

## Desktop launcher

The launcher:

1. validates the profile set and workload contract;
2. runs desktop preflight and requires `READY` plus `mayMeasure=true`;
3. captures the preflight commit and browser/environment identity;
4. starts the serial Playwright measurement;
5. revalidates Git/browser identity at sampling start;
6. evaluates the raw result with the canonical evaluator;
7. atomically writes one bounded JSON result only after validation; and
8. exits 0 only for evaluator `PASS`, 2 for an honest evaluator `FAIL`, and 1
   for invalid input, qualification failure, interruption, or infrastructure
   error.

Qualification failure starts no Playwright process. Signals and exceptions
terminate owned child processes and remove temporary files.
