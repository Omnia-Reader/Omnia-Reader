# Omnia Reader Sync Gateway Contract

Status: GitHub/Git LFS and MEGA gateway adapters plus native MEGA bridge source implemented; live-provider validation pending
Version: 1
Last updated: 2026-07-25

## Purpose

The PWA cannot safely retain reusable GitHub or MEGA credentials. Omnia
therefore calls a same-origin gateway with an HttpOnly session cookie. The
gateway authenticates the provider, scopes access to one selected
repository/folder, validates all logical paths, and transfers the files in
`.omnia-reader/v1/`.

Reading and imports are local-first. A missing or unavailable gateway must not
prevent normal reader use.

## Workspace service

`apps/sync-gateway` is the runnable Nx/Fastify implementation of this HTTP
boundary. It provides:

- Provider-scoped HttpOnly, SameSite=Lax session cookies.
- Strict same-origin and `X-Omnia-CSRF` mutation checks.
- Root-confined path, JSON size, publication size, media type, and SHA-256
  validation.
- Shared GitHub/Git LFS and MEGA document/object routes with injectable
  provider adapters.
- Streaming publication bodies through the gateway boundary.
- A state-bound, cache-disabled MEGA credential page that exchanges a
  one-use password for an encrypted reusable SDK session.
- AES-256-GCM sealed process-local sessions for development and an optional
  Redis-backed store for multi-replica deployments.
- Non-sensitive JSON errors and a `/healthz` probe.

Run the boundary alone with `npm run gateway:start`, or run it behind the
Angular development proxy with `npm run start:full`. Both providers fail closed
when their required configuration is absent; the service never accepts partial
credentials or pretends that remote data was synchronized.

### GitHub App configuration

The GitHub adapter uses the GitHub App web authorization flow, rotates the
provider session after its state-bound callback, discovers repositories through
the user's app installations, and exchanges an app JWT for a one-hour
installation token scoped to the selected repository and `contents: write`.
Configure:

```text
OMNIA_GITHUB_APP_ID=<numeric GitHub App ID>
OMNIA_GITHUB_CLIENT_ID=<GitHub App client ID>
OMNIA_GITHUB_CLIENT_SECRET=<GitHub App client secret>
OMNIA_GITHUB_PRIVATE_KEY=<PEM private key; literal \n is accepted>
OMNIA_GITHUB_CALLBACK_URL=https://reader.example/api/sync/github/auth/callback
OMNIA_SYNC_SESSION_KEY=<base64 encoding of exactly 32 random bytes>
```

Generate a session key with `openssl rand -base64 32`. The application stores
user, refresh, and installation tokens only inside AES-256-GCM encrypted,
12-hour server sessions. Without Redis the checked-in store is process-local
and deliberately ephemeral.

### Shared session store and key rotation

Use Redis when more than one gateway replica serves the same origin:

```text
OMNIA_SYNC_REDIS_URL=rediss://user:password@redis.example:6379/0
OMNIA_SYNC_REDIS_PREFIX=omnia:sync:v1
OMNIA_SYNC_SESSION_TTL_MS=43200000
OMNIA_SYNC_SESSION_PREVIOUS_KEYS=<previous base64 key>[,<older base64 key>]
```

Non-loopback Redis must use `rediss://`; unencrypted `redis://` is accepted
only on loopback for development and tests. The gateway keeps one Redis
connection, gives GitHub and MEGA separate namespaces, stores only opaque
AES-256-GCM envelopes, and hashes each random browser session ID before using
it as a Redis key. Redis owns expiry. Session-ID rotation uses one atomic Lua
operation that consumes the old record exactly once, so concurrent callback
replays cannot mint another replacement session.

`OMNIA_SYNC_SESSION_KEY` is always the current encryption key. During a rolling
rotation, put up to three older keys in
`OMNIA_SYNC_SESSION_PREVIOUS_KEYS`, newest first. Reads made with an older key
are re-encrypted with the current key without extending their remaining Redis
TTL. After the maximum session TTL has elapsed across all replicas, remove the
retired keys. Do not reuse the bridge token, Redis password, GitHub secret, or
MEGA credentials as a session key.

The GitHub App must be installed on the repositories a user may select. It
needs repository Contents read/write permission for synchronization and
Administration read/write permission if users may create a private sync
repository from Omnia Reader. The adapter:

1. Validates OAuth `state`, exchanges the callback code, and rotates the
   HttpOnly session.
2. Lists only repositories visible through the user's GitHub App
   installations and records the owning installation ID server-side.
