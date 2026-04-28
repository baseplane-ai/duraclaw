# Research: a baseplane-style docs hierarchy for duraclaw (internal, no renderer)

**Date:** 2026-04-28
**Mode:** research
**Workflow:** RE-c05d-0428
**Type:** Feature research (gap analysis + IA proposal)
**Outcome:** Adopt baseplane's **Theory → Primitives → Modules → Integrations** layered hierarchy as plain markdown inside this repo. **No docs site, no renderer, no hosting** — these layers exist purely so the kata workflow and human readers have a stable place to find each kind of knowledge. Next step is planning mode to spec the adoption.

> **Scope note (revised after initial pass).** The first version of this research evaluated mkdocs / Astro Starlight / Docusaurus and proposed a publish workflow. **That's out of scope.** We don't want a docs *site* — we want the *organisational structure* baseplane uses internally. This revision strips renderer/hosting content; the remaining sections (hierarchy, gap analysis, IA proposal, migration plan) are what matters.

---

## TL;DR

1. **Adopt the hierarchy, skip the website.** Copy baseplane's 5-layer structure (Theory / Primitives / Modules / Specs / Rules + Integrations + `_archive/`) as plain markdown directories. No `mkdocs.yml`, no GH Pages, no Cloudflare. Files render fine in GitHub, in editors, and to the AI sessions that consume them.
2. **Duraclaw already has 2 of 5 layers.** `planning/specs/` (62 specs) ≈ baseplane Specs. `.claude/rules/` (11 rules) ≈ baseplane Rules. **Theory, Primitives, Modules, Integrations are missing** as discoverable layers.
3. **Some "rules" are actually theory.** `.claude/rules/session-lifecycle.md` and `.claude/rules/client-data-flow.md` describe invariants ("DO is authoritative", "every event has a monotonic seq") — they're theory wearing rule clothing. The rule frontmatter (`paths:`) means AI sessions auto-load them when editing matching files; that's a rule-layer feature. We need both: theory docs that describe invariants, and thin rule stubs that point editors at them.
4. **The kata `theory-primitives-review` prompt is currently un-runnable.** `.kata/prompts/theory-primitives-review.md` references baseplane-specific theory docs (`domains.md`, `data.md`, `dynamics.md`, `experience.md`, `governance.md`, `boundaries.md`) and primitives (DataForge, CommandBus, EventBus, Workflows) that don't exist here. Adopting the hierarchy unblocks this.
5. **Pick a root: `docs/` or `planning/`.** Open decision. Baseplane uses `docs/`. Duraclaw uses `planning/` for specs/research. Sticking the new layers under `planning/theory/` etc. keeps everything-not-code under one root; using `docs/` matches baseplane verbatim. Recommendation: **`docs/`**, because Theory/Primitives/Modules/Integrations are not "planning" (in-flight work) — they're stable knowledge that outlives any plan.
6. **Phased plan.** P0 (~30 min): create empty directories + index pages. P1 (~3-4h): seed Theory by splitting it out of CLAUDE.md and the two theory-shaped rule files; seed Modules from package READMEs; seed Integrations from CLAUDE.md "Tech Stack". P2 (ongoing): author Primitives, retarget the kata review prompt against real duraclaw theory.

---

## Part 1 — What baseplane does (hierarchy only)

The hierarchy is documented on baseplane's own index page. We don't need any of their tooling — just the structure.

| Layer          | Location              | Contents                                       | Changes when                |
|----------------|-----------------------|------------------------------------------------|-----------------------------|
| **Theory**     | `docs/theory/`        | Principles, constraints, invariants            | Domain model changes        |
| **Primitives** | `docs/primitives/`    | Concept + wireframes + behavior per primitive  | Product design evolves      |
| **Modules**    | `docs/modules/`       | Module declarations + feature behaviors        | Product scope changes       |
| **Specs**      | `planning/specs/`     | Specific feature requirements                  | Per-feature implementation  |
| **Rules**      | `.claude/rules/`      | File paths, imports, anti-patterns             | Stack or framework changes  |

