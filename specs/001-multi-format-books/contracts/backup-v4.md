# Backup Archive Contract: Schema 4

## Compatibility

- Media type remains `application/vnd.omnia-reader.backup+zip`.
- Schema 4 writers emit logical membership explicitly.
- Schema 4 readers accept schemas 1–3 by wrapping each exact book in a singleton
  logical book after existing migration/validation.
- Older readers reject schema 4 before mutation; no optional sidecar may make a
  grouped archive appear safely flattenable.

## Manifest Shape

The schema 4 manifest retains current archive metadata and variant-keyed arrays,
including exact books, progress documents, bookmarks, annotations, reader
preferences, and binary entry declarations. It adds:

- `logicalBooks[]`: complete schema-1 logical records sorted by logical ID;
- `logicalBookCovers[]`: optional logical ID, safe archive path, media type,
  declared size, and SHA-256, sorted by logical ID;
- `logicalBookPreferences[]`: synchronized preferred-format registers, including
  winning change ID and causal heads, sorted by logical ID;
- `membershipReconciliations[]`: open records plus resolved authority required
  to prevent conflict loss or resurrection, sorted by conflict ID;
- explicit schema version 4 and entry-table declarations for every added cover.

Publication bytes remain content-addressed and unique. The same variant is
stored once even when referenced by migration or state arrays.
Device-local health/availability is derived and is never serialized. Restore
validates exact staged bytes and the receiving device re-derives availability
after commit.

## Validation Before Mutation

In addition to existing ZIP signature, overlap, path-confinement, entry-count,
expanded-size, digest, and declared-size checks, reject the archive if:

- a logical ID or variant ID is duplicated;
- a logical book is empty or has more than one EPUB/PDF;
- any variant belongs to zero or more than one logical book;
- a membership field references a missing book or wrong format;
- progress, bookmark, or annotation format/ID disagrees with its variant;
- a logical cover/preference references a missing logical book;
- a preferred format is not a member format (local unavailability of that member
  remains valid and does not discard the preference);
- a reconciliation record has unsafe identifiers, missing involved changes or
  variants, inconsistent accepted/rejected memberships, or invalid resolution
  authority;
- any metadata/document exceeds existing bounded field or manifest limits;
- a publication or cover path is unsafe, duplicated, undeclared, or has a
  mismatched digest/size/media type;
- the schema is unknown or newer.

## Current-Library Conflict Preflight

After complete archive integrity/schema validation and before staging bytes or
calling any mutator, read one consistent current-library graph/revision and
evaluate every archived membership without short-circuiting:

- exact variant already owned by another logical book;
- archived logical ID has incompatible membership;
- archived EPUB/PDF slot is occupied by a different current variant.

Identical ownership in the same slot is idempotent and not a conflict. Return a
bounded `LibraryBackupRestoreConflictError` containing every conflict as
`{ kind, archiveLogicalBookId, format, archiveVariantId,
currentLogicalBookId?, currentVariantId? }`, deduplicated and sorted by logical
ID, format, variant ID, then kind. A non-empty report performs no temporary
OPFS, repository, journal, preference, or reconciliation write. Recheck the
captured revision in the final transaction; retry the preflight or abort with a
stale-library result if it changed.

The report is bounded by the archive's already validated maximum logical-book
and variant-entry counts and is never truncated within those bounds. Newer
progress, bookmark, annotation, or preference state alone is not a membership
conflict and follows the existing per-record restore/causal-merge rule only
after a conflict-free preflight. Insufficient staging quota or storage is a
storage failure, not a conflict: it produces no partial-success report and the
atomic restore boundary removes staged data or restores complete before-images.

## Deterministic Export

1. Snapshot validated logical records and exact variant state.
2. Sort logical books, variants, state, and entry declarations by canonical IDs.
3. Serialize a canonical manifest.
4. Write the manifest and declared publication/cover entries in deterministic
   order using the existing streaming/cancellation boundary.

Two exports of unchanged durable data must yield equivalent manifest content
and membership irrespective of UI sort order.

## Atomic Restore

1. Stream and validate the complete archive without changing the library.
2. Build and validate the complete candidate relationship graph and complete
   the current-library conflict preflight.
3. Only after a conflict-free preflight, stage publication and cover bytes under
   unreachable temporary names.
4. Recheck the preflight revision and, in one repository transaction, apply
   variants, binary metadata, logical
   books, covers/preferences, reconciliation authority, and all variant state.
5. Publish staged bytes/handles as reachable and clean replaced/unreachable
   objects only after the durable commit.
6. On any failure, restore complete before-images for pre-existing records and
   remove newly staged data.

The observable result is the complete prior library or complete restored
library. Compatible existing preference registers merge by causal ancestry and
change-ID tie-break, never by timestamp. Existing newer variant state follows
the established restore rules, but those rules may not split membership,
partially replace one logical book, or change state in a preflight failure.

## Required Fixtures

- current schema-3 library with EPUB and PDF singletons;
- schema-4 EPUB+PDF logical book with independent progress/bookmarks/annotations;
- logical cover, synchronized preference, unavailable preferred member, and
  reconciliation round-trip;
- malformed duplicate membership and same-format conflict;
- multiple simultaneous ownership/occupied-slot conflicts returned in canonical
  order with zero mutation, plus a current-revision race;
- corrupt/missing publication and logical-cover entries;
- injected failure after each staging/transaction step;
- cancellation before validation, during streaming, and before commit.
