# Performance Evidence Requirements Checklist

**Purpose**: Review the feature requirements as a release-gate contract before task generation
**Created**: 2026-08-20
**Audience**: Authors and pull-request reviewers

## Requirement Completeness

- [x] CHK001 Are qualification fields defined for source, workload, runtime, resources, emulator, and artifact identities on every applicable platform? [Completeness, Spec §FR-001–FR-005]
- [x] CHK002 Are requirements present for qualification, immediate pre-sampling recapture, post-run evaluation, and final promotion? [Completeness, Spec §FR-005, §FR-009–FR-013]
- [x] CHK003 Are unavailable, mismatched, supplemental, crash, timeout, signal, disconnect, and invalid-result outcomes all defined? [Completeness, Spec §FR-011–FR-012]
- [x] CHK004 Are cleanup requirements defined for every owned runtime and temporary resource without authorizing foreign-resource cleanup? [Completeness, Spec §FR-012]

## Requirement Clarity

- [x] CHK005 Is “same workload” quantified by exact branch, warm-up, distribution, sample, counter, and evaluator semantics? [Clarity, Spec §FR-006–FR-007, §SC-002]
- [x] CHK006 Is the distinction between mobile runtime, browser emulation, debug package, and exact release artifact unambiguous? [Clarity, Spec §FR-008]
- [x] CHK007 Is primary evidence publication distinguished from supplemental smoke and explicit `UNVERIFIED` outcomes? [Clarity, Spec §FR-010–FR-011]
- [x] CHK008 Is aggregate `PASS` defined without pooling, substitution, or unavailable-platform promotion? [Clarity, Spec §FR-014, §SC-005]

## Requirement Consistency

- [x] CHK009 Do immutable-profile requirements align with the prohibition on reinterpreting existing v1 evidence? [Consistency, Spec §FR-001, §FR-015]
- [x] CHK010 Do platform-specific identity requirements consistently require live recapture before sampling? [Consistency, Spec §FR-002–FR-005, §FR-009]
- [x] CHK011 Do artifact requirements consistently cover both selected bytes and the runtime actually launched or installed? [Consistency, Spec §FR-003–FR-004, §SC-004]

## Acceptance Criteria Quality

- [x] CHK012 Can every missing, changed, duplicated, or mismatched identity fixture be objectively classified before the first sample? [Measurability, Spec §SC-001]
- [x] CHK013 Are sample cardinality and independent counter outcomes numerically testable for each platform? [Measurability, Spec §SC-002]
- [x] CHK014 Are failure-injection outcomes objectively tied to exit status, cleanup, and absence of evidence promotion? [Measurability, Spec §SC-003]
- [x] CHK015 Are compatibility outcomes for the existing desktop and lifecycle gates independently measurable? [Measurability, Spec §SC-006]

## Scenario and Boundary Coverage

- [x] CHK016 Are identity drift, multiple runtimes, artifact mutation, wrong content/format/engine, and output attacks explicitly covered? [Coverage, Spec §Edge Cases]
- [x] CHK017 Are offline/no-provider operation and deterministic restart after interruption specified? [Coverage, Spec §Quality and Boundary Requirements]
- [x] CHK018 Are accessibility invariants for labelled controls, focus, announcements, touch targets, and platform back behavior stated? [Coverage, Spec §Accessibility and interaction]
- [x] CHK019 Are physical devices, additional desktop operating systems, and manual assistive-technology checks explicitly excluded from inferred acceptance? [Boundary, Spec §Non-goals, §Acceptance Evidence]
- [x] CHK020 Are missing approved snapshots, runtimes, artifacts, and automation boundaries allowed only as honest unavailable gates rather than assumed identities? [Dependency, Spec §Assumptions]