Plus three sibling concepts:
- `docs/integrations/` — external service reference data
- `docs/testing/` — manual testing data
- `docs/_archive/` — dissolved layers / superseded docs (their old `patterns/` layer migrated into theory + primitives, and `_archive/` keeps the trail)

What makes this work isn't the renderer — it's the **"Changes when" cadence**. Each layer has a different update frequency, so they don't churn together: Theory rarely; Primitives when product design evolves; Modules when scope changes; Specs constantly; Rules when the stack changes.

---

## Part 2 — What duraclaw has today

### Layer-by-layer inventory

| Baseplane layer  | Duraclaw equivalent                                                      | State           |
|------------------|---------------------------------------------------------------------------|-----------------|
| Theory           | Scattered: `CLAUDE.md` "Architecture / Key invariants", `.claude/rules/session-lifecycle.md` (theory in rule clothing), `.claude/rules/client-data-flow.md` (also theory-shaped) | **Missing as a layer** |
| Primitives       | `.interface-design/system.md` (design tokens) + `packages/ai-elements/` (UI lib) — neither documented as a primitive layer | **Missing as a layer**     |
| Modules          | Per-package `README.md`s (`packages/shared-transport/README.md`, `apps/orchestrator/scripts/README.md`, `.devcontainer/README.md`) — partial, uneven | **Missing as a layer** |
| Specs            | `planning/specs/` — 62 files                                              | **Strong** ✅    |
| Rules            | `.claude/rules/` — 11 files (`client-data-flow`, `deployment`, `gateway`, `kata`, `mobile`, `orchestrator`, `session-lifecycle`, `session-runner`, `shared-transport`, `testing`, `worktree-setup`) | **Strong** ✅ (but two files are mis-categorised, see below) |
| Integrations     | Implicit in `CLAUDE.md` "Tech Stack", scattered through specs            | **Missing**     |
| Archive          | Nothing structurally — old specs/research sit alongside current ones      | **Missing**     |
| Research         | `planning/research/` — 91 files (no baseplane analogue surfaced)          | **Extra layer duraclaw has** |

### Mis-categorised content in `.claude/rules/`

Two rule files are theory in disguise. Quoting from each:

- **`.claude/rules/session-lifecycle.md`** describes the lifecycle states and transitions of a session — that's `dynamics.md`-shaped content in baseplane terms (lifecycle states, transitions, phase rules). The file currently has a `paths:` frontmatter so AI sessions auto-load it when editing matching files; that's rule-layer behaviour. **Both functions needed.**
- **`.claude/rules/client-data-flow.md`** opens with: *"DO-authoritative status — the SessionDO stamps `sessionStatus` on every `messages:*` / `branchInfo:*` WS frame…"* — that's an invariant statement ("DO is authoritative"). Should be theory.

The split looks like: **theory file describes the invariant; rule stub points editors at the theory file via `paths:` frontmatter.** Same content surface for AI sessions, cleaner organisation for humans.

### Smoking gun: `.kata/prompts/theory-primitives-review.md`

The kata workflow already has a `theory-primitives-review` skill (and `kata-spec-writing` references "behaviors with B-IDs and layers"). The review prompt at `.kata/prompts/theory-primitives-review.md:7-28` references:

```
**Theory** (invariants that survive stack rewrites):
- domains.md         - module boundaries, capability ownership, org scoping
- data.md            - entity definitions, schemas, archetypes, validation
- dynamics.md        - lifecycle states, transitions, phase rules
- experience.md      - UI layout principles, navigation patterns
- governance.md      - permission models, access rules, approval chains
- boundaries.md      - integration patterns, sync models

**Platform Primitives**:
1. DataForge       - entity definitions, schemas, archetypes
2. Relationships   - entity connections, foreign keys
3. Workflows       - multi-step processes, state machines
4. Templates       - reusable configurations, defaults, presets
5. CommandBus      - frontend operation dispatch
6. EventBus        - real-time sync, cache invalidation
```

