# Data Model: Qualified Desktop Performance Driver

## WorkloadRecipeV1

- `schemaVersion`: exactly `1`
- `recipeId`: exactly `multi-format-management-v1`
- `seed`: fixed non-empty identifier
- `logicalBooks`: exactly `1000`
- `exactVariants`: exactly `2000`
- `logicalChangeHistory`: exactly `500`
- `formats`: exactly ordered `epub`, `pdf`
- `items`: exactly 1,000 `LogicalWorkloadItemV1` values
- `recipeDigest`: frozen recipe-specification SHA-256 inherited from the
  immutable v1 performance profile
- `workloadDigest`: lowercase SHA-256 over canonical generated workload content
  excluding the claimed workload digest

Validation rejects unknown fields, missing/duplicate logical or variant IDs,
wrong format pairing, non-canonical ordering, count drift, and digest drift.

## LogicalWorkloadItemV1

- `ordinal`: unique integer from 0 through 999
- `logicalBookId`: deterministic ID derived from recipe/ordinal
- `title`: deterministic searchable title
- `epub`: one `VariantDescriptorV1`
- `pdf`: one `VariantDescriptorV1`
- `historyDepth`: integer from 0 through the recipe bound; the complete workload
  totals exactly 500 logical changes

## VariantDescriptorV1

- `variantKey`: deterministic recipe descriptor identity; the actual
  exact-edition SHA-256 remains the digest of the generated publication bytes
- `format`: `epub` or `pdf`, matching its owning slot
- `fileName`: deterministic safe filename
- `mediaType`: exact supported media type
- `contentSeed`: bounded string used by a safe fixture builder

The descriptor is identity/setup data, not a substitute for validating the
generated publication bytes before import or restore.

## ManagementBranchV1

- `id`: one approved stable branch ID
- `action`: add-local, associate, detach, delete, reconcile, replace, or restore
- `outcome`: success or failure
- `activation`: trusted product event (`click`, `change`, or `input`)
- `acknowledgement`: first visible semantic busy/progress/success/failure state
- `finalState`: action-specific durable inventory/error/conflict outcome
- `failureMechanism`: null for success; fixed invalid input, stale state, occupied
  slot, or injected transaction/precommit failure for failure branches

The matrix contains exactly one success and one failure branch for each action.

## DistributionContractV1

- `id`: filter, open-epub, open-pdf, switch-epub-to-pdf, or switch-pdf-to-epub
- `activation`: trusted input/click event
- `finalState`: filtered inventory or visible healthy renderer with selected
  format state
- `warmups`: exactly 20 discarded samples
- `minimumSamples`: exactly 200 measured samples

## DesktopMeasurementRunV1

The run uses the base raw-result fields already defined by feature 012:
profile/dataset identity, command, canonical timestamp, environment, ordered
acknowledgement arrays, five warm-up/sample distributions, and four counters.

State transitions:

```text
CREATED -> PREFLIGHTED -> SETUP -> WARMING -> SAMPLING -> EVALUATING -> WRITTEN
   |            |          |         |            |             |
   +----------> ABORTED <---+---------+------------+-------------+
```

- Only `READY` preflight may enter `SETUP`.
- Any identity drift before `SAMPLING` transitions to `ABORTED`.
- Only a structurally valid evaluator result may enter `WRITTEN`.
- `ABORTED` owns no final evidence filename and cleans temporary state.

## Compatibility

No application durable records change. The workload/matrix contract is additive
test infrastructure. Any semantic change requires a new recipe/profile version;
previous v1 evidence is never reinterpreted.
