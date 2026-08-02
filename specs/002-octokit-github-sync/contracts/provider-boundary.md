# Contract: GitHub Provider Boundary

## Public boundary

The existing `/api/sync/github` gateway routes, provider-scoped HttpOnly cookie, CSRF requirements, request bodies, response bodies, safe error messages, and `Retry-After` behavior remain unchanged.

## Internal provider ownership

- Octokit owns supported GitHub App authentication mechanics, OAuth token protocol requests, REST request construction, REST pagination, version and user-agent headers, and request-error representation.
- Omnia Reader owns encrypted session persistence, refresh/disconnect/revocation races, authorization generations, input and response validation, safe gateway error mapping, configured deadlines, and provider-scope enforcement.
- Omnia Reader owns Git LFS batch negotiation and every signed action transfer, including URL/header validation, redirect rejection, streaming, integrity checks, exact content length, verification, and pointer publication ordering.

## Compatibility requirements

- Automatic SDK retry and throttling may recover safely replayable operations within the bounded gateway policy; single-use and non-idempotent operations must opt out of ambiguous replay.
- Rate limits that cannot be completed within the bounded in-request policy must remain observable to the gateway scheduler through the existing `429 Retry-After` response.
- Octokit errors must be translated without exposing credentials, request bodies, authorization headers, raw provider messages longer than the existing bound, or provider quota totals.
- A `403` with exhausted primary quota and a `429` secondary limit must remain an application-owned `429` with a bounded retry delay.
- GitHub App JWT authentication failure must preserve repository selection and map to `502`; installation access removal must clear the matching selection and map to `403`.
- User-scoped `401` must retain the existing one-retry concurrent-rotation check before consuming the matching session.
