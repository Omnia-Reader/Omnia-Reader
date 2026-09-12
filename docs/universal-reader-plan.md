# Omnia Reader: Universal Reader Development Plan

Status: In active development

Current delivery priority: finish and harden the Angular web reader while
bringing GitHub synchronization into the supported application flow. GitHub
uses the gateway-hosted GitHub App authorization path and can select or create
a private repository for books and reading state. The Settings flow now
separates GitHub App installation/repository access from state-bound account
authorization, recovers when an installation exposes no repositories, and
guides the user to approve missing repository permissions after a GitHub 403.
Its Settings journey now presents an Account/Repository/Library checklist,
identifies Git + LFS as the recommended provider, filters large repository
lists, links to the selected private repository, refreshes pending-change and
remote-backup state after automatic synchronization, and provides an immediate
retry action after a failed automatic attempt. The final setup step distinguishes
a queued or ready first synchronization from a genuinely synchronized library,
then reports the most recent successful synchronization time and the received,
sent, conflict-retry, and invalid-record counts. That successful result is
validated and persisted per provider across application restarts, while selecting
a different destination clears stale evidence. Manual and automatic runs update
the same global status. The application toolbar now keeps synchronization state
visible outside Settings, reports active
publication-transfer percentage, distinguishes setup, scheduled, delayed,
offline, cancelled, successful, and attention-required states, and provides a
one-click path to the relevant synchronization details.
Signed, replay-safe GitHub authorization webhooks now invalidate every local
session for a revoked user across gateway replicas, while provider `401`
fallback handling remains in place. Lost installation access clears only the
stale repository choice.
MEGA deployment and Tauri/native packaging remain secondary until the Angular
and GitHub journeys are production-ready.
Last updated: 2026-08-20

## 1. Goal

Develop Omnia Reader into an offline-first EPUB and PDF reader that uses one
Angular application across:

- Installable web/PWA deployments.
- Windows, macOS, and Linux desktop applications.
- Android applications.

Books, reading progress, bookmarks, highlights, and notes must be saved locally
first and optionally synchronized through a user-selected provider. The first
providers are a Git repository, with EPUB/PDF binaries stored through Git LFS,
and MEGA. A user can restore the same library, exact reading positions,
bookmarks, highlights, and notes on another device without manually copying
publication files.

The first production release supports DRM-free EPUB and PDF. DRM/LCP, PDF
reflow, iOS, additional book formats, OCR, AI features, and plugin systems are
out of scope for the initial release.

## Implementation Status

The shared web application foundation and the first vertical reader slice are
implemented:

- Enforced Nx boundaries separate format-neutral domain/core code, the
  EPUB.js-compatible renderer, PDF.js, browser storage, platform adapters, and
  Git sync concerns.
- Library, reader, settings, and synchronization routes are lazy loaded.
  `/settings/sync` is active and registers the provider-neutral synchronization
  services. GitHub is the supported current path: its credentials remain in
  the same-origin gateway session, while the browser selects or creates a
  private repository. A missing or unconfigured gateway remains non-fatal to
  local reading. MEGA remains available behind the same provider contract but
  is secondary to the GitHub journey.
- The library has responsive, accessible grid and list views, metadata-aware
  search, deterministic recent/title/author/added sorting, composable
  all/in-progress/finished/not-started filters, activity and import dates,
  useful empty states, and locally persisted view preferences. Durable current
  reading percentages distinguish untouched, in-progress, and finished
  publications, drive those status filters, and give each card an accessible
  start or continue-reading affordance. Exact-edition duplicate imports remain
  single stored books and
  produce explicit added/already-present feedback for individual and mixed
  multi-file selections. Every selected publication is independently atomic:
  damaged files are rejected by name without discarding valid books from the
  same batch. Opening a publication updates its recent activity without
  changing its original import time. Every book exposes an accessible
  exact-file export action that preserves its original EPUB/PDF bytes and file
  name. Supported hosts stream directly to a user-selected destination;
  browsers without that API use a standard download without changing or
  removing the local publication. Removing a book uses an accessible in-app
  confirmation that names the publication and explains that its local file,
  progress, bookmarks, highlights, and notes will be deleted. Cancellation
  restores focus, confirmed removal reports success and disables competing
  actions while busy, and persistence failures keep the book available with an
  actionable error. A confirmed local removal records a durable device-local
  synchronization exclusion: an existing remote backup remains intact and
  cannot silently restore the edition on the next pull. Explicitly importing
  the same exact edition clears that exclusion and adds it back to
  synchronization.
- EPUB and PDF editions can be grouped into one explicit logical book while
  retaining exact SHA-256 variant identity and independent reading state. The
  compact format row opens a healthy preferred edition with a healthy fallback,
  supports non-destructive detach, per-variant export/delete, and exact-source
  recovery from either a local file or the configured synchronization
  destination. Unavailable variants remain visible and manageable, with stable
  keyboard focus and announced recovery outcomes.
- Imported EPUB/PDF binaries, extracted metadata, normalized cover artwork,
  progress, bookmarks, highlights, notes, and format preferences are durable.
  Publication bytes use OPFS where available with a versioned, byte-backed
  IndexedDB fallback and lazy migration from legacy Blob records; EPUB covers
  come from the package manifest, PDF covers come from page one, and
  exact-edition SHA-256 IDs provide duplicate detection.
- Settings reports whether the offline library has persistent or best-effort
  host storage, displays browser quota usage when available, and lets the user
  explicitly request protection from automatic browser eviction. A denied or
  unavailable browser permission remains non-fatal and points the user to the
  portable backup path.
- The browser library database is at schema version 9. Every persisted domain
  record is validated when read or written. Malformed books, binary
  references, covers, merged progress, per-device progress documents,
  bookmarks, annotations, and preferences are atomically moved into a lossless
  quarantine store instead of crashing the library or contaminating
  synchronization; healthy records remain available. The version 8-to-9
  migration creates deterministic singleton logical books and adds logical
  covers, synchronized format preferences, and membership reconciliations
  without re-keying exact-variant reading state.
- Exact-edition SHA-256 hashing is incremental and runs in a dedicated worker
  through the pinned `hash-wasm` implementation. The bounded main-thread
  fallback is used only when a host cannot create workers.
- Settings can export and restore a provider-neutral `.omnia-backup` archive.
  Its version 4 manifest covers exact publication bytes, metadata, logical-book
  membership and covers, synchronized format preferences and reconciliations,
  the merged
  resume view, provider-neutral per-device progress history, bookmarks,
  highlights, notes, deletion tombstones, and reader preferences.
  Export streams directly to File System Access destinations where available
  and to opaque Tauri save targets through bounded raw IPC chunks; cancellation
  aborts the browser write or removes the native temporary file before commit.
  Browsers without File System Access retain the interoperable Blob-download
  fallback.
  Restore remains compatible with versions 1–3, validates strict ZIP structure,
  declared paths, bounded expanded sizes, CRC signatures, schemas, logical
  cover digests, and every publication SHA-256 before mutating the library. A
  complete deterministic ownership/occupied-format conflict report is produced
  before writes. Compatible restores publish books, binaries, logical state,
  covers, progress, reader preferences, bookmarks, and annotations in one
  revision-checked IndexedDB transaction, so stale revisions or failures expose
  no partial restore.
- The exact-pinned `@likecoin/epub-ts` runtime renders EPUB content in its own
  iframe with scripts disabled. It retains the EPUB.js API while replacing the
  obsolete `unload` lifecycle listener with `pagehide`. The adapter waits for
  the runtime's separate archived-resource replacement promise before first
  render or teardown, so embedded CSS and fonts cannot race book destruction
  in slower WebKit environments. Recursive contents, NAV/NCX-relative and
  fragment-only table-of-contents targets, headless incremental full-text
  search, finite paginated layout, direction-aware keyboard, wheel, Pointer
  Event swipe, and deduplicated Touch Event fallback navigation in both the
  application and publication iframe, relocation events, CFI resume, themes,
  typography, flow, and spread preferences use the common reader contract.
  EPUB reading mode defaults to the publication: package-level and item-level
  `rendition:flow` declarations select paginated or document-scrolling
  presentation, while explicit Paginated and Scrolling choices remain durable
  user overrides. Scrolled publications retain normal browser wheel behavior
  instead of translating vertical scrolling into page turns.
  Horizontal swipes ignore vertical scrolling, multitouch, controls, links,
  annotations, and active text selections.
  Invalid table-of-contents targets produce a controlled reader error instead
  of an unhandled renderer rejection. The reader presents every ToC level with
  stable hierarchical
  numbering and accessible per-section expand/collapse controls, collapsed by
  default. EPUB landmark semantics deterministically exempt front/back matter
  such as prefaces and contributors from generated chapter numbers; a
  conservative normalized-title fallback covers legacy EPUB/NCX and PDF
  outlines without semantic roles. Unnumbered entries do not consume the
  chapter sequence. Publication scripts, active
  embeds, inline handlers, form submission targets, unsafe URLs, remote
  resource attributes, remote stylesheet links, and remote CSS imports/font
  URLs in both chapter markup and packaged stylesheets are removed before
  rendering without discarding safe embedded publication CSS. The web and
  Tauri CSPs deny unlisted origins, objects, and form
  actions. Their narrowly required `unsafe-inline` script allowance supports
  EPUB.ts's trusted iframe bootstrap; authored publication scripts remain
  blocked by the script-disabled sandbox and pre-render sanitizer. Text
  selection remains passive until the reader explicitly requests the context
  menu with a secondary click; only then does Omnia offer highlighting and note
  actions. The annotation editor supports highlight, underline, and
  strikethrough decorations with independent colors and optional notes.
  Selected ranges produce quote-backed CFI annotations and persisted
  decorations are reapplied through EPUB highlight/underline primitives;
  strikethrough lines remain centered when EPUB pagination rerenders a mark.
  Event-driven selection
  capture has a deduplicated stable-selection fallback plus a sandbox-frame
  bridge for WebKit hosts that drop iframe pointer-event delivery.
