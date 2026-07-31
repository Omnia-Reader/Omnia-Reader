# Spec-Driven Development

Omnia Reader uses GitHub Spec Kit 0.15.0 with the Codex skills integration.
Spec Kit owns feature intent and traceability; the existing Omnia Reader skills
own repository-specific implementation, verification, and review.

## Artifact Ownership

| Artifact                          | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `.specify/memory/constitution.md` | Non-negotiable product and engineering rules                                  |
| `.specify/templates/overrides/`   | Upgrade-safe Omnia spec, plan, task, and checklist templates                  |
| `specs/NNN-feature/spec.md`       | User outcomes, requirements, non-goals, and acceptance evidence               |
| `specs/NNN-feature/plan.md`       | Technical ownership, design, risk, and verification plan                      |
| `specs/NNN-feature/tasks.md`      | Test-first, resumable implementation slices                                   |
| `docs/universal-reader-plan.md`   | Product direction, architecture decisions, verified status, and release gates |

Do not use `docs/universal-reader-plan.md` as a task tracker. Update it only
when a delivered change materially changes product scope, architecture, a
release gate, or verified implementation status.

## Standard Feature Flow

From a new Codex session in the repository root:

1. `$speckit-specify <desired outcome>`
2. `$speckit-clarify` when choices remain that affect scope, security, durable
   data, or user experience
3. Review and approve `spec.md`
4. `$speckit-plan`
5. Review and approve `plan.md`
6. `$speckit-checklist requirements`
7. `$speckit-tasks`
8. `$speckit-analyze` for cross-project, reader-engine, persistence, sync,
   security, or native work
9. `$speckit-implement`
10. `$verify-omnia-reader`
11. `$review-omnia-reader` for non-trivial risk

Select the repository implementation skill according to ownership:

- `$develop-omnia-reader` for application UI, platform-neutral orchestration,
  or cross-project work.
- `$change-reader-engine` for EPUB/PDF contracts, locators, rendering,
  navigation, search, selection, or reader lifecycle.
- `$change-offline-sync` for IndexedDB/OPFS, backup, migrations,
  synchronization, gateways, providers, sessions, Git/LFS, or MEGA.

The Spec Kit workflow may orchestrate work, but it does not replace those
repository-specific instructions.

## Proportional Use

Use the full flow for new behavior, product decisions, cross-project changes,
durable schemas, synchronization, reader engines, security boundaries, or
native features.

For a small regression, amend or create a concise spec, reproduce it with a
failing test, implement the fix, and run focused verification. Documentation,
formatting, or mechanical maintenance that changes no behavior or architecture
does not require a numbered feature specification.

For a large feature, split it into independently useful feature directories.
Each directory must have its own acceptance scenarios, plan, tasks, and
evidence rather than one long-running task list.

## Tooling and Updates

The project was initialized with:

```bash
uvx --from specify-cli==0.15.0 specify init --here --force \
  --integration codex --integration-options=--skills --script sh \
  --ignore-agent-tools
```

Inspect the installed version and integration state with:

```bash
uvx --from specify-cli==0.15.0 specify version
uvx --from specify-cli==0.15.0 specify integration status
```

For routine upgrades, select and review a new pinned version, then run
`uvx --from specify-cli==<new-version> specify integration upgrade codex`. Do
not use forced initialization as the normal update path. Preserve and review
project customizations under `.specify/memory/` and
`.specify/templates/overrides/` before accepting an upgrade. Do not edit
managed core files directly under `.specify/templates/`; confirm each active
override with
`uvx --from specify-cli==0.15.0 specify preset resolve <template-name>`.
