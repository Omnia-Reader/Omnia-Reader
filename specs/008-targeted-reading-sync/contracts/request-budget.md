# Targeted Reading-State Request Contract

## Eligibility

All of the following are required: GitHub is selected; destination revision is supported; the pending batch is non-empty and contains only progress, bookmark, or annotation operations; the current revision equals the trusted full checkpoint.

## One new record

- Destination revision probes: exactly one before dispatch.
- Prefix listings: zero.
- Exact document reads: exactly one.
- Document writes: at most one, required when merged content differs.
- Schema, publication, logical-book, and unrelated reading-state workers: zero.
- Immediate complete verification passes: zero.

At the GitHub provider boundary, the document write performs no content preflight GET. A stale optimistic revision or create-existing race is a conflict.

## Fallback and reconciliation

Ineligible batches use complete synchronization. A targeted push, conflict, rejection, or remaining operation invalidates the global checkpoint. Existing background revision polling then enters complete reconciliation; the targeted result never claims global convergence.