None of these files exist in duraclaw, and none of those primitives map to our stack:

| Baseplane primitive | Duraclaw equivalent (if any)                                |
|---------------------|--------------------------------------------------------------|
| DataForge           | Drizzle + D1 schema (`apps/orchestrator/src/db/schema.ts`)   |
| Relationships       | Drizzle relations + DO-side foreign keys                     |
| Workflows           | Explicit DO state machines (kata phases, session lifecycle)  |
| Templates           | Spec templates in `planning/spec-templates/`                 |
| CommandBus          | TanStack DB collections + WS message dispatch                |
| EventBus            | DialBackClient + BufferedChannel WS pubsub                   |

This map is itself a small piece of new theory work. Either retarget the prompt against duraclaw's actual theory + primitives, or delete it. The choice is forced once the layers exist.

---

## Part 3 — Information architecture proposal

Concrete tree, with each entry's source content mapped from existing assets so this is grounded.

### Recommended root: `docs/`

Reasoning: Theory/Primitives/Modules/Integrations are stable knowledge that outlives any specific plan. `planning/` is for in-flight work (specs, research, reviews, evidence, verify). Mixing the two muddies "what is settled" vs "what is being worked on". Baseplane uses `docs/` and the convention is well-understood.

Alternative: nest under `planning/` to keep all-non-code under one root. Survives equally well; pick by taste. Decision belongs in the planning-mode spec, not this research doc.

### `docs/` tree

```
docs/
├── index.md                  # Hierarchy table + intro (mirror baseplane's index)
├── theory/
│   ├── index.md              # 1-page summary of all theory docs
│   ├── session-lifecycle.md  # FROM: .claude/rules/session-lifecycle.md (rules → theory split)
│   ├── client-data-flow.md   # FROM: .claude/rules/client-data-flow.md (rules → theory split)
│   ├── do-authority.md       # NEW: SessionDO is the durable truth-gate; D1 is fallback
│   ├── transport.md          # NEW: BufferedChannel monotonic seq + gap sentinel; DialBackClient backoff
│   ├── identity-model.md     # FROM: CLAUDE.md "Identity Management" → theory of failover (LRU, cooldown, lossless resume)
│   └── observability.md      # FROM: CLAUDE.md "DO observability" — logEvent / event_log invariant
├── primitives/
│   ├── index.md
│   ├── design-system.md      # FROM: .interface-design/system.md
│   ├── ai-elements.md        # FROM: packages/ai-elements/ (component inventory)
│   ├── chain-status.md       # NEW: chain status item primitive (refs spec 16-chain-ux)
│   └── tabs-and-drafts.md    # NEW: yjs tab+draft primitive (refs specs 3, 17, etc.)
├── modules/
│   ├── index.md
│   ├── orchestrator.md       # FROM: .claude/rules/orchestrator.md + apps/orchestrator/scripts/README.md
│   ├── agent-gateway.md      # FROM: .claude/rules/gateway.md + packages/agent-gateway/
│   ├── session-runner.md     # FROM: .claude/rules/session-runner.md
│   ├── docs-runner.md        # FROM: planning/specs/27-docs-as-yjs-dialback-runners.md (note: this is the live yjs docs runner, unrelated to this research)
│   ├── shared-transport.md   # FROM: packages/shared-transport/README.md
│   ├── kata.md               # FROM: .claude/rules/kata.md + packages/kata/
│   └── mobile.md             # FROM: .claude/rules/mobile.md
├── integrations/
│   ├── index.md
│   ├── cloudflare.md         # NEW: Workers, DOs, D1, R2 footprint (cite the migration research)
│   ├── claude-agent-sdk.md   # NEW: SDK version, how runner wraps it
│   ├── better-auth.md        # NEW: D1 adapter, email-only, no GH OAuth
│   ├── capacitor.md          # NEW: Android shell, Firebase, OTA bundle pipeline
│   └── github.md             # NEW: issue/PR linking convention from chain-status-item.tsx
├── testing/
│   ├── index.md
│   ├── prod-test-users.md    # FROM: ~/.claude/projects/.../MEMORY.md "Prod test users" entry
│   └── dev-up.md             # FROM: scripts/verify/dev-up.sh + .claude/rules/worktree-setup.md
└── _archive/
    └── (dropzone for dissolved layers / superseded docs)
```