- PDF.js runs in a lazy engine with a separately deployed worker and the
  official virtualized `PDFViewer`. It provides multi-page canvas rendering,
  selectable text and annotation layers, interactive AcroForm fields with
  accessible-name fallbacks, shell-mediated HTTP(S) external links, native
  internal destinations, outline mapping, search, page locators, virtualized
  thumbnails, live page tracking, fit/custom zoom, rotation, exact page resume,
  and an accessible password challenge owned by the shared Angular shell.
  Valid encrypted PDFs remain importable without retaining a password and
  support incorrect-password retry in the reader. Malformed imports are
  rejected through the actual lazy engine and atomically remove only newly
  created records. PDF text selection is likewise passive until an explicit
  secondary click. Accepted selections persist page-relative text offsets and
  PDF-space rectangles so highlights, underlines, and strikethrough marks
  survive zoom and rotation.
- Progress is saved from renderer relocation events, not only button actions.
  Local writes remain authoritative and append to an offline sync operation
  journal.
- The shared footer exposes an accessible cross-format book-progress scrubber.
  It uses EPUB generated-location percentages and stable CFIs, while PDF
  percentages resolve to the nearest stable page. The native range control is
  keyboard, touch, and assistive-technology operable; seeking updates the same
  persisted locator used by automatic resume. Page status, scrubber, and
  overall percentage share a compact single line whose measured browser height
  stays at or below 32 px. Its final footer geometry is reserved before either
  renderer mounts so EPUB pagination and fullscreen viewports remain stable.
- The shared reader shell supports true browser fullscreen immersive reading
  without collapsing the EPUB iframe or PDF canvas viewport. Its toolbar
  retracts to the top edge after the pointer returns to the publication,
  reappears from a thin desktop hover strip, and remains independently
  discoverable through a touch-sized coarse-pointer target and keyboard focus.
  Explicit show/hide controls and focus transfer keep the mode operable without
  relying on hover alone.
- Reader-owned password, external-link consent, and annotation dialogs use
  automatic initial focus, keyboard focus containment, and focus restoration.
  While external-link consent is open, book-navigation shortcuts are isolated
  so a decision cannot move the publication behind the modal.
- Reader side panels remain semantically complementary, move focus to their
  first useful surface, expose explicit close controls, and restore the
  corresponding toolbar trigger when dismissed. Choosing panel content returns
  focus to the publication, while arrow, wheel, and swipe navigation are
  isolated whenever a panel is open.
- On narrow mobile viewports the reader keeps the table of contents directly
  available and consolidates secondary tools into an in-reader action panel,
  avoiding horizontal toolbar overflow without relying on an overlay outside
  the fullscreen reader root. Opening search, bookmarks, annotations,
  thumbnails, settings, shortcuts, or immersive mode from this panel preserves
  focus context and restores focus to the visible mobile trigger when closed.
- A format-neutral keyboard command layer opens the table of contents, search,
  bookmarks, annotations, settings, immersive mode, and the current-location
  bookmark action. The same commands work when an EPUB iframe owns focus,
  ignore editable controls and repeated key events, and only prevent a browser
  key action when the reader shell actually handles it. A toolbar button and
  `?` shortcut open a focus-contained command reference whose close action
  restores the reader's previous focus.
- The shared reader shell can create, revisit, persist, and delete PDF or EPUB
  bookmarks. Deletions are durable tombstones, so an older provider copy
  cannot resurrect a bookmark on another device.
- The same shell can create colored highlights, attach or edit notes, navigate
  back to an annotation, delete it, and undo an accidental deletion from an
  accessible transient action. Undo restores the same stable annotation ID
  with a revision newer than its deletion tombstone, so later synchronization
  cannot resurrect the deletion over the restored record. Its per-book
  annotation overview shows
  totals by decoration type and note presence, searches quotes, notes, and
  locations, orders results either by publication location or most-recent
  update, and provides direct Go to, Edit, and Delete actions. The current
  filtered, searched, and sorted overview can be exported as deterministic
  Markdown through the shared browser/native save boundary. The export includes
  locations, decoration styles, colors, quotes, and notes while escaping
  publication-provided content. Annotation totals are also visible as a compact
  badge in the reader toolbar, making the per-book overview discoverable
  without opening it first. Annotation deletions are durable tombstones and
  local persistence completes before rendering or sync work. Records created
  before decoration styles remain valid and default to highlight rendering.
- Ctrl+mouse-wheel zoom is serialized across both engines and reports the
  resulting EPUB font-size or PDF page-view percentage in a non-interactive
  overlay. Repeated wheel steps refresh the overlay timeout; it automatically
  disappears 1.2 seconds after the final step and is never shown for ordinary
  wheel page navigation or settings changes.
- EPUB rendering now preserves authored fixed-layout geometry and typography,
  honors RTL page progression and authored spread settings, and routes
  internal links without allowing publication scripts. HTTP(S) links require
  explicit reader consent before the browser or narrowly scoped native opener
  receives them; unsupported schemes remain inert. A hash-pinned,
  independently authored W3C/IDPF corpus verifies the 136-chapter,
  embedded-font Moby-Dick sample, the embedded-font Hebrew Israel Sailing
  sample, the mixed reflowable/fixed-layout Voyage of Life sample, and a
  vertically scrollable manga, including search, ToC navigation, authored
  direction, physical arrow order, authored layout/flow transitions, natural
  vertical scrolling, and user flow overrides in Chromium, Firefox, and
  WebKit.
- The provider-neutral synchronization core covers the complete local library:
  immutable EPUB/PDF objects, per-book manifests, and per-device progress
  documents plus bookmark and annotation records and tombstones. It verifies
  object size and SHA-256 before publishing or restoring a book, retries
  optimistic conflicts, and can seed a newly selected provider from the local
  snapshot. A durable compound-keyed cache retains every valid progress
  document observed from any provider, so Git/LFS-to-MEGA migrations and the
  reverse preserve device history while the local resume record remains a
  merged view. Every coordinated synchronization first initializes or validates
  the canonical `.omnia-reader/manifest.json` application, schema,
  content-identity, and enabled-feature contract; malformed, incomplete, or
  future schemas fail closed before any child document is read or written.
- Git/Git LFS and MEGA gateway clients implement the same logical sync layout.
  Sync Settings let the user choose a provider, authenticate, select a
  repository or folder, and manually synchronize books, reading progress,
  bookmarks, highlights, and notes. Publication uploads use the original Blob
  as the native request body, downloads monitor the browser response stream,
  and both directions report byte progress and honor cancellation without
  acknowledging the pending journal operation. Provider credentials remain
  behind the documented same-origin gateway contract.
- A runnable Nx/Fastify gateway core now enforces provider-scoped HttpOnly
  sessions, same-origin/CSRF checks, confined logical paths, bounded JSON and
  publication metadata, streaming object bodies, and non-sensitive errors for
  both route families. The GitHub adapter implements state-bound, S256
  PKCE-protected web authorization, encrypted expiring server sessions,
  strict user/refresh-token rotation with per-process concurrent request
  coalescing, installation-scoped repository discovery/tokens, optimistic
  Contents API commits, Git LFS batch/basic transfers, verification, and
  pointer publication ordering. Definitive refresh-token rejection consumes
  the encrypted session once, as does a provider 401 that definitively revokes
  the matching user authorization. Explicit disconnect deletes local authority
  first and revokes only that session's GitHub user token; a concurrent refresh
  cannot leave a newly rotated token orphaned. Lost installation access clears
  only the matching stale repository choice, while transient provider failures
  preserve the session for retry. GitHub primary and secondary rate limits
  become a safe, bounded `Retry-After` contract; automatic synchronization
  persists that deadline and cannot hot-loop queued local work. The MEGA
  gateway adapter now implements state-bound login, encrypted SDK sessions,
  writable-folder reauthorization, deterministic duplicate handling,
  optimistic whole-file replacement, immutable object transfer, and integrity
  verification through a
  private official-SDK bridge contract. The repository
  now includes the pinned native C++ bridge implementation with SDK
  login/session restoration, folder enumeration, root-confined file
  operations, verified transfers, and bounded concurrency. Its pinned
  SDK-linked Release build passes in an isolated Ubuntu 24.04 environment;
  non-root container packaging and its lifecycle smoke test are implemented.
  Image scanning/signing/publishing and the live-provider conformance suite
  remain pending. Both providers fail closed without complete configuration.
- Automatic synchronization is journal-driven and provider-neutral. Book
  changes, provider selection, startup, application backgrounding, and restored
  connectivity trigger immediate attempts; progress, bookmark, and annotation
  changes use a one-second trailing quiet interval. A visible, online GitHub
  client checks the lightweight repository revision every ten seconds; hidden,
  offline, stopped, and non-Git clients do not poll. Automatic publication transfers expose byte progress,
  can be cancelled through the same abort-aware transport contract as manual
  sync, and retain durable local journal work for a later retry. Cancellation
  is reported separately from provider failures without blocking local reading.
  The persistent application toolbar subscribes to both scheduler state and
  provider-selection changes, so setup, disconnect, offline, delayed, active
  transfer, cancellation, success, and failure feedback remains current on
  every route. Local-only development builds show their local storage boundary
  without exposing or contacting a remote provider.
