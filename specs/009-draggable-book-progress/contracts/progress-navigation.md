# Progress Navigation UI Contract

## Slider

- `input` immediately updates displayed percent and schedules navigation.
- Clicking an unmarked rail position emits the native range value and seeks there without milestone snapping.
- Renderer calls are sequential; an unstarted value is replaceable by a newer value.
- The final input/change value is eventually requested unless the reader is destroyed.
- The slider stays operable during queue-owned work and is disabled during loading or unrelated navigation.
- Navigation failures use the existing reader navigation-error surface and do not prevent a later retry.

## Milestones

1. `Beginning` is always present when overall progression seeking is available, displays first at 0%, and calls overall progression seeking with 0 even when the publication has no TOC.
2. Each depth-0 TOC entry follows in authored order, including entries explicitly or implicitly unnumbered.
3. TOC activation calls exact-locator navigation.
4. Valid locator progression/page metadata controls rail placement; otherwise authored order supplies a stable fallback that reserves 0 for Beginning. Controls with the same valid position receive a small deterministic visual separation so each remains pointer-accessible while retaining its true percentage label and target.
5. Nested TOC entries are excluded from the rail but remain available in the TOC panel.
6. Milestone buttons keep exact-locator activation; the transparent space between them remains owned by the slider for arbitrary forward and backward seeking.
