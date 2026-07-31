# UI Interaction Contract

## Library Card

One logical book produces one card/list row and one result-count item.

Required presentation:

- shared title, authors, cover, and catalog activity;
- one format row immediately after catalog metadata and before secondary
  management actions, containing exactly one EPUB badge control followed by
  exactly one PDF badge control with equal visual weight: identical minimum
  height, inline padding, type scale/weight, border width, and corner treatment;
  content may wrap or widen a badge, and state may change text/icon/color, but
  neither format is styled as the primary action;
- a present-format badge labelled visually as `<FORMAT> <progress>%`, where the
  valid normalized progress `p` from that exact variant displays as `100%` only
  when `p >= 1` and otherwise as
  `min(99, round(100 * clamp(p, 0, 1)))%`; absent progress is `0%` and progress
  is never merged across formats; the format and percentage are text within one
  interactive badge, not visually adjacent sibling controls;
- a missing-format badge labelled visually as `<FORMAT> Add`, with no synthetic
  percentage or placeholder variant;
- present-format availability derived from the canonical status (`checking`,
  `healthy`, `unavailable`, or `quarantined`); `healthy` may be exposed as
  `Available`, and the precise unavailable/quarantine cause appears in adjacent
  text and the accessible name;
- no separate `Read EPUB`, `Read PDF`, `Add format`, or `Associate existing`
  card buttons;
- management actions for detach, delete variant, export variant, recovery,
  reconciliation, and whole-book removal remain available as applicable without
  duplicating the badge row.

Badge behavior:

1. Activating a healthy present-format badge authoritatively verifies and opens
   that exact variant. Its accessible name includes book title, format,
   percentage, and availability.
2. A checking, unavailable, or quarantined present-format badge remains visible
   and keyboard-focusable with percentage/status and `aria-disabled="true"`.
   Its status text is referenced by its accessible description.
   Activation keeps focus in place, announces the status once, and neither opens
   the variant nor starts recovery. Applicable recovery remains a separately
   named adjacent management action reachable without relying on color or hover.
3. Activating a missing-format badge opens an anchored, non-modal action menu
   named for that book and format; the trigger exposes its popup relationship
   and expanded state. Initial focus is `Add local <format>`; the next and only
   other action is `Associate existing <format>`. Up/Down Arrow moves between
   actions, Home/End moves to the first/last action, and touch activates the
   named action.
4. The menu owns no durable state. Escape closes it and restores the originating
   badge. Tab/Shift+Tab closes it and continues forward/backward document focus
   order. Outside-pointer dismissal leaves focus on the clicked focusable target
   or restores the badge when the target is not focusable. Picker/dialog
   cancellation or failure restores the badge and changes nothing. Selecting an
   action closes the menu before its picker or dialog opens. Successful add or
   association updates the same card and focuses the same slot after it becomes
   the now-present format badge.
5. The two badges remain in EPUB-then-PDF order before and after updates. Their
   compact visual treatment retains visible focus and a minimum 48px hit target.

The card does not enter settled presentation until its initial batched progress
lookup completes. A loading placeholder must not expose a fabricated `0%`,
missing state, or actionable format badge. After settlement, a refresh retains
the last resolved percentage and adds `Progress updating`; a failed refresh
retains that value and adds `Progress temporarily unavailable`. Without any
resolved sample, use the non-actionable loading/error presentation rather than
inventing a percentage. A later successful sample updates the same slot without
focus loss. Settled-card conformance uses the exact 48-row matrix in `spec.md`
§Closed settled-card matrix for SC-007. Present-variant status/cause conformance
uses the separate nine-row matrix in `spec.md` §Closed health-presentation
matrix for FR-007.

Unavailable/quarantined variants remain visible/manageable but are never chosen
as default links. A healthy variant has valid metadata/reference and detected
format plus accessible, size-complete bytes whose SHA-256 matches its variant
ID. Candidate order is synchronized preferred format, sole candidate, EPUB,
then PDF; authoritative local verification occurs before renderer use. A failed
candidate exposes its derived status and falls through without overwriting
preference. If no variant is healthy, keep the card in search/sort/filter and
backup results, render text explanations for every availability state,
remove/disable reading actions, and retain applicable recovery, detach, delete,
and remove actions.

### Live Card Updates

