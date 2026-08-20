# Validation Quickstart: Multi-Format Books

This guide is the runnable acceptance path after implementation. It references
the [data model](data-model.md) and [contracts](contracts/) rather than
duplicating implementation tasks.

## Prerequisites

```sh
nvm use
npm ci
```

Use DRM-free EPUB/PDF fixtures representing the same work, plus corrupt,
same-format, and exact-duplicate fixtures. Provider, desktop, and Android gates
require their documented credentials/toolchains and are reported separately.

## 1. Focused Contract and Migration Gates

```sh
npx nx test reader-domain
npx nx test library-data-access
npx nx test sync-core
npx nx test sync-git
npx nx test sync-mega
npx nx test omnia-reader
```

Expected:

- an actual v8 IndexedDB fixture opens at v10 through the v9 singleton migration
  with one logical book per exact variant and unchanged reading-state IDs; a
  v9 fixture gains an empty logical-change outbox without rewriting its state;
- add, associate, detach, and delete failure injection always yields a complete
  before-or-after state;
- backup v4 round-trips two variants and schemas 1–3 restore as singletons;
- backup preflight reports every membership/occupied-slot conflict in canonical
  order and invokes no OPFS, repository, preference, reconciliation, or journal
  mutator;
- root schema 1→2 migration, canonical-state migration, causal
  membership/preference conflicts, persistent reconciliation, tombstones, and
  bounded optimistic retries converge without data loss or variant-state
  changes; a schema-2 device checkpoint is invalidated once before the
  canonical-state fast path is trusted;
- derived availability distinguishes `unavailable` causes
  missing/evicted/inaccessible/incomplete from `quarantined` causes
  malformed-reference/integrity-invalid/unsupported; same-size wrong bytes and
  format mismatch are isolated before renderer use, while verified exact-source
  replacement supersedes historical quarantine without changing identity,
  membership, state, or preference;
- reader switching preserves separate EPUB/PDF state and tears down the prior
  reader.

## 2. Static, Production, and Hygiene Gates

```sh
npx nx run-many -t lint -p reader-domain library-data-access sync-core sync-git sync-mega omnia-reader omnia-reader-e2e
npx nx build omnia-reader --configuration production
npx nx format:check
git diff --check
```

Expected: all projects pass lint, the production/PWA build passes configured
bundle budgets, repository formatting passes, and the intended diff has no
whitespace errors. Correct formatting only in the intended feature diff before
rerunning.

## 3. Primary Chromium Journeys

```sh
npx nx run omnia-reader-e2e:e2e -- --project=chromium src/example.spec.ts src/accessibility.spec.ts
```

Demonstrate:

1. Import EPUB and observe exactly two badges: `EPUB 0%` and `PDF Add`, with no
   separate Read, Add format, or Associate existing buttons. Activate `PDF Add`,
   choose the local-file path, add a PDF, and observe the same card change to two
   present-format badges.
2. Open each format from its badge and save different progress/bookmarks/
   annotations. Return to the library and verify independently rounded EPUB/PDF
   percentages, then switch repeatedly and observe independent resumes.
3. Import standalone EPUB/PDF entries with state, activate the destination's
   missing-format badge, choose association, select the compatible entry, and
   preserve both state sets and destination presentation.
4. Reject duplicate, same-format, corrupt, and cancelled inputs without a
   transient card or durable mutation.
   When an exact duplicate belongs to another logical book, verify the explicit
   association offer opens the existing-book flow and still performs no mutation
   before confirmation.
5. Detach one variant without deleting it; then separately delete one variant
   and verify its sibling remains readable.
6. Complete all badge and choice actions by keyboard and touch at 320px width.
   Verify stable EPUB-then-PDF order, 48px hit targets, visible focus, names that
   include book/format/progress or add-or-associate purpose, one status/alert
   announcement, focus restored to the originating badge on cancellation/failure,
   and focus moved to the same slot as the newly present badge on success.
   Confirm the anchored menu initially focuses `Add local <format>`, orders
   `Associate existing <format>` second, closes before either nested flow opens,
   restores the badge after Escape, advances document focus after Tab/Shift+Tab,
   and preserves a clicked focusable target after outside-pointer dismissal.
   Exercise local-picker cancellation, an empty candidate list, and failed
   add/association with zero durable change. Repeat at 200% browser text scaling
   with long localized labels/titles and require wrapping, no lost
   differentiating text, and no horizontal page scrolling.