- The PWA application shell and static assets work offline; imported books stay
  in OPFS or the IndexedDB fallback rather than the Angular service-worker
  cache.
- Tailwind CSS v4 is the default product styling system. Angular Material is
  retained only in lazy feature UI where it is useful, while renderer-specific
  rules remain inside the EPUB/PDF adapters.
- A Tauri 2 host now packages the same Angular application for desktop and
  Android. The dependency-injected platform adapter selects browser or Tauri
  behavior without leaking native APIs into feature code.
- Native import uses a filtered operating-system picker and two narrow Rust
  commands. Selected paths and Android document URIs stay in a Rust-owned
  opaque registry; only validated EPUB/PDF bytes cross the IPC boundary.
- Operating-system open-with and share events now use the same opaque native
  registry and import service. Cold-start arguments, Android/macOS opened URLs,
  warm desktop launches through Tauri's single-instance plugin, and desktop or
  browser file drops are queued, signature-validated, imported, journaled, and
  opened without exposing native paths to Angular.
- Exact-edition `omnia-reader://reader/<sha256>` links use the same cold-start
  and single-instance queues. The native boundary converts the URL digest to
  the canonical `sha256:<digest>` book identity; Angular opens that precise
  local edition and falls back to the library when it is unavailable.
- A platform-neutral back-navigation coordinator gives transient UI
  last-opened-first priority. Escape closes reader or mobile-navigation panels
  without leaving the current book; Android hardware back uses the same
  handlers, then follows explicit reader/settings parent routes, and requests a
  native application exit only from the library root.
- The Tauri capability grants core defaults plus only HTTP(S) URL opening.
  Dialog and filesystem plugins are called from Rust, not exposed to
  publication content or the frontend. A restrictive production CSP is
  configured. Web and Tauri font policies allow renderer-generated `blob:`
  URLs for embedded EPUB fonts while continuing to reject remote font origins.
- EPUB/PDF associations are configured for desktop bundles and are present in
  the generated Android manifest. A Tauri aarch64 Android debug APK has been
  built successfully with NDK 29 and Java 21.

Verified in the current implementation:

```text
npx nx run-many -t test --all --skip-nx-cache            PASS (12 projects + 2 prerequisite tasks)
npx nx run-many -t lint --all --skip-nx-cache            PASS (12 projects)
npx nx test omnia-reader                                PASS (105/105)
npx nx test sync-core                                   PASS (106/106)
npx nx test sync-git                                    PASS (25/25)
npx nx test sync-gateway                                PASS (121 passed; 1 live Redis test skipped)
npx nx test reader-epub                                 PASS (20/20)
npx nx test reader-domain                               PASS (27/27)
Local reader/domain/engine/storage/platform suites        PASS (105/105)
npx nx run-many -t lint -p omnia-reader omnia-reader-e2e sync-gateway sync-git PASS
npx nx build omnia-reader --configuration production     PASS
npx nx build omnia-reader --configuration local-development PASS
npx nx build sync-gateway --configuration production     PASS
npm run container:smoke                                  PASS (web + gateway health, headers, cache, proxy)
REMOTE_SYNC_E2E=1 ... --project=chromium src/sync.spec.ts PASS (7/7)
Chromium/WebKit persisted successful Git result E2E       PASS (2/2)
PWA_E2E=1 ... --project=chromium src/offline.spec.ts    PASS (cold PDF + EPUB restart)
npm audit --omit=dev                                     PASS (0 vulnerabilities)
Runtime dependency contract                              PASS (2/2; PDF.js 6.2.108, fast-uri 3.1.5 + 4.1.2)
Chromium/WebKit PDF security compatibility               PASS (3/3 per browser)
npx nx run omnia-reader-e2e:performance                  PASS (3/3)
npx nx run omnia-reader-e2e:performance-evidence-test    PASS (43/43; management/evidence contracts)
Desktop management branch smoke                          PASS (1 active Chromium journey; 3 expected mode skips)
npm run release:test                                    PASS (8/8)
npm run release:verify                                  PASS (122 files; 33 npm + 483 Rust + 4 bridge inputs + 4 CI actions)
cargo test --manifest-path src-tauri/Cargo.toml           PASS (2/2)
npm run native:build                                     PASS (deb + rpm + AppImage)
Initial production bundle                                394.46 kB (87.58 kB estimated transfer; PDF.js lazy)
Schema-v10 migration, outbox, and corrupt recovery tests  PASS
Cross-provider per-device progress migration tests        PASS
Git LFS/MEGA interrupted-publication recovery tests       PASS
Chromium layered PDF/EPUB reader and resume E2E          PASS
Chromium PDF/EPUB arrow and wheel navigation E2E          PASS
Chromium/Firefox PDF/EPUB swipe navigation E2E            PASS (6/6)
Chromium/Firefox/WebKit PDF/EPUB progress seeking E2E      PASS (6/6)
Chromium/Firefox/WebKit exact PDF/EPUB library export E2E  PASS (3/3)
Chromium/Firefox/WebKit duplicate/mixed/corrupt import E2E PASS (6/6)
Chromium/Firefox/WebKit representative EPUB corpus E2E    PASS (15/15)
Chromium/Firefox/WebKit malformed PDF/EPUB rollback E2E   PASS (6/6)
WebKit PDF/EPUB/fixed-layout reader regression E2E        PASS (3/3)
Chromium finite PDF/EPUB viewport and pagination E2E      PASS
Chromium reader console and EPUB script-sandbox E2E       PASS
Chromium/WebKit remote EPUB font/CSS sanitization E2E      PASS (2/2)
Chromium/Firefox/WebKit nested EPUB ToC navigation E2E     PASS (3/3)
Chromium durable PDF bookmark create/resume/delete E2E   PASS
Chromium/Firefox/WebKit PDF/EPUB annotation lifecycle E2E PASS (6/6)
Chromium/WebKit PDF/EPUB annotation deletion undo E2E     PASS (4/4 focused)
Chromium/WebKit styled annotation and zoom feedback E2E   PASS (4/4)
Chromium/WebKit annotation overview ordering E2E           PASS (2/2; 2 workers; 41.2s)
Chromium/WebKit PDF/EPUB annotation Markdown export E2E    PASS (4/4 focused; 1.4m)
Chromium/WebKit focused Git/PDF/EPUB UX E2E               PASS (8/8; 4 workers; 1.2m)
Chromium/WebKit PDF/EPUB keyboard command E2E             PASS (4/4; 2 workers; 1.3m)
Chromium/WebKit mobile-width PDF reader actions E2E        PASS (2/2; 2 workers; 41.5s)
Chromium/Firefox/WebKit PDF/EPUB immersive reader E2E    PASS (6/6)
Chromium drag-and-drop import and automatic open E2E      PASS
Chromium installed-PWA fully-offline reopen E2E          PASS
Chromium durable EPUB/PDF cover extraction E2E           PASS
Chromium OPFS storage and legacy Blob migration E2E      PASS
Chromium/Firefox/WebKit storage persistence/quota E2E     PASS (3/3)
Chromium/Firefox/WebKit storage/remote-sync dormancy E2E  PASS (6/6)
Chromium/Firefox/WebKit storage Settings WCAG E2E         PASS (3/3)
Chromium/Firefox/WebKit removal/backup/progress restore E2E PASS (3/3)
Chromium/Firefox/WebKit removal-dialog WCAG E2E            PASS (3/3)
Chromium deterministic reader Escape handling E2E         PASS
Chromium fixed-layout/RTL/link-policy EPUB E2E            PASS
Chromium WCAG A/AA library/settings/PDF/EPUB E2E           PASS (4/4)
Chromium/Firefox/WebKit library search/sort/status/view E2E PASS (3/3)
Chromium/Firefox/WebKit library progress/resume E2E        PASS (3/3)
Chromium/Firefox/WebKit populated progress grid/list WCAG  PASS (3/3)
Chromium large-publication performance/memory/backup E2E   PASS (3/3)
Chromium/WebKit active local web E2E matrix                PASS (51/55 matrix + 4/4 corrected Git-label rerun; 23 skipped; 4 workers)
Chromium/WebKit Git/LFS PDF convergence E2E                PASS (2/2; REMOTE_SYNC_E2E=1)
Chromium/WebKit MEGA EPUB convergence E2E                  PASS (2/2; REMOTE_SYNC_E2E=1)
Chromium/WebKit automatic upload cancellation E2E          PASS (2/2)
Chromium/WebKit global sync status/setup/cancellation E2E   PASS (4/4 focused)
Chromium/WebKit complete active sync suite                  PASS (20/24; 4 skipped)
Chromium/WebKit remote-backup local removal E2E             PASS (2/2)
Chromium/WebKit confirmed remote-backup deletion E2E         PASS (2/2)
Chromium GitHub OAuth cancellation recovery E2E              PASS (1/1)
Chromium GitHub repository permission recovery E2E           PASS (1/1)
Chromium GitHub authorization revocation recovery E2E         PASS (1/1)
Chromium GitHub rate-limit recovery E2E                       PASS (1/1)
Firefox repeated PDF/EPUB full-state sync gate             DEFERRED
Git interrupted upload and optimistic 409 browser retry    PASS
Chromium/Firefox/WebKit PDF forms/links/encryption/recovery PASS
Chromium/Firefox/WebKit reader modal focus/isolation E2E   PASS (6/6)
Chromium/Firefox/WebKit reader side-panel focus/isolation   PASS (6/6)
Chromium/Firefox/WebKit reader side-panel WCAG E2E          PASS (6/6)
Chromium/Firefox/WebKit PDF reader-dialog WCAG E2E         PASS (3/3)
Chromium/Firefox/WebKit quarantine export and WCAG E2E     PASS
Chromium/Firefox/WebKit hostile EPUB no-script/network E2E PASS
Chromium/Firefox/WebKit production security headers        PASS
Firefox production PDF and EPUB reader journeys           PASS
Firefox fixed-layout/RTL/link-policy EPUB E2E             PASS
Firefox WCAG A/AA library/settings/PDF/EPUB E2E            PASS (4/4)
WebKit production PDF and EPUB reader journeys            PASS
WebKit fixed-layout/RTL/link-policy EPUB E2E              PASS
WebKit WCAG A/AA library/settings/PDF/EPUB E2E             PASS (4/4)
Tauri Linux amd64 deb/rpm/AppImage release bundles        PASS
Tauri native PDF startup/EPUB forwarding/deep-link E2E    PASS
Tauri Android aarch64 debug APK and AAB                  PASS
Tauri Android aarch64 Rust type check                    PASS
Tauri Android back-listener and root-exit adapter tests   PASS
GitHub Actions workflow YAML and immutable action pins    PASS
```

