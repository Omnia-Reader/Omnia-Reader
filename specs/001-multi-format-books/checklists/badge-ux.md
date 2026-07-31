# Format Badge UX Requirements Checklist

**Purpose**: Review whether the badge-only library-card requirements are complete, clear, consistent, measurable, and ready for implementation.
**Created**: 2026-07-31
**Feature**: [spec.md](../spec.md)

## Requirement Completeness

- [x] CHK001 Are requirements defined for every badge state: healthy, checking, unavailable, quarantined, and missing? [Completeness, Spec §FR-022–FR-023]
- [x] CHK002 Are the required visible contents of present and missing badges specified for EPUB and PDF, including format label, percentage or `Add`, status, and stable order? [Completeness, Spec §FR-022–FR-023, UI Contract §Library Card]
- [x] CHK003 Are requirements explicit about which legacy card controls disappear and which management or recovery controls remain outside the badge row? [Completeness, Spec §FR-022–FR-023, UI Contract §Library Card]
- [x] CHK004 Are requirements documented for progress that is absent, zero, fractional, complete, stale, or temporarily unavailable while library state is being resolved? [Gap, Spec §FR-022]
- [x] CHK005 Are requirements complete for both choices exposed by each missing-format badge, including their labels, ordering, purpose, and relationship to the originating book and format? [Completeness, Spec §FR-023, UI Contract §Add Format from a Missing Badge and §Associate Existing from a Missing Badge]

## Requirement Clarity

- [x] CHK006 Is “compact badge control” defined precisely enough to preserve the intended visual hierarchy without weakening the 48px target and visible-focus requirements? [Ambiguity, Spec §FR-022, UI Contract §Accessibility and Responsive Rules]
- [x] CHK007 Is it unambiguous that the format label and progress percentage form one interactive badge rather than separate controls or an unrelated nearby value? [Clarity, Spec §FR-022, UI Contract §Library Card]
- [x] CHK008 Is the whole-number progress rule explicit about rounding, clamping, and whether an incomplete variant may visually report `100%`? [Ambiguity, Spec §FR-022, UI Contract §Library Card]
- [x] CHK009 Is the distinction between a missing-format `Add` state and a present but unreadable format stated clearly enough to prevent an unavailable source from being presented as missing? [Clarity, Spec §FR-022–FR-023]
- [x] CHK010 Is “cannot initiate reading” defined with an accessible interaction state and a clear route to status details or recovery for checking, unavailable, and quarantined badges? [Ambiguity, Spec §FR-022, UI Contract §Library Card]
- [x] CHK011 Is the choice surface type and dismissal model specified sufficiently to determine its accessible name, initial focus, Escape behavior, and relationship to the originating badge? [Clarity, Spec §FR-023, UI Contract §Library Card]

## Requirement Consistency

- [x] CHK012 Are the always-visible EPUB/PDF requirement, one-format-per-logical-book invariant, and missing-format `Add` semantics mutually consistent? [Consistency, Spec §Non-goals, FR-001, FR-023]
- [x] CHK013 Are the visual percentage tolerance in SC-007 and the exact rounding/default/completion rules in FR-022 and the UI contract consistent? [Consistency, Spec §FR-022 and SC-007, UI Contract §Library Card]
- [x] CHK014 Is successful-flow focus behavior reconciled between the specification’s “originating badge after completion” wording and the UI contract’s “newly present badge after success” requirement? [Conflict, Spec §Accessibility and interaction, UI Contract §Library Card]
- [x] CHK015 Are cancellation and failure outcomes consistent across FR-023, the add-local flow, the associate-existing flow, and accessibility rules? [Consistency, Spec §FR-023, UI Contract §Add Format from a Missing Badge and §Associate Existing from a Missing Badge]
- [x] CHK016 Are badge-only card requirements consistent with the retained reader-level format selector and with management actions that intentionally remain outside the badge row? [Consistency, Spec §FR-009 and FR-022–FR-023, UI Contract §Reader Format Choice]

## Acceptance Criteria Quality

