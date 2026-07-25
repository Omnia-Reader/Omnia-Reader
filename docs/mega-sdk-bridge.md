# MEGA SDK Bridge Contract

Status: gateway adapter and pinned native service implemented and SDK-linked build verified; live-provider validation pending
Protocol version: 1
Last updated: 2026-07-25

## Purpose

MEGA does not publish a supported Node.js binding. Omnia Reader therefore keeps
the Fastify gateway provider-neutral and connects it to a private service built
with the [official MEGA SDK](https://github.com/meganz/sdk). The SDK supports a
headless C++ client and Java bindings; its public API provides account login,
`dumpSession`/`fastLogin`, `fetchNodes`, stable node handles, node enumeration,
uploads, downloads, moves, renames, removal, and custom node attributes.

The bridge is an internal deployment component, not a second public Omnia API.
Only `apps/sync-gateway` may call it. Browser clients continue to use
`/api/sync/mega`; they never receive a MEGA password, master key, reusable SDK
session, or bridge credential.

## Trust boundary

- Put the bridge on loopback or a private network. Use HTTPS outside loopback.
- Authenticate every call with `Authorization: Bearer <bridge token>`.
- Pass the UTF-8 SDK session as base64url in `X-Omnia-Mega-Session`.
- Redact both headers, request bodies for `/v1/sessions`, temporary file paths,
  and provider transfer URLs from logs and traces.
- Configure the MEGA application key only in the bridge.
- Run as an unprivileged user with a private, size-bounded temporary directory.
- Do not persist account passwords. After successful `login`, call
  `fetchNodes`, return `dumpSession`, and release the password immediately.
- Either restore a `MegaApi` instance with `fastLogin` and `fetchNodes` for
  each operation or pool it by a one-way digest of the SDK session. Never use
  an account email as the pool key.

## Gateway configuration

```text
OMNIA_MEGA_SDK_BRIDGE_URL=https://mega-sdk.internal
OMNIA_MEGA_SDK_BRIDGE_TOKEN=<independent random service credential>
OMNIA_MEGA_LOGIN_URL=https://reader.example/api/sync/mega/auth/login
OMNIA_SYNC_SESSION_KEY=<base64 encoding of exactly 32 random bytes>
```

The adapter is fail-closed: none of these variables enables partial behavior.
Loopback HTTP is accepted for local development; every non-loopback bridge and
login URL must use HTTPS.

## Native service build and configuration

`tools/mega-sdk-bridge` is the protocol-v1 C++ service. Its CMake build fetches
the official MEGA SDK at commit
`51954a44aa3cfd8f0e2e5a82c23083d8cc250cc5` (SDK 10.17.0), cpp-httplib at
`d66d9a95997d51a8ba9822a611d1267757741535`, and nlohmann/json at
`55f93686c01528224f448c19128836e7df245f72`. A compile-time version assertion
forces an explicit review before a MEGA SDK upgrade.

On Debian/Ubuntu, install a C++20 toolchain, CMake, Git, pkg-config, and the
development packages for Crypto++, libsodium, SQLite, libcurl, ICU, and
OpenSSL. Then build:

```sh
npx nx build mega-sdk-bridge --skip-nx-cache
```

For a production-shaped build that does not require those development packages
on the host, build the multi-stage container image:

```sh
npx nx run mega-sdk-bridge:container --skip-nx-cache
npx nx run mega-sdk-bridge:container-smoke --skip-nx-cache
```

This produces `omnia-reader/mega-sdk-bridge:local` from a digest-pinned Ubuntu
24.04 base. The build stage compiles the pinned MEGA SDK and bridge in Release
mode and must pass the native core test before the runtime stage is created.
The runtime image contains only the bridge and required shared libraries, runs
as UID/GID `10001:10001`, and owns a mode-`0700` temporary directory at
`/var/lib/omnia-mega-bridge`. The smoke target seeds recognized crash remnants,
checks startup cleanup and authentication, sends `SIGTERM`, and requires a
clean exit within five seconds.

The service reads:

```text
OMNIA_MEGA_APP_KEY=<application key registered with MEGA>
OMNIA_MEGA_BRIDGE_TOKEN=<same independent service credential as the gateway>
OMNIA_MEGA_BRIDGE_HOST=127.0.0.1
OMNIA_MEGA_BRIDGE_PORT=47831
OMNIA_MEGA_BRIDGE_TMP=/private/omnia-mega-sdk-bridge
OMNIA_MEGA_MAX_PUBLICATION_BYTES=2147483648
OMNIA_MEGA_MAX_CONCURRENT_REQUESTS=4
OMNIA_MEGA_MAX_QUEUED_REQUESTS=32
```

The service intentionally binds only to a loopback host. The temporary
directory must be private to one bridge process. The service
uses mode-`0600` upload files and per-download directories, bounds its worker
and request queues, applies a two-hour SDK transfer timeout, and removes
request files on normal completion and handled failures. A separate gateway
host must reach it through an authenticated TLS proxy or sidecar that
terminates on the bridge host's loopback interface.

For containers, put the gateway and bridge in the same network namespace, such
as containers in one Kubernetes Pod, and point the gateway at
`http://127.0.0.1:47831`. A normal Docker bridge network gives each container a
different loopback interface, and publishing port `47831` does not override the
service's loopback-only policy. For local diagnostics, host networking is
acceptable; do not expose the process on a public interface.

## Wire API

All JSON uses UTF-8 and `application/json`. Successful deletion may return
`204`. Binary uploads and downloads use `application/octet-stream`.

| Method   | Path                                         | Official SDK operation                                                   |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `POST`   | `/v1/sessions`                               | `login`, optional MFA login, `fetchNodes`, `dumpSession`                 |
| `DELETE` | `/v1/session`                                | `fastLogin`, `fetchNodes`, provider logout                               |
| `GET`    | `/v1/folders`                                | Enumerate authorized folder nodes and access levels                      |
| `GET`    | `/v1/files?rootHandle=...&prefix=...`        | Enumerate every matching file node, including duplicate names            |
| `GET`    | `/v1/files/{handle}?rootHandle=...`          | Verify root ancestry, then `getNodeByHandle` plus `startDownload`        |
| `POST`   | `/v1/files?rootHandle=...&path=...`          | Verify request bytes, `startUpload`, then set the `osh` custom attribute |
| `PUT`    | `/v1/files/{handle}?rootHandle=...&path=...` | Resolve the confined parent, then `moveNode`/`renameNode`                |
| `DELETE` | `/v1/files/{handle}?rootHandle=...`          | Verify root ancestry and write access, then `remove`                     |

### Create a session

Request:

```json
{
  "email": "reader@example.com",
  "password": "one-use plaintext over the private TLS hop",
  "multiFactorCode": "123456"
}
```

`multiFactorCode` is optional. Response:

```json
{
  "account": "reader@example.com",
  "session": "value returned by MegaApi::dumpSession"
}
```

The same-origin gateway login page is cache-disabled, frame-blocked, protected
by a random state value and strict Origin/Sec-Fetch-Site checks, and submits the
password in the request body rather than the URL. The gateway stores only the
returned SDK session in its AES-256-GCM sealed provider session.

### Folder result

```json
{
  "folders": [
    {
      "handle": "base64url-node-handle",
      "name": "Omnia Reader",
      "path": "/Cloud Drive/Omnia Reader",
      "canWrite": true
    }
  ]
}
```

Folder handles are opaque. The bridge must recompute access from the restored
account on every call; the selected handle supplied by the gateway is never
sufficient authorization by itself.

### File result

```json
{
  "handle": "base64url-node-handle",
  "path": ".omnia-reader/v1/books/ab/book/edition.epub",
  "revision": "opaque-handle-and-fingerprint-revision",
  "size": 123456,
  "sha256": "64-lowercase-hex-characters"
}
```

`GET /v1/files` wraps these in `{ "files": [...] }`. It must return every live
candidate under the selected root, including files with duplicate names. The
gateway groups candidates by normalized logical path:

- identical small documents choose the lexicographically smallest stable
  handle;
- divergent documents return `409`;
- identical immutable objects choose the smallest handle;
- objects with different SHA-256 or size return `409`.

`revision` is opaque to the browser and must change when file content changes.
A stable encoding of node handle plus MEGA fingerprint is suitable.

The bridge writes the publication SHA-256 to the custom node attribute `osh`
after a successful upload. The official SDK limits custom attribute names to
one through seven UTF-8 bytes, so this name is portable. The gateway also
verifies the bytes itself before accepting an upload and while serving a
download.

## Transfer ordering

The official SDK uploads from a local path. A bridge implementation should
stream the HTTP request into a mode-`0600` temporary file while calculating
SHA-256 and enforcing `Content-Length`. Call `startUpload` only after the
declared length and digest match, set `osh`, return the resulting node
metadata, and securely remove the temporary file in every outcome.

The gateway uploads into `.omnia-reader/v1/.staging/` first. For a small
document it rechecks the current revision, moves the previous node to staging,
moves the new node into place, verifies the visible result, and then removes
the backup. Publication objects are immutable: only a missing exact-edition
path is moved into place. If another client wins the race, identical bytes
converge and different bytes return `409`.

Downloads must be confined by both the selected root handle and requested node
handle. Prefer SDK streaming callbacks; a mode-`0600` temporary download is an
acceptable first implementation if it is bounded, removed reliably, and never
shared between requests.

## Error contract

The bridge returns a non-sensitive JSON code:

```json
{
  "code": "SESSION_EXPIRED"
}
```

Supported actionable codes are:

| Code                  | Gateway status | Meaning                                  |
| --------------------- | -------------- | ---------------------------------------- |
| `INVALID_CREDENTIALS` | `401`          | Account or password was not accepted     |
| `MFA_REQUIRED`        | `401`          | A two-factor code is required            |
| `INVALID_MFA`         | `401`          | The two-factor code was not accepted     |
| `SESSION_EXPIRED`     | `401`          | `fastLogin` can no longer restore access |
| `DUPLICATE_NODES`     | `409`          | The bridge cannot safely resolve nodes   |
| `TRANSFER_QUOTA`      | `429`          | Transfer quota is temporarily exhausted  |
| `STORAGE_QUOTA`       | `507`          | Account storage is exhausted             |

Do not return SDK sessions, passwords, provider URLs, node keys, stack traces,
or raw SDK error text. Unknown bridge 5xx responses become a generic `502` at
the public gateway.

## Native bridge completion gate

The TypeScript adapter, HTTP bridge client, native protocol-v1 source,
configuration validation, root-ancestry enforcement, verified temporary-file
transfers, bounded concurrency, login page, session sealing, duplicate
reconciliation, optimistic replacement, and deterministic core/protocol tests
are implemented. Release still requires:

1. Scan, sign, publish, and deploy the production image by immutable digest.
   The local multi-stage image build, SDK-linked Release build, non-root
   runtime, CTest, and loopback authentication smoke test pass.
2. Run bridge conformance tests against a disposable MEGA account.
3. Run two-client duplicate/race tests, expired-session tests, MFA tests, and
   storage/transfer-quota probes.
4. Interrupt live uploads and downloads to confirm provider-side cancellation.
   The request-disconnect hooks, MEGA cancel-token polling, SIGTERM handling,
   deterministic crash cleanup, and container lifecycle smoke test pass.
5. Exercise the implemented encrypted Redis `GatewaySessionStore` and rolling
   key rotation against the production Redis HA/backup deployment.
