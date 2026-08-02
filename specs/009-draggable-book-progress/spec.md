# Feature Specification: Draggable Book Progress

**Feature Directory**: `009-draggable-book-progress`

**Created**: 2026-08-02

**Status**: Accepted

**Input**: User description: "Allow readers to drag or click between milestones on the progress bar to move quickly back and forth, add a beginning/zero milestone for the first page, and show every top-level section such as Preface."

## Outcome and Scope

**Outcome**: Readers can scrub through a book with immediate position changes and can identify or select the true beginning and every top-level publication section from the progress bar.

**In scope**:

- Continuous pointer/touch and keyboard progress seeking for formats that support overall progression seeking, including direct rail clicks between milestones.
- A distinct 0% milestone named `Beginning` that targets the first readable position rather than the first TOC entry.
- One milestone for every top-level table-of-contents entry, including unnumbered front/back matter such as Preface, Foreword, or Appendix.

**Non-goals**:

- Nested TOC entries as progress milestones.
- Changes to TOC numbering, persisted progress schemas, EPUB pagination, or PDF page navigation.
- Synthesizing authored section milestones when a publication has no top-level TOC entries.

## User Scenarios and Testing

### User Story 1 - Scrub through a book (Priority: P1)

A reader drags the progress thumb backward and forward and sees the publication follow the most recent selected position without having to release the pointer first.

**Why this priority**: Fast direct movement is the primary requested interaction and must remain usable under renderer latency.

**Independent test**: Drag the slider through multiple values while one seek is still pending; the visible and persisted location ultimately matches the last value and the slider remains operable throughout.

**Acceptance scenarios**:

1. **Given** an open seekable book, **When** the reader drags across several positions, **Then** position requests begin during the drag and the latest selected position wins.
2. **Given** a seek already in progress, **When** the reader reverses direction, **Then** the slider remains enabled and the reader lands at the latest backward position.
3. **Given** a keyboard-focused slider, **When** its value changes, **Then** the same latest-position behavior applies and the accessible value remains current.
4. **Given** a renderer rejects a seek, **When** dragging ends, **Then** the reader reports the navigation error and remains usable for another seek.
5. **Given** two adjacent milestones, **When** the reader clicks an unmarked point between them, **Then** the reader seeks to that in-between publication position rather than snapping to either milestone.

---

### User Story 2 - Navigate complete book structure (Priority: P2)

A reader sees the true start of the publication and every top-level section on the progress rail, including unnumbered material such as Preface.

**Why this priority**: The current chapter-only filter hides valid book structure and incorrectly makes the first chapter appear to be the beginning.

**Independent test**: Open the EPUB fixture containing Preface, Chapter One, and Chapter Two; the rail exposes Beginning plus all three top-level entries, and each control navigates to its named destination.

**Acceptance scenarios**:

1. **Given** a book with top-level Preface and chapters, **When** the reader views the progress rail, **Then** it shows `Beginning`, `Preface`, and every top-level chapter in publication order.
2. **Given** the `Beginning` milestone, **When** it is activated, **Then** the reader moves to overall progression 0 rather than to the first TOC locator.
3. **Given** a top-level milestone, **When** it is activated, **Then** the reader moves to that entry's exact locator and preserves its authored label/numbering.
4. **Given** two milestones without position metadata, **When** they are laid out, **Then** they receive stable ordered fallback positions without obscuring the dedicated zero milestone.

### Edge Cases

- A publication with no TOC still shows Beginning but does not invent authored section milestones.
- A publication with one top-level entry shows `Beginning` and that entry.
- Invalid or non-finite locator progression uses a bounded, stable order-based position.
- Repeated drag input is coalesced so renderer work remains sequential and only the latest pending value is retained.
- Pointer, touch, and keyboard interaction preserve the slider focus and accessible value text.
- Reader teardown does not start queued seeks after destruction.

## Requirements

### Functional Requirements

- **FR-001**: Omnia Reader MUST request book-position changes during slider input, not only after input is committed.
- **FR-002**: Omnia Reader MUST process at most one progress seek at a time and retain only the latest pending slider value.
- **FR-003**: Omnia Reader MUST keep the progress slider operable while its own seek request is running and MUST land on the final selected value.
- **FR-004**: Omnia Reader MUST expose a distinct `Beginning` milestone at 0% whenever overall progression seeking is available, including when the publication has no TOC.
- **FR-005**: Omnia Reader MUST expose every top-level TOC entry as a milestone in authored order, regardless of chapter numbering classification.
- **FR-006**: Activating `Beginning` MUST use overall-progression seeking at 0; activating a TOC milestone MUST use that entry's locator.
- **FR-007**: Milestone positions MUST prefer valid publication position metadata, use deterministic ordered fallback positions when metadata is absent, and keep controls with equal positions individually pointer-accessible without changing their true percentage labels or targets.
- **FR-008**: Seek failure MUST expose the existing navigation error and allow a later slider interaction to retry.
- **FR-009**: Clicking an unmarked point on the progress rail MUST seek to that point without snapping to an adjacent milestone, in both forward and backward directions.

### Quality and Boundary Requirements

**Offline and recovery**

- All behavior remains local and available offline; failed renderer navigation does not alter durable schema or require network recovery.

**Security and trust**

- TOC labels and locators remain publication-controlled hostile input handled through existing text binding, locator validation, sandboxing, and engine navigation boundaries.

**Accessibility and interaction**

- The native range control remains keyboard, pointer, and touch operable with `Book progress` and current percentage semantics. Every milestone remains a labelled button, with `Beginning` distinguished from authored entries.

**Platform and compatibility**

- The behavior applies to seek-capable EPUB and PDF readers on web/PWA and shared Tauri webviews. Chromium is required locally; Firefox and WebKit are renderer compatibility gates when available.

**Lifecycle and performance**

- Rapid input MUST never create concurrent renderer seeks; only one in-flight and one latest pending value are retained. No dependencies, workers, listeners, or persistent records are added.

**Migration and compatibility**

- No schema, backup, sync, locator, or public engine contract changes are required. Existing saved locations remain compatible.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A drag sequence that emits at least three values begins navigation before release and finishes at the last emitted value in 100% of focused test runs.
- **SC-002**: The standard EPUB fixture exposes exactly four ordered milestones: Beginning, Preface, Chapter One, and Chapter Two.
- **SC-003**: During a delayed seek, the slider remains enabled and a direction reversal is accepted without concurrent seek execution.
- **SC-004**: Focused unit, Chromium journey, affected lint, production build, and diff checks complete without a new failure.
- **SC-005**: The focused Chromium journey clicks forward and backward at non-milestone rail positions and lands strictly between their adjacent milestone percentages.

## Acceptance Evidence

- Angular unit coverage for continuous coalesced seeking, final-value behavior, retry, Beginning behavior, and all top-level milestones.
- Focused Playwright EPUB coverage proving live drag/input movement, direct in-between rail clicks, and Beginning/Preface/chapter navigation.
- Chromium evidence is required locally; Firefox and WebKit results are reported separately if unavailable.
- `npx nx test omnia-reader`, affected lint, production build, and `git diff --check` are required.

## Assumptions

- Native range `input` events represent pointer, touch, and keyboard value changes across supported browsers.
- A TOC milestone without reliable position metadata may use an ordered visual fallback while navigation still uses its exact locator.