3. Uses GitHub blob SHAs for optimistic JSON document updates.
4. Requests a basic Git LFS batch action for immutable EPUB/PDF bytes, streams
   and verifies the exact SHA-256 and length, invokes the LFS verification
   action when supplied, and only then commits `.gitattributes` and the
   canonical pointer.
5. Can create an initialized private repository through `POST /user/repos`.
   When the App installation covers all repositories, the new destination is
   selected immediately. For installations limited to selected repositories,
   the user is sent to GitHub installation settings to grant access before
   refreshing the list.

Live credentialed GitHub integration tests, Redis HA/backup monitoring, and
provider quota/rate-limit deployment monitoring remain release gates.

### MEGA SDK bridge configuration

MEGA does not publish a supported Node.js binding. The live adapter therefore
uses a private service built with the official C++ SDK or its Java bindings:

```text
OMNIA_MEGA_SDK_BRIDGE_URL=https://mega-sdk.internal
OMNIA_MEGA_SDK_BRIDGE_TOKEN=<independent random service credential>
OMNIA_MEGA_LOGIN_URL=https://reader.example/api/sync/mega/auth/login
OMNIA_SYNC_SESSION_KEY=<base64 encoding of exactly 32 random bytes>
```

The gateway implements the state-bound login page, encrypted SDK-session
storage, per-request folder authorization, duplicate reconciliation,
optimistic whole-file document replacement, immutable object publication, and
stream integrity checks. The repository also contains the pinned C++ bridge
service with SDK session restoration, writable-root and ancestry checks,
bounded transfers, and verified temporary files. Its SDK-linked Release build
and non-root container image build pass in an isolated Ubuntu 24.04
environment, including native CTest and a loopback authentication smoke test.
Image scanning/signing/publishing and live disposable-account conformance tests
remain release gates; its versioned private protocol, build prerequisites,
container deployment shape, and SDK method mapping are specified in [the MEGA
SDK bridge contract](mega-sdk-bridge.md).

## Security requirements

- Use `Secure`, `HttpOnly`, `SameSite=Lax` session cookies with short idle and
  absolute expirations.
- Rotate the session identifier after authentication and disconnect.
- Require `X-Omnia-CSRF: 1` plus strict same-origin `Origin`/`Sec-Fetch-Site`
  validation for every app mutation. The credential form uses strict
  same-origin checks plus its one-time state value because an HTML form cannot
  set the custom header.
- Accept only paths under `.omnia-reader/v1/`; normalize and reject absolute
  paths, `..`, encoded separators, NULs, and provider-specific aliases.
- Apply JSON body, publication size, request duration, and concurrency limits.
- Keep GitHub installation tokens, MEGA passwords, keys, and reusable SDK
  sessions in an encrypted server-side secret store. Never return them to the
  app or include them in logs.
- Redact provider response headers and URLs that contain temporary transfer
  credentials.
- Verify every publication's declared SHA-256 and byte length before confirming
  upload or download.
- Authorize the selected repository/folder on every request; never trust a
  browser-supplied owner, repository name, or MEGA node handle by itself.

All JSON errors use:

```json
{
  "message": "Actionable, non-sensitive explanation"
}
```

## Shared document and object shapes

```typescript
interface RemoteDocument {
  path: string;
  content: string;
  revision: string;
}

interface RemoteObject {
  path: string;
  revision: string;
  size: number;
  sha256: string;
}
```

`revision` is an opaque provider revision. The app sends it as
`expectedRevision` when replacing a document. A mismatch returns `409`.

Publication object uploads are binary request bodies with:

```text
Content-Type: application/epub+zip | application/pdf
X-Omnia-SHA256: <64 lowercase hexadecimal characters>
X-Omnia-Size: <decimal byte length>
X-Omnia-CSRF: 1
```

The gateway should support cancellation and resumable provider transfers.
Never publish `book.json` until its publication object is durably present and
verified.

The document/object endpoints expose one provider-neutral logical tree:

```text
.omnia-reader/v1/
├── manifest.json
├── books/<bookId>/book.json
├── books/<bookId>/publication.epub|publication.pdf
├── progress/<bookId>/<deviceId>.json
├── bookmarks/<bookId>/<bookmarkId>.json
└── annotations/<bookId>/<annotationId>.json
```

The client initializes `manifest.json` once and validates its application,
schema version, SHA-256 publication identity, and required feature set before
accessing any child document. Providers preserve it as an ordinary optimistic
JSON write; they do not synthesize or silently upgrade an unsupported schema.

Publication objects are immutable. Progress, bookmark, and annotation paths
contain small versioned JSON documents and use `expectedRevision` for
optimistic updates. Bookmark and annotation deletions remain full tombstone
documents rather than provider file deletions, so a stale client cannot
restore obsolete user data.

