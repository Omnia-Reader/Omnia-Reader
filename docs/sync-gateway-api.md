# Omnia Reader Sync Gateway Contract

Status: GitHub/Git LFS and MEGA gateway adapters plus reference same-origin container deployment implemented; live-provider validation pending
Version: 1
Last updated: 2026-08-02

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

### Production container deployment

`deployment/compose.yaml` builds digest-pinned, non-root web and gateway images.
Nginx is the only published service and proxies `/api/sync` to the internal
gateway, preserving the browser's same-origin cookie and CSRF boundary. Request
and response buffering are disabled so large EPUB/PDF bodies remain streamed.
Both containers use read-only root filesystems, drop Linux capabilities, expose
health checks, and stop gracefully.

Copy `deployment/gateway.env.example` to the ignored
`deployment/gateway.env`, replace the placeholders for the providers being
enabled, and validate the exact production route:

```sh
npm run container:smoke
docker compose --file deployment/compose.yaml up --detach --build
```

The smoke gate builds both images, waits for both health checks, verifies the
application security headers, probes the gateway through the Nginx proxy, and
proves that an unconfigured GitHub provider reports a safe unauthenticated
session. Production still requires an HTTPS edge, a shared Redis session store
for restart and replica continuity, credentialed provider conformance tests,
and deployment-specific image scanning, signing, and publication.

### GitHub App configuration

The GitHub adapter uses Octokit.js for GitHub App authentication, OAuth protocol
requests, REST requests, pagination, retry, and provider-aware throttling. It
uses the GitHub App web authorization flow with an S256 PKCE challenge, stores
the one-time verifier only in its encrypted provider session, rotates that
session after its state-bound callback, discovers repositories through the
user's app installations, and exchanges an Octokit-generated App JWT for a
one-hour installation token scoped to the selected repository and
`contents: write`. Configure:

```text
OMNIA_GITHUB_APP_ID=<numeric GitHub App ID>
OMNIA_GITHUB_CLIENT_ID=<GitHub App client ID>
OMNIA_GITHUB_CLIENT_SECRET=<GitHub App client secret>
OMNIA_GITHUB_PRIVATE_KEY=<PEM private key; literal \n is accepted>
OMNIA_GITHUB_CALLBACK_URL=https://reader.example/api/sync/github/auth/callback
OMNIA_GITHUB_INSTALLATION_URL=https://github.com/apps/<app-slug>/installations/new
OMNIA_GITHUB_REQUEST_TIMEOUT_MS=60000
OMNIA_GITHUB_TRANSFER_TIMEOUT_MS=21600000
OMNIA_GITHUB_WEBHOOK_SECRET=<independent random secret; production webhook only>
OMNIA_SYNC_SESSION_KEY=<base64 encoding of exactly 32 random bytes>
```

Generate a session key with `openssl rand -base64 32`. The application stores
user, refresh, and installation tokens only inside AES-256-GCM encrypted,
12-hour server sessions. Without a configured persistent store, the checked-in
store is process-local and deliberately ephemeral.

`OMNIA_GITHUB_REQUEST_TIMEOUT_MS` is optional and bounds OAuth, GitHub API,
Git LFS batch, and LFS verification requests; it defaults to 60 seconds and may
be configured from 1 second through 5 minutes.
`OMNIA_GITHUB_TRANSFER_TIMEOUT_MS` independently bounds whole LFS object
uploads and downloads; it defaults to 6 hours and may be configured from
1 minute through 24 hours so operators can preserve large-book support on slow
links. A deadline returns an application-owned `504`, while transport failures
return `502`; provider or network details are not exposed.

Expiring GitHub user tokens are refreshed during the final minute of their
lifetime. Concurrent requests in one gateway process share the same rotation,
and a successful refresh is accepted only when GitHub returns a complete new
access-token and refresh-token pair. A definitive `bad_refresh_token` response
consumes the encrypted provider session once and requires the user to connect
again; malformed or temporarily unavailable provider responses retain the
session for a later bounded retry.

Disconnect removes local session authority before using GitHub's single-token
revocation endpoint for that session's user access token. It does not revoke
the user's application grant or other devices' tokens. A refresh that finishes
after disconnect has already consumed the session also revokes its newly
rotated access token instead of leaving an orphaned credential. Provider
revocation is bounded and best-effort: an unavailable GitHub endpoint is
reported only in safe gateway logs, while the local session remains deleted.

