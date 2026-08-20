# Feature Specification: Multi-Format Books

**Feature Directory**: `001-multi-format-books`

**Created**: 2026-07-31

**Status**: Draft

**Input**: User description: "I'd like to be able to associate/upload multiple formats of the same book, such as EPUB and PDF. On library cards, keep only the EPUB and PDF badges, remove the separate Read EPUB and Read PDF buttons, show each format's reading-progress percentage next to its badge, and remove the separate Add format and Associate existing buttons by integrating those actions into the format badges."

## Outcome and Scope _(mandatory)_

**Outcome**: Readers can keep EPUB and PDF versions of the same work together as
one library book, choose the version they want to read, and manage each source
file without creating duplicate library cards or losing format-specific reading
state.

**In scope**:

- Add a supported publication file as another format of an existing book.
- Associate compatible standalone library entries as formats of one logical
  book.
- Show the available formats on a single library entry and let the reader choose
  which one to open.
- Use the EPUB and PDF badges as the complete card-level surface for opening an
  existing format or adding/associating a missing format.
- Preserve, remove, back up, and synchronize each associated source file and its
  format-specific reading state safely.
- Migrate existing one-file books into the multi-format model without changing
  their visible library behavior.

**Non-goals**:

- Converting one publication format into another.
- Automatically associating books solely because their title, author, or other
  metadata looks similar.
- Translating reading locations, bookmarks, or annotations between EPUB and PDF.
- Supporting DRM-protected publications or formats other than EPUB and PDF.
- Keeping multiple files of the same format in one logical book; separate
  editions of the same format remain separate library books.

## Clarifications

### Session 2026-08-20

- Q: Which synchronization representation is authoritative after feature 010? → A: Preserve this feature's multi-format membership, preference, reconciliation, exact-object recovery, and convergence outcomes, but use the current `.omnia-reader/manifest.json` schema-2 gate and the single canonical `.omnia-reader/logical-books/state.json` document. The former append-only `logical-books/changes/` and checkpoint persistence described by the original implementation design is compatibility input only and MUST NOT be reintroduced.

### Session 2026-07-31

- Q: Where should focus go after a missing-format add or association finishes? → A: Cancellation or failure returns focus to the originating missing badge; success focuses the same slot after it becomes the newly present format badge.
- Q: What finite denominator establishes the badge-only library-card success criterion? → A: Use the closed 48-state matrix formed from seven settled states per EPUB/PDF slot, excluding the invalid both-missing pair.
- Q: Which path counts toward the two-minute SC-001 usability outcome? → A: Measure local-file addition only; existing-entry association remains a separate acceptance journey and does not count toward SC-001.
- Q: How should present-badge progress and unreadable interaction be represented? → A: Clamp valid saved progress to 0–1, round to a whole percent while reserving 100% for completion, and keep checking/unavailable/quarantined badges focusable with status semantics but unable to open or trigger recovery.
- Q: How should adding or associating a missing format work without separate card buttons? → A: Always show one EPUB badge and one PDF badge. A present-format badge opens that format and shows its progress; activating a missing-format badge presents format-specific choices to add a local file or associate a compatible existing entry.
- Q: How should format choice and per-format progress appear on a library card? → A: Use only compact EPUB and PDF badge controls; remove the separate Read EPUB and Read PDF buttons, show each format's progress percentage adjacent to its badge, and let an available badge open that format.
- Q: When concurrent synchronization changes conflict over which logical book should contain a variant, how should the reader resolve the conflict? → A: Preserve both variants and require explicit user reconciliation.
- Q: What should happen when a reader adds a file that is already stored as a variant of another logical book? → A: Reject the add and offer association with the existing book.
- Q: How should a logical book appear when none of its variants is currently readable because every source is missing, unavailable, or quarantined? → A: Keep it visible with recovery and management actions.
- Q: What should happen when a backup restore conflicts with the current library because a variant already belongs elsewhere or a logical book already contains that format? → A: Abort before mutation and report all conflicts.
- Q: Should the preferred or most recently opened format be stored separately on each device or synchronized across devices? → A: Synchronize the preferred format across devices.
- Q: When should Omnia Reader update a book's synchronized preferred format, and what should it open before any preference exists? → A: Update only after an explicit format choice successfully opens; with no preference, use the sole healthy format, then EPUB, then PDF, and never update preference from failed opens or automatic fallback.
- Q: Which assistive-technology combinations must audit the multi-format journeys before release? → A: Require NVDA with Firefox on Windows, VoiceOver with Safari on macOS, and TalkBack with Android WebView; unavailable combinations remain unverified, not passed.
- Q: When should a publication variant count as healthy and be eligible for automatic opening or fallback? → A: When its source bytes are accessible, integrity-valid, supported, and not quarantined.
- Q: What should count as the required visible acknowledgement within one second after a management action starts? → A: A visible busy, progress, success, or failure state appears within one second of activation.
- Q: How should the supported reference device classes be fixed so performance results remain comparable between releases? → A: Define versioned minimum CPU, memory, power-mode, OS, and browser/WebView profiles for each device class; faster hardware is supplemental evidence.
- Q: After invalid active source data is isolated, how should availability and the failure reason be represented? → A: Report `quarantined` eligibility with a required `integrity-invalid`, `unsupported`, or `malformed-reference` cause; use the cause for explanation and the status for opening eligibility.
- Q: What is the complete canonical variant-health vocabulary? → A: Use exactly `checking`, `healthy`, `unavailable`, and `quarantined`; `checking` and `healthy` have no cause, `unavailable` requires `missing`, `evicted`, `inaccessible`, or `incomplete`, and `quarantined` requires `integrity-invalid`, `unsupported`, or `malformed-reference`.
- Q: Which recovery actions should an unavailable or quarantined variant expose? → A: Offer exact-source replacement for every unavailable or quarantined variant and verified synchronized-download retry when a remote exact object exists; success preserves identity, membership, state, and preference, while cancellation or failure changes nothing.
- Q: Which management branches must satisfy the one-second acknowledgement requirement? → A: Use the fixed 14-branch matrix: success and failure for add, associate, detach, delete variant, reconcile membership, replace source, and restore conflict handling.
- Q: Which runtime identity and drivers establish the four primary performance profiles? → A: Freeze profile v1 from a clean `npm ci` installation of the committed lockfile and use separate desktop-web, mobile-web, packaged-desktop release, and Android release drivers.

