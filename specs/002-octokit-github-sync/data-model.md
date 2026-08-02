# Data Model: Octokit GitHub Synchronization

## Durable state

No new entity or schema is introduced.

### Existing GitHub provider session

The encrypted `GitHubSessionState` remains backward compatible and continues to contain only the gateway-owned authorization state, PKCE verifier, user and refresh tokens with expirations, authorization generation, public user metadata, discovered repositories, selected repository, and cached installation token with expiration.

### State transitions

- **Disconnected → pending authorization**: store state, PKCE verifier, and safe return path.
- **Pending → authenticated**: validate callback, acquire user authorization, read the authenticated user, record the current revocation generation, and atomically rotate the browser session ID.
- **Authenticated → refreshed**: coalesce concurrent refresh, validate the complete rotated token pair, and update the encrypted record only while the original authority remains current.
- **Authenticated → disconnected/revoked**: delete local session authority before best-effort remote token revocation; webhook generation changes invalidate every affected session on next access.
- **Repository selected → repository inaccessible**: clear only the matching selected repository and cached installation token.

## Validation and compatibility

- Existing session records require no migration.
- Missing or malformed authorization generation, tokens, expiration values, user data, repository data, or provider responses retain their existing fail-closed outcomes.
- Existing synchronized paths, blob revisions, LFS object identity, pointer content, and `.gitattributes` lines remain unchanged.
- Rollback to the prior provider implementation requires no record or remote repository conversion.
