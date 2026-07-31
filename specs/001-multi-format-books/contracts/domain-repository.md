# Domain and Repository Contract

## Purpose

Define the public, format-neutral boundary used by the library UI, reader shell,
backup, and sync without changing EPUB/PDF engine contracts or the meaning of
existing variant `bookId` fields.

## Existing Variant Operations

Existing variant-oriented operations remain available for reader, binary,
state, backup, and synchronization consumers:

- get/list exact publication variants;
- open one variant source by SHA-256 ID;
- save/read variant progress, progress documents, bookmarks, and annotations;
- access variant cover and source metadata;
- validate/store/remove exact source data.

They must not return logical IDs in a `bookId` field.

## Logical Read Operations

The repository exposes:

- `listLogicalBooks()` — validated logical catalog records only, deterministic
  order left to the caller;
- `getLogicalBook(logicalBookId)` — one aggregate or null;
- `findLogicalBookByVariant(variantId)` — the unique owning aggregate or null;
- `getLogicalBookCover(logicalBookId)` — bounded cover or null;
- `getLogicalBookFormatPreference(logicalBookId)` — synchronized causal register
  or null;
- `saveLogicalBookFormatPreference(logicalBookId, preferredFormat,
mutationIdentity)` — persist after a successful explicit format open and
  return a preference-only logical change when the value differs;
- `listOpenMembershipReconciliations()` — durable deterministic conflicts for
  library/settings presentation;
- `reconcileMembership(conflictId, decision, mutationIdentity)` — validate
  current heads/cardinality and commit an explicit child resolution;
- `resolveVariantAvailability(variantIds)` — batched lightweight device-local
  status for card presentation; may return `checking` but never claims
  unverified bytes are healthy;
- `openHealthyVariant(variantId)` — return the exact source only after metadata,
  reference, detected format, byte accessibility/size, and SHA-256 identity pass;
  otherwise return `unavailable` with a missing/evicted/inaccessible/incomplete
  cause, or isolate invalid active data and return `quarantined` with an
  integrity-invalid/unsupported/malformed-reference cause;
- `replaceVariantSource(variantId, selectedSource)` — validate a hostile local
  selection against the existing variant's format, size, and SHA-256 identity,
  then atomically replace only device-local binary/reference and quarantine
  evidence.

Read validation quarantines a malformed logical record without deleting or
quarantining healthy variant records. A missing member returns explicit
availability rather than silently removing membership. Historical quarantine
rows do not poison a valid replacement active record, and cover state does not
participate in health.

Recovery never changes the variant ID, logical membership, catalog data,
variant reading state, synchronized preference, or logical-change journal. A
cancelled, mismatched, incomplete, or failed recovery leaves the prior active
source and derived status unchanged. Retry is offered only when the exact remote
object is known; otherwise local replacement remains available.

Provider descriptor lookup and download remain outside `LibraryRepository` in
`sync-core`. A user-requested sync retry validates the immutable remote object,
then supplies it to `replaceVariantSource`; persistence never acquires provider
or network authority.

## Atomic Mutation Operations

Each successful mutation returns a complete `LogicalBookMutationResult`:

- created/updated/deleted logical IDs;
- created/deleted variant IDs;
- complete after-state snapshots;
- one `LogicalBookChange` ready to append after commit;
- preference/reconciliation effects and resolved conflict IDs, when applicable;
- cleanup handles for unreachable staged binaries, if any.

### Add variant

Inputs: destination logical ID, exactly one selected source, validated/enriched
variant metadata, and mutation/change identity.

Preconditions:

- destination exists and is valid;
- candidate format is EPUB or PDF and is not occupied;
- exact candidate ID is not already a member or standalone variant. If another
  logical book owns it, return a typed `belongs-to-other-book` result containing
  that logical ID so the UI can offer explicit existing-book association;
- bytes, size, media type, digest, format, archive/PDF structure, and DRM policy
  pass existing import validation.

Commit: variant metadata, binary metadata, logical membership, and any
variant-derived cover state in one IndexedDB transaction after byte staging.

### Associate existing

Inputs: destination and source logical IDs plus mutation identity.

Preconditions:

- IDs are distinct and both records are valid/non-empty;
- the union contains no repeated variant and at most one of each format;
- all references and formats validate.

Commit: retain destination ID/catalog/cover, set union membership, remove source
logical/catalog cover state, retain a valid destination preferred format,
tombstone the removed source preference, and preserve all variant bytes and
locator state. The source cover is retained only as variant cover for future
detach.

### Detach variant

Inputs: logical ID, member variant ID, mutation identity.

Preconditions: source has two variants and the selected variant is a current
member.

Commit: remove membership from the source and create a new singleton logical
record using the detached variant's source metadata/cover. Never re-key the
original logical book or variant state. A preference that no longer names a
member is changed or tombstoned in the same mutation; it never moves or rewrites
variant reading state.

### Delete variant or logical book

Inputs: logical ID, selected variant ID or whole-book intent, and mutation
identity.

Preconditions: explicit confirmed intent names the format or whole book.

Commit: delete only the selected variant and its exact state while updating the
remaining membership, or delete all aggregate members for whole-book intent.
OPFS deletion follows durable metadata commit and is idempotent.

## Error Contract

Expected failures are distinguishable and actionable:

- cancellation (no mutation, not an error alert);
- unsupported/corrupt/DRM-protected source;
- exact duplicate;
- same-format conflict;
- checking member, unavailable member with a
  missing/evicted/inaccessible/incomplete cause, or quarantined member with an
  integrity-invalid/unsupported/malformed-reference cause;
- stale aggregate changed by another local action;
- quota/storage transaction failure;
- optional synchronization pending/conflict.

An open synchronization membership conflict is not a transient error. It
remains queryable and actionable until a valid explicit reconciliation commits.
Cancellation, dismissal, provider retry, or restart does not clear it.

No failure returns a success result with partial membership. Retrying the same
mutation identity is idempotent.

## Reader Contract

- Reader routes continue to accept an exact variant ID.
- The active engine, source, progress, bookmarks, and annotations are resolved
  from that variant exactly as before.
- Sibling lookup uses `findLogicalBookByVariant()` only to present format
  choices.
- Preferred/default resolution orders candidates, then calls
  `openHealthyVariant()` before renderer creation. A failed preferred candidate
  keeps the synchronized preference, exposes its local reason, and tries the
  next ordered member.
- Switching variants flushes active progress and resolves transient editing
  state before navigation; route recreation owns teardown and lazy engine load.
