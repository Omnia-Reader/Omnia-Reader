# Research: Draggable Book Progress

## Decision: Use native input events with a latest-value queue

**Rationale**: The existing native range already provides pointer, touch, and keyboard semantics. Its `input` event fires while the value changes. A sequential queue preserves renderer safety while allowing reversal and discarding stale pending values.

**Alternatives considered**:

- Seek only on `change`: current behavior; it does not move the book during dragging.
- Fire every seek concurrently: risks out-of-order relocation, persistence, and renderer lifecycle work.
- Add an external slider/gesture dependency: unnecessary and increases bundle/accessibility risk.

## Decision: Milestones reflect structural TOC entries, not chapter classification

**Rationale**: The user asked for top-level sections, and the existing TOC already preserves authored order and unnumbered landmarks. Filtering `Preface` is contrary to that contract.

**Alternatives considered**:

- Expand only the nonchapter title allowlist: remains language-dependent and incomplete.
- Include nested entries: overcrowds the compact rail and exceeds scope.

## Decision: Map rail clicks explicitly through slider geometry

**Rationale**: Chromium browser evidence showed that an unmarked rail click could leave the native range at its old value under the overlaid milestone layout. Mapping a primary-pointer click through the existing thumb-aware geometry makes arbitrary gap seeking deterministic while preserving native input, keyboard, touch, focus, and milestone-button behavior.

**Alternatives considered**:

- Rely only on the browser's native range click: failed the focused Chromium regression by remaining at 0%.
- Put a click handler on the milestone overlay: risks intercepting exact-locator milestone buttons and duplicates slider semantics.
- Replace the native range with a custom slider: unnecessary and weakens accessibility and compatibility.

## Decision: Beginning is a synthetic progression target

**Rationale**: The first TOC locator may start after cover/title matter. Progression 0 is the existing engine contract for the earliest stable book location.

**Alternatives considered**:

- Reuse the first TOC entry: reproduces the reported defect.
- Persist a synthetic locator: unnecessary schema and compatibility change.

## Decision: Reserve zero in ordered fallback layout

**Rationale**: Some TOC locators do not expose overall position metadata. Stable order-based fallback positions reserve 0 for Beginning so the first authored entry remains separately pointer-accessible.

**Alternatives considered**:

- Place the first authored entry at 0: overlapping controls obscure one another.
- Derive EPUB CFIs by loading every section during UI setup: adds renderer work and trust/lifecycle complexity for a visual fallback.