## GitHub and Git LFS endpoints

Base path: `/api/sync/github`

| Method   | Path                                  | Result                                                                       |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/session`                            | Authenticated user and selected repository, or `{ "authenticated": false }`  |
| `GET`    | `/auth/start?returnTo=/settings/sync` | Starts GitHub App authorization                                              |
| `DELETE` | `/session`                            | Revokes/deletes the gateway session                                          |
| `GET`    | `/repositories`                       | `{ "repositories": GitHubRepository[] }`                                     |
| `PUT`    | `/repository`                         | Selects `{ "repositoryId": number }`                                         |
| `POST`   | `/repository`                         | Creates private `{ "name": string }`, then selects it when App access exists |
| `GET`    | `/files?prefix=...`                   | `{ "files": RemoteDocument[] }`                                              |
| `GET`    | `/file?path=...`                      | A document; `404` if absent                                                  |
| `PUT`    | `/file`                               | Creates/replaces a document; `409` on revision mismatch                      |
| `GET`    | `/lfs/object/metadata?path=...`       | Object metadata; `404` if absent                                             |
| `GET`    | `/lfs/object?path=...`                | Verified publication bytes                                                   |
| `PUT`    | `/lfs/object?path=...`                | Uploads/verifies a Git LFS object                                            |

The gateway owns `.gitattributes` with:

```gitattributes
.omnia-reader/v1/books/**/*.epub filter=lfs diff=lfs merge=lfs -text
.omnia-reader/v1/books/**/*.pdf filter=lfs diff=lfs merge=lfs -text
```

For an upload it must:

1. Stream the bytes while calculating SHA-256 and enforcing the declared size.
2. Use the Git LFS batch API (or a pinned `git-lfs` reference client) to
   discover/upload/verify the object.
3. Generate the canonical LFS v1 pointer.
4. Commit the pointer and any book manifest only after object verification.
5. Return an error when LFS is disabled or storage/bandwidth quota is
   exhausted; never fall back to a large ordinary Git blob.

## MEGA endpoints

Base path: `/api/sync/mega`

| Method   | Path                                  | Result                                                             |
| -------- | ------------------------------------- | ------------------------------------------------------------------ |
| `GET`    | `/session`                            | Account label and selected folder, or `{ "authenticated": false }` |
| `GET`    | `/auth/start?returnTo=/settings/sync` | Opens a gateway-owned MEGA login flow                              |
| `DELETE` | `/session`                            | Logs out and deletes the reusable SDK session                      |
| `GET`    | `/folders`                            | `{ "folders": MegaFolder[] }`                                      |
| `PUT`    | `/folder`                             | Selects `{ "handle": string }` after server-side authorization     |
| `GET`    | `/documents?prefix=...`               | `{ "documents": RemoteDocument[] }`                                |
| `GET`    | `/document?path=...`                  | A small JSON document; `404` if absent                             |
| `PUT`    | `/document`                           | Creates/replaces a document; `409` on revision mismatch            |
| `GET`    | `/object/metadata?path=...`           | Publication metadata; `404` if absent                              |
| `GET`    | `/object?path=...`                    | Verified publication bytes                                         |
| `PUT`    | `/object?path=...`                    | Uploads/verifies an encrypted MEGA file                            |

Use the official MEGA SDK in the gateway. MEGA permits duplicate names and
does not offer cross-client sync locking, so the gateway must resolve nodes by
the selected root handle plus normalized path and return `409` when multiple
live candidates cannot be reconciled safely. Exact-edition publication objects
are immutable, which avoids whole-file rewrites after their first upload.
Progress, bookmark/tombstone, and annotation/tombstone JSON documents use the
same small-document endpoints and conflict behavior.

The gateway-owned login page accepts the account password only in a same-origin
POST body, never in a URL. It is `no-store`, cannot be framed, validates a
random authorization state, rotates the HttpOnly session on success, and keeps
only `dumpSession` output in the encrypted server-side record.

## HTTP behavior

- `200`: successful read/update.
- `204`: successful disconnect where no body is needed.
- `400`: malformed schema, path, digest, size, or selection.
- `401`: missing/expired provider session.
- `403`: provider permission is insufficient.
- `404`: gateway/provider feature not configured or selected item absent.
- `409`: optimistic revision conflict or ambiguous duplicate provider node.
- `413`: publication exceeds the deployment limit.
- `429`: local/provider rate or transfer quota reached.
- `507`: provider storage quota exhausted.

## References

- [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents)
- [Git LFS pointer specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
- [Git LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
- [Official MEGA SDK](https://github.com/meganz/sdk)
- [MEGA SDK bridge contract](mega-sdk-bridge.md)
