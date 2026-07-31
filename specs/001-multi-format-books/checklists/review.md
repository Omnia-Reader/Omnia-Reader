# Formal Requirements Review Checklist: Multi-Format Books

**Purpose**: Validate the completeness, clarity, consistency, measurability, and risk coverage of the multi-format-book requirements before implementation
**Created**: 2026-07-31
**Feature**: [spec.md](../spec.md)

**Note**: This checklist is a formal peer-review gate for the written requirements and design artifacts. It evaluates whether the required behavior is specified well enough to implement; it does not test the implementation.

## Requirement Completeness

- [x] CHK001 Are the complete lifecycle states of a logical book and each publication variant documented, including singleton, associated, detached, unavailable, quarantined, and deleted states? [Completeness, Spec §Key Entities and Durable State, Data Model §State Transitions]
- [x] CHK002 Are requirements present for every user-visible variant action—add, associate, choose, export, detach, delete one variant, and remove the whole book? [Completeness, Spec §FR-002–FR-003 and FR-008–FR-012, UI Contract §Library Card]
- [x] CHK003 Are default-format, explicit-format, stale-preference, sole-healthy-variant, and no-healthy-variant requirements all documented? [Completeness, Spec §FR-007–FR-009, Data Model §Logical Book Preference]
- [x] CHK004 Are catalog metadata and cover ownership requirements complete for association, detachment, deletion of the original variant, migration, backup, and restore? [Completeness, Spec §FR-004 and FR-010, Data Model §Logical Book Cover]
- [x] CHK005 Does the specification enumerate every durable item that backup, restore, and synchronization must preserve, including logical membership, exact sources, covers, preferences, exclusions, tombstones, and variant-scoped reading state? [Completeness, Spec §FR-015–FR-016 and §Migration and compatibility]
- [x] CHK006 Are user-facing conflict and reconciliation requirements documented for concurrent association, detachment, deletion, reimport, and same-format choices across devices? [Gap, Spec §FR-015, Sync Contract §Causal Merge]

## Requirement Clarity

- [x] CHK007 Is “the same book” clarified as an explicit reader association rather than a metadata-derived identity decision? [Clarity, Spec §Non-goals and §Assumptions]
- [x] CHK008 Are canonical `checking`, `healthy`, `unavailable`, and `quarantined` statuses and their causes defined with unambiguous consequences for presentation, default selection, reading, recovery, and management, including the user-facing `Available` label for `healthy`? [Clarity, Spec §FR-007–FR-008 and §Edge Cases]
- [x] CHK009 Is “actionable result” specified precisely enough for duplicate, same-format, corrupt, DRM-protected, quota, stale-state, and provider failures? [Ambiguity, Spec §US1 scenario 3 and FR-005–FR-006, Domain Contract §Error Contract]
- [x] CHK010 Is reader-perspective atomicity defined with clear commit boundaries for staged bytes, durable metadata, optional journaling, post-delete cleanup, and restart recovery? [Clarity, Spec §FR-013–FR-014, Plan §Security and Failure Handling]
- [x] CHK011 Is “the same safety guarantees as a standalone publication import” expanded into an authoritative, bounded set of integrity, size, format, archive, script, navigation, DRM, and quarantine requirements? [Clarity, Spec §FR-006 and §Security and trust]

## Requirement Consistency

- [x] CHK012 Are the one-EPUB/one-PDF invariant, separate-edition non-goal, add-format flow, and existing-entry association flow mutually consistent? [Consistency, Spec §Non-goals, FR-002–FR-005]
- [x] CHK013 Are destination-owned catalog presentation requirements consistent across association, anchor-variant detachment, variant deletion, migration, and logical-cover retention? [Consistency, Spec §FR-004 and FR-010–FR-012, Data Model §Logical Book Cover]
- [x] CHK014 Is the synchronized preferred-format decision consistent across local persistence, migration, backup, provider synchronization, causal merge, unavailable-member fallback, and deletion/tombstone behavior? [Consistency, Spec §Format Preference and §Migration and compatibility, Research §Decision 9]
- [x] CHK015 Are final-variant deletion, whole-book removal, logical-book non-emptiness, and tombstone requirements consistent across the specification, data model, backup, and sync contracts? [Consistency, Spec §FR-012 and FR-015, Data Model §Delete Variant, Sync Contract §Journal and Provider Semantics]
- [x] CHK016 Is the mixed-version “fail safely” requirement consistent with the plan’s acknowledged already-running schema-1 synchronization overlap and later reconciliation behavior? [Conflict, Spec §Migration and compatibility, Plan §Delivery and Documentation]

## Acceptance Criteria Quality