The EPUB engine and its declared JSZip compatibility dependency remain in the
lazy EPUB chunk and outside the initial application bundle.

The following release requirements remain open:

- Native ingress is implemented. A feature-gated Linux native-host journey now
  verifies a cold-start PDF argument, rendered PDF canvas, button and arrow
  navigation, a second-process EPUB argument forwarded through Tauri's
  single-instance plugin, rendered EPUB iframe content, and EPUB button and
  arrow navigation, then an exact-edition link that reopens the PDF. Operating-
  system association and protocol activation from installed
  bundles and Android intents still need packaged-app/emulator end-to-end
  gates. Mobile back-button behavior is implemented and covered by
  adapter/unit tests plus the shared Chromium Escape journey, but still needs
  an Android emulator and physical-device runtime gate. Lifecycle tests,
  signing, and signed release distributables remain. Read-only GitHub Actions jobs
  now run the shared release/browser gates and build unsigned Linux, Windows,
  macOS, and Android verification packages with immutable action pins and
  pinned Node, Rust, Java, Android SDK, and NDK inputs. The exact combined
  Android APK/AAB command passes locally; the first hosted matrix run remains
  required. The documented WebKit/GTK development packages are installed on
  the local Linux build host, and a warning-free production build now produces
  a 5.7 MB Debian package, 5.7 MB RPM, and 82 MB AppImage. Installed-association
  activation, drag/drop in a native host, background/termination lifecycle,
  signing, and publishing remain release requirements.
- The browser clients, shared coordinator, secure same-origin gateway core,
  GitHub App/Git LFS provider adapter, MEGA gateway/SDK bridge client, and
  pinned native MEGA bridge source and non-root container packaging are
  implemented. The gateway also has encrypted multi-replica Redis session
  persistence with atomic session-ID and rolling encryption-key rotation. Live
  credentialed GitHub tests, image scanning/signing/publishing, production
  Redis HA/backup validation, provider-native byte-range/session resume,
  live-provider interruption and quota behavior, and end-to-end tests against
  real providers remain release requirements. Deterministic provider tests now
  verify that GitHub primary/secondary rate limits are distinguished from
  permission failures, expose only a bounded retry deadline, survive a
  scheduler restart without a request burst, and never render provider text.
  They also verify that an interrupted Git LFS upload publishes no pointer, an
  interrupted MEGA move removes its staged object, and a whole-transfer retry
  succeeds.
  Cross-browser HTTP-boundary journeys also prove that a clean second device
  restores the exact PDF through Git/LFS and the exact EPUB through MEGA,
  including synchronized reading positions, bookmarks, highlights, and notes;
  each device then contributes distinct progress, bookmark, highlight, and note
  state and both devices converge without losing either contribution. The
  simulated remote retains two per-device progress documents, two bookmarks,
  and two annotations for each journey. The Git journey recovers from both an
  interrupted object upload and an optimistic document conflict.
- Automatic quiet-interval, startup, destination-selection, background, and
  online-resume scheduling is implemented. Guaranteed completion after a hard
  browser close or Android process termination still requires service-worker
  or native lifecycle transfer support; the current background flush is
  best-effort.
- Backup archives now stream directly to File System Access and opaque native
  save destinations with bounded chunks, cancellation, and final commit
  semantics; browsers without File System Access retain a compatible final
  `Blob` download. Generated large-PDF/EPUB streaming coverage is implemented;
  multi-gigabyte and constrained-device profiling remain. Schema-v8 read/write
  validation, lossless corrupt-record quarantine, healthy-record continuity,
  and version 7 migration coverage are implemented. Settings now provide
  user-facing,
  read-only quarantine inspection and versioned lossless diagnostic export
  without exposing raw corrupt payloads in the DOM or mutating the recovery
  store. The version 3 archive includes synchronized highlights, notes, and
  per-device progress history and remains compatible with version 1 bookmark
  archives and version 2 archives without progress history. Binary references
  already validate their schema, repair from a duplicate re-import, and lazily
  migrate legacy IndexedDB Blobs to OPFS.
- Deterministic cross-browser PDF compatibility fixtures now cover AES-256
  encrypted documents with password retry, interactive forms, accessible
  widget names, internal/external link policy, malformed-file rollback, and a
  virtualized 180-page publication. Representative real-world very large,
  complex-form, and unusual-encryption publications remain release
  requirements.
- Reflowable long-form, embedded-font, RTL, mixed fixed-layout, authored
  vertical-scrolling, and legacy EPUB 2/NCX representative coverage is
  implemented. Deterministic malformed-archive coverage proves readable errors,
  complete rollback, and clean browser consoles. Add broader unusual and
  independently authored malformed samples without making the deterministic
  default matrix network-dependent.
- Packaged desktop, Android emulator, and physical-device compatibility gates
  plus the remaining manual assistive-technology, security, performance, and
  release audits.
- The fail-closed multi-format performance evidence core now validates
  canonical profile identity, bounded environment input, raw unpooled
  statistics, dispositions, atomic result paths, and all-four-profile
  aggregation. The desktop-web driver now builds the deterministic
  1,000-logical-book/2,000-variant dataset, drives all fourteen management
  branches and five separate distributions through product controls, captures
  page-owned paint-eligible timings, and fails closed on environment or
  sampling-identity drift. The clean current-host preflight is `UNVERIFIED`
  because the frozen cgroup, power, display, and Chromium values were not
  supplied, so no desktop acceptance result is claimed. Mobile-web and Android
  identities remain unresolved; mobile-web, packaged-desktop, Android, and
  aggregate SC-004 measurements remain open release gates.

## 2. Initial Repository Assessment

This section records the historical prototype state from which implementation
began.

The initial Angular 22/Nx 23 application was a working EPUB prototype. It had a
responsive Angular Material shell, file selection, EPUB metadata and table of
contents extraction, continuous chapter rendering, and basic typography
controls.

The prototype needs to be restructured before adding formats and platforms:

- `Viewer` owns import, parsing, rendering, navigation, and UI state.
- The application eagerly loads all EPUB chapters.
- EPUB content is inserted through `bypassSecurityTrustHtml`; Shadow DOM is not
  a security boundary for untrusted publication content.
- The custom parser assumes common OPF filenames, only rewrites a subset of
  publication resources, and does not revoke generated object URLs.
- There is no durable library, book identity, progress model, storage
  abstraction, sync engine, or platform boundary.
- Existing unit tests only check that components can be created, and the
  Playwright test only checks the document title.
- The production build passes, but the current initial bundle and viewer
  stylesheet exceed their warning budgets. Format engines must therefore be
  lazy-loaded.

Baseline validation performed before this plan:

```text
npx nx test omnia-reader --skip-nx-cache                 PASS (3 tests)
npx nx lint omnia-reader --skip-nx-cache                 PASS
npx nx build omnia-reader --configuration production    PASS with warnings
```

## 3. Architecture Decisions

### 3.1 Application and native host

- Keep Angular and Nx as the application framework and workspace.
- Build one responsive reader UI shared by every target.
- Use Tailwind CSS v4 utilities as the default application styling layer.
  Reserve component CSS for publication-renderer behavior that cannot be
  expressed cleanly in the shared utility system.
- Make the web target an Angular PWA with an offline application shell.
- Put publication bytes behind an OPFS-first adapter with an IndexedDB fallback
  and request persistent browser storage without treating a denied grant as an
  import failure.
- Compute exact-edition SHA-256 values incrementally in a dedicated worker
  using the exact, lockfile-pinned `hash-wasm` package. Keep its WASM and the
  bounded no-worker fallback outside the initial application chunk.
- Use Tauri 2 as the native host for Windows, macOS, Linux, and Android.
- Keep browser and native behavior behind dependency-injected platform
  adapters. Feature code must not call Tauri APIs directly.
- Validate Tauri desktop and Android file import, persistent storage, EPUB
  iframe rendering, and PDF workers with an early vertical spike.

Tauri is preferred over separate Electron and Capacitor applications because it
can host the same frontend on all requested native targets and offers a
capability-based native security model.

### 3.2 Rendering libraries

#### PDF

Use Mozilla `pdfjs-dist`, including selected generic viewer components where
useful:

- `PDFViewer`
- `EventBus`
- `PDFLinkService`
- `PDFFindController`
- Text and annotation layers

PDF.js stays behind `PdfReaderEngine`. PDF.js-specific events and types must not
leak into application-domain or sync models.