## User Scenarios and Testing _(mandatory)_

### User Story 1 - Add another format (Priority: P1)

A reader who already has a book in the library adds the same work in another
supported format. The library continues to show one book, clearly indicates both
available formats, and retains both original files.

**Why this priority**: This is the smallest outcome that directly removes
duplicate library entries while preserving access to both source publications.

**Independent test**: Import one EPUB as a book, activate its missing PDF badge,
choose to add a local PDF, and verify that one library entry exposes both
formats and can open either source without showing a separate add-format action.

**Acceptance scenarios**:

1. **Given** a book containing only an EPUB variant, **When** the reader adds a
   valid PDF as another format, **Then** the library shows one book with EPUB and
   PDF available and retains the existing EPUB state.
2. **Given** the device is offline, **When** the reader adds a valid local PDF to
   an EPUB book, **Then** the association completes locally and remains available
   after the application is restarted.
3. **Given** a selected file is corrupt, unsupported, DRM-protected, or already
   present, **When** the reader attempts to add it, **Then** the existing book and
   all of its variants remain unchanged and the reader receives an actionable
   result.
4. **Given** the selected file already belongs to another logical book, **When**
   the reader attempts to add it, **Then** no membership changes and the reader
   is directed to associate the existing books explicitly.
5. **Given** a book contains only EPUB, **When** the reader activates its missing
   PDF badge, **Then** the reader can choose either to add a local PDF or to
   associate a compatible PDF already in the library, and no separate Add format
   or Associate existing button appears on the card.

---

### User Story 2 - Associate existing library entries (Priority: P2)

A reader who previously imported EPUB and PDF versions as separate books can
associate them without re-uploading either file. The resulting logical book
retains the durable state of both source entries.

**Why this priority**: Existing libraries need a safe path to gain the new
organization without deleting and re-importing files.

**Independent test**: Start with standalone EPUB and PDF entries that each have
reading state, activate the EPUB book's missing PDF badge, choose the existing
PDF entry, and verify one library entry contains both files and preserves each
format's prior resume position.

**Acceptance scenarios**:

1. **Given** separate EPUB and PDF library entries, **When** the reader explicitly
   associates one with the other, **Then** one logical book remains and both
   variants and their format-specific state are preserved.
2. **Given** either logical book already contains the other entry's format,
   **When** association is attempted, **Then** the reader is told about the
   conflict and no files or reading state are changed.