- [x] CHK017 Are “representative readers,” the participant count, task starting conditions, and assistance criteria defined well enough to measure the 95% two-minute outcome reproducibly? [Measurability, Spec §SC-001]
- [x] CHK018 Are supported reference device classes, data preparation, timing start/end points, warm/cold conditions, and percentile calculation defined for the two-second performance outcome? [Measurability, Spec §SC-004 and §Acceptance Evidence]
- [x] CHK019 Are the finite valid, failure, interruption, migration, recovery, and compatibility matrices defined so each “100%” success criterion has an objective denominator? [Measurability, Spec §SC-002–SC-003 and SC-006]
- [x] CHK020 Are the assistive-technology audit method, supported combinations, pass criteria, touch conditions, keyboard conditions, and narrow-viewport criteria explicit enough to evaluate SC-005 objectively? [Measurability, Spec §SC-005, UI Contract §Accessibility and Responsive Rules]

## Scenario Coverage

- [x] CHK021 Are the primary requirements complete for adding EPUB to PDF and PDF to EPUB, with one-card presentation and both original sources retained? [Coverage, Spec §US1 and FR-001–FR-002]
- [x] CHK022 Are alternate requirements complete for associating already imported entries in either destination direction while preserving destination presentation and both state sets? [Coverage, Spec §US2 and FR-003–FR-004]
- [x] CHK023 Are exception requirements documented for cancellation, zero/multiple selected files, exact duplicates, same-format conflicts, corrupt/DRM-protected input, quota failure, stale aggregate state, and missing source data? [Coverage, Spec §Edge Cases, UI Contract §Add Format, Domain Contract §Error Contract]
- [x] CHK024 Are recovery requirements complete for interrupted local mutations, failed storage cleanup, database migration abort/retry, partial backup restore, provider outage, sync schema upgrade interruption, and checkpoint interruption? [Coverage, Spec §FR-013–FR-016, Plan §Security and Failure Handling]
- [x] CHK025 Are concurrent multi-device requirements defined for association versus association, association versus detach/delete, deletion versus stale updates, explicit reimport, and deterministic conflict visibility? [Coverage, Sync Contract §Causal Merge]
- [x] CHK026 Are zero-state requirements documented for no compatible association candidates, no healthy variants, an empty library after removal, and a logical record whose members are all unavailable or quarantined? [Gap, Spec §Edge Cases, UI Contract §Associate Existing]

## Edge Case Coverage

- [x] CHK027 Is the required outcome specified when an exact duplicate variant already belongs to another logical book or appears in a synchronized/backup candidate? [Gap, Spec §FR-005 and §Edge Cases]
- [x] CHK028 Are anchor-variant detachment requirements explicit about stable logical identity, destination presentation, the detached book’s metadata/cover, and preference ownership? [Edge Case, Data Model §Detach Variant]
- [x] CHK029 Are malformed logical aggregate, missing cover, missing binary, quarantined variant, and all-variants-unavailable outcomes distinguished without permitting silent membership repair or data loss? [Coverage, Spec §Edge Cases, Domain Contract §Logical Read Operations]
- [x] CHK030 Are conflict rules defined for restoring a multi-format backup into an existing library with overlapping variants, newer state, occupied formats, or insufficient storage? [Gap, Spec §FR-015–FR-016, Backup Contract §Atomic Restore]

## Non-Functional Requirements

- [x] CHK031 Are hostile-input requirements complete at every boundary: local publication, persisted aggregate, backup archive, remote change, checkpoint page, object path, declared size, digest, and metadata field? [Security, Spec §Security and trust, Plan §Security and Failure Handling]
- [x] CHK032 Are offline and provider-failure requirements explicit about when local success is announced, when remote work is considered pending, and what remains available during retry/compaction failure? [Reliability, Spec §FR-014–FR-015, Sync Contract §Checkpoints and Bounds]
- [x] CHK033 Are accessibility requirements complete for every badge, default/explicit read choice, menu, candidate dialog, conflict, confirmation, progress state, announcement, focus destination, touch target, and 320px layout? [Accessibility, Spec §Accessibility and interaction, UI Contract]
- [x] CHK034 Are performance requirements defined for library aggregation, progress summaries, format choice, engine selection, hashing, association, synchronization history, and checkpoint compaction without conflating local UI timing with provider timing? [Performance, Spec §Lifecycle and performance, Plan §Lifecycle and Performance]
- [x] CHK035 Are lifecycle requirements explicit for progress flush, annotation drafts, panels, workers, object URLs, canvases, iframes, listeners, staged files, and pending asynchronous work during switch, cancellation, failure, and teardown? [Lifecycle, Spec §Lifecycle and performance, Plan §Lifecycle and Performance]

## Dependencies and Assumptions