7. Make both variants unavailable and verify one searchable/manageable card,
   precise per-format explanations, no reading action, and retained recovery and
   management actions.
8. Restore an archive with at least one ownership and two occupied-format
   conflicts; verify all are reported and a canonical before/after inventory is
   unchanged. Repair the archive and verify a later restore succeeds.
9. Replace the preferred source with same-size wrong bytes and separately a
   format-mismatched source; verify authoritative open quarantines it before
   renderer creation, opens a verified sibling without changing preference, and
   accepts a later exact-source replacement. Exercise both local replacement and
   descriptor-gated synchronized-download retry; mismatch, cancellation, and
   failure preserve the prior source, membership, state, and preference.
10. Generate all 48 rows from `spec.md` §Closed settled-card matrix for SC-007.
    For every ordered EPUB/PDF state pair except both-missing, assert stable
    badge order, the canonical percentage/status/interaction for each slot, both
    choices for each missing slot, and absence of legacy read/add/associate card
    buttons. A pending batched progress lookup uses the existing loading
    presentation and must not be counted as a settled row or exposed as a fake
    `0%`.
11. Generate the separate nine rows from `spec.md` §Closed health-presentation
    matrix for FR-007. Assert each exact status/cause description, open
    eligibility, focusable disabled semantics, and separately reachable recovery
    rule without adding those rows to either the 48-row settled-card denominator
    or SC-003's 48-case recovery denominator.
12. While a card is focused, drive progress refresh pending/failure/success,
    health changes, a present-to-missing membership change, and a missing slot
    becoming present while its action menu is open. Require in-place slot
    updates, the defined stale/temporarily-unavailable progress text, no routine
    progress announcement, one material state announcement, and the exact focus
    destination. Remove the focused card and require focus on the next card,
    previous card, or named library heading/import action in that order.

## 4. Offline/PWA Restart

```sh
PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts
```

Expected: add/associate/manage operations complete offline, survive a cold
restart, and both healthy variants remain readable. Competing membership changes
produce the same accepted projection and persistent review action on both
replicas; explicit reconciliation converges after restart. Concurrent EPUB/PDF
preference changes converge by causal ancestry then change ID. An unavailable
winner remains stored while a healthy fallback opens without publishing a new
preference. Optional sync failure is visible as pending and never blocks the
local library.

## 5. Cross-Browser Format Switching

```sh
npx nx run omnia-reader-e2e:e2e -- --project=firefox src/example.spec.ts
npx nx run omnia-reader-e2e:e2e -- --project=webkit src/example.spec.ts
```

Expected: badge controls, add-or-associate choice surface, dialogs, route
recreation, EPUB/PDF rendering, progress display/flush, and focus behavior match
Chromium. Record any genuinely unavailable
engine/platform gate rather than implying it passed.

## 6. Performance Fixture

Create the immutable profile set and validate the selected environment before
sampling:

```sh
npm ci
node apps/omnia-reader-e2e/performance/validate-profile.mjs specs/001-multi-format-books/performance/profiles-v1.json desktop-web-v1
npx nx run omnia-reader-e2e:performance-desktop-web
```

Run the remaining profile-specific targets separately:

```sh
npx nx run omnia-reader-e2e:performance-mobile-web
npx nx run omnia-reader-e2e:performance-packaged-desktop
npx nx run omnia-reader-e2e:performance-android
```

The mobile driver uses the pinned AVD Chrome. The packaged-desktop and Android
drivers build their release package/APK before preflight and include its digest.
All four use the environments defined in
[the performance evidence contract](contracts/performance-evidence.md). A
missing profile environment or any CPU/memory, OS, power-mode, runtime, snapshot,
or fixture mismatch is `UNVERIFIED` and performs no measured run.

Use exactly 1,000 logical books and 2,000 exact variants (one EPUB and one PDF
per book), deterministic metadata/progress, documented representative source
sizes, populated local/offline storage, and a bounded logical-change history.

Install page-side monotonic capture before each sample. Start both intervals at
the trusted activation event. `acknowledgementMs` ends at the first painted
visible busy, progress, success, or failure state after one animation frame;
`finalResultMs` ends only at the action-specific completed state. A busy/loading
state never counts as the final result, and Node-side timing around Playwright
calls is diagnostic only.

