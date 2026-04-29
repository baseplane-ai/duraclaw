# Modules

A module is a per-package surface document — what a package owns, what it consumes, and the single domain question it uniquely answers. The Modules layer is flat: one file per package at `docs/modules/{package}.md`, plus a top-level `INVENTORY.md` table that lists every module and its key fields.

## Module Test

A module earns its keep by satisfying these facets:

- **Nav entry / package surface** — a package or `apps/` entrypoint that is a real, navigable boundary in the repo.
- **Cohesive responsibility** — one job. If you find yourself describing two unrelated jobs, you have two modules.
- **Single domain question** — exactly one question this module uniquely answers (e.g. "where do user sessions live and how do they sync?"). If two modules answer the same question, one is redundant.

## File convention

```
docs/modules/{package}.md     # one file per package, flat (no subdirectories)
docs/modules/INVENTORY.md     # table: Module | Package | Domain Question | Owns | Consumes
```

Individual module docs and `INVENTORY.md` are authored in P1 of GH#135. This index intentionally does not enumerate modules — that is `INVENTORY.md`'s job.