3. **Given** association is interrupted before its durable update completes,
   **When** the library is opened again, **Then** it shows either the two original
   standalone books or the completed association, never a partial or missing
   variant.
4. **Given** no compatible existing entry is available for the missing format,
   **When** the reader chooses association from that format's badge, **Then** the
   reader sees a named empty state and can return to the same badge or choose a
   local file without any membership change.

---

### User Story 3 - Choose and manage a format (Priority: P3)

A reader can see which formats a book contains, open the desired one, resume that
format independently, and remove or detach a variant without accidentally
deleting the whole logical book.

**Why this priority**: Association is only useful when format choice and later
management are understandable and safe.

**Independent test**: Open each format at a different position, return to the
library, resume each one, detach one variant, and verify both the remaining book
and the detached standalone book retain the expected source and state.

**Acceptance scenarios**:

1. **Given** a book has EPUB and PDF variants, **When** the reader opens the book,
   **Then** the synchronized preferred format opens when healthy and the reader
   can explicitly choose the other format before or during entry to reading.
2. **Given** each format has a different saved position, **When** the reader
   switches formats, **Then** the selected format resumes at its own saved
   position without overwriting the other format's position.
3. **Given** a book has two variants, **When** the reader chooses to detach one
   variant and confirms the action, **Then** that variant becomes a standalone
   library book and neither source file is deleted.
4. **Given** a book has two variants, **When** the reader chooses to delete one
   variant and confirms the action, **Then** only that source and its
   format-specific state are removed and the other variant remains readable.
5. **Given** concurrent synchronization changes assign a variant to conflicting
   logical books, **When** synchronization settles the conflict, **Then** both
   exact variants are preserved and the reader receives a persistent action to
   choose the final association explicitly.
6. **Given** every variant of a logical book is unavailable or quarantined,
   **When** the reader views the library, **Then** the book remains visible with
   reading disabled, each format's status explained, and recovery and management
   actions available.
7. **Given** the reader prefers PDF on one synchronized device, **When** another
   device receives that preference and PDF is available, **Then** PDF becomes the
   default there without changing either format's independent reading state.
8. **Given** a library book contains EPUB and PDF variants with different saved
   positions, **When** the reader views its card, **Then** the card shows one
   compact badge control per available format with that format's progress
   percentage adjacent to the badge and shows no separate Read EPUB or Read PDF
   button.
9. **Given** a format is healthy, **When** the reader activates its badge using
   pointer, touch, or keyboard input, **Then** that exact format opens and resumes
   from its independent saved position.
10. **Given** any library card, **When** the reader views its format controls,
    **Then** exactly one EPUB badge and one PDF badge are present, and the card
    contains no separate Read, Add format, or Associate existing controls.

### Edge Cases

- Selecting the exact file already stored reports a duplicate and does not create
  another variant or logical book; when it belongs to another logical book, the
  result directs the reader to the explicit existing-book association flow.
- Adding or associating a second file of a format already present reports a
  conflict and does not replace either file implicitly.
- Different or missing title, author, cover, language, publisher, or identifier
  metadata does not trigger automatic association; an explicit reader choice is
  required and the existing logical book's catalog presentation is retained.
- A variant is healthy only when its source bytes are accessible,
  integrity-valid, supported, and not quarantined. Missing, evicted,
  inaccessible, or incomplete bytes produce `unavailable` with a precise cause.
  Invalid active metadata/reference, digest mismatch, or detected-format
  mismatch produces `quarantined` with an `integrity-invalid`, `unsupported`, or
  `malformed-reference` cause and cannot prevent access to a healthy sibling.
- Removing the only remaining variant follows the existing whole-book removal
  confirmation rather than leaving an empty logical book.
- Cancelling file selection, association, detachment, deletion, or format choice
  makes no durable changes.
- Restart, storage failure, or synchronization interruption cannot leave a
  logical book referring to a source or reading-state record that was silently
  discarded.
- A concurrent synchronization membership conflict retains the deterministic
  accepted association and every exact variant until the reader explicitly
  chooses the final association; no conflicting variant is silently detached,
  deleted, or reassigned.
- When all variants are missing, unavailable, or quarantined, the logical book
  remains visible, no reading action is offered, and format-specific status,
  recovery, and management actions remain available.
- Replacing an unavailable or quarantined source succeeds only when the selected
  source has the existing variant's supported format, exact size, and SHA-256
  identity. A verified synchronized-download retry follows the same checks.
  Success changes only device-local binary/reference and quarantine evidence;
  logical membership, variant reading state, and synchronized preference remain
  unchanged. Cancellation or failure makes no durable change.