- [x] CHK036 Is the DRM-free EPUB/PDF-only assumption consistent with all acceptance scenarios, validation language, fixture requirements, and explicit non-goals? [Assumption, Spec §Non-goals and §Assumptions]
- [x] CHK037 Are the best-effort provider assumption and mandatory release evidence reconciled by explicitly distinguishing local acceptance, simulated provider evidence, credentialed GitHub/MEGA evidence, and genuinely unavailable gates? [Dependency, Spec §Assumptions and §Acceptance Evidence, Plan §Residual gates]
- [x] CHK038 Are unchanged reader-engine, platform-picker, gateway, credential, and native-command boundaries documented as dependencies, including the behavior relied upon from each existing contract? [Dependency, Plan §Impact and Ownership, Research §Decision 4–5 and Decision 10]

## Ambiguities and Conflicts

- [x] CHK039 Is synchronized preferred format clarified as an independent causal register, including when it is created, unchanged, restored, unavailable, stale/dormant, absent, or tombstoned and whether logical activity ordering participates? [Clarity, Spec §FR-008 and §Format Preference, Research §Decision 9]
- [x] CHK040 Does the specification define the reader-facing resolution path for a surfaced synchronization conflict rather than only the deterministic data-preservation rule? [Gap, Spec §FR-015, Sync Contract §Causal Merge]

## Notes

- Check items off only after the cited requirements are demonstrably complete, clear, consistent, and measurable.
- Record each finding inline and update the owning specification, plan, data model, or contract before marking the item complete.
- Re-run `$speckit-analyze` after resolving checklist findings and before implementation.

## Planning Reconciliation Addendum (2026-07-31)

The following items extend this checklist after the clarified synchronized
preferred-format decision and the regenerated plan. Earlier items remain as an
audit trail; where their device-local premise conflicts with this addendum, the
new synchronized-preference items are authoritative.

### Requirement Completeness

- [x] CHK041 Are requirements complete for the synchronized preference lifecycle: absent state, explicit creation, repeated same-format choice, unavailable preferred member, membership removal, logical-book deletion, backup, restore, and sync migration? [Completeness, Spec §FR-021, Data Model §Logical Book Format Preference]
- [x] CHK042 Are durable membership-reconciliation requirements complete for conflict creation, visibility, dismissal, restart, checkpoint compaction, explicit resolution, stale resolution, and resolved-conflict non-resurrection? [Completeness, Spec §FR-017, Sync Contract §Causal Merge, UI Contract §Synchronization Reconciliation]
- [x] CHK043 Are restore requirements complete for archive validation, current-library snapshot comparison, every ownership/occupied-format conflict, deterministic reporting, revision recheck, zero-mutation abort, and corrected-archive retry? [Completeness, Spec §FR-020, Backup Contract §Current-Library Conflict Preflight]
- [x] CHK044 Are requirements complete for duplicate-owned-elsewhere association offers and all-variants-unavailable presentation, recovery, searchability, backup eligibility, and management? [Completeness, Spec §FR-018–FR-019, UI Contract §Add Format and §Library Card]

### Requirement Clarity

- [x] CHK045 Is the preference update event unambiguously limited to a successfully opened explicit format choice, with failed opens, automatic defaults, fallbacks, and unchanged-format opens explicitly excluded? [Clarity, Spec §FR-021, Research §Decision 9, UI Contract §Reader Format Choice]
- [x] CHK046 Are causal preference terms—observed heads, descendant dominance, concurrent change-ID tie-break, dormant stale preference, and tombstone—defined precisely enough to yield one outcome without timestamp authority? [Clarity, Data Model §Logical Book Format Preference, Sync Contract §Preferred-format fold]
- [x] CHK047 Is a “persistent reader action” defined with an exact lifetime, discoverable surfaces, available decisions, completion condition, cancellation outcome, and stale-state result? [Clarity, Spec §FR-017, UI Contract §Synchronization Reconciliation]
- [x] CHK048 Is “report all detected conflicts” bounded and clarified with a complete conflict taxonomy, deduplication key, stable ordering, consistent-snapshot rule, and no-short-circuit requirement? [Clarity, Spec §FR-020, Backup Contract §Current-Library Conflict Preflight]

### Requirement Consistency

- [x] CHK049 Is synchronized `preferredFormat` represented consistently across the specification, plan, research, data model, repository, backup, sync, and UI contracts without any remaining device-local or exact-variant preference semantics? [Consistency, Spec §FR-021, Research §Decision 9]
- [x] CHK050 Is the independent preference merge domain consistent with the requirement that progress, progress documents, bookmarks, annotations, membership, and source identity never change during preference convergence? [Consistency, Spec §FR-021, Data Model §Logical Book Change, Sync Contract §Preferred-format fold]
- [x] CHK051 Are preference effects for association, detach, delete-variant, delete-book, and concurrent membership changes mutually consistent about retention, replacement, dormancy, and tombstoning? [Consistency, Domain Contract §Atomic Mutation Operations, Data Model §State Transitions]
- [x] CHK052 Are schema-1 sync migration, backup schemas 1–3, IndexedDB v8 migration, and schema-4 restore consistent about not inventing synchronized preference from legacy activity? [Consistency, Plan §Delivery and Documentation, Data Model §Migration and Compatibility]

