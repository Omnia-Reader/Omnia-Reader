# Provider Object Path Contract

For every new EPUB or PDF upsert, the publication manifest and any logical-book variant effect MUST reference the identical value returned by the provider-neutral canonical book object path.

```text
.omnia-reader/library/<confined-readable-stem>--<first-12-sha256>/<confined-original-filename>.<epub|pdf>
```

The leaf is the original filename when it is safe for the shared provider path. Existing deterministic confinement applies to separators, control characters, percent-encoding hazards, missing extensions, and bounds. The directory suffix is collision metadata, not the filename or integrity authority.

Consumers MAY accept this exact legacy form only for backward compatibility:

```text
.omnia-reader/v1/books/<complete-sha256>/publication.<epub|pdf>
```

The digest and extension MUST be derived from and equal the validated variant. Producers MUST NOT create new logical changes with the legacy form. All other paths are invalid.

Every full synchronization inventories `.omnia-reader/v1/`. Valid supported entries are mapped to `.omnia-reader/`, embedded owned paths are normalized, and destination content or object integrity is verified. Only after the current pass succeeds may every exposed entry beneath `v1` be deleted. No `v1` entry adheres to the current format. Cleanup MUST NOT target current paths or content outside `.omnia-reader/`.