- When backup membership overlaps another logical book or would add a second
  variant of an occupied format, restore reports every detected conflict and
  aborts before changing any local data.
- A synchronized preferred format that is unavailable on the current device is
  retained for future recovery but is skipped in favor of an available variant;
  concurrent preference changes converge without affecting variant state.
- When no synchronized preference exists, the default is the sole healthy
  format, then EPUB, then PDF. Failed opens and automatic fallback never create
  or change the preference.
- Format controls remain understandable and operable on narrow viewports, with
  keyboard-only input, touch, and assistive technology.
- A format with no saved reading position displays `0%`. For a valid normalized
  saved progress `p`, the displayed percentage is `100%` when `p >= 1`;
  otherwise it is `min(99, round(100 * clamp(p, 0, 1)))%`. The calculation is
  independent for EPUB and PDF and never substitutes one format's progress for
  the other. A logical card does not enter its settled presentation until its
  batched progress lookup completes, so a pending lookup is never misreported as
  `0%`.
- After a card has settled, a progress refresh retains the last resolved
  percentage and adds the textual state `Progress updating`; a failed refresh
  retains that percentage and adds `Progress temporarily unavailable`. If no
  progress sample has ever resolved, the card stays in its non-actionable
  loading/error presentation and does not invent a percentage. A later
  successful refresh updates the same badge in place without moving focus.
- A checking, unavailable, or quarantined format keeps its badge and saved
  percentage visible for recognition and management. The badge remains
  keyboard-focusable with `aria-disabled="true"` and a textual status
  description, but activation keeps focus in place, announces that status once,
  and neither opens the variant nor starts recovery. Applicable recovery remains
  a separately named, adjacent management action.
- A missing format has no reading percentage. Its badge remains visible in a
  distinct textual `Add` state and opens format-specific add-or-associate
  choices; it is not treated as unavailable, quarantined, or started at `0%`.
- Cancelling the missing-format badge choices, local file selection, or existing
  entry selection restores focus to that same badge and makes no durable change.
- Successful local addition or association keeps the same format slot and moves
  focus to it after it becomes the newly present format badge.
- A missing-format badge never offers an existing entry that would create a
  same-format conflict, and selecting add versus associate never happens
  automatically from metadata similarity.
- If progress, health, or membership changes while a badge or its choice surface
  has focus, the existing EPUB/PDF slot is updated in place. A materially new
  health or membership state is announced once without moving focus. If a
  missing slot becomes present while its choice surface is open, the surface
  closes and focus moves to that now-present slot; if the whole card disappears,
  focus moves to the nearest stable library control.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Omnia Reader MUST represent a library book as one logical work with
  one or more distinct publication variants, while retaining the exact identity
  and original file of every variant.
- **FR-002**: From an existing book, a reader MUST be able to select a local file
  in a supported format not already present and add it as another variant.
- **FR-003**: A reader MUST be able to explicitly associate a standalone EPUB
  book with a standalone PDF book already in the library without re-uploading
  either source.
- **FR-004**: Omnia Reader MUST NOT automatically associate entries based only on
  similar metadata, and MUST retain the existing destination book's catalog
  presentation when a variant with differing metadata is explicitly associated.
- **FR-005**: A logical book MUST contain at most one EPUB variant and one PDF
  variant; an attempted same-format conflict MUST leave all existing data
  unchanged and explain how the reader can proceed.
- **FR-006**: Before completing an upload or association, Omnia Reader MUST
  validate the candidate's supported format, integrity, size, and exact identity
  with the same safety guarantees as a standalone publication import. Exact-
  source replacement and synchronized-download recovery MUST apply the same
  checks before making recovered bytes active.
- **FR-007**: Omnia Reader MUST display one library entry for a logical book and
  clearly expose every format using exactly the device-local status `checking`,
  `healthy`, `unavailable`, or `quarantined`, without counting variants as
  additional books. `Checking` and `healthy` MUST have no cause; `unavailable`
  MUST have cause `missing`, `evicted`, `inaccessible`, or `incomplete`; and
  `quarantined` MUST have cause `integrity-invalid`, `unsupported`, or
  `malformed-reference`.
- **FR-008**: A reader MUST be able to choose a healthy format to open. Selection
  MUST try the synchronized preferred format while it is healthy; otherwise it
  MUST use the sole healthy format, then EPUB, then PDF. Failed opens and
  automatic fallback MUST NOT request a preference change.
