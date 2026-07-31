# Accessibility Requirements Checklist: Multi-Format Books

**Purpose**: Validate that accessibility, format-choice, fallback, and assistive-technology release requirements are complete, clear, consistent, and objectively reviewable before task regeneration
**Created**: 2026-07-31
**Feature**: [spec.md](../spec.md)

**Note**: This is a reviewer-facing requirements-quality checklist. It evaluates the written specification and design artifacts, not the implementation.

## Requirement Completeness

- [x] CHK001 Are accessibility requirements defined for all eight required journeys: add, associate, choose, detach, delete, synchronization reconciliation, all-variants-unavailable management, and restore-conflict reporting? [Completeness, Spec §Accessibility and interaction, SC-005]
- [x] CHK002 Are accessible name, role, state, book context, and format context requirements documented for every control and persistent status involved in those journeys? [Completeness, UI Contract §Accessibility and Responsive Rules]
- [x] CHK003 Are announcement requirements complete for dialog purpose, initial focus, confirmation, conflict, busy state, success, cancellation, and failure? [Completeness, Spec §SC-005, UI Contract §Accessibility and Responsive Rules]
- [x] CHK004 Are focus-order, initial-focus, cancellation, completion, failure, and dialog-close focus outcomes specified for each applicable journey? [Coverage, Spec §Accessibility and interaction, UI Contract §Add Format–Detach and Delete]
- [x] CHK005 Are keyboard, screen-reader keyboard, touch exploration, swipe, activation, pointer, and narrow-viewport interaction requirements assigned to the platforms where each input mode applies? [Completeness, Spec §Accessibility and interaction, Quickstart §8]

## Requirement Clarity

- [x] CHK006 Is “without visual interpretation” defined by objective criteria covering discoverability, announced context and state, predictable focus, and independent journey completion? [Clarity, Spec §SC-005, Quickstart §8]
- [x] CHK007 Is “announced once” sufficiently defined to distinguish required status changes from duplicate or suppressed announcements? [Ambiguity, UI Contract §Accessibility and Responsive Rules]
- [x] CHK008 Is the required result vocabulary limited unambiguously to `PASS`, `FAIL`, and `UNVERIFIED`, with the entry criteria for each result documented? [Clarity, Quickstart §8]
- [x] CHK009 Is an unavailable audit environment distinguished clearly from a journey failure, an implementation defect, and missing evidence? [Clarity, Spec §Acceptance Evidence, Quickstart §8]
- [x] CHK010 Is the meaning of a “healthy” preferred format and every condition that triggers an automatic fallback defined consistently for assistive-technology announcements? [Clarity, Spec §FR-008 and FR-021, UI Contract §Library Card]

## Requirement Consistency

- [x] CHK011 Are the three required combinations identical across the clarification, accessibility requirements, SC-005, acceptance evidence, plan, research decision, UI contract, and quickstart? [Consistency, Spec §Clarifications and SC-005, Research §Decision 11]
- [x] CHK012 Are the eight audited journeys named and scoped consistently across SC-005, the plan verification gate, the UI contract, and the quickstart matrix? [Consistency, Spec §SC-005, Plan §Verification Plan, Quickstart §8]
- [x] CHK013 Is the rule that automated accessibility/browser evidence cannot substitute for a manual matrix cell consistent across all release-evidence artifacts? [Consistency, Plan §User Interface and Accessibility, UI Contract §Accessibility and Responsive Rules, Quickstart §8]
- [x] CHK014 Are explicit successful format choice, failed choice, automatic default, unavailable-format fallback, and synchronized preference requirements consistent across the spec, data model, research, and UI contract? [Consistency, Spec §FR-008 and FR-021, Research §Decision 9, Data Model §Logical Book Format Preference]
- [x] CHK015 Are keyboard-only and touch success claims in SC-005 consistent with the platform-specific screen-reader interaction methods required by the quickstart? [Consistency, Spec §SC-005, Quickstart §8]

## Acceptance Criteria Quality

- [x] CHK016 Can each of the 24 assistive-technology journey cells be judged independently using the documented names, states, announcements, focus, and non-visual completion criteria? [Measurability, Spec §SC-005, Quickstart §8]
- [x] CHK017 Does the evidence schema define enough provenance—commit/build, date, tester, platform, assistive-technology version, browser/WebView version, fixture, transcript, focus sequence, and defect or blocker—to make every result reviewable? [Measurability, Quickstart §8]
- [x] CHK018 Is the release rule objectively stated so SC-005 cannot pass while any required cell is `FAIL`, `UNVERIFIED`, or lacks evidence? [Acceptance Criteria, Spec §Acceptance Evidence, Quickstart §8]
- [x] CHK019 Are format-choice audit criteria measurable for selected-state announcement, successful preference update, failed-choice non-update, fallback non-update, and preservation of format-specific reading state? [Acceptance Criteria, Spec §FR-008–FR-009 and FR-021, Quickstart §8]

## Scenario and Edge-Case Coverage

- [x] CHK020 Are accessibility requirements defined for stale conflicts, invalid same-format reconciliation outcomes, long restore-conflict lists, unavailable preferred formats, and books with no readable variants? [Coverage, Spec §Edge Cases and FR-017–FR-020]
- [x] CHK021 Are cancellation and failure requirements defined without implying success announcements, durable preference changes, membership changes, or loss of the invoking focus target? [Exception Flow, Spec §Edge Cases, UI Contract §Add Format–Detach and Delete]
- [x] CHK022 Are requirements present for status changes that occur while a screen-reader user is reviewing a dialog, including stale data, newly unavailable variants, and synchronization updates? [Gap, UI Contract §Associate Existing and §Synchronization Reconciliation]
- [x] CHK023 Are requirements defined for accessible presentation when titles, filenames, conflict reasons, or announcement transcripts are long, duplicated, or otherwise difficult to distinguish? [Gap, UI Contract §Associate Existing and §Backup Restore Conflict Report]

## Dependencies, Boundaries, and Traceability

- [x] CHK024 Are required operating systems, assistive technologies, browsers/WebView, device or emulator needs, and their unavailable-gate reporting rules documented without permitting substitute combinations? [Dependency, Spec §Acceptance Evidence, Plan §Residual gates]
- [x] CHK025 Are platform-specific audit requirements kept consistent with the unchanged picker, reader-engine, gateway, credential, and native boundaries? [Consistency, Plan §Impact and Ownership, Research §Decision 10]
- [x] CHK026 Is SC-005 traceable to requirement-level evidence for every journey and matrix cell while remaining distinct from automated browser and Chromium accessibility evidence? [Traceability, Plan §Verification Plan, Quickstart §3 and §8]
- [x] CHK027 Are the newly clarified accessibility matrix and preference rules reflected in downstream task requirements without retaining obsolete placeholders or device-local preference assumptions? [Traceability, Spec §Clarifications, Tasks §Final Verification]

## Review Notes

- 2026-07-31: All 27 requirements-quality items passed after the UI contract
  defined live dialog revalidation, single-transition announcements,
  long/duplicate text disambiguation, named zero states, and the quickstart
  defined exact `PASS`/`FAIL`/`UNVERIFIED` entry criteria. Tasks T033, T037,
  T045, T055, T081, T083, and T107 carry the resulting implementation and
  evidence obligations.

## Notes

- Mark an item complete only after the cited requirements are sufficiently explicit and mutually consistent.
- Record unresolved wording problems or artifact conflicts inline before regenerating implementation tasks.
