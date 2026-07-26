# Omnia Reader

Omnia Reader is an offline-first EPUB and PDF reader built from one Angular
application for the web/PWA, Tauri desktop, and Android.

The current implementation includes an OPFS-first local library with a
byte-backed IndexedDB fallback, incremental worker hashing, durable EPUB/PDF
covers, explicit duplicate and partial-import outcomes, the maintained
`@likecoin/epub-ts` EPUB.js-compatible runtime and PDF.js reader engines,
keyboard, wheel, and guarded touch navigation, exact resume locations,
book-wide progress seeking, library reading-status filters, accessible
recoverable local-book removal, immersive
fullscreen reading, format preferences,
fixed-layout and RTL EPUB support, NAV/NCX-relative table-of-contents navigation
with numbered, initially collapsed sections and unnumbered front/back matter,
safe internal links, consent-gated HTTP(S) links, durable bookmarks, highlights
and notes, full-text search, versioned full-library backup archives, a
preserved provider-neutral sync core, PWA offline support, and narrow native
import, exact-edition deep-link, and external-link bridges.
Backups stream directly to File System Access and native save destinations
where supported, with cancellation and a compatible browser download fallback.
Reader panels, desktop Escape, and Android hardware back share deterministic
last-opened-first navigation behavior.
Each reader side panel moves focus to its first useful surface, has an explicit
close control, restores the corresponding toolbar trigger when dismissed, and
returns focus to the publication after navigation. Page arrows, wheel, and
swipe gestures are isolated while a panel is open.
Reader-owned password, external-link consent, and annotation dialogs contain
keyboard focus, start on the safest useful control, restore focus when closed,
and prevent page-navigation shortcuts from acting behind modal consent.
The synchronization core journals books, progress, bookmark
tombstones, and annotation tombstones, verify immutable publication objects,
and communicate with Git/Git LFS and MEGA gateways. The Angular app exposes
the sync route, durable operation journal, and automatic scheduler. GitHub uses
a state-bound GitHub App login with encrypted server-side sessions; users can
select an existing private repository or create one from the settings flow.
See the
[universal reader development plan](docs/universal-reader-plan.md) for the
architecture, verified status, and remaining release work. Release candidates
follow the executable gates and recovery procedures in the
[release and rollback runbook](docs/release-and-rollback.md).

## Web development

Use Node `v26.5.0` from `.nvmrc` and the locked dependency set:

```sh
nvm use
npm ci
npm start
```

The development application is served at <http://localhost:4300>.

Offline reading needs no sync server. GitHub synchronization is available
through the isolated same-origin gateway, which can be started with:

```sh
npm run start:full
```

The gateway listens on `127.0.0.1:3333`; the Angular development server proxies
`/api/sync` to it. The GitHub App/Git LFS and MEGA adapters activate when their
documented environment variables are present and otherwise fail closed. MEGA
uses a private service built with the official SDK; its deployment boundary is
specified in [the MEGA SDK bridge contract](docs/mega-sdk-bridge.md).
The provider clients use the same-origin endpoints documented in
[the sync gateway contract](docs/sync-gateway-api.md). Provider credentials
stay in that gateway; they are never stored by the Angular app. Development
uses an encrypted in-memory session store. Multi-replica deployments can use
the documented Redis store with atomic session rotation, TTL expiry, and
rolling AES key rotation.

The default browser E2E matrix covers GitHub repository onboarding. The longer
two-device Git/LFS and MEGA convergence journeys remain opt-in:

```sh
REMOTE_SYNC_E2E=1 npx nx run omnia-reader-e2e:e2e -- src/sync.spec.ts
```

The opt-in
[representative publication corpus](docs/representative-publication-corpus.md)
downloads hash-pinned W3C/IDPF EPUB samples and checks long-form embedded-font
rendering, search, and authored RTL navigation in Chromium and WebKit:

```sh
REPRESENTATIVE_PUBLICATIONS_E2E=1 npx playwright test \
  --config apps/omnia-reader-e2e/playwright.config.ts \
  apps/omnia-reader-e2e/src/representative-publications.spec.ts
```

The pinned native bridge source is an Nx project. After installing the MEGA
SDK's documented native dependencies, build it with:

```sh
npx nx build mega-sdk-bridge --skip-nx-cache
```

Alternatively, build the digest-pinned non-root runtime image without
installing the native toolchain on the host:

```sh
npx nx run mega-sdk-bridge:container --skip-nx-cache
npx nx run mega-sdk-bridge:container-smoke --skip-nx-cache
```

The resulting local image is
`omnia-reader/mega-sdk-bridge:local`. The bridge deliberately listens only on
loopback, so deploy it beside the sync gateway in the same network namespace
(for example, as a Kubernetes sidecar) or place an authenticated TLS proxy on
the bridge host. Publishing its Docker port from an isolated container network
is intentionally not a supported exposure model.

Useful verification commands:

```sh
npx nx test omnia-reader
npx nx test reader-domain
npx nx test reader-core
npx nx test reader-epub
npx nx test reader-pdf
npx nx test library-data-access
npx nx test platform
npx nx lint omnia-reader
npx nx lint omnia-reader-e2e
npx nx build omnia-reader --configuration production
npx nx run omnia-reader-e2e:e2e -- --project=chromium
npm run performance:e2e
PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts
npm run native:e2e
npm run release:test
npm run release:verify
```

The workspace-wide test aggregate currently enters a recursive Nx invocation
through the deferred `mega-sdk-bridge:configure-core` target. Use the explicit
local-reader commands above until provider/native task orchestration returns to
scope.

The release verifier rebuilds the production web app and gateway, checks the
shared `0.1.0` version, production dependency vulnerabilities, reviewed
licenses, and immutable bridge inputs, then writes normalized npm, Rust, and
bridge-source CycloneDX SBOMs plus SHA-256 artifact manifests under
`dist/release/`.

Playwright normally uses its installed Chromium. On a development machine with
only a system Chrome, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to that
executable. A nonstandard WebKit launcher can be selected with
`PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH`.

## Continuous integration

The `Verify` GitHub Actions workflow runs the locked test, lint, production
build, dependency-audit, release-metadata, active browser, and installed-PWA
offline gates. After the shared gates pass, it builds unsigned Tauri bundles
on Linux x64, Windows x64, and macOS arm64, plus an Android aarch64 debug APK
and AAB, and retains them as short-lived verification artifacts.

All actions are pinned to immutable commit SHAs and the workflow has read-only
repository permissions. These unsigned artifacts prove packaging only; signed
release publication remains a separate, protected workflow that requires
platform signing identities and explicit release approval.

## Web deployment

Deploy the built local-reader PWA behind HTTPS; it does not require the
`/api/sync` gateway. If remote providers are re-enabled later, deploy their
gateway behind the same origin. The required browser security policy is
exported from
`tools/web-security-headers.mjs`; the production-like Playwright server applies
it and the cross-browser suite verifies it. Configure the same headers at the
real CDN or reverse proxy and add HTTP Strict Transport Security at the TLS
edge. The CSP meta element in `index.html` is a fallback, not a replacement for
response headers.

## Tauri desktop

Install the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for the host
operating system, then run:

```sh
# Debian and Ubuntu
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  dbus-x11 xvfb
```

```sh
npm run native:dev
npm run native:build
npm run native:e2e
```

The similarly named runtime packages are not sufficient for compiling: the
`-dev` packages provide the GLib, GTK, JavaScriptCoreGTK, and WebKitGTK
`pkg-config` metadata consumed by Cargo build scripts. The native E2E command
builds a debug-only, feature-gated WebDriver endpoint and drives it directly
through the W3C protocol; Ubuntu does not need a separate
`webkit2gtk-driver` package. When no desktop session bus is available, run it
as `dbus-run-session -- xvfb-run -a npm run native:e2e`. The native host
deliberately exposes no general filesystem or shell command to the webview,
and production builds do not include the test endpoint.

## Android

Install Android SDK Platform/Build Tools, NDK side-by-side, Java 21, and the
four Rust Android targets described by Tauri. Set `ANDROID_HOME`, `NDK_HOME`,
and `JAVA_HOME`, then run:

```sh
npm run android:init
npm run android:dev
npm run android:build -- --debug --apk --target aarch64 --ci
```

The generated Android Studio project lives under `src-tauri/gen/android`.
Release APK/AAB output must be signed before distribution.