- Progress, health, and membership updates reuse the existing EPUB/PDF slot and
  do not recreate or reorder the format controls. A focused slot keeps focus;
  a materially new health or membership state is announced once, while routine
  progress changes are not live-announced.
- If synchronization or another completed operation fills a missing slot while
  its action menu is open, close the menu without invoking either action, update
  that slot to its present badge, focus it, and announce the change once.
- If a present slot becomes missing while focused, keep focus on the same slot
  after it becomes `<FORMAT> Add`. If an update removes the whole card, move
  focus to the next card, otherwise the previous card, otherwise the named
  library heading or primary import action.
- An open association or reconciliation dialog revalidates changed membership
  and health before confirmation. Stale choices refresh or become disabled in
  place and are announced once; no update may silently confirm an action.

## Source Recovery

- Every unavailable or quarantined variant offers `Replace <format> source`.
- A `Retry synchronized download` action is additionally present only when sync
  has a verified descriptor for that exact variant object.
- Replacement uses the existing picker, accepts exactly one source, and states
  that the source must match the existing exact publication; zero selections is
  cancellation and multiple selections are rejected before mutation.
- Progress and the final result are announced. An identity, size, format,
  structure, DRM, or integrity mismatch names the cause and leaves the prior
  active source, membership, reading state, and preference unchanged.
- Success replaces only device-local binary/reference and quarantine evidence,
  restores the variant's healthy eligibility, keeps the current card/focus, and
  announces the title and format. It emits no logical membership or preference
  change.

## Add Format from a Missing Badge

1. The missing-format badge and its choice surface name the destination book and
   exact missing format.
2. Choosing `Add local <format>` opens existing platform publication selection
   constrained and validated for the originating format.
3. Zero selections is cancellation with focus restored to the missing badge and
   no alert.
4. More than one selection produces an actionable no-mutation result and restores
   focus to the missing badge.
5. Validation progress is announced without blocking the whole library.
6. Success updates the existing card in place, converts the missing badge to a
   present badge with initial progress, focuses it, and announces title + added
   format; no second card briefly appears.
7. Duplicate, same-format, invalid, quota, or storage failures name the source
   and leave the card/state unchanged.
8. If the exact candidate belongs to another logical book, announce its current
   title and offer `Associate existing <format> with <destination>` only when
   that source is a compatible standalone book. A candidate already in the
   destination is reported as an exact duplicate. A candidate owned by a
   multi-format book, or whose association would occupy an existing format
   slot, gets an explanatory no-mutation result instead of an unsafe offer.
   Opening the existing association dialog is explicit; no source, membership,
   or journal mutation occurs before confirmation.

## Associate Existing from a Missing Badge

1. Choosing `Associate existing <format>` from a missing badge opens a dialog
   listing only compatible standalone candidates that contain that exact format,
   using title, author, format, filename, and enough metadata to avoid ambiguous
   selection.
   When no compatible candidate exists, it presents a named empty state,
   explains that a standalone opposite-format book is required, and returns
   focus without mutation when closed.
2. Similar metadata may rank/filter candidates but never preselects or commits
   association.
3. Confirmation names destination presentation and both formats and states that
   format-specific reading data remains separate.
4. A stale/same-format conflict keeps the dialog safe and reloads choices.
5. Success removes the source card, updates the destination card, converts and
   focuses its originating badge as a present format, and announces completion.

## Reader Format Choice

- When a healthy sibling exists, expose a named `Reading format` control in the
  wide toolbar and narrow reader-actions panel.
- The current format is programmatically selected and format names are text.
- Before navigation, persist current progress, resolve/preserve any annotation
  draft according to existing close behavior, and close transient panels.
- Navigate to the sibling variant route only after required local state settles.
- Resolve the target through the authoritative healthy-source boundary before
  renderer creation; digest/format mismatch is quarantined and announced.
- Persist and journal synchronized preferred format only after an explicit
  target format successfully opens and only when it changes. Failed opens,
  automatic defaults, and unavailable-format fallbacks do not update it.
- New variant resumes its own progress/bookmarks/annotations. Switching back
  restores the first variant's independent state.
- A failed flush or newly unavailable sibling prevents navigation and announces
  an actionable error without tearing down the current reader.

## Synchronization Reconciliation