### What stays where it is

- **`planning/specs/`** — unchanged. Already the Specs layer.
- **`planning/research/`** — unchanged. Research is duraclaw-specific (no baseplane analogue), and 91 files would swamp any nav anyway. Cross-link from theory/module docs where relevant.
- **`planning/reviews/`, `planning/verify/`, `planning/evidence/`** — unchanged. These are kata workflow artefacts, not knowledge layers.
- **`.claude/rules/`** — keeps its 11 files **except** the two theory-shaped ones, which become thin stubs:
  ```md
  ---
  paths: ["apps/orchestrator/src/components/**", "..."]
  ---
  # Client data flow (rule stub)
  See `docs/theory/client-data-flow.md` for the invariants.
  Implementation pointers:
  - DO writes `sessionStatus` on every `messages:*` frame (see `apps/orchestrator/.../session-do.ts`)
  - Client extracts via `useSessionStatus(sessionId)` (see `.../hooks/use-session-status.ts`)
  ```
  This preserves the `paths:` auto-load behaviour for AI sessions while moving invariant prose to theory.
- **`CLAUDE.md`** — anything moved into `docs/theory/` becomes a one-line link in CLAUDE.md (keep the project root signal-dense).

### "Changes when" cadence (adapted)

| Layer        | Changes when                                                  |
|--------------|---------------------------------------------------------------|
| Theory       | A new SDK/runtime invariant lands, or an existing one breaks  |
| Primitives   | A new shared UI/UX building block stabilises                  |
| Modules      | A package is added or its surface changes                     |
| Integrations | An external dependency is added/upgraded/swapped              |
| Specs        | Per-feature, in-flight                                        |
| Rules        | A stack-level convention changes (new linter, new framework)  |

---

## Part 4 — Phased rollout (no renderer, no publish)

### P0 — Create the layer skeleton (~30 min)

```
mkdir -p docs/{theory,primitives,modules,integrations,testing,_archive}
```

Write `docs/index.md` mirroring the hierarchy table from Part 1. Add stub `index.md` to each layer with a one-sentence "what lives here" summary. Commit.

**Exit criteria:** the directories exist, the index renders correctly in GitHub, and a `find docs -name '*.md'` shows the expected stubs.

### P1 — Seed content (~3-4h)

In rough priority order (highest leverage first):

1. **Theory split.** Move `.claude/rules/session-lifecycle.md` → `docs/theory/session-lifecycle.md` and `.claude/rules/client-data-flow.md` → `docs/theory/client-data-flow.md`. Replace each rule file with a thin stub (frontmatter + link). Author 3-4 new theory docs from CLAUDE.md invariants: `do-authority.md`, `transport.md`, `identity-model.md`, `observability.md`.
2. **Modules.** One page per package, sourced from existing READMEs and `.claude/rules/<package>.md` files. Mostly consolidation, not authoring.
3. **Integrations.** Five short pages (Cloudflare, claude-agent-sdk, Better Auth, Capacitor, GitHub). Most content is in `CLAUDE.md` "Tech Stack" + the recent baseplane-migration research.
4. **Testing.** Lift `MEMORY.md` "Prod test users" entry into `docs/testing/prod-test-users.md`; lift `dev-up.sh` walkthrough.

**Exit criteria:** every layer has ≥1 page with real content; cross-links are valid (`grep -r '](docs/' .` resolves); CLAUDE.md is shorter, not longer.

### P2 — Primitives + retarget kata reviews (ongoing, opportunistic)