- [x] CHK017 Does SC-007 define a finite, representative set of library-card states that makes its `100%` denominator reproducible? [Measurability, Spec §SC-007]
- [x] CHK018 Can the “no separate Read, Add format, or Associate existing button” criterion be evaluated objectively without accidentally excluding retained recovery or management actions? [Acceptance Criteria, Spec §SC-007, UI Contract §Library Card]
- [x] CHK019 Are the progress source, sampling point, rounding method, and allowed tolerance specified well enough to measure each displayed percentage objectively? [Measurability, Spec §FR-022 and SC-007]
- [x] CHK020 Are the required outcomes for keyboard, touch, 320px layout, accessible naming, announcements, and focus expressed as objective acceptance criteria for the badge refinement? [Acceptance Criteria, Spec §Accessibility and interaction, Quickstart §Chromium journey]

## Scenario Coverage

- [x] CHK021 Are primary requirements complete for opening healthy EPUB and PDF variants from their respective badges while preserving independent progress? [Coverage, Spec §US3 and FR-022]
- [x] CHK022 Are alternate-flow requirements complete for adding a local source and associating an existing source from either missing EPUB or missing PDF? [Coverage, Spec §US1–US2 and FR-023]
- [x] CHK023 Are exception requirements defined for picker cancellation, empty candidates, invalid input, duplicate ownership, occupied format, stale candidates, storage failure, and association failure? [Coverage, Spec §US1–US2, UI Contract §Add Format from a Missing Badge and §Associate Existing from a Missing Badge]
- [x] CHK024 Are recovery requirements complete when a present badge represents an unavailable or quarantined source, including how recovery remains discoverable without restoring removed card buttons? [Coverage, Spec §FR-019 and FR-022, UI Contract §Source Recovery]
- [x] CHK025 Are live-update requirements defined when progress, health, membership, or synchronization changes while the card or missing-format choice surface is open? [Gap, UI Contract §Library Card]

## Edge Case Coverage

- [x] CHK026 Are requirements defined for long book titles, translated labels, text scaling, and narrow cards without truncating the differentiating format/progress/status information? [Edge Case, Spec §Accessibility and interaction, UI Contract §Accessibility and Responsive Rules]
- [x] CHK027 Are requirements explicit for a logical book with no healthy variants so both badges, status explanations, recovery, management, and focus order remain understandable? [Coverage, Spec §US3 scenario 6 and FR-022]
- [x] CHK028 Is the required badge state specified during asynchronous health checking or progress retrieval so temporary state is not mistaken for `0%`, missing, or actionable? [Gap, Spec §FR-007 and FR-022]

## Non-Functional Requirements

- [x] CHK029 Are accessible names specified distinctly for healthy, checking, unavailable, quarantined, and missing badges without relying on color, tooltip, position, or visual adjacency? [Accessibility, Spec §Accessibility and interaction, UI Contract §Accessibility and Responsive Rules]
- [x] CHK030 Are focus order, initial focus, Escape, cancellation, failure, and successful replacement requirements complete for both the choice surface and its nested picker/dialog flows? [Accessibility, Spec §FR-023, UI Contract §Add Format from a Missing Badge and §Associate Existing from a Missing Badge]
- [x] CHK031 Are timing requirements clear about which badge activation starts the one-second acknowledgement interval and what visible state constitutes acknowledgement versus final completion? [Performance, Spec §Lifecycle and performance, Performance Contract §Timing Boundaries]
- [x] CHK032 Are cross-browser and host expectations scoped consistently for Chromium, Firefox, WebKit, PWA, desktop Tauri, and Android, including how unavailable gates are reported? [Compatibility, Spec §Platform and compatibility and §Acceptance Evidence]

## Dependencies and Assumptions

- [x] CHK033 Is the assumption that existing picker, association, progress, health, and authoritative-open boundaries can support the badge flows documented with the exact behavior relied upon from each? [Dependency, Plan §User Interface and Accessibility]
- [x] CHK034 Is it explicit that the choice surface is transient and creates no placeholder variant, durable membership, preference, synchronization, host, or reader-engine state before confirmation? [Assumption, Plan §Constitution Check, Data Model §Publication Variant]

