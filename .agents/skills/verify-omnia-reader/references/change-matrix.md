# Change-aware verification matrix

## Always

```sh
git diff --check
```

Format only the files intentionally changed. For repository source, use:

```sh
npx prettier --write <paths>
```

## TypeScript projects

| Area                       | Focused tests                     |
| -------------------------- | --------------------------------- |
| App shell or feature UI    | `npx nx test omnia-reader`        |
| Reader domain              | `npx nx test reader-domain`       |
| Reader core                | `npx nx test reader-core`         |
| EPUB engine                | `npx nx test reader-epub`         |
| PDF engine                 | `npx nx test reader-pdf`          |
| Browser persistence/backup | `npx nx test library-data-access` |
| Platform adapters          | `npx nx test platform`            |
| Sync core                  | `npx nx test sync-core`           |
| Git/LFS client/journal     | `npx nx test sync-git`            |
| MEGA client                | `npx nx test sync-mega`           |
| Gateway                    | `npx nx test sync-gateway`        |

Run `npx nx lint <project>` for each affected TypeScript project. For shared
public APIs, use the Nx graph or affected project list to add consumer tests.

## Web application and browser journeys

Production and bundle gate:

```sh
npx nx build omnia-reader --configuration production
```

Focused Chromium journey:

```sh
npx nx run omnia-reader-e2e:e2e -- --project=chromium
```

Installed PWA/offline journey:

```sh
PWA_E2E=1 npx nx run omnia-reader-e2e:e2e -- --project=chromium src/offline.spec.ts
```

Use Firefox and WebKit for renderer, event, selection, navigation, or
compatibility changes. State the actual project and fixture coverage.

## Gateway and provider boundaries

```sh
npx nx test sync-gateway
npx nx lint sync-gateway
npx nx build sync-gateway --configuration production
```

Gateway unit tests do not replace live GitHub/MEGA, Redis HA, quota,
interruption, or credential-rotation gates.

## Tauri and native work

Shared Rust host:

```sh
cargo check --manifest-path src-tauri/Cargo.toml
```

Desktop and Android packaging require their documented host toolchains:

```sh
npm run native:build
npm run android:build -- --debug --apk --target aarch64 --ci
```

For the MEGA SDK bridge, select the narrow Nx target first:

```sh
npx nx test mega-sdk-bridge --skip-nx-cache
npx nx build mega-sdk-bridge --skip-nx-cache
npx nx run mega-sdk-bridge:container-smoke --skip-nx-cache
```

Host compilation, container smoke, live SDK/provider behavior, Android
emulator, and physical-device behavior are distinct gates.

## Broad gates

Use for cross-cutting, dependency, architecture, or release work:

```sh
npx nx run-many -t test --all --skip-nx-cache
npx nx run-many -t lint --all --skip-nx-cache
npx nx build omnia-reader --configuration production
npx nx build sync-gateway --configuration production
npm audit --omit=dev
```

Do not run every expensive gate by reflex. Do run every gate needed for the
claim being handed off.