- **FR-009**: Resume position, bookmarks, annotations, and other
  publication-location-dependent state MUST remain scoped to their source
  variant and MUST NOT be silently translated or overwritten when formats are
  switched or associated.
- **FR-010**: Catalog-level information used to find and display the logical book
  MUST remain shared, while source identity, file properties, availability, and
  reading-location state MUST remain distinguishable per variant.
- **FR-011**: A reader MUST be able to detach a variant from a multi-format book
  into a standalone library book without deleting its source or format-specific
  state.
- **FR-012**: A reader MUST be able to delete one variant after a confirmation
  that names the affected format; deleting the last variant MUST use the existing
  whole-book removal behavior.
- **FR-013**: Upload, association, detachment, and deletion MUST be atomic from
  the reader's perspective: failure or interruption MUST preserve either the
  complete prior state or the complete requested state.
- **FR-014**: All association and variant-management operations MUST work without
  a network connection, become durable before optional synchronization, and
  remain correct after restart.
- **FR-015**: Backup, restore, synchronization, merge, exclusion, and deletion
  behavior MUST preserve logical-book membership, every variant's exact
  identity, and variant-specific state without silent loss, duplication, or
  resurrection.
- **FR-016**: Existing libraries, backups, and synchronized single-file books
  MUST remain readable and appear as logical books with one variant after the
  feature is introduced.
- **FR-017**: When concurrent synchronization changes conflict over logical-book
  membership, Omnia Reader MUST preserve every exact variant, retain the
  deterministic accepted membership, and provide a persistent reader action for
  explicit reconciliation before changing the association.
- **FR-018**: When an add-format candidate already belongs to another logical
  book, Omnia Reader MUST leave both memberships unchanged, reject the add, and
  offer the explicit existing-book association flow.
- **FR-019**: When no variant of a logical book is readable, Omnia Reader MUST
  keep the logical book visible, disable reading actions, explain each format's
  availability status and cause, and retain management actions. It MUST offer
  exact-source replacement for an unavailable or quarantined variant and MUST
  additionally offer verified synchronized-download retry when a remote exact
  object exists. Recovery success MUST preserve the variant ID, logical
  membership, format-specific state, and synchronized preference; cancellation,
  mismatch, or failure MUST leave them unchanged.
- **FR-020**: Before restoring a multi-format backup, Omnia Reader MUST detect
  every membership and occupied-format conflict with the current library; if any
  conflict exists, it MUST abort the entire restore before mutation and report
  all detected conflicts.
- **FR-021**: After an explicit format choice successfully opens, Omnia Reader
  MUST persist, back up, and synchronize that preferred format for the logical
  book across devices. Reopening the same format, a failed open, or an automatic
  fallback MUST NOT emit a preference update. Concurrent preference updates MUST
  converge deterministically and MUST NOT change or merge any variant's reading
  state.
- **FR-022**: Each library card MUST present its available formats using only
  compact EPUB and PDF badge controls, with no separate `Read EPUB` or `Read PDF`
  buttons. The badges MUST share one format row immediately after the catalog
  metadata and before secondary management actions, use equal visual weight,
  remain in EPUB-then-PDF order, and contain their format label and progress as
  text within the same interactive control. A badge for a present variant MUST
  display that variant's whole-number reading-progress percentage, using `0%`
  when no progress exists and `100%` when complete. A healthy badge MUST open
  its exact format. A checking, unavailable, or quarantined badge MUST remain
  visible and keyboard-focusable with `aria-disabled="true"`, retain its saved
  percentage, expose a textual status through its accessible description, and
  MUST NOT open the variant or initiate recovery. Applicable recovery MUST
  remain a separately named secondary management action. The card MUST NOT
  enter its settled presentation until its initial batched progress lookup
  completes. A later refresh MUST retain and identify the last resolved value
  while pending or temporarily unavailable, then update the same slot without
  focus loss when a new value resolves.