## Ambiguities and Conflicts

- [x] CHK035 Is the term “adjacent” reconciled with the UI contract’s combined `<FORMAT> <progress>%` badge label so spacing and control ownership cannot be interpreted differently? [Ambiguity, Spec §FR-022, UI Contract §Library Card]
- [x] CHK036 Is the required presentation of status for unreadable present variants defined without conflicting with the rule that a present badge normally acts as the open control? [Ambiguity, Spec §FR-022]
- [x] CHK037 Are traceability links from FR-022, FR-023, and SC-007 to primary, alternate, exception, recovery, accessibility, and cross-platform acceptance evidence complete? [Traceability, Plan §Verification Plan]

## Notes

- Check items off only after the cited requirements are demonstrably complete, clear, consistent, and measurable.
- Record findings inline and update the owning specification, plan, contract, or quickstart before marking an item complete.
- This checklist reviews requirements writing; it does not verify the implementation.

## Post-Remediation Addendum (2026-07-31)

### Requirement Completeness

- [x] CHK038 Are all seven settled slot states and the exclusion of the both-missing pair documented sufficiently to define exactly 48 valid ordered EPUB/PDF card states? [Completeness, Spec §Closed settled-card matrix for SC-007]
- [x] CHK039 Are requirements present for the non-settled batched-progress period so it cannot be interpreted as missing, `0%`, or actionable? [Completeness, Spec §FR-022, UI Contract §Library Card]

### Requirement Clarity

- [x] CHK040 Is the canonical percentage formula explicit about input normalization, clamping, rounding, absent progress, and reserving `100%` for completion? [Clarity, Spec §FR-022 and §Edge Cases]
- [x] CHK041 Are `aria-disabled="true"`, retained keyboard focus, status description, activation outcome, and separately reachable recovery defined unambiguously for checking, unavailable, and quarantined badges? [Clarity, Spec §FR-022, UI Contract §Library Card]

### Requirement Consistency

- [x] CHK042 Is successful add/association focus consistently assigned to the same slot after it becomes present, while cancellation and failure consistently return to the originating missing badge? [Consistency, Spec §FR-023, Plan §User Interface and Accessibility, UI Contract §Library Card]
- [x] CHK043 Is the local-file-only SC-001 cohort consistently separated from existing-entry association in the specification, validation protocol, and acceptance tasks? [Consistency, Spec §SC-001, Quickstart §Usability Protocol, Tasks §Cross-Cutting Acceptance]

### Acceptance Criteria Quality

- [x] CHK044 Can every SC-007 row be evaluated from the specified slot fixtures without inventing progress, status, interaction, ordering, or legacy-control expectations? [Measurability, Spec §SC-007 and §Closed settled-card matrix for SC-007]
- [x] CHK045 Are the closed 48-row settled-card matrix and the separate 48-case recovery matrix named and scoped distinctly enough to prevent their denominators or evidence from being conflated? [Clarity, Spec §SC-007, Quickstart §Primary Chromium Journeys and §Recovery Matrix]

### Scenario and Traceability Coverage

- [x] CHK046 Are the non-representative health causes omitted from the 48-row presentation denominator explicitly covered by another bounded status/error matrix? [Coverage, Spec §Closed settled-card matrix for SC-007, Spec §FR-007]
- [x] CHK047 Are FR-022, FR-023, SC-001, and SC-007 traceable to focused unit, Chromium, cross-browser, accessibility, usability, and unavailable-gate requirements without treating one evidence class as a substitute for another? [Traceability, Plan §Verification Plan, Tasks §Badge-Only Library Card Refinement]

## Review Record

- **Reviewed**: 2026-07-31
- **Result**: 47/47 requirement-quality checks pass after reconciling the
  specification, plan, UI contract, validation quickstart, and implementation
  tasks.
- **Boundaries**: This result accepts the requirements writing only. Source
  implementation and runtime evidence remain governed by the unchecked tasks in
  `tasks.md`.
