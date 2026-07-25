# Omnia Reader

Omnia Reader is an offline-first EPUB and PDF reader built from one Angular
application for the web/PWA, Tauri desktop, and Android.

The current implementation includes an OPFS-first local library with a
byte-backed IndexedDB fallback, incremental worker hashing, durable EPUB/PDF covers,
the maintained `@likecoin/epub-ts` EPUB.js-compatible runtime and PDF.js reader
engines, keyboard and button page navigation, exact resume locations, format
preferences, fixed-layout and RTL EPUB support, safe internal links,
consent-gated HTTP(S) links, durable bookmarks, highlights and notes, full-text
search, versioned full-library backup archives, a local-first sync journal,
PWA offline support, and narrow native import and external-link bridges.
Backups stream directly to File System Access and native save destinations
where supported, with cancellation and a compatible browser download fallback.
Reader panels, desktop Escape, and Android hardware back share deterministic
last-opened-first navigation behavior.
The synchronization core journals books, progress, bookmark tombstones, and
annotation tombstones, verifies immutable publication objects, automatically
retries after local and lifecycle changes, and has client contracts for
Git/Git LFS and MEGA gateways.
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

The app remains fully usable without a sync server. To run the Angular app and
the local gateway boundary together:

```sh
npm run start:full
```

The gateway listens on `127.0.0.1:3333`; the Angular development server proxies
`/api/sync` to it. The GitHub App/Git LFS and MEGA adapters activate when their
documented environment variables are present and otherwise fail closed. MEGA
uses a private service built with the official SDK; its deployment boundary is
specified in [the MEGA SDK bridge contract](docs/mega-sdk-bridge.md).
Git/LFS and MEGA buttons expect the same-origin endpoints documented in
[the sync gateway contract](docs/sync-gateway-api.md). Provider credentials
stay in that gateway; they are never stored by the Angular app. Development
uses an encrypted in-memory session store. Multi-replica deployments can use
the documented Redis store with atomic session rotation, TTL expiry, and
rolling AES key rotation.

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
npx nx run-many -t test --all --skip-nx-cache
npx nx run-many -t lint --all --skip-nx-cache
npx nx build omnia-reader --configuration production
npx nx run omnia-reader-e2e:e2e -- --project=chromium
npm run performance:e2e
PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts
npm run release:test
npm run release:verify
```

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

Deploy the built PWA and `/api/sync` gateway behind the same HTTPS origin. The
required browser security policy is exported from
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
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

```sh
npm run native:dev
npm run native:build
```

The similarly named runtime packages are not sufficient for compiling: the
`-dev` packages provide the GLib, GTK, JavaScriptCoreGTK, and WebKitGTK
`pkg-config` metadata consumed by Cargo build scripts. The native host
deliberately exposes no general filesystem or shell command to the webview.

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