### Acceptance Criteria Quality

- [x] CHK053 Is the SC-001 participant protocol sufficiently normative about cohort composition, input modes, supported device classes, starting state, timing boundaries, assistance, failure conditions, and per-direction success thresholds? [Measurability, Spec §SC-001, Quickstart §7]
- [x] CHK054 Is the SC-004 performance protocol sufficiently normative about fixture sizes, warm-ups, sample counts, timing boundaries, percentile calculation, non-pooled distributions, hardware disclosure, and unavailable reference classes? [Measurability, Spec §SC-004, Quickstart §6]
- [x] CHK055 Does the fixed SC-003 matrix define an objective denominator and canonical before/after inventory for every mutation, interruption, restart, cancellation, validation, and synchronization class? [Measurability, Spec §SC-003, Quickstart §8]
- [x] CHK056 Does the fixed SC-006 matrix define an objective denominator across persistence, backup, synchronization, preferences, reconciliation, tombstones, exclusions, and provider transports? [Measurability, Spec §SC-006, Quickstart §8]

### Scenario and Edge-Case Coverage

- [x] CHK057 Are concurrent preference scenarios specified for ancestor/descendant choices, EPUB-versus-PDF choices in both delivery orders, repeated delivery, unavailable winners, deleted formats, and later explicit recovery choices? [Coverage, Spec §FR-021, Sync Contract §Preferred-format fold]
- [x] CHK058 Are reconciliation exception and recovery requirements specified for invalid same-format outcomes, state advancement during review, provider failure after local resolution, restart, provider switch, checkpoint pruning, and an offline replica returning later? [Coverage, Spec §FR-017, Data Model §Membership Reconciliation]
- [x] CHK059 Are hostile malformed-archive failures clearly separated from valid-archive/current-library conflicts, including the required reader-facing result and mutation boundary for each class? [Coverage, Spec §FR-020, Backup Contract §Validation Before Mutation and §Current-Library Conflict Preflight]
- [x] CHK060 Are duplicate scenarios distinguished for a candidate already in the destination, owned by a standalone source, and owned by a multi-format source whose association would violate format cardinality? [Coverage, Spec §FR-018, UI Contract §Add Format]

### Non-Functional Requirements and Dependencies

- [x] CHK061 Are hostile-input bounds and validation requirements specified for preference effects, causal heads, conflict identifiers, reconciliation proposals, resolved authority, and restore conflict reports? [Security, Constitution §II, Sync Contract §Logical Change Document]
- [x] CHK062 Are accessibility requirements complete for unavailable-book explanations, duplicate association offers, persistent conflict indicators, reconciliation choices, restore conflict lists, announcements, disabled outcomes, focus restoration, touch, and narrow screens? [Accessibility, Spec §FR-017–FR-020, UI Contract §Accessibility and Responsive Rules]
- [x] CHK063 Are offline-first requirements explicit about local preference/reconciliation durability preceding journaling, provider failure remaining pending, fallback availability, and retry not clearing unresolved reader actions? [Reliability, Constitution §I, Plan §Security and Failure Handling]
- [x] CHK064 Are unchanged engine, picker, provider-transport, gateway, credential, and native boundaries reconciled with the new preference/reconciliation contracts without implying new authority or dependencies? [Dependency, Plan §Impact and Ownership, Research §Decision 10]

### Ambiguities, Conflicts, and Traceability

- [x] CHK065 Are obsolete device-local preference premises explicitly removed or superseded in every current planning and review artifact so they cannot be mistaken for accepted requirements? [Conflict, Spec §Clarifications, Research §Decision 9]
- [x] CHK066 Are FR-017 through FR-021 each traceable to focused requirement-level acceptance evidence and downstream work covering domain, persistence, backup, sync, UI, accessibility, and recovery where applicable? [Traceability, Plan §Verification Plan, Gap]

## Review Notes

- 2026-07-31: All 66 formal requirements-review items passed after correcting
  stale device-local preference questions and closing gaps for the fixed
  four-row SC-002 denominator, duplicate/zero-state behavior, bounded restore
  conflicts and storage failure, provider-switch reconciliation, live dialog
  changes, accessibility disambiguation, and performance evidence dispositions.
  The accepted preference model is synchronized and causally merged; no current
  planning artifact retains the superseded device-local preference premise.