- **FR-023**: Every library card MUST always show exactly one EPUB badge and one
  PDF badge. When a format is missing, its badge MUST show a textual `Add` state
  instead of a percentage and MUST provide the format-specific choices to add a
  local source or associate a compatible existing library entry. The choice
  surface MUST be an anchored, non-modal action menu named for the book and
  missing format. It MUST focus `Add local <format>` first, place `Associate
existing <format>` second, support keyboard and touch operation, and close on
  Escape or outside-pointer dismissal. The card MUST NOT show separate `Add
format` or `Associate existing` buttons. Escape, picker/dialog cancellation,
  or failure MUST restore focus to the originating badge and leave membership
  and reading state unchanged. Outside-pointer dismissal MUST keep focus on the
  clicked focusable target, or restore the badge when there is none. Tab or
  Shift+Tab MUST close the menu and continue the card's document focus order.
  Selecting a choice MUST close the menu before opening its picker or dialog.
  Success MUST focus the same slot after it becomes the newly present format
  badge. A concurrent update that fills the missing slot MUST close the menu,
  update that slot in place, focus it, and announce the change once without
  starting either choice.

### Key Entities and Durable State _(include when data changes)_

- **Logical Book**: The single library-visible work. It owns catalog presentation
  and membership of one or more publication variants; it exists only while at
  least one variant remains.
- **Publication Variant**: One exact source publication belonging to a logical
  book. Its durable identity, format, original filename, media type, size, and
  import history remain distinct from other variants. Availability and integrity
  are device-local derived results, never durable variant fields. It is healthy
  only while its source bytes are accessible, integrity-valid, supported, and
  not quarantined.
- **Variant Reading State**: Resume position, bookmarks, annotations, and other
  location-dependent records tied to one publication variant so incompatible
  EPUB and PDF locations cannot overwrite one another.
- **Format Preference**: The format the reader most recently chose explicitly
  and successfully opened for a logical book. It is backed up and synchronized
  across devices, used only while that format is healthy, and is not changed by
  failed opens or automatic fallback.
- **Association Change**: A durable, recoverable change that joins, detaches, or
  deletes variants and can be reproduced consistently across backup, restore,
  and synchronization.

### Quality and Boundary Requirements _(mandatory)_

**Offline and recovery**

- Every in-scope action remains available for local publications while offline.
  Interrupted operations recover to a complete before-or-after state on the next
  library load, and optional provider failure cannot block local reading or
  management.

**Security and trust**

- Every newly selected or recovered source remains hostile input. Association
  cannot bypass size, integrity, archive, script, unsafe-navigation, quarantine,
  or DRM checks, and it introduces no new credential or unrestricted host-file
  access.

**Accessibility and interaction**

- Format badges, choices, conflicts, confirmations, progress, and results have
  accessible names and status announcements. All actions support keyboard and
  visible focus, preserve or restore focus after dialogs, provide touch targets
  suitable for handheld use, and do not rely on color alone.
- At 320 CSS pixels and at 200% browser text scaling, the EPUB-then-PDF format
  row may wrap but MUST retain order, visible focus, and 48px targets without
  horizontal page scrolling. Localized format/action/status text, long titles,
  filenames, and causes MUST wrap without clipping or truncating the information
  that distinguishes the book, format, progress, availability, or candidate.
- Interactive EPUB and PDF badges expose the format, book title, progress
  percentage, and availability in one understandable accessible name. Progress
  is available as text and is not conveyed by color, position, or shape alone.
- A missing-format badge exposes the format, book title, and `Add or associate`
  purpose in its accessible name. Its choice surface is keyboard and touch
  operable, has an announced name, and returns focus to the originating badge
  after cancellation or failure; success focuses the same slot after it becomes
  the newly present badge.
- Before release, add, associate, choose, detach, delete, synchronization
  reconciliation, all-variants-unavailable management, and restore-conflict
  reporting MUST be audited with NVDA and Firefox on Windows, VoiceOver and
  Safari on macOS, and TalkBack with Android WebView. Each audited journey MUST
  expose understandable names and states, announce dialog purpose, conflicts,
  status, and failure, preserve a predictable focus sequence, and remain
  completable without visual interpretation. An unavailable combination MUST be
  reported as unverified and MUST NOT be counted as passing.

**Platform and compatibility**

- The same user outcome applies to supported web/PWA and desktop and Android
  hosts. Library management and format selection work in supported Chromium,
  Firefox, and WebKit environments; host-specific file selection differences do
  not change the durable result.

**Lifecycle and performance**