Do not initially use `ngx-extended-pdf-viewer`. It is a strong Angular wrapper
for rapid prototypes, but it brings an opinionated complete UI that conflicts
with the shared EPUB/PDF reader shell and bundle-size goals.

#### EPUB

Use exact, lockfile-pinned `@likecoin/epub-ts` behind `EpubReaderEngine`. It is
the maintained, TypeScript-first EPUB.js-compatible runtime and provides local
archive loading, EPUB 2/3 parsing, reflowable and fixed-layout rendering,
paginated and scrolled modes, EPUB CFI navigation, table of contents handling,
and sandboxed iframe rendering. The compatibility layer keeps the renderer
replaceable without leaking its types into the application domain.

Scripted EPUB content must remain disabled. Publication content must never be
inserted into the Angular document using `bypassSecurityTrustHtml`.

Maintain an EPUB compatibility corpus across reflowable, fixed-layout, RTL,
large-chapter, malformed, and hostile publications. Runtime upgrades must pass
finite-layout, page-within-chapter navigation, resume, search, and console
error gates before being accepted.

#### Readium

Follow the Readium Locator JSON model for progress, bookmarks, and annotations,
but keep an Omnia-owned structural TypeScript representation in the domain
layer.

Do not initially use `@readium/navigator` as the EPUB renderer. It is an active,
standards-oriented toolkit with strong locator, position, preference,
decoration, reflowable, and fixed-layout APIs, but it expects:

- A Readium Web Publication Manifest.
- A positions list.
- Publication resources exposed through a compatible `Fetcher`.

It does not currently provide the complete browser-side path from an arbitrary
local packaged `.epub` file to a renderable publication. Omnia would need to
build and maintain an OPF/navigation parser, ZIP-backed fetcher, manifest
generator, and positions generator, or introduce a publication streaming
server.

Reconsider the Readium renderer if Omnia later requires LCP/DRM, a
server-produced Web Publication Manifest pipeline, audiobooks, or a fully
native Readium Kotlin Android client.

#### Alternatives

Use Foliate JS as an architectural reference for modular book loaders,
random-access ZIP loading, progress calculation, and format-neutral rendering.
Do not make it a production dependency while its API is explicitly unstable
and lacks formal releases.

### 3.3 Product boundaries

Create focused Nx libraries with dependency tags that enforce this direction:

```text
libs/reader/domain       Format-neutral models and contracts
libs/reader/core         Reader facade and session orchestration
libs/reader/epub         EPUB.js adapter
libs/reader/pdf          PDF.js adapter
libs/library/data-access Local metadata, book sources, and progress
libs/sync/core           Provider-neutral journal and library sync coordinator
libs/sync/git            Git/GitHub metadata and Git LFS provider
libs/sync/mega           MEGA provider
libs/platform            Browser and Tauri adapters
```

Application routes:

```text
/library
/reader/:bookId
/settings
/settings/sync
```

The EPUB and PDF libraries must be loaded only when their respective formats
are opened.

## 4. Core Interfaces

The application owns these interfaces; third-party renderer types stay inside
their adapters.

```typescript
type PublicationFormat = 'epub' | 'pdf';

interface BookSource {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  open(): Promise<Blob | ArrayBuffer>;
}

interface PublicationMetadata {
  title: string;
  authors: string[];
  language?: string;
  publisher?: string;
  identifier?: string;
  cover?: Blob;
}

interface PublicationLocator {
  href: string;
  type: string;
  title?: string;
  locations?: {
    fragments?: string[];
    progression?: number;
    position?: number;
    totalProgression?: number;
  };
  text?: {
    before?: string;
    highlight?: string;
    after?: string;
  };
}

interface ReaderEngine {
  open(source: BookSource): Promise<PublicationMetadata>;
  mount(host: HTMLElement): Promise<void>;
  close(): Promise<void>;
  tableOfContents(): readonly TocEntry[];
  currentLocator(): PublicationLocator | null;
  onSelection(listener: (selection: PublicationSelection) => void): () => void;
  clearSelection(): void;
  setAnnotations(annotations: readonly PublicationAnnotation[]): Promise<void>;
  goTo(locator: PublicationLocator): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  search(query: string): AsyncIterable<SearchResult>;
}

interface LibraryRepository {
  listBooks(): Promise<readonly BookRecord[]>;
  importBook(source: BookSource): Promise<BookRecord>;
  removeBook(bookId: string): Promise<void>;
  getProgress(bookId: string): Promise<ReadingProgress | null>;
  saveProgress(progress: ReadingProgress): Promise<void>;
}

interface SyncProvider {
  readonly kind: 'git' | 'mega';
  authenticate(): Promise<void>;
  list(prefix: string): Promise<readonly RemoteEntry[]>;
  readDocument(path: string): Promise<RemoteDocument | null>;
  writeDocument(request: DocumentWrite): Promise<RemoteDocument>;
  downloadObject(path: string): Promise<ReadableStream<Uint8Array>>;
  uploadObject(request: ObjectUpload): Promise<RemoteObject>;
  disconnect(): Promise<void>;
}
```

## 5. Local Library and Progress

### 5.1 Book identity

- Calculate a SHA-256 fingerprint from the publication bytes.
- Use the fingerprint as the exact-edition `bookId`.
- Store embedded ISBN/publication identifiers as metadata, not as the primary
  key.
- Calculate large hashes incrementally outside the Angular UI thread.
- Treat a revised publication as a different exact edition; migration between
  editions is an explicit future feature.

### 5.2 Storage

Web:

- IndexedDB stores metadata, normalized cover artwork, progress, bookmarks,
  highlights/notes with deletion tombstones, preferences, and sync operations.
- OPFS stores publication binaries where available.
- Byte-backed IndexedDB storage is the fallback when OPFS is unavailable or a
  browser cannot persist Blob values.
- Versioned binary references lazily migrate legacy IndexedDB Blobs to OPFS or
  the byte-backed fallback.
  Missing or malformed references remain repairable by re-importing the same
  exact edition; publication metadata and progress are not discarded.
- The Angular service worker caches only the application shell and static
  resources, not arbitrary imported books.

Tauri:

- Publication binaries use application-data storage or a validated
  permission-backed source reference.
- Metadata and progress use the same repository interface as the web target.
- Native paths and Android document URIs never enter the shared domain model.

### 5.3 Progress behavior

- Save progress locally on every meaningful relocation event.
- Restore the last exact locator after process termination, not only after
  normal navigation.
- EPUB progress uses resource href, CFI/fragment, resource progression, and
  total progression where available.
- PDF progress uses the publication resource plus page and optional viewport
  fragment, represented as a Readium-compatible locator.
- Store `furthestTotalProgression` separately from the current locator so users
  may intentionally reread earlier content.

## 6. Library Synchronization

### 6.1 Scope

Every configured provider synchronizes:

- The original DRM-free EPUB or PDF bytes.
- The exact-edition book manifest and display metadata.
- Current reading progress.
- Furthest progress.
- Bookmarks and deletion tombstones.
- Highlights, notes, and deletion tombstones.
- Device identity and update time.

Cover images are a bounded local cache derived from the synchronized
publication bytes. They are not uploaded as a second copy: after Git LFS or
MEGA restores a book, the client extracts the EPUB package cover or renders
the first PDF page and stores the normalized result locally.

The schema reserves future locations for shared preferences and reading
statistics. Those additional records are not synchronized in the first
release.

Book synchronization is explicit and visible in settings. Removing a local
book must not silently delete the remote copy. Remote deletion is a separate
confirmed action so another device cannot erase a user's only backup. A
device-local exclusion set prevents a remotely backed-up edition from being
restored after local removal; a successful explicit re-import clears that
edition's exclusion. The separate remote-delete action writes a versioned
per-book tombstone before deleting the publication object with an optimistic
provider revision, so concurrent or offline devices cannot resurrect a stale
backup. Existing local copies remain readable, and an explicit newer re-import
may recreate the remote backup.

### 6.2 Offline operation journal

Local writes append typed operations independently of network availability:

```typescript
interface SyncOperation {
  id: string;
  entity: 'book' | 'progress' | 'bookmark' | 'annotation' | 'preference';
  entityId: string;
  operation: 'upsert' | 'delete';
  revision: number;
  createdAt: string;
  payload: unknown;
}
```

The synchronizer acknowledges operations only after the remote commit is
confirmed. A sync failure never rolls back or blocks local reading.

Binary uploads are content-addressed and idempotent. The coordinator verifies
the SHA-256 digest and byte length before publishing the book manifest, and
again before importing a downloaded publication. Interrupted transfers remain
pending and safely retry as whole transfers without publishing incomplete
manifests or provider references. Provider-native byte-range or upload-session
resume remains future work.

### 6.3 Provider-neutral layout

```text
.omnia-reader/
├── manifest.json
├── books/<bookId>/book.json
├── books/<bookId>/publication.epub
├── books/<bookId>/publication.pdf
├── progress/<bookId>/<deviceId>.json
├── bookmarks/<bookId>/<bookmarkId>.json
├── annotations/<bookId>/<annotationId>.json
└── preferences/<deviceId>.json
```

Exactly one publication object exists under each exact-edition `bookId`. Its
extension and media type must agree with `book.json`. The book manifest
contains the original file name, format, media type, size, SHA-256 book ID,
display metadata, object path, creation time, and schema version. The binary is
immutable: a changed publication has a different `bookId` and object path.

`manifest.json` describes the Omnia schema and enabled features; per-book
manifests remain independently mergeable so adding a book does not rewrite a
single global catalog.

