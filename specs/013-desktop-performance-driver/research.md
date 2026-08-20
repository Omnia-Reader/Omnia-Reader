# Research: Qualified Desktop Performance Driver

## Decision: Keep the legacy lifecycle gate separate

**Decision**: Add a new management Playwright spec and Nx targets rather than
expanding the existing three-test `performance.spec.ts` target.

**Rationale**: The legacy gate measures large-publication import/open, retained
heap, renderer counts, long tasks, and streaming backup. Its fixtures,
thresholds, and CDP assumptions are unrelated to the fixed multi-format
management matrix. Separate selection prevents either gate from silently
standing in for the other and keeps failure diagnostics focused.

**Alternatives considered**: One combined spec/target was rejected because an
environment variable or test filter could accidentally produce incomplete
evidence while appearing to run “performance”.

## Decision: Contract first, browser second

**Decision**: Represent the fourteen branches and five distributions in one
strict dependency-free Node module, then make the browser journey consume that
contract.

**Rationale**: Completeness, identity, bounds, and deterministic ordering can be
proved quickly without starting Angular or Chromium. The browser test then owns
only real UI orchestration and page-side timing.

**Alternatives considered**: Duplicating branch arrays inside Playwright was
rejected because producer-selected subsets and drift would be hard to detect.

## Decision: Compact deterministic descriptors

**Decision**: Generate 1,000 logical-book descriptors and 2,000 variant
descriptors from a frozen seed, deriving bytes only when setup needs them.

**Rationale**: Canonical identity must be fast to recompute and remain below
the evidence input bound. Holding or serializing 2,000 complete EPUB/PDF files
would add memory and artifact-size risk without improving identity validation.

**Alternatives considered**: Checking in a large generated archive was rejected
as generated binary churn. Repeated UI import of every file remains available
as a correctness reference but is too slow for contract tests.

## Decision: Page-owned acceptance timing

**Decision**: Install a minimal page observer before each action. It records the
trusted activation timestamp and resolves acknowledgement/final timestamps only
after the required semantic state survives a `requestAnimationFrame`.

**Rationale**: Playwright/Node timings include transport and scheduler latency
and cannot prove when a user could see feedback. Page monotonic time preserves
one clock origin and the existing evidence contract.

**Alternatives considered**: Node timers remain diagnostic only. Mutation
observer timestamps alone were rejected because DOM mutation does not prove
paint eligibility.

## Decision: Qualification precedes process launch

**Decision**: The desktop launcher consumes the committed preflight report and
starts no browser/server unless it is exactly `READY` and `mayMeasure=true`.

**Rationale**: Sampling first and relabelling later wastes long runs and risks
publishing non-primary data. A dirty tree is deliberate supplemental evidence,
while unavailable/mismatched constraints are unverified; neither may run this
primary driver.

**Alternatives considered**: Automatic cgroup creation inside the driver was
rejected for v1 because host privilege, power mode, browser revision, and
display identity still require explicit external qualification.

## Decision: Evaluator owns the final disposition

**Decision**: Playwright emits base raw evidence; the existing evaluator
recomputes statistics and determines `PASS` or `FAIL`. The driver atomically
writes only evaluator-valid output.

**Rationale**: This preserves one trust boundary and prevents producer summaries
from overriding raw samples.

**Alternatives considered**: Directly writing Playwright summaries was rejected
as redundant and weaker than the committed evidence core.