- A management action provides visible acknowledgement—a busy, progress,
  success, or failure state—within one second of activation. Listing or opening
  a logical book loads only the chosen source, and cancelled, failed, switched,
  or closed flows release temporary resources. With 1,000 logical books and up
  to two variants each, 95% of library filtering, opening, and format-selection
  actions provide a visible result within two seconds on a supported reference
  device. Each reference device class has a versioned minimum CPU, memory,
  power-mode, OS, and browser/WebView profile. Primary acceptance evidence must
  use those profiles; faster hardware provides supplemental evidence only.
  Acknowledgement evidence MUST cover the fixed 14-branch matrix: one success
  and one injected or expected failure for add format, associate existing,
  detach, delete variant, reconcile membership, replace source, and restore
  conflict handling. Profile v1 MUST obtain dependency and browser identities
  from a clean installation of the committed lockfile, and packaged desktop and
  Android measurements MUST use their separate release-build drivers.

**Migration and compatibility**

- Migration is automatic, restart-safe, and preserves exact-edition identity,
  files, covers, progress, bookmarks, annotations, preferences, exclusions, and
  deletion history. New backups round-trip multi-format membership; older valid
  backups restore as single-variant logical books. A multi-format restore with
  any membership or occupied-format conflict fails before mutation and reports
  all conflicts. Mixed-version synchronization MUST fail safely rather than
  flatten, delete, or silently separate associated variants.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: At least 95% of representative readers can add a local PDF file to
  an existing EPUB book, or a local EPUB file to an existing PDF book, in under
  two minutes without assistance. Existing-entry association is measured
  separately and MUST NOT count toward this outcome.
- **SC-002**: In 100% of tested valid upload and association journeys, the
  library shows one logical book, exposes both formats, and opens the selected
  original source.
- **SC-003**: In 100% of tested offline, restart, cancellation, validation-error,
  storage-failure, and interrupted-synchronization scenarios, no previously
  durable source or reading state is silently lost or duplicated.
- **SC-004**: Every tested management action shows a visible busy, progress,
  success, or failure state within one second of activation. With 1,000 logical
  books and up to 2,000 variants, at least 95% of tested library filtering,
  book-opening, and format-selection actions show a result within two seconds on
  each supported reference device class's versioned minimum CPU, memory,
  power-mode, OS, and browser/WebView profile. Faster hardware results are
  supplemental and do not establish the release pass. The acknowledgement set
  is exactly the fixed 14-branch matrix defined under Lifecycle and performance;
  omitting or pooling a branch fails the criterion.
- **SC-005**: All add, associate, choose, detach, delete, synchronization
  reconciliation, all-variants-unavailable management, and restore-conflict
  journeys can be completed using keyboard-only and touch input. NVDA with
  Firefox on Windows, VoiceOver with Safari on macOS, and TalkBack with Android
  WebView each convey the controls, states, dialog purpose, conflicts,
  confirmations, status, failure, and focus sequence without visual
  interpretation; unavailable combinations are reported as unverified rather
  than passing.
- **SC-006**: Migration, backup/restore, and synchronization compatibility tests
  preserve 100% of variant memberships, exact source identities, synchronized
  format preferences, and format-specific state across the supported upgrade
  and recovery matrix.
- **SC-007**: All 48 valid rows of the closed settled-card matrix under
  Acceptance Evidence MUST pass: exactly one EPUB badge and one PDF badge
  appear, no separate Read, Add format, or Associate existing button appears,
  every present format's displayed percentage matches the canonical formula,
  and every missing-format badge exposes both add-local and associate-existing
  choices.

## Acceptance Evidence _(mandatory)_

### Closed settled-card matrix for SC-007

Each EPUB slot and PDF slot independently uses one of these seven settled
fixture states:

1. `missing`: visual `Add`, no percentage, both format-specific choices;
2. `checking`: saved `37.4%` → visual `37%`, focusable `aria-disabled="true"`
   semantics and
   textual `Checking` status;
3. `healthy-zero`: no saved progress → visual `0%`, opens the exact variant;
4. `healthy-progress`: saved `37.4%` → visual `37%`, opens the exact variant;
5. `healthy-complete`: saved `1.0` → visual `100%`, opens the exact variant;
6. `unavailable-progress`: saved `37.4%` → visual `37%`, focusable
   `aria-disabled="true"` semantics and an `Unavailable: missing` description;
7. `quarantined-progress`: saved `37.4%` → visual `37%`, focusable
   `aria-disabled="true"` semantics and a `Quarantined: integrity invalid`
   description.

The denominator is the ordered Cartesian product of EPUB state × PDF state,
excluding only `missing` × `missing` because a logical book cannot exist without
a variant: `7 × 7 - 1 = 48` rows. Every row keeps EPUB first and PDF second,
contains no legacy read/add/associate card button, validates each present slot's
percentage and interaction state, and validates both choices for every missing
slot. Other status causes remain covered by the canonical health/error matrices;
they do not expand this presentation denominator.