Production deployments should activate the GitHub App webhook at
`https://reader.example/api/sync/github/webhook` and configure the same
independent, random secret in `OMNIA_GITHUB_WEBHOOK_SECRET`. The gateway
validates the exact raw request body with HMAC-SHA256 before parsing it,
accepts only the `github_app_authorization` `revoked` payload for a valid
sender, and deduplicates GitHub's `X-GitHub-Delivery` identifier. A valid
revocation advances that user's authorization generation, invalidating every
encrypted session on its next access without scanning or exposing session
records. Reauthorization records the new generation and remains valid.

A user-scoped GitHub API `401` also consumes the matching encrypted provider
session and requires reconnection. Before doing so, the adapter re-reads the
session and retries once when another request has already rotated the user
token. If the selected repository is no longer accessible to the App, the
adapter clears only that matching stale destination and returns `403`, allowing
a concurrent repository reselection to win. A GitHub App JWT authentication
failure instead returns an application-owned `502` and preserves the selected
destination for a later retry.

GitHub primary rate-limit `403` responses with
`X-RateLimit-Remaining: 0` and secondary `429` responses are distinct from
repository permission failures. The gateway converts both to an application-
owned `429`, derives a bounded delay from `Retry-After` or
`X-RateLimit-Reset`, and returns only that delay in a standard `Retry-After`
header. Provider-controlled messages and the remaining-account quota are not
forwarded. The Angular client persists the retry deadline and delays queued
automatic work across restarts; manual retry and all local reading remain
available.

Octokit retries a safely replayable transient REST request once and follows one
short primary or secondary rate-limit delay when it fits the configured gateway
request deadline. OAuth code exchange, refresh-token rotation, repository
creation, installation-token creation, token revocation, and repository content
mutations disable ambiguous server-error replay. If throttling cannot complete
inside the bounded in-request policy, the gateway preserves the application-
owned `429 Retry-After` response above so the durable synchronization scheduler
remains authoritative across restarts.

For local development:

1. In GitHub **Settings → Developer settings → GitHub Apps**, create an App
   with homepage URL `http://localhost:4300` and callback URL
   `http://localhost:4300/api/sync/github/auth/callback`. Set its setup URL to
   `http://localhost:4300/settings/sync` and enable **Redirect on update** so
   installation changes return to the same Settings flow.
2. Webhooks may remain inactive for loopback-only development because GitHub
   cannot reach the gateway. Under repository permissions grant
   **Contents: Read and write**. Grant
   **Administration: Read and write** only when Omnia Reader should create a
   private repository on the user's behalf.
3. Leave **Request user authorization (OAuth) during installation** disabled.
   Omnia Reader starts its state-bound user authorization separately after
   installation; combining the callbacks would bypass the gateway-generated
   authorization state.
4. Generate a private key and record the App ID, client ID, and a new client
   secret. Prefer expiring user authorization tokens; the gateway rotates their
   refresh tokens without exposing either token to the browser.
5. Copy `apps/sync-gateway/.env.local.example` to
   `apps/sync-gateway/.env.local`, replace every placeholder, and generate the
   session key with `openssl rand -base64 32`. Set
   `OMNIA_GITHUB_INSTALLATION_URL` to the App's public installation URL:
   `https://github.com/apps/<app-slug>/installations/new`.
6. Run `npm run start:full`, open `/settings/sync`, select **Git + LFS**, and
   use **Install GitHub App** before **Connect GitHub**. An all-repositories
   installation can immediately see a repository created by Omnia Reader. A
   selected-repositories installation requires granting the newly created
   repository afterward. `npm start` intentionally runs the local-only reader
   without the sync gateway.

The session endpoint reports `{ "configured": false, "authenticated": false }`
when no GitHub App credentials are present. The Settings page keeps the user in
the app and explains the missing setup instead of navigating to a failed
authorization response.

### Lightweight GitHub synchronization revision

An authenticated client with a selected repository can call:

```text
GET /api/sync/github/revision
```

The no-store response contains `{ "revision": "<opaque value>" }`. The gateway
derives the bounded value from the selected repository identity, default branch,
and current Git tree SHA; an empty selected repository has its own scoped empty
value. The route performs no synchronized-document blob reads and no Git LFS
operation. Authentication, repository access, rate limits, timeouts, and safe
error mapping are identical to the other GitHub read routes.

The browser keeps a bounded, schema-versioned, device-local checkpoint. Before a
GitHub sync it checks the durable operation journal and this revision. If the
journal is empty and the revision matches a trusted checkpoint, the shared manual
and automatic sync worker returns a zero-change success without running document,
merge, or publication workers.

That result carries an internal `unchanged` marker. Status consumers use it to
retain already-current remote-backup presentation instead of immediately
re-listing GitHub documents after the fast check. Older stored status history
without the optional marker remains valid.

