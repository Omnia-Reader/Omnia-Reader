---
name: review-omnia-reader
description: Review Omnia Reader diffs, branches, commits, or pull requests without changing code. Use for repository-specific correctness, regression, security, accessibility, performance, compatibility, architecture-boundary, and missing-test findings across Angular/Nx, EPUB/PDF engines, offline storage, sync gateway, Tauri, Rust, and C++ bridge work.
---

# Review Omnia Reader

Find concrete defects and missing validation. Do not implement fixes unless the
user separately asks for changes.

## Establish review scope

1. Identify the requested base, commit, or working-tree diff. Do not assume a
   base branch when it can be discovered.
2. Read applicable `AGENTS.md` instructions and inspect repository status.
3. Use CodeGraph for affected symbols, callers, tests, and teardown/error paths.
4. Read [references/review-checklist.md](references/review-checklist.md) and
   apply only relevant sections.
5. Use current primary documentation when a finding depends on library or
   framework behavior.

## Evaluate

Prioritize:

1. data loss, credential exposure, unsafe publication execution, broken trust
   boundaries, and unrecoverable migrations;
2. user-visible correctness, exact resume, merge/tombstone errors, lifecycle
   leaks, offline regressions, and browser/native incompatibility;
3. missing tests for changed behavior and error paths;
4. maintainability issues only when they create a concrete future defect.

Reproduce or trace each finding far enough to explain the triggering condition
and impact. Do not report speculative risks without a reachable path. Ignore
style-only observations unless they conceal correctness or boundary problems.

## Report

- Lead with findings ordered by severity.
- Give each finding a concise title, affected file and line, evidence, impact,
  and a practical remediation direction.
- Keep summaries secondary to findings.
- If no actionable findings remain, say so explicitly and list residual
  unverified gates such as cross-browser, live-provider, packaged-native, or
  physical-device behavior.