1. **Primitives layer.** Hardest because it requires *deciding* what counts as a primitive in duraclaw. Candidates: design tokens, `ai-elements/` components, chain-status item, tab+draft yjs primitive, virtualised message list. One primitive doc per stable building block.
2. **Retarget `.kata/prompts/theory-primitives-review.md`.** Rewrite against duraclaw's actual theory docs (the 6-7 from P1) and primitives (whatever ships in P2). Use the baseplane→duraclaw primitive map from Part 2 as the starting point.

**Exit criteria:** `theory-primitives-review` runs against a real spec and produces useful output, not "I can't find domains.md".

---

## Part 5 — Risks (much narrower without a renderer)

| Risk                                                          | Likelihood | Mitigation                                                                                  |
|---------------------------------------------------------------|------------|----------------------------------------------------------------------------------------------|
| Doc rot — content stops matching the code                     | High       | Quarterly burn-down pass; rule stubs with `paths:` frontmatter keep theory in AI sessions' face when editing related code |
| Hierarchy drift — people put theory in modules etc.          | Medium     | Lock the "Changes when" table in `docs/index.md`; reference it in PR template / spec template |
| Half-migrated state — some theory in `docs/`, some still in `.claude/rules/` | High during P1 | Do the rules → theory split atomically (move + stub in same commit); track outstanding splits in the planning-mode spec |
| `theory-primitives-review` continues to misfire if not retargeted | High      | Either delete the prompt now (P0) or commit to retargeting in P2; do not leave it pointing at non-existent docs |
| Choosing `docs/` vs `planning/` and changing later            | Low        | `git mv` is cheap; pick one in the planning-mode spec and move on                            |

Notably absent (because there's no renderer): build-system risks, hosting risks, public-vs-private risks, link-check CI, Python toolchain, GH Actions changes.

---

## Part 6 — Decisions to make in planning mode

These are the choices the planning-mode spec needs to nail down. Most are small.

1. **Root: `docs/` or `planning/<layer>/`?** Recommendation: `docs/`. Different from `planning/` because these layers are stable knowledge, not in-flight work.
2. **Atomic migration vs gradual?** Recommendation: atomic for the rule→theory split (the two files), gradual for everything else (one PR per module, etc.).
3. **What about `planning/research/`?** Recommendation: leave alone. 91 historical research docs don't fit any of the new layers cleanly. Cross-link from theory/module docs as needed.
4. **Retire `theory-primitives-review` immediately or after P2?** Recommendation: edit it now to say "WIP — duraclaw theory docs forthcoming, see `docs/theory/`" so the prompt fails loudly with a useful pointer instead of failing confusingly.
5. **CLAUDE.md trim — what to keep at the root?** Recommendation: keep the architecture diagram, key invariants list (with each item linking into `docs/theory/`), monorepo structure, key commands, conventions. Move long-form prose into theory docs.
6. **Scope of the planning-mode spec.** Recommendation: spec covers P0+P1 only. P2 (Primitives) is separate because deciding what counts as a primitive is its own question.

---

## References

- **baseplane hierarchy** — probed via `curl https://docs.baseplane.ai` (HTML index page); only the structure was lifted, no content
- **prior research** — `planning/research/2026-04-28-baseplane-to-codevibesmatter-migration.md` (relevant for the integrations layer)
- **duraclaw existing assets cited:**
  - `CLAUDE.md` — Architecture / Identity Management / DO observability sections
  - `.claude/rules/` — 11 rule files (two are theory-shaped: `session-lifecycle.md`, `client-data-flow.md`)
  - `.kata/prompts/theory-primitives-review.md` — the broken prompt
  - `.kata/prompts/spec-review.md`, `.kata/prompts/code-review.md` — sibling kata prompts
  - `planning/specs/` (62), `planning/research/` (91)
  - `.interface-design/system.md` — design tokens
  - `packages/*/README.md` — module-shaped content scattered
- **what was deliberately dropped from this research** — renderer evaluation (mkdocs / Astro / Docusaurus), hosting (GH Pages / CF Pages), domain choice, publish workflow. Out of scope: this is internal markdown, not a website.