Each bookmark document is a complete, versioned record containing its stable
ID, book ID, format, device ID, Readium-compatible locator, display label, and
creation/update timestamps. Deleting a bookmark writes the same record with
`deletedAt` equal to `updatedAt`; clients retain and synchronize that tombstone
to prevent stale devices from resurrecting it. Pull and restore select records
by newest `updatedAt`, then use deterministic device/record ordering for equal
timestamps.

Each annotation document is a complete, versioned record containing its stable
ID, book ID, format, device ID, quote-backed locator, color, optional note, and
creation/update timestamps. EPUB locators use CFI ranges. PDF locators use page
text offsets plus bounded PDF-coordinate rectangles so the renderer can
recreate highlights after zoom or rotation. Deletion and conflict resolution
use the same tombstone and deterministic last-writer-wins rules as bookmarks.

Each progress document contains:

```json
{
  "schemaVersion": 1,
  "bookId": "sha256:...",
  "format": "epub",
  "deviceId": "...",
  "locator": {},
  "furthestTotalProgression": 0.42,
  "updatedAt": "2026-07-24T12:00:00.000Z",
  "appVersion": "..."
}
```

Separate files per device avoid content-level merge conflicts. On pull:

- Validate every book manifest and object path.
- Download a missing publication, stream it into local durable storage, verify
  its SHA-256 and length, then make it visible in the library atomically.
- Never replace a valid local binary with unverified remote bytes.
- Reject malformed documents and quarantine unsupported future schema
  versions.
- Select the valid device locator with the newest `updatedAt` as the current
  resume location.
- Resolve equal timestamps deterministically by `deviceId`.
- Merge `furthestTotalProgression` using the maximum value.
- Preserve every device document.

### 6.4 Git and GitHub provider

Implement Git through a minimal authentication/sync gateway. GitHub is the
first hosted Git service:

- Request only repository contents permission for the selected repository.
- Keep GitHub tokens out of browser storage.
- Use ordinary Git blobs/commits for manifests, progress documents, bookmark
  records, and annotation records.
- Track `.omnia-reader/library/**/*.epub` and
  `.omnia-reader/library/**/*.pdf` in `.gitattributes` with
  `filter=lfs diff=lfs merge=lfs -text`.
- Generate the canonical Git LFS v1 pointer containing the SHA-256 object ID
  and byte length, transfer the object through the LFS batch API, and publish
  the pointer only after the LFS upload is verified. The gateway may delegate
  this protocol to a pinned `git-lfs` reference client.
- Supply the existing blob SHA for updates.
- On HTTP 409, pull, merge, and retry with bounded exponential backoff.
- Serialize writes made by one client.
- Detect repositories where Git LFS is unavailable or quota is exhausted
  before marking a book operation complete.

Persist books, progress, bookmarks, highlights, and notes locally immediately.
Automatically push:

- After a successful import.
- After a bookmark is created or deleted.
- After a highlight or note is created, edited, or deleted.
- On book switch.
- When the application enters the background or closes.
- After a quiet reading interval.
- On manual sync.

Coalesce rapid reading-state changes behind a one-second quiet interval. Check
the lightweight GitHub repository revision every ten seconds while visible and
online so another local device converges without requiring a public webhook.
Retry queued changes when connectivity returns and always honor provider
`Retry-After`.

### 6.5 MEGA provider

MEGA implements the same logical paths without Git commits or LFS pointers:

- Use the official MEGA SDK behind the same-origin gateway for the web/PWA.
  Native direct SDK adapters may be added later, but must preserve the same
  schema and conflict behavior.
- Store the selected MEGA folder handle and encrypted SDK session only in the
  gateway's protected server-side session store. Never put account passwords,
  master keys, or reusable sessions in browser storage.
- Upload EPUB/PDF objects as encrypted MEGA files and JSON records as small
  encrypted files under one application folder.
- Use stable node handles and provider revisions, not file names alone, for
  optimistic updates. MEGA permits duplicate names and documents that its sync
  engine has no cross-client locking, so the Omnia coordinator must reconcile
  duplicates deterministically.
- Treat publication objects as immutable. Because the SDK does not provide
  delta writes, only a missing exact-edition object is uploaded; progress,
  bookmark, and annotation JSON remain small and replaceable.
- Surface MEGA storage quota, transfer quota, expired session, and duplicate
  node conditions as actionable sync states.

Users choose one active provider per sync profile. Switching providers copies
the validated logical library; it never deletes data from the old provider.

## 7. User Experience

Use a library-first shell inspired by established readers such as Koodo Reader,
without copying its AGPL-licensed code.

Library milestone:

- Grid and list views.
- Recent books.
- Search, sorting, and durable reading-status filters.
- Cover and metadata display.
- Duplicate detection.
- Import, remove, export, and restore.
- Empty, loading, permission, and corrupt-file states.

Reader layout:

- Left panel: table of contents, bookmarks, highlights/notes, and search.
- Right panel: format-aware settings.
- Top bar: book identity and global actions.
- Bottom area: progress and navigation.
- Touch-friendly tap zones and explicit controls.
- Keyboard shortcuts and distraction-free mode on desktop.

The application toolbar keeps the active synchronization state visible across
library, reader, and settings routes. Its compact status link exposes live
publication-transfer percentage when available, announces meaningful state
changes to assistive technology, and opens synchronization recovery or setup
in one action. A local-only build states that boundary instead of presenting a
remote-provider action.

EPUB controls:

- Font family and size.
- Line height, paragraph spacing, margins, and maximum line width.
- Light, sepia, and dark themes.
- Paginated and scrolling modes.
- One- and two-page presentation where supported.

PDF controls:

- Page navigation.
- Fit page, fit width, and custom zoom.
- Rotation.
- Outline and thumbnails.
- Text search and selection.
- Colored text highlights with optional notes.
- Password prompt.

Do not rely on edge-hover-only controls; every action must be keyboard,
touch, and assistive-technology accessible.

## 8. Native Packaging

Tauri desktop:

- EPUB and PDF file associations.
- Open-with, drag-and-drop, and single-instance import handling.
- Deep-link protocol support.
- Validated native file dialogs and storage access.
- Signed Windows, macOS, and Linux artifacts.
- Desktop updating only after signing infrastructure is available.

Tauri Android:

- Android document picker and persisted content access.
- Open-with and share intents for EPUB/PDF.
- Back-button behavior integrated with reader panels and route history.
- Progress flush on pause/background and process termination signals.
- Signed APK for testing and AAB for distribution.

Native commands expose narrow typed operations. They must not expose a general
shell, arbitrary filesystem access, or unvalidated paths to publication
content.

Current native implementation notes:

- `pick_publications` accepts only EPUB/PDF selections, inspects file signatures
  in Rust, and returns opaque source IDs plus display metadata.
- `read_publication` consumes an opaque ID once and returns raw IPC bytes. It
  accepts no caller-provided path.
- `tauri-plugin-fs` is used only from Rust so Android `content://` sources work
  without granting broad frontend filesystem permissions.
- Native imports are copied into the same OPFS-first durable library used by
  the PWA; the picker URI is not persisted or exposed to the domain layer.
- Tauri's Android back event is registered only on Android. A shared
  coordinator first closes the newest transient panel, then maps reader and
  nested settings routes to their explicit parent. At the library root it
  invokes the narrow native app-exit command instead of relying on WebView
  history.
- The Linux amd64 Tauri production build is warning-free and produces validated
  Debian, RPM, and AppImage artifacts. A debug-only, feature-gated native
  WebDriver endpoint verifies cold-start PDF ingestion and second-process EPUB
  forwarding through the real single-instance plugin, then exercises rendered
  content, both arrow/button navigation paths, and exact-edition deep-link
  routing. The runner uses deterministic generated fixtures, isolated XDG
  storage, and the W3C protocol directly, so Ubuntu needs no separate
  `webkit2gtk-driver` package. Installed-association and protocol activation,
  native drag/drop, and background/termination lifecycle journeys remain.
- Android initialization and aarch64 debug APK assembly are verified. Runtime
  picker/open-with and hardware-back behavior still need an emulator and
  physical-device gate.

## 9. Delivery Sequence

### Phase 0: Foundation and platform spike

- Create the Nx library boundaries and dependency constraints.
- Introduce domain types and the `ReaderEngine` facade.
- Add library, reader, and settings routes.
- Validate Tauri desktop and Android with local files and lazy workers.
- Add the EPUB/PDF fixture corpus and security fixtures.
- Resolve deprecated Nx lint and Tailwind integration.

Exit gate: one minimal EPUB and one PDF open through the common facade in the
web, desktop, and Android development targets.

### Phase 1: Production EPUB

- Implemented: integrate exact-pinned `@likecoin/epub-ts` through
  `EpubReaderEngine`.
- Implemented: replace unsafe Angular HTML injection with sanitized,
  script-disabled iframe rendering.
- Implemented: lazy section rendering, recursive numbered and initially
  collapsed TOC, semantic unnumbered front/back matter, headless search,
  themes, finite pagination, scrolling, keyboard/wheel/touch navigation, and
  exact CFI resume.
- Implemented: remove the custom parser after fixture parity is demonstrated.

Exit gate: the EPUB corpus passes on Chromium, Firefox, WebKit, Tauri desktop,
and Android WebView.

### Phase 2: PDF and offline library

- Implemented: integrate PDF.js through `PdfReaderEngine`.
- Implemented: virtualized pages, text/annotation layers, outline, search,
  password handling, thumbnails, and PDF locators.
- Implemented: the library repository, incremental worker fingerprints,
  OPFS-first binary storage with a versioned IndexedDB fallback and lazy
  migration, duplicate repair, import-time metadata, durable bounded cover
  artwork, and local progress.
