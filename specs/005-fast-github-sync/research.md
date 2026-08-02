# Research: Fast GitHub Synchronization

## Decision 1: Use a selected-repository tree revision as the remote change token

**Decision**: Read the selected repository's current default-branch tree SHA and
return a bounded value scoped with repository identity and branch. Represent an
empty repository explicitly.

**Rationale**: The existing list path reads the same tree and then downloads
every matching blob. Tree identity changes whenever synchronized files change,
so one metadata read can reject the no-change case before any document content
is transferred. Scoping prevents a checkpoint from matching another destination.

**Alternatives considered**:

- List all synchronized documents and hash their revisions: still downloads
  every document because the current gateway list contract includes content.
- Trust only elapsed time or last success: can hide another device's change.
- Add a mutable remote checkpoint file: introduces another conflict-prone remote
  record and mutation for every sync.

## Decision 2: Require an empty durable journal before skipping

**Decision**: The fast path checks the authoritative operation journal, not only
process-local activity or scheduler history.

**Rationale**: Process-local events disappear on restart. The IndexedDB journal
survives restart and already represents every local change that must reach a
provider, so pending work reliably vetoes a skip.

**Alternatives considered**:

- Scheduler quiet windows: reduce calls but can defer unsent restart-persistent
  changes.
- Process-local dirty flag: loses authority after reload or crash.
- Recompute a digest of the whole local library: duplicates journal ownership
  and is more expensive than reading pending operations.

## Decision 3: Establish a checkpoint only across a stable full pass

**Decision**: Compare the remote revision before and after the complete delegate
sync. Store it immediately when equal, the journal is empty afterward, and there
are no reported pushes, conflicts, or rejected records. After a successful
mutating or unstable pass, run one immediate complete verification pass and
store only its stable, mutation-free result.

**Rationale**: A remote change during a worker pass could otherwise be mistaken
for synchronized state. Performing the required stable pass inside the same sync
preserves that safety without forcing the next user-triggered sync through every
worker again.

**Alternatives considered**:

- Store only the post-pass revision: can cement a concurrent change that arrived
  after its owning worker already ran.
- Store revisions returned by writes: does not prove later workers or another
  device left the repository unchanged.
- Lock the GitHub repository during sync: unavailable and hostile to normal Git
  collaboration.

## Decision 4: Keep checkpoint storage disposable and fail open

**Decision**: Use a small schema-versioned localStorage record with strict size
and shape checks. Any read/write failure behaves as no checkpoint.

**Rationale**: The checkpoint is a performance hint, not user data. It must not
create an IndexedDB migration or ever block local reading or complete sync.

**Alternatives considered**:

- Add it to the sync journal database: raises migration and transaction coupling
  for non-authoritative state.
- Put it in synchronized settings: different devices have independent applied
  state, so sharing the checkpoint is unsafe.

## Decision 5: Extend transport with an optional capability

**Decision**: Add an optional cancellation-aware destination revision method and
feature-detect it in the wrapper.

**Rationale**: GitHub can provide an authoritative cheap revision; MEGA has a
different model and is outside this feature. Optional capability preserves all
existing transports and makes absence fall back to full sync.

**Alternatives considered**:

- Put GitHub types directly in sync-core: violates provider-neutral ownership.
- Require every provider to implement a revision now: broadens scope and risks
  weaker MEGA semantics.
