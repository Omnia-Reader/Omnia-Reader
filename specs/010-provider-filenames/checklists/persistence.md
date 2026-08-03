# Persistence Requirements Checklist: Provider Book Filenames

**Purpose**: Review requirement quality for provider paths, integrity, compatibility, and recovery
**Created**: 2026-08-02
**Feature**: [spec.md](../spec.md)

## Requirement Completeness

- [x] CHK001 Are new publication-manifest and logical-change producers both covered by the canonical filename requirement? [Completeness, Spec FR-001–FR-002]
- [x] CHK002 Are SHA-256 identity, size, format, and digest guarantees explicitly preserved? [Completeness, Spec FR-003]
- [x] CHK003 Is the compatibility behavior for existing hash-addressed records specified? [Completeness, Spec FR-004]

## Requirement Clarity and Consistency

- [x] CHK004 Is “exact filename” distinguished from the containing collision-resistant directory suffix? [Clarity, Spec Assumptions]
- [x] CHK005 Is the same provider-neutral rule stated for GitHub and MEGA without provider-specific path drift? [Consistency, Spec FR-006]
- [x] CHK006 Are current generation and legacy acceptance clearly separated so compatibility cannot create new obsolete writes? [Consistency, Spec FR-002 and FR-004]

## Scenario and Edge-Case Coverage

- [x] CHK007 Are same-name different-edition collisions covered without weakening complete identity? [Coverage, Spec Edge Cases]
- [x] CHK008 Are hostile filenames, traversal, mismatched identity, interruption, and offline behavior addressed? [Coverage, Spec FR-005 and Quality Requirements]
- [x] CHK009 Is rollback behavior bounded for immutable changes and older clients? [Recovery, Spec Migration and Compatibility]

## Acceptance Criteria Quality

- [x] CHK010 Can new canonical paths, legacy acceptance, and malformed rejection be measured independently? [Measurability, Spec SC-001–SC-003]
- [x] CHK011 Are required local checks distinguished from credentialed provider and platform gates? [Evidence, Spec Acceptance Evidence]
- [x] CHK012 Is destination convergence required even for an unchanged full synchronization rather than only after a local mutation? [Completeness, Spec FR-007]
- [x] CHK013 Are cleanup ownership boundaries explicit enough to protect current records and unknown user content? [Security, Spec FR-008]
- [x] CHK014 Are cleanup failure, interruption, restart, and retry outcomes specified? [Recovery, Spec FR-009]
- [x] CHK015 Is `.omnia-reader/` unambiguously the only current root, with every root-derived domain included? [Completeness, Spec FR-011]
- [x] CHK016 Must previous-root documents and publication integrity be verified before deleting their only copy? [Recovery, Spec FR-007 and FR-012]
- [x] CHK017 Does the provider-neutral inventory expose documents, objects, invalid stale entries, and bounded failure behavior for both GitHub and MEGA? [Consistency, Spec FR-010]
- [x] CHK018 Are unknown files outside `.omnia-reader/` protected while every entry inside obsolete `v1` is explicitly owned? [Security, Spec FR-008]

## Canonical Logical-State Quality

- [x] CHK019 Is the single current logical-state path and the prohibition on new change/checkpoint entries unambiguous? [Clarity, Spec FR-014]
- [x] CHK020 Are all compact fields needed for remote restoration and stale-device convergence explicitly enumerated? [Completeness, Spec FR-015]
- [x] CHK021 Are book deletion, variant removal, and preference-clear tombstone requirements all covered? [Coverage, Spec FR-015 and User Story 4]
- [x] CHK022 Is whole-document last-writer-wins explicitly excluded and a deterministic record-level authority defined? [Consistency, Spec Non-goals and FR-015]
- [x] CHK023 Are optimistic revision conflicts, retry bounds, and retry exhaustion outcomes specified? [Recovery, Spec FR-017–FR-018]
- [x] CHK024 Is legacy migration ordered so state publication, reread, semantic verification, and exact history cleanup are independently required? [Recovery, Spec FR-016]
- [x] CHK025 Are interrupted post-write cleanup and idempotent legacy replay addressed? [Edge Case, Spec User Story 4 and FR-016]
- [x] CHK026 Are malformed, oversized, duplicate, identity-conflicting, and internally inconsistent state inputs bounded before local replacement? [Security, Spec Edge Cases and Contract]
- [x] CHK027 Is active remote-only publication restoration required without consulting mutation history? [Completeness, Spec FR-015]
- [x] CHK028 Are change-only client incompatibility and the upgrade boundary stated explicitly? [Dependency, Spec Edge Cases]
- [x] CHK029 Can complete migration, concurrent convergence, stale deletion protection, and failure preservation be objectively measured? [Measurability, Spec SC-006–SC-007]
- [x] CHK030 Is the upgrade behavior for a previously trusted unchanged-revision checkpoint specified so it cannot bypass migration? [Recovery, Spec FR-019 and SC-008]

## Notes

- Standard-depth reviewer checklist; all 30 requirements-quality items pass.