- Implemented: host-neutral storage durability status, browser persistence
  requests and quota estimates, native persistent-storage reporting, and
  accessible Settings guidance for denied or unavailable browser grants.
- Implemented: enable and test the PWA shell. The production service-worker
  gate now imports both formats into isolated persistent Chromium profiles,
  saves a non-initial PDF page and EPUB chapter, closes and relaunches the
  browser, disables networking before the cold start, and restores both the
  publications and their exact reading positions with clean browser consoles.

Exit gate: EPUB and PDF reading work offline and restore after forced
termination.

### Phase 3: Full library synchronization

Current delivery state: active for the Angular application, with GitHub as the
priority path but still explicitly experimental. Provider credentials are
managed by same-origin gateway sessions rather than browser storage. The
deterministic simulated provider journeys pass across Chromium, Firefox, and
WebKit; live credentialed GitHub validation and deployment to a real HTTPS
environment remain release gates. A reference
same-origin production stack is implemented with digest-pinned non-root web and
gateway images, an internal-only gateway, streamed publication proxying,
read-only filesystems, health checks, and an executable container smoke gate.
MEGA is implemented but secondary. The default `npm start` build is
deliberately local-only and cannot schedule or route remote synchronization;
`npm run start:full` selects the sync-enabled development build and starts the
gateway alongside it.

- Implemented: operation journal and deterministic progress merge rules.
- Implemented: canonical root schema/features manifest initialization,
  validation, optimistic conflict retry, and fail-closed coordination before
  child synchronization.
- Implemented: synchronize exact EPUB/PDF binaries and per-book manifests in
  addition to progress.
- Implemented: durable PDF/EPUB bookmarks, deletion tombstones, deterministic
  merge rules, complete snapshot seeding, and provider-neutral Git/MEGA
  synchronization.
- Implemented: durable PDF/EPUB highlights and notes, deletion tombstones,
  quote-backed locators, backward-compatible highlight/underline/strikethrough
  styles, searchable per-book annotation overview, deterministic filtered
  Markdown export, deterministic merge rules, complete snapshot seeding, and
  provider-neutral Git/MEGA synchronization.
- Implemented in the web client contract: GitHub App authentication,
  App installation/repository-access onboarding, repository selection, Git LFS
  object transfer, actionable error mapping, guided setup-state feedback,
  repository filtering/linking, automatic-result refresh, and manual retry.
  Successful manual and automatic results share one global status, including
  received, sent, conflict-retry, and invalid-record counts. A validated,
  provider-scoped local history restores this evidence after restart; changing
  the selected repository or folder clears it so a previous destination cannot
  appear current.
  The gateway implements OAuth
  state validation, S256 PKCE with an encrypted one-time verifier, callback
  rotation, sanitized cancellation/failure recovery, strict expiring
  user/refresh-token rotation with per-process concurrent request coalescing
  and one-time invalidation after definitive rejection, including a user-token
  401 when the matching authorization has been revoked. Explicit disconnect
  deletes the local session before revoking its single GitHub user token, and
  refresh/disconnect races revoke any rotated token that can no longer be
  attached to a live session. A raw-body HMAC-validated,
  delivery-deduplicated `github_app_authorization` webhook advances a
  user-scoped generation in memory or shared Redis, invalidates all of that
  user's sessions without a scan, and rejects token-refresh races before they
  can restore authority. Installation-scoped tokens, a validated public
  installation URL, Contents API optimistic commits, verified LFS batch/basic
  transfers, safe 403 recovery that clears only the matching stale repository
  selection, and a reconnect UI are covered without exposing
  provider-controlled error text. GitHub App authentication failures preserve
  the selected destination for retry. Primary and secondary provider rate
  limits map to a bounded `Retry-After` response, safe Settings guidance, and
  persisted automatic-sync backoff so queued work cannot hot-loop. OAuth,
  GitHub API, Git LFS metadata/verification, and whole-object transfers have
  separate configurable deadlines; stalled and failed provider requests map
  to application-owned errors without publishing a pointer. LFS actions also
  require credential-free HTTPS URLs, reject explicit loopback/private
  literal-IP targets, and accept only bounded non-hop-by-hop headers before any
  object request. Live credentialed provider testing remains pending.
- Implemented in the web client contract: MEGA authentication, folder
  selection, encrypted object transfer, and duplicate-node conflict handling.
  The gateway now includes its protected login page, encrypted SDK session,
  writable-folder authorization, deterministic duplicate reconciliation,
  optimistic whole-file JSON replacement, immutable publication transfer, and
  a validated private bridge client. The pinned native C++ bridge now
  implements official-SDK login/MFA, session restoration, writable-folder
  enumeration, root-confined node access, uploads, downloads, moves, removal,
  and `osh` integrity attributes. Its SDK-linked Release build and core CTest
  pass in an isolated Ubuntu 24.04 environment; digest-pinned non-root
  container packaging and a lifecycle smoke test are implemented. Image
  scanning/signing/publishing and live provider conformance tests remain
  pending.
- Implemented: pull, push, bounded conflict retry, durable offline operation
  queue, provider selection, manual sync, automatic lifecycle scheduling, and
  visible automatic-sync status both in Settings and in the persistent
  application toolbar. The toolbar reacts immediately to provider selection
  and disconnect, distinguishes setup, scheduled, delayed, offline, cancelled,
  successful, and attention-required states, links directly to synchronization
  details, and reports live publication-transfer percentage. Manual and
  automatic publication transfers expose direction, bytes transferred, total
  bytes, percentage, and cancellation.
  Uploads send the original Blob through the browser-native request body and
  downloads monitor the response stream, avoiding a second explicit full
  binary copy in application code. Cancellation retains the local journal
  operation for a safe retry. A deterministic Chromium/WebKit browser journey
  holds an automatic PDF upload at the HTTP boundary, exposes progress and
  cancellation through Settings, aborts it, and verifies that the local change
  remains pending and manually retryable. Restart-safe whole-transfer retry is
  covered for Git LFS and MEGA publication interruptions. Provider-native
  byte-range or upload-session resume and guaranteed process-termination
  delivery are pending.
- Implemented: removing a book from one device preserves its remote backup and
  durably excludes that exact edition from subsequent pulls and snapshot
  seeding on that device. Re-importing the same EPUB/PDF opts it back into
  synchronization.
- Implemented: Settings lists publication files in the active remote
  destination and exposes a separate confirmed deletion action. Deletion
  commits a versioned book tombstone before revision-deleting the Git LFS
  pointer or every matching MEGA node, retains existing local copies, discards
  stale pending uploads, survives interrupted cleanup, and permits a
  deliberately newer re-import. Core, gateway, Angular, Chromium, and WebKit
  regressions cover conflicts, rollback, retry, and local-copy preservation.
- Implemented: deterministic Chromium, Firefox, and WebKit HTTP-boundary
  journeys synchronize an exact PDF through Git/LFS and an exact EPUB through
  MEGA, then restore publication bytes, reading position, bookmark, highlighted
  quote, and attached note on a clean second browser device. That second device
  then creates distinct progress, bookmark, highlight, and note state; after
  synchronization, both devices expose both contributions. The journeys verify
  two per-device progress documents, two bookmark documents, and two annotation
  documents at the remote boundary. The Git journey also proves retry after an
  interrupted object upload and an optimistic manifest conflict.
- Verified for the synchronization-stability candidate: all 27 compatibility
  and complete Git/MEGA PDF/EPUB convergence cases pass across Chromium,
  Firefox, and WebKit. Desktop native sessions use the pinned `keyring` 3.6.3
  platform backends; Android deliberately remains session-only and requires
  reauthentication after restart. Deterministic unit, real-Redis, native
  contract, release, lint, build, audit, formatting, and diff gates pass.
  Container runtime, packaged host/emulator, protected live GitHub, registry
  signing, staging/canary, deployment, and physical-device evidence remain
  unavailable. GitHub therefore remains experimental and no immutable release
  candidate is accepted.
- Implemented: shared schema, provider migration, privacy, and recovery
  behavior.

Exit gate at the deterministic provider boundary: PASS. A clean second device
restores books, progress, bookmarks, highlights, and notes; both devices make
distinct changes and converge without losing either device's state; and the
same corpus passes through Git/LFS and MEGA. Live credentialed provider
conformance remains a release gate.

### Phase 4: Native releases

- Implemented: file associations, opaque open-with/share ingestion,
  single-instance forwarding, and drag-and-drop ingestion.
- Implemented: provider-neutral, versioned backup archives for complete local
  publication bytes, metadata, merged and per-device progress, bookmark and
  annotation tombstones, highlights/notes, reader preferences, logical-book
  membership/covers, synchronized format preferences, and reconciliation
  records, with strict preflight validation, version 1–3 migration, complete
  conflict reporting, and atomic revision-checked merge behavior.
- Implemented: deterministic mobile back handling with transient-panel
  priority, explicit route parents, and root-only native exit.
- Implemented: direct File System Access and native archive save targets,
  bounded native IPC chunks, cancellation, and large PDF/EPUB browser
  streaming coverage.
- Implemented: warning-free Linux amd64 Tauri production packaging with
  validated Debian, RPM, and AppImage outputs.
- Implemented: read-only, immutable-action CI packaging for unsigned
  Linux/Windows/macOS verification bundles and Android aarch64 debug APK/AAB
  packages. The first hosted matrix run remains required.
- Implemented: Linux native-host lifecycle E2E for cold-start PDF open-with
  arguments, single-instance EPUB forwarding, actual format rendering, and
  arrow/button navigation plus exact-edition deep-link routing. The
  feature-gated test endpoint is excluded from production builds and runs under
  isolated XDG directories.