Activation is missing-format badge activation for the choice surface,
file-input `change` after local selection, candidate confirmation `click` for
association, confirmation-button `click` for detach/delete/reconcile, search
`input`, or present-format badge activation for open/switch. Final add/associate
state includes the missing badge changing from `Add` to its percentage on the
same card. Final filter state includes the updated result summary and cards.
Final open/switch state includes the selected format badge plus visible first
EPUB iframe content or PDF canvas.

For every primary profile, exercise all 14 branches in the closed matrix below
at least 20 times for acknowledgement. Separately discard 20 warm-ups and
record at least 200 final measurements for filtering, EPUB open, PDF open,
EPUB→PDF, and PDF→EPUB. Alternate formats and use unique books so cached routes
do not dominate. Never pool actions, formats, directions, or profiles.

| Action                       | Success/expected result      | Failure                                     |
| ---------------------------- | ---------------------------- | ------------------------------------------- |
| Add local from missing badge | valid opposite-format source | corrupt or unsupported source               |
| Associate from missing badge | compatible standalone entry  | stale or occupied-format conflict           |
| Detach variant               | durable standalone result    | injected storage transaction failure        |
| Delete variant               | sibling-preserving result    | injected storage transaction failure        |
| Reconcile membership         | valid child resolution       | stale-head rejection                        |
| Replace source               | exact verified replacement   | identity, size, or detected-format mismatch |
| Restore conflict handling    | complete conflict report     | malformed archive or stale precommit        |

Expected:

- every management acknowledgement sample is at most 1,000 ms;
- each filter/open/switch distribution has p95 at most 2,000 ms and at least 95%
  of samples at most 2,000 ms on every primary profile;
- only the selected variant/engine loads;
- checkpoint creation/interruption does not make local interaction unavailable;
- wrong-book/format, missing-acknowledgement, console-error, and overlapping-
  engine counts are zero.

Write every raw result to
`specs/001-multi-format-books/performance/results/<UTC-date>-<git-sha>-<profile-id>.json`
using the evidence contract. SC-004 passes only when all four primary profiles
are `PASS`. Faster hardware, unconstrained local runs, viewport-only emulation,
and CDP throttling alone are `SUPPLEMENTAL` and never replace a primary result.

## 7. Usability Protocol

Run 40 untrained participants who have not contributed to or previously tested
this feature: 20 add a local PDF file to EPUB and 20 add a local EPUB file to
PDF. Existing-entry association is a separate acceptance journey and cannot be
assigned to or counted in this SC-001 cohort. Within each direction,
assign exactly eight participants to pointer input on `desktop-web-v1`, six to
keyboard-only input on `desktop-web-v1`, and six to touch input on
`mobile-web-v1`; do not change input mode or provide assistive hints during a
run. Start timing when the populated library and task prompt appear; stop when
the participant activates the missing-format badge, selects `Add local
<format>`, chooses the supplied opposite-format file, completes the flow, sees
both formats on one card, and opens the added format through its present badge. A
success finishes within 120 seconds without a moderator hint, incorrect deletion,
duplicate card, input-mode substitution, or abandonment. Each direction
requires at least 19/20 successes and the aggregate at least 38/40. Record
median, p95, failures, input mode, and device/profile class.

## 8. Assistive-Technology Release Matrix

Create `specs/001-multi-format-books/accessibility-results.md` and run every
journey below with each required combination:

| Environment | Assistive technology and browser/host |
| ----------- | ------------------------------------- |
| Windows     | NVDA with Firefox                     |
| macOS       | VoiceOver with Safari                 |
| Android     | TalkBack with Android WebView         |

Use this 3×8 result matrix in the evidence record. Every cell contains only
`PASS`, `FAIL`, or `UNVERIFIED`:

| Journey                               | NVDA + Firefox | VoiceOver + Safari | TalkBack + Android WebView |
| ------------------------------------- | -------------- | ------------------ | -------------------------- |
| Add another format                    |                |                    |                            |
| Associate existing entries            |                |                    |                            |
| Choose or switch format               |                |                    |                            |
| Detach a variant                      |                |                    |                            |
| Delete a variant                      |                |                    |                            |
| Reconcile a synchronization conflict  |                |                    |                            |
| Manage all variants unavailable       |                |                    |                            |
| Review the full restore-conflict list |                |                    |                            |