A first, changed, unsupported, invalid, or storage-blocked state always falls
back to the complete synchronization path. A complete no-op pass establishes a
new checkpoint only when the remote revision is identical before and after the
pass, no journal work remains, and the result reports no push, conflict, or
rejected record. A successful mutating or unstable pass immediately runs one
bounded complete verification pass; a stable mutation-free verification stores
the checkpoint during the same user-visible synchronization. Continued
instability stores nothing, preventing a concurrent remote change from being
recorded as already applied without forcing the next user action through another
full pass.

During a complete fallback, progress, bookmark, and annotation synchronization
reuse the documents returned by their prefix list as the optimistic write
snapshot. Identical local records therefore cause no individual `/file` request;
only a `409` conflict retries the affected path. Those three independent state
workers start concurrently after schema, publication, and logical-book ordering
requirements complete. Concurrency is bounded to those three workers, while
conflict retries and mutation ordering remain unchanged. Within each GitHub
document listing, matching blobs are fetched with concurrency bounded to eight
and returned in deterministic tree order instead of being read sequentially.
Checkpoint I/O is best effort and never affects local reading or authoritative
sync data.

MEGA does not implement this optional revision capability and retains its existing
complete synchronization behavior.

### Low-latency local-first synchronization

Reading-state writes use a one-second trailing quiet interval, so rapid progress,
bookmark, and annotation changes coalesce into one attempt. Book changes,
backgrounding, reconnect, and destination changes remain immediate. GitHub
`Retry-After` always overrides the shorter schedule.

While the application is visible, online, and GitHub-selected, a ten-second
revision check discovers changes made by another device. The timer stops while
hidden, offline, on another provider, or after scheduler teardown. An unchanged
checkpoint costs only the revision request and performs no document or Git LFS
work. This polling path requires no public endpoint, webhook secret, or GitHub
App event subscription and therefore works in the supported local, desktop, and
mobile topology.

### Shared session store and key rotation

For localhost or a single gateway process, persist the encrypted session
envelopes across restarts in a gateway-owned directory:

```text
OMNIA_SYNC_SESSION_DIRECTORY=apps/sync-gateway/.session-data
```

The directory contains separate GitHub and MEGA files, uses hashed browser
session identifiers, and never stores provider tokens as plaintext. It is not
a shared or distributed store. Do not mount it into multiple gateway replicas,
and do not use it with the GitHub webhook because webhook revocation state
must be shared atomically.

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

The same Redis connection stores hashed GitHub user and delivery identifiers
for webhook-driven authorization generations. Applying a delivery and
advancing its generation is one atomic Lua operation, so retries and concurrent
replicas cannot apply the same GitHub delivery twice. User generations remain
monotonic so reauthorization and later revocations cannot reuse an old
generation; delivery deduplication records expire after their replay window.

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
repository from Omnia Reader. If GitHub denies repository listing, selection,
or creation with `403`, the Settings page links to the validated App
installation URL so the user can approve the updated permissions and refresh
the repository list. Provider-controlled error details are not rendered, and
the local library remains unchanged. The adapter:

1. Validates OAuth `state`, exchanges the callback code, and rotates the
   HttpOnly session.
2. Lists only repositories visible through the user's GitHub App
   installations and records the owning installation ID server-side.
3. Uses GitHub blob SHAs for optimistic JSON document updates.
4. Requests a basic Git LFS batch action outside Octokit's generated REST
   surface for immutable EPUB/PDF bytes, streams
   and verifies the exact SHA-256 and length, invokes the LFS verification
   action when supplied, and only then commits `.gitattributes` and the
   canonical pointer. Transfer actions must use credential-free HTTPS URLs,
   omit fragments, and provide only bounded end-to-end headers; explicit
   loopback/private literal-IP targets and hop-by-hop or request-framing
   headers are rejected before any object request.