- Complete lifecycle integration and protected signing/publishing.
- Validate desktop installers and Android APK/AAB artifacts.
- Add multi-gigabyte and constrained-device archive memory profiling.

Exit gate: signed release candidates pass the full cross-platform test matrix.

### Phase 5: Hardening

- Implemented: deterministic WCAG A/AA accessibility audits for the library,
  settings, PDF reader shell, and EPUB reader shell in Chromium, Firefox, and
  WebKit. EPUB publication contents remain outside this application-owned gate
  because they are untrusted author-controlled documents in a script-disabled
  iframe. Manual keyboard, screen-reader, and mobile assistive-technology
  audits remain release requirements.
- Implemented browser baseline: an opt-in, serial Chromium gate imports and
  opens a generated 180-page PDF and 80-chapter EPUB, verifies arrow/button
  navigation, bounds live PDF canvases and EPUB frames, enforces import/open
  and main-thread long-task budgets, proves reader DOM teardown, and limits
  post-GC retained heap growth through the Chrome DevTools Protocol. The
  representative EPUB compatibility corpus, including a pinned Readium EPUB
  2/NCX smoke test, is implemented across Chromium, Firefox, and WebKit.
  Deterministic malformed EPUB import also proves user-readable recovery,
  rollback, and console cleanliness. Performance profiling on those
  publications and real Android remain release requirements.
- Implemented: Playwright keeps CPU- and memory-heavy tests ordered within
  their files. The active local gate runs Chromium and WebKit with four workers,
  while CI scales across a browser-by-two-shard job matrix with one worker per
  machine. Firefox automation is temporarily opt-in so app feature work remains
  the priority. The dedicated installed-PWA cold-restart and large-publication
  performance gates remain serialized in a separate Chromium job. The first
  hosted execution of this sharded topology remains required.
- Implemented: matching web and Tauri Content Security Policies plus a hostile
  EPUB corpus covering scripts, inline handlers, nested frames, refresh,
  forms, remote images, stylesheets, CSS imports, and CSS URLs. Unit and
  Chromium/Firefox/WebKit E2E gates prove that the publication neither
  executes authored code nor makes publication-controlled network requests.
  A production response-header policy now adds CSP, shell-only anti-framing,
  MIME-sniffing, referrer, resource, and permissions controls; its CSP remains
  aligned with the HTML fallback, preserves the sandboxed internal-link
  target, and passes Chromium/Firefox/WebKit reader journeys. Real CDN or
  reverse-proxy parity and a broader third-party malicious-publication corpus
  remain release requirements.
- Implemented: storage migration, runtime schema enforcement, corrupt-record
  quarantine, healthy-library recovery, safe recovery inspection, and
  versioned lossless diagnostic export, with unit and cross-browser WCAG E2E
  coverage.
- Implemented: the production Angular warning/error budgets are release gates.
  A fail-closed release verifier aligns npm, Cargo, and Tauri versions; rebuilds
  web and gateway artifacts without the Nx cache; requires a clean production
  vulnerability audit; emits normalized npm, Rust, and pinned bridge-source
  CycloneDX 1.5 SBOMs; rejects missing or unreviewed license expressions;
  verifies full Git commit and base-image digest pins; and writes deterministic
  SHA-256 artifact manifests. Post-build bridge image scanning and its
  operating-system package SBOM remain part of the native release gate.
- Implemented: digest-pinned production web and gateway images plus a hardened
  same-origin Compose topology. Nginx serves the PWA, applies the canonical
  security-header policy, streams `/api/sync` publication bodies to an
  internal-only gateway, and supports SPA fallback and immutable asset caching.
  The smoke gate builds both images, waits for health, validates headers and
  proxy routing, and proves provider-disabled behavior. A real HTTPS
  deployment, shared production Redis, credentialed provider validation, image
  scanning, signing, and publication remain release requirements.
- Implemented: an executable release and rollback runbook covers immutable
  promotion, native/bridge signing and scanning requirements, canary and smoke
  gates, rollback triggers, per-runtime recovery, local-first data retention,
  service-worker behavior, and forward-fix-only schema changes.

## 10. Test and Release Gates

Unit and integration tests:

- EPUB metadata, manifest, TOC, resource, fixed-layout, RTL, and CFI behavior.
- PDF outline, page locator, password, search, and link behavior.
- SHA-256 identity and duplicate detection.
- EPUB cover extraction, PDF first-page cover generation, bounded artwork
  persistence, fallback states, and cache deletion.
- Incremental worker hashing, OPFS/IndexedDB fallback, legacy Blob migration,
  malformed binary references, and duplicate re-import repair.
- Backup archive schema, unsafe/undeclared ZIP entries, size limits, CRC and
  SHA-256 integrity, merge rules, and complete browser export/restore.
- Reading progress serialization and schema validation.
- Bookmark serialization, tombstone validation, deterministic merge, and
  stale-record rejection.
- Annotation serialization, tombstone validation, deterministic merge,
  stale-record rejection, EPUB CFI capture/rendering, and PDF coordinate
  capture/rendering.
- Operation journal retry and acknowledgement.
- Automatic sync coalescing, offline retry, quiet-period debounce, background
  flush, persisted Git rate limiting, transfer progress, cancellation, and
  scheduler-stop abort handling.
- Deterministic multi-device merge rules.
- Book manifest validation, immutable object identity, interrupted upload
  recovery, and downloaded-binary hash verification.
- Git LFS pointer and batch-transfer behavior.
- MEGA duplicate-name and whole-file replacement behavior.
- Storage migrations and corrupt records.
- Browser and Tauri platform adapters.
- LIFO transient-panel handling, Escape behavior, Android parent-route mapping,
  listener cleanup, and root-only application exit.

End-to-end journeys:

- Import, read, close, reopen, and resume an EPUB.
- Import, search, zoom, close, reopen, and resume a PDF.
- Use the application fully offline after installation.
- Restore books, progress, bookmarks, highlights, and notes onto a clean
  simulated device.
- Create, reopen, filter, navigate to, restyle, edit, and delete
  highlights/underlines/strikethroughs/notes in EPUB and PDF.
- Synchronize a library between two simulated devices through Git/LFS and
  MEGA.
- Recover from a remote 409 conflict and an interrupted sync.
- Recover from an interrupted large publication upload without publishing a
  dangling book manifest.
- Open EPUB/PDF through desktop and Android operating-system associations.
- Close reader panels before navigating Android back, traverse explicit parent
  routes, and exit only from the library root.
- Audit the library, settings, PDF reader shell, and EPUB reader shell against
  automated WCAG A/AA rules in Chromium, Firefox, and WebKit.
- Open a hostile EPUB in Chromium, Firefox, and WebKit and prove that authored
  scripts, active embeds, form targets, and remote resource requests remain
  inert while pagination and navigation continue to work.

Security gates:

- EPUB scripts and inline event handlers cannot execute.
- Publication content cannot navigate the application shell.
- Unexpected publication network requests are blocked.
- External links require explicit user action and open outside the publication
  context.
- Git credentials, MEGA credentials/keys, and reusable provider sessions never
  appear in logs, sync documents, IndexedDB, or native unencrypted
  preferences.
- Downloaded EPUB/PDF bytes are not imported until their declared length and
  SHA-256 digest match.

Performance gates:

- EPUB sections and PDF pages are loaded incrementally. The browser gate
  limits a 180-page PDF to six live canvases and an 80-chapter EPUB to two
  live frames.
- Object URLs, workers, canvases, and renderer instances are released when a
  book closes. The browser gate requires no reader canvases, frames, or
  viewport after returning to the library and less than 48 MiB post-GC heap
  growth over the post-import baseline.
- EPUB and PDF engines remain outside the initial web bundle.
- The application shell meets the configured 500 kB initial warning budget.
- Generated large-publication import completes within 20 seconds, first render
  within 15 seconds, every observed main-thread long task stays below one
  second, and aggregate long-task time stays below four seconds in the serial
  Chromium gate.
- Representative large publications remain responsive on a real Android
  device.
- Large book upload/download is streamed, reports progress, can be cancelled,
  and does not require a second full in-memory copy.

Compatibility matrix:

- Latest Chromium and WebKit Playwright targets; Firefox is temporarily
  deferred.
- Windows, macOS, and Linux Tauri builds.
- At least one current physical Android device plus an emulator in CI.

## 11. References

- [PDF.js](https://mozilla.github.io/pdf.js/)
- [EPUB.ts](https://github.com/likecoin/epub.ts)
- [EPUB.js](https://github.com/futurepress/epub.js)
- [Readium Web toolkit](https://github.com/readium/ts-toolkit)
- [Readium EpubNavigator](https://github.com/readium/ts-toolkit/blob/develop/navigator/docs/epub/EpubNavigator.md)
- [Readium publication handling](https://github.com/readium/ts-toolkit/blob/develop/navigator/docs/HandlingPublications.md)
- [Readium Locator model](https://readium.org/architecture/models/locators/)
- [Foliate JS](https://github.com/johnfactotum/foliate-js)
- [Koodo Reader](https://github.com/koodo-reader/koodo-reader)
- [Tauri 2](https://v2.tauri.app/start/)
- [Angular PWA guide](https://angular.dev/ecosystem/service-workers/getting-started)
- [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents)
- [Git LFS pointer specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
- [Git LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
- [Official MEGA SDK](https://github.com/meganz/sdk)
- [Omnia Reader MEGA SDK bridge contract](mega-sdk-bridge.md)