### Closed health-presentation matrix for FR-007

This separate nine-row matrix covers every valid present-variant health
status/cause pair. It is not part of SC-007's 48 settled-card rows and is not the
48-case before/after recovery matrix used by SC-003.

| Status        | Cause                 | Badge opens | Accessible description             | Recovery action                                   |
| ------------- | --------------------- | ----------- | ---------------------------------- | ------------------------------------------------- |
| `checking`    | none                  | no          | `Checking`                         | none                                              |
| `healthy`     | none                  | yes         | `Available`                        | none                                              |
| `unavailable` | `missing`             | no          | `Unavailable: missing`             | `Replace <format> source`; sync retry if verified |
| `unavailable` | `evicted`             | no          | `Unavailable: evicted`             | `Replace <format> source`; sync retry if verified |
| `unavailable` | `inaccessible`        | no          | `Unavailable: inaccessible`        | `Replace <format> source`; sync retry if verified |
| `unavailable` | `incomplete`          | no          | `Unavailable: incomplete`          | `Replace <format> source`; sync retry if verified |
| `quarantined` | `integrity-invalid`   | no          | `Quarantined: integrity invalid`   | `Replace <format> source`; sync retry if verified |
| `quarantined` | `unsupported`         | no          | `Quarantined: unsupported`         | `Replace <format> source`; sync retry if verified |
| `quarantined` | `malformed-reference` | no          | `Quarantined: malformed reference` | `Replace <format> source`; sync retry if verified |

Every non-healthy row keeps the badge focusable with `aria-disabled="true"`,
retains the last resolved percentage, and must not open or start recovery when
activated. Recovery is a separately reachable secondary action. A synchronized
download retry appears only when a verified descriptor exists for that exact
variant object.

- Contract evidence covers FR-001 through FR-023, including identity,
  same-format conflicts, per-variant state, synchronized format preference,
  atomic failure, migration, backup, restore, synchronization, merge, exclusion,
  and deletion behavior.
- Real-browser journeys cover adding a second format, associating existing
  entries from a missing-format badge, badge-only format presentation,
  independent progress percentages, selecting and resuming each present format
  from its badge, empty/cancelled add-or-associate choices, conflict and
  corrupt-input handling, explicit synchronization-conflict reconciliation,
  detaching, deleting, offline restart, keyboard use, focus behavior, narrow
  viewport, and accessible status announcements.
- The browser matrix includes supported Chromium, Firefox, and WebKit. PWA
  offline/restart behavior is required. Desktop and Android host file-selection
  and persistence journeys are required when their build, emulator, or device
  gates are available; unavailable gates must be recorded explicitly rather
  than reported as passing.
- Assistive-technology evidence records each required NVDA/Firefox,
  VoiceOver/Safari, and TalkBack/Android WebView journey and its result. Missing
  operating systems, screen readers, emulators, or devices remain explicit
  unverified release gates rather than inferred passes.
- Migration fixtures include a current single-file library, an older valid
  backup, a multi-format backup, interrupted association state, and mixed-version
  synchronization records. Performance evidence records activation-to-first-
  acknowledgement and activation-to-final-result separately and uses 1,000
  logical books and up to 2,000 variants on every versioned minimum reference
  profile. Evidence records the profile version, CPU, memory, power mode, OS,
  and browser/WebView; results from faster hardware are labeled supplemental.

## Assumptions

- The supported publication formats remain DRM-free EPUB and PDF.
- A logical book contains at most one source per format; another edition in the
  same format remains a separate logical book.
- Association is an explicit reader choice. Metadata may help readers recognize
  a candidate but never commits an association automatically.
- The destination book's existing catalog title, authors, cover, and related
  presentation remain authoritative when another variant is associated.
- Reading locations are not reliably portable between EPUB and PDF, so each
  variant retains independent resume, bookmark, and annotation state.
- The preferred format is synchronized across devices, but it never changes or
  combines the independent reading state of either variant.
- On library cards, the EPUB and PDF badges are the format-selection controls;
  there are no additional per-format reading buttons. Each badge's percentage
  represents only that variant's saved reading progress.
- Both supported format badges are always visible. A badge for a missing format
  shows an `Add` state and opens a choice between selecting a local source and
  associating a compatible existing entry; these actions do not appear as
  separate card buttons.
- Existing optional synchronization providers continue to be best-effort and
  local durable state remains authoritative.