5. Can create an initialized private repository through `POST /user/repos`.
   When the App installation covers all repositories, the new destination is
   selected immediately. For installations limited to selected repositories,
   the user is sent through the configured App installation URL to grant access
   before refreshing the list.

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
├── README.md
├── manifest.json
├── library/<readable-name>--<short-id>/book.json
├── library/<readable-name>--<short-id>/<original-name>.epub|pdf
├── .deletions/books/<sha256>.json
├── progress/<bookId>/<deviceId>.json
├── bookmarks/<bookId>/<bookmarkId>.json
└── annotations/<bookId>/<annotationId>.json
```

The readable library directory and generated `README.md` are for human
browsing. The short suffix prevents ordinary name collisions; the manifest and
object verification still use the complete SHA-256 edition identity. Removing
a book commits its deletion marker before deleting the named manifest and
publication. Synchronization removes the obsolete hash-addressed
`.omnia-reader/v1/books/` layout.

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

| Method   | Path                                              | Result                                                                       |
| -------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/session`                                        | Provider configuration, authenticated user, and selected repository          |
| `GET`    | `/auth/start?returnTo=/settings/sync`             | Starts GitHub App authorization                                              |
| `GET`    | `/auth/callback`                                  | Validates GitHub state, rotates the session, and returns to Sync Settings    |
| `POST`   | `/webhook`                                        | Validates a signed revocation and invalidates that user's sessions           |
| `DELETE` | `/session`                                        | Deletes the local session and revokes its GitHub user token                  |
| `GET`    | `/repositories`                                   | `{ "repositories": GitHubRepository[] }`                                     |
| `PUT`    | `/repository`                                     | Selects `{ "repositoryId": number }`                                         |
| `POST`   | `/repository`                                     | Creates private `{ "name": string }`, then selects it when App access exists |
| `GET`    | `/files?prefix=...`                               | `{ "files": RemoteDocument[] }`                                              |
| `GET`    | `/file?path=...`                                  | A document; `404` if absent                                                  |
| `GET`    | `/file?path=...&optional=true`                    | A document; cache-disabled `204` if absent                                   |
| `PUT`    | `/file`                                           | Creates/replaces a document; `409` on revision mismatch                      |
| `DELETE` | `/file?path=...&expectedRevision=...&message=...` | Deletes a document; `409` on revision mismatch                               |
| `GET`    | `/lfs/object/metadata?path=...`                   | Object metadata; `404` if absent                                             |
| `GET`    | `/lfs/object/metadata?path=...&optional=true`     | Object metadata; cache-disabled `204` if absent                              |
| `GET`    | `/lfs/object?path=...`                            | Verified publication bytes                                                   |
| `PUT`    | `/lfs/object?path=...`                            | Uploads/verifies a Git LFS object                                            |

OAuth callback failures never render provider responses directly. The gateway
validates `state`, discards provider-controlled error descriptions, clears the
pending browser session, and redirects to `/settings/sync` with one bounded
outcome: `github-denied`, `github-invalid`, or `github-failed`. The Angular
route presents an actionable message and immediately removes that status from
the URL with history replacement. Successful exchanges additionally require
the original server-side PKCE verifier; the browser receives only the derived
S256 challenge and no provider token or verifier.

The gateway owns `.gitattributes` with:

```gitattributes
.omnia-reader/v1/library/**/*.epub filter=lfs diff=lfs merge=lfs -text
.omnia-reader/v1/library/**/*.pdf filter=lfs diff=lfs merge=lfs -text
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

| Method   | Path                                                  | Result                                                             |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `GET`    | `/session`                                            | Account label and selected folder, or `{ "authenticated": false }` |
| `GET`    | `/auth/start?returnTo=/settings/sync`                 | Opens a gateway-owned MEGA login flow                              |
| `DELETE` | `/session`                                            | Logs out and deletes the reusable SDK session                      |
| `GET`    | `/folders`                                            | `{ "folders": MegaFolder[] }`                                      |
| `PUT`    | `/folder`                                             | Selects `{ "handle": string }` after server-side authorization     |
| `GET`    | `/documents?prefix=...`                               | `{ "documents": RemoteDocument[] }`                                |
| `GET`    | `/document?path=...`                                  | A small JSON document; `404` if absent                             |
| `GET`    | `/document?path=...&optional=true`                    | A document; cache-disabled `204` if absent                         |
| `PUT`    | `/document`                                           | Creates/replaces a document; `409` on revision mismatch            |
| `DELETE` | `/document?path=...&expectedRevision=...&message=...` | Deletes a document; `409` on revision mismatch                     |
| `GET`    | `/object/metadata?path=...`                           | Publication metadata; `404` if absent                              |
| `GET`    | `/object/metadata?path=...&optional=true`             | Publication metadata; cache-disabled `204` if absent               |
| `GET`    | `/object?path=...`                                    | Verified publication bytes                                         |
| `PUT`    | `/object?path=...`                                    | Uploads/verifies an encrypted MEGA file                            |

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
- `429`: local/provider rate or transfer quota reached. When the provider
  supplies a usable deadline, the response includes a bounded integer
  `Retry-After` value between one second and 24 hours.
- `502`: provider or GitHub App authentication failed upstream while the local
  session remains retryable.
- `507`: provider storage quota exhausted.

## References

- [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
- [GitHub App setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents)
- [Git LFS pointer specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
- [Git LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
- [Official MEGA SDK](https://github.com/meganz/sdk)
- [MEGA SDK bridge contract](mega-sdk-bridge.md)