For every execution record commit/build, date and tester, OS or device,
screen-reader and browser/WebView versions, fixture and journey, expected and
observed announcement transcript, focus sequence and restoration target,
result, and any defect or blocker link. Check correct name, role, state, format,
and book context; announced dialog purpose and initial focus; single
announcements for conflict, confirmation, busy, success, cancellation, and
failure; predictable focus; and completion without visual interpretation.
Desktop audits use screen-reader keyboard navigation; TalkBack uses swipe/touch
exploration and activation.

For choose/switch, additionally verify that the synchronized preference is
announced as selected, a successful explicit switch updates it, a failed switch
does not, and an unavailable preferred format announces fallback without
publishing a preference. EPUB/PDF progress, bookmarks, and annotations must be
unchanged except for state explicitly created within the selected variant.

A matrix cell is `PASS` only when the environment is available and the journey
is understandable, predictably focused, correctly announced, and completable
without visual interpretation. It is `FAIL` when that environment is available
but any required outcome is unmet. It is `UNVERIFIED` only when the named OS,
assistive technology, browser/WebView, emulator, or device is genuinely
unavailable and the reason is recorded. An unexecuted cell or a cell lacking the
required evidence is incomplete, not `UNVERIFIED`. Never infer a cell from
automated Chromium, Firefox, WebKit, emulator, or unit results. SC-005 cannot be
reported as passed while any cell is `FAIL`, `UNVERIFIED`, incomplete, or lacks
evidence.

## 9. Fixed Recovery and Compatibility Matrices

For SC-002, run exactly four valid journeys: add PDF to an EPUB logical book,
add EPUB to a PDF logical book, associate a standalone PDF into an EPUB
destination, and associate a standalone EPUB into a PDF destination. Each row
passes only when one logical card exposes both formats and opening the newly
added/associated format returns bytes whose SHA-256 equals that original
source. All four rows form the denominator; no direction or operation may be
omitted or substituted.

For SC-003, exercise add, associate, detach, delete-non-last, preference change,
and exact-source replacement at five points: before transaction, transaction
abort, after local commit before journal, interrupted upload, and interrupted
download (30 cases). Add the six operations committed offline then
restarted/reconnected, five cancellation cases (picker, association, detach,
delete, replace source), and seven validation cases (unsupported, corrupt,
duplicate-here, duplicate-elsewhere, occupied format, replacement identity
mismatch, replacement format mismatch): 48 cases total.

For every case compare canonical membership, exact hashes/sizes, availability,
preferred format, progress/documents, bookmarks, annotations, tombstones,
exclusions, and pending journal operations. Only the complete before-state or
complete requested after-state passes.

For SC-006, run these 14 rows: v8 singleton EPUB, singleton PDF, and mixed DB
migration; backup schemas 1, 2, 3, and 4; interrupted association restart;
new/new non-conflicting membership; new/new conflicting membership; concurrent
preferred formats; new client reading legacy sync; unsupported newer/mixed
membership refusal; and membership with deletion tombstone/exclusion. Every row
must preserve membership, exact identities/hashes, preference, all variant state,
covers/catalog ownership, exclusions, and deletion history. Run provider-neutral
fixtures for all rows and simulated Git/MEGA transports for sync rows.

## 10. Credentialed Provider Matrix

Run identical provider-neutral scenarios against configured GitHub and MEGA
transports:

- previous-root bootstrap, canonical-state migration, then compare-and-swap to
  the current root schema 2;
- old-client version refusal;
- object-before-change publication and interruption after every step;
- two-device concurrent associate/detach/delete and same-format conflicts;
- persistent conflict action after restart, explicit reconciliation, and
  convergence on the other device;
- concurrent EPUB/PDF preference choices in both delivery orders, an unavailable
  preferred member fallback, and byte-identical variant state before/after;
- deletion versus stale association, followed by explicit child reimport;
- canonical-state conflict, interrupted migration/cleanup retry, and stale
  offline-client reapply;
- delete variant versus delete whole logical book;
- quota/network failure leaves local state usable and journal work pending.

Expected: both providers converge to byte-equivalent logical state and surface
the same conflicts. Unit transport fixtures do not replace this credentialed
gate.

## 11. Host Gates

Desktop build:

```sh
npm run native:build
```

Android build:

```sh
npm run android:build -- --debug --apk --target aarch64 --ci
```

On packaged desktop, Android emulator, and physical Android device, exercise
file selection, add/associate, restart persistence, format choice, detach, and
delete. These are separate gates; unavailable toolchains/devices must be listed
explicitly. `cargo check` is required only if implementation changes native
commands contrary to the plan.