- An affected card and synchronization settings display `Format association
needs review` with a persistent `Review format association` action. Dismissal,
  navigation, restart, and another sync do not resolve it.
- The labelled dialog shows the accepted and competing memberships, exact
  formats/filenames/identities, preserved reading-state guarantee, and any
  same-format constraint.
- Valid explicit choices keep the accepted association, move the preserved
  variant to the competing logical book, or keep it standalone. Invalid
  same-format outcomes are disabled with explanatory text.
- Confirmation commits one atomic reconciliation change. Cancellation restores
  focus and changes nothing; stale/failure results leave the action open.
- While this or an association dialog is open, a membership, availability, or
  synchronization update revalidates the displayed choices before confirmation.
  A choice that became stale or unavailable is disabled or refreshed in place,
  the change is announced once, and focus remains on the corresponding choice
  or moves to the dialog heading; the dialog never closes or commits silently.

## Backup Restore Conflict Report

- A non-empty preflight report announces `Backup not restored` and the complete
  conflict count; it never shows partial restore success.
- A persistent semantic list groups membership and occupied-format conflicts and
  names current book, backup book, format, filename, and reason in deterministic
  order.
- Closing the report restores focus and changes nothing. Selecting the repaired
  archive again remains possible.

## Detach and Delete

- Detach confirmation names the format and explains that it becomes a separate
  library book without deleting its file/state.
- Delete-variant confirmation names the format and states that only that source
  and its format-specific state are removed.
- Removing the final variant uses the existing whole-book confirmation.
- After success, focus moves to the updated card, new detached card, or nearest
  stable library control. Cancellation restores invoking-control focus.
- Removing the last library book exposes the existing named empty-library state
  and places focus on its primary import action or heading.

## Accessibility and Responsive Rules

- Every icon-only action has an accessible name including book title/format.
- Present badge names include title, format, progress percentage, and
  availability. Missing badge names include title, format, and `Add or
associate`; neither state depends on a tooltip.
- Completion/cancellation uses polite status semantics; failures use alert
  semantics. Each semantic state transition produces at most one live-region
  message; rerendering or receiving the same synchronized state produces none,
  while a materially new busy, conflict, success, cancellation, or failure
  state must be announced.
- Dialogs initially focus the first meaningful control. Cancellation or failure
  restores the originating badge; successful add/association focuses the same
  slot after it becomes the present badge.
- Keyboard order follows visible order; menus/dialogs support Escape and do not
  trap focus after close.
- Visible focus and at least 48px touch targets apply to both compact badges and
  every choice action.
- Format/availability is never conveyed by color alone.
- At 320 CSS pixels wide and at 200% browser text scaling, the format row may
  wrap but keeps EPUB before PDF; no required format action is clipped or
  reachable only by horizontal page scrolling, and every badge/choice retains a
  48px target and visible focus.
- Localized format, action, availability, progress-refresh, and recovery labels
  wrap within their controls without ellipsis or loss of distinguishing text.
- Titles, filenames, reasons, and conflict descriptions wrap without hiding
  their differentiating text. Duplicate titles or filenames include format,
  owning-book context, and a shortened exact-identity suffix in the accessible
  name; long restore reports remain semantic lists with independently reachable
  items rather than one oversized announcement.
- Before release, audit add, associate, choose, detach, delete, synchronization
  reconciliation, all-variants-unavailable management, and restore-conflict
  reporting with NVDA + Firefox on Windows, VoiceOver + Safari on macOS, and
  TalkBack + Android WebView.
- Each audit records understandable names and states, dialog-purpose and
  conflict/status/failure announcements, predictable focus, and completion
  without visual interpretation in
  `specs/001-multi-format-books/accessibility-results.md`.
- Controls expose the correct name, role, state, format, and book context.
  Dialog purpose and initial focus are announced; conflict, confirmation, busy,
  success, cancellation, and failure are announced once. Format choice exposes
  the current selection and successful change.
- Focus follows visual order and Escape, cancellation, and completion restore or
  move it predictably. Desktop audits use screen-reader keyboard navigation;
  TalkBack uses swipe/touch exploration and activation. Color, tooltip, hover,
  or visual position is never the sole carrier of meaning.
- An unavailable assistive-technology/browser combination is `UNVERIFIED`, not
  passed, and cannot be inferred from automated accessibility or browser tests.
