# Research: a baseplane-style docs stack for duraclaw

**Date:** 2026-04-28
**Mode:** research
**Workflow:** RE-c05d-0428
**Type:** Library/tech evaluation + feature research (gap analysis)
**Outcome:** Recommend **MkDocs + Material for MkDocs** (parity with baseplane), hosted on GitHub Pages with a Cloudflare CNAME, organised under the **Theory → Primitives → Modules → Integrations** hierarchy. The bigger lift is the *information architecture*, not the tooling — duraclaw already has Specs and Rules layers; the missing layers are Theory, Primitives, Modules, and Integrations.

---

## TL;DR

1. **Stack: copy baseplane verbatim.** docs.baseplane.ai runs `mkdocs 1.6.1 + mkdocs-material 9.7.6`, dark "slate" theme, indigo accent, hosted at `baseplane-ai.github.io/baseplane/` with a Cloudflare CNAME at `docs.baseplane.ai`. There is no reason to pick a different generator — Material for MkDocs is the highest-quality docs theme in the ecosystem, the convention is already in our heads, and parity makes future cross-referencing cheap.
2. **The hierarchy matters more than the renderer.** Baseplane's value isn't mkdocs — it's the five-layer knowledge hierarchy (Theory / Primitives / Modules / Specs / Rules) plus the `_archive/` discipline. Adopt the hierarchy first; the renderer is a 30-minute job.
3. **Duraclaw already has 2 of 5 layers.** `planning/specs/` (62 specs) ≈ baseplane Specs. `.claude/rules/` (11 rules) ≈ baseplane Rules. Theory, Primitives, Modules, Integrations don't exist as a `docs/` tree — what we have lives scattered across `CLAUDE.md`, `.claude/rules/*.md` (which mixes theory-shaped content with rule-shaped content), `planning/research/` (91 docs, mostly historical), and per-package `README.md`s.
4. **The kata theory-primitives-review prompt is a smoking gun.** `.kata/prompts/theory-primitives-review.md` references baseplane theory docs (`domains.md`, `data.md`, `dynamics.md`, `experience.md`, `governance.md`, `boundaries.md`) and primitives (DataForge, Workflows, CommandBus, EventBus) that **do not exist in duraclaw**. This review currently can't be run on a duraclaw spec. Setting up a duraclaw-shaped Theory + Primitives layer fixes this side effect.
5. **Phased plan.** P0 (≈90 min): bootstrap `docs/` + `mkdocs.yml` + GH Pages publish workflow, empty stubs. P1 (≈4-6h): seed Theory from existing CLAUDE.md invariants, seed Modules from package READMEs, seed Integrations from Tech Stack section. P2 (ongoing): Primitives layer + reformulate `theory-primitives-review` prompt against duraclaw's actual theory.

---

## Part 1 — What baseplane actually does

Probed via `curl https://docs.baseplane.ai` (WebFetch returned 403 — Cloudflare bot block — but raw curl works) and the rendered nav structure.

### Renderer

- **Generator:** `mkdocs 1.6.1` (declared in `<meta name="generator">`)
- **Theme:** `mkdocs-material 9.7.6` (signature `md-*` CSS classes)
- **Color scheme:** `slate` (dark), primary `indigo`, accent `indigo`
- **Fonts:** Roboto + Roboto Mono (mkdocs-material default)
- **Source repo:** `github.com/baseplane-ai/baseplane` (linked from header — likely private; we did not attempt unauthenticated access)
- **Hosting:** canonical URL is `baseplane-ai.github.io/baseplane/` → GitHub Pages → CNAME `docs.baseplane.ai` behind Cloudflare. `Server: cloudflare`, `cf-cache-status: DYNAMIC` on responses.

### Knowledge hierarchy (lifted from their index page)

| Layer          | Location              | Contents                                       | Changes when                |
|----------------|-----------------------|------------------------------------------------|-----------------------------|
| **Theory**     | `docs/theory/`        | Principles, constraints, invariants            | Domain model changes        |
| **Primitives** | `docs/primitives/`    | Concept + wireframes + behavior per primitive  | Product design evolves      |
| **Modules**    | `docs/modules/`       | Module declarations + feature behaviors        | Product scope changes       |
| **Specs**      | `planning/specs/`     | Specific feature requirements                  | Per-feature implementation  |
| **Rules**      | `.claude/rules/`      | File paths, imports, anti-patterns             | Stack or framework changes  |

Plus:
- `docs/integrations/` — external service reference data (Procore API schemas, sync docs)
- `docs/testing/` — manual testing data
- `docs/_archive/` — legacy docs (their dissolved `patterns/` layer migrated into theory + primitives)

Their nav (counted from the rendered HTML) has Planning at the top, then Rules (the largest section, ~30 entries), then Theory/Primitives/Modules/Integrations. Rules are exposed *in the docs site* even though they live at `.claude/rules/` in the repo — mkdocs's `nav:` lets you point at any markdown path under the repo root.

### What's worth copying (and what isn't)

| Copy                                                         | Skip / adapt                                                              |
|--------------------------------------------------------------|----------------------------------------------------------------------------|
| The 5-layer hierarchy + `_archive/` discipline               | Their specific theory docs (`domains.md`, `data.md`, …) — these are       |
| The "Changes when" column on the index — sets cadence        | construction-software shaped, not us                                       |
| mkdocs + mkdocs-material 9.x with slate/indigo               | Their primitives (DataForge, CommandBus) — we don't have this stack        |
| Surfacing `.claude/rules/` *in* the docs nav                 | Procore integration page                                                   |
| `_archive/` for dissolved layers                             | "Internal documentation for Baseplane" privacy posture (decision for us)   |

---

## Part 2 — What duraclaw has today

### Layer-by-layer inventory

| Baseplane layer  | Duraclaw equivalent                                                      | State           |
|------------------|---------------------------------------------------------------------------|-----------------|
| Theory           | Scattered: `CLAUDE.md` "Architecture / Key invariants", `.claude/rules/session-lifecycle.md` (mostly theory in rule clothing), `.claude/rules/client-data-flow.md` (also theory-shaped) | **No `docs/theory/`** |
| Primitives       | Effectively nothing — the closest thing is `.interface-design/system.md` (design tokens) and `packages/ai-elements/` (UI library) | **Missing**     |
| Modules          | Per-package `README.md`s (`packages/shared-transport/README.md`, `apps/orchestrator/scripts/README.md`, `.devcontainer/README.md`) — partial, uneven | **Missing as a layer** |
| Specs            | `planning/specs/` — 62 files, well-populated                              | **Strong** ✅    |
| Rules            | `.claude/rules/` — 11 files (`client-data-flow`, `deployment`, `gateway`, `kata`, `mobile`, `orchestrator`, `session-lifecycle`, `session-runner`, `shared-transport`, `testing`, `worktree-setup`) | **Strong** ✅    |
| Integrations     | Implicit in `CLAUDE.md` "Tech Stack", scattered through specs            | **Missing**     |
| Archive          | Nothing structurally — old specs/research just sit alongside current ones | **Missing**     |
| Research         | `planning/research/` — 91 files (no baseplane analogue surfaced; they may live in `_archive/` or be private) | **Extra layer duraclaw has, baseplane doesn't expose** |

Key observation: **duraclaw rules are doing double duty.** `.claude/rules/session-lifecycle.md` and `.claude/rules/client-data-flow.md` read like theory docs (they describe invariants — "DO is authoritative", "every event has a monotonic seq") that happen to be filed under rules because there was nowhere else to put them. Splitting them is the highest-leverage move in the whole migration.

### Smoking gun: `.kata/prompts/theory-primitives-review.md`

Our kata workflow already has a `theory-primitives-review` skill (and a `kata-spec-writing` skill that references "behaviors with B-IDs and layers"). The prompt at `.kata/prompts/theory-primitives-review.md:7-28` references:

```
**Theory** (invariants that survive stack rewrites):
- domains.md         - module boundaries, capability ownership, org scoping
- data.md            - entity definitions, schemas, archetypes, validation
- dynamics.md        - lifecycle states, transitions, phase rules
- experience.md      - UI layout principles, navigation patterns
- governance.md      - permission models, access rules, approval chains
- boundaries.md      - integration patterns, sync models

**Platform Primitives**:
1. DataForge       - entity definitions, schemas, archetypes, validation pipelines
2. Relationships   - entity connections, foreign keys, reference integrity
3. Workflows       - multi-step processes, state machines, approval chains
4. Templates       - reusable configurations, defaults, presets
5. CommandBus      - frontend operation dispatch, optimistic updates
6. EventBus        - real-time sync, cache invalidation, cross-module notifications
```

None of these files exist in duraclaw, and none of those primitives map to our stack (we don't have DataForge — we have Drizzle + D1; we don't have CommandBus — we have TanStack DB collections; we don't have Workflows — we have explicit DO state machines). The prompt was copied from baseplane unchanged. **Either retarget this prompt to duraclaw's actual theory + primitives, or delete it.** That decision is forced once the docs/ tree exists.

---

## Part 3 — Stack evaluation

We're picking the renderer for a small, high-traffic-by-developer-eye-only docs site. Ranked on what matters here: low-friction authoring, baseplane parity, ops surface, and how well it tolerates being the destination for both `docs/`-tree content *and* externally-located markdown (`.claude/rules/`, `planning/specs/`).

| Option                  | Renderer | Toolchain | External-markdown nav | Theme quality | Baseplane parity | Notes                                          |
|-------------------------|----------|-----------|------------------------|---------------|------------------|------------------------------------------------|
| **MkDocs + Material**   | Static   | Python    | ✅ via `nav:` paths    | Best in class | **Identical**    | What baseplane uses. Recommended.              |
| Astro Starlight         | Static   | Node      | ⚠️ MDX + symlinks       | Excellent     | Partial (baseplane.ai marketing is Astro)        | Tempting because the rest of the org is Node, but the nav model is rigid (auto-discovered from `src/content/docs/`) and pulling in `.claude/rules/` requires symlinks or copy-on-build. |
| Docusaurus              | Static   | Node      | ⚠️ via sidebars.js + symlinks | Good         | None              | React-heavy, slow build, themer needed for parity. Not justified vs. Material. |
| Nextra                  | Static   | Node      | ⚠️ similar to Starlight | Good          | None              | Bound to Next.js; we don't run Next.js anywhere. |
| VitePress               | Static   | Node      | ✅ via config           | Good          | None              | Lighter than Docusaurus, but no advantage over Material to offset losing baseplane parity. |
| Plain markdown (no site)| —        | —         | n/a                    | n/a           | n/a              | Lowest effort; loses search, nav, mobile rendering, and the cultural artefact "the docs site". Acceptable as P0 stopgap if we want to defer the renderer. |
| Mount on orchestrator SPA | Custom | Node      | ✅                      | Custom build  | None              | Serves the docs from `dura.baseplane.ai/docs`. Cute, but auth gates it (most docs sites are public/skim-friendly), and we'd be writing a docs renderer instead of shipping product. |

**Recommendation: MkDocs + Material.** Reasons in priority order:

1. **Parity with baseplane.** Same syntax, same theme, same admonitions, same tabs. Anyone who has touched baseplane docs can write here. When the two hierarchies diverge, the diff is content, not framework.
2. **`nav:` is path-agnostic.** mkdocs lets `nav:` reference any markdown path under the configured `docs_dir` *or* parent dirs (with `monorepo` plugin or symlinks). This makes "`.claude/rules/` shows up in the docs nav" trivial — exactly what baseplane does.
3. **Material for MkDocs is unmatched.** Built-in search, instant nav, code copy buttons, admonitions, content tabs, mermaid, math, dark/light toggle, social cards. Setup is `mkdocs.yml` + `pip install`.
4. **Python toolchain is fine.** GitHub Actions has python preinstalled. The CI step is `pip install mkdocs-material && mkdocs build --strict && publish`. We don't have to add python anywhere else; the dev workflow stays Node.
5. **Public-by-default GitHub Pages is what we already do.** No new infra. No CF Worker to write. Just `gh-pages` branch + a CNAME record to a chosen subdomain.

---

## Part 4 — Information architecture proposal

Concrete `docs/` tree for duraclaw, with the source content for each entry mapped from existing assets so this isn't speculative.

### `docs/` tree

```
docs/
├── index.md                  # Knowledge hierarchy table + intro (mirror baseplane's index)
├── theory/
│   ├── index.md              # 1-page summary of all theory docs
│   ├── session-lifecycle.md  # FROM: .claude/rules/session-lifecycle.md (rules → theory split)
│   ├── client-data-flow.md   # FROM: .claude/rules/client-data-flow.md (rules → theory split)
│   ├── do-authority.md       # NEW: SessionDO is the durable truth-gate; D1 is fallback
│   ├── transport.md          # NEW: BufferedChannel, monotonic seq, gap sentinel; DialBackClient backoff
│   ├── identity-model.md     # FROM: CLAUDE.md "Identity Management" → theory of failover
│   └── observability.md      # FROM: CLAUDE.md "DO observability" — logEvent/event_log invariant
├── primitives/
│   ├── index.md
│   ├── design-system.md      # FROM: .interface-design/system.md
│   ├── ai-elements.md        # FROM: packages/ai-elements/ + screenshots
│   ├── chain-status.md       # NEW: chain status item primitive (referenced in 16-chain-ux spec)
│   └── tabs-and-drafts.md    # NEW: yjs tab+draft primitive (refs spec 3, 17, 18-yjs-tab)
├── modules/
│   ├── index.md
│   ├── orchestrator.md       # FROM: .claude/rules/orchestrator.md + apps/orchestrator/scripts/README.md
│   ├── agent-gateway.md      # FROM: .claude/rules/gateway.md + packages/agent-gateway/
│   ├── session-runner.md     # FROM: .claude/rules/session-runner.md
│   ├── docs-runner.md        # FROM: planning/specs/27-docs-as-yjs-dialback-runners.md
│   ├── shared-transport.md   # FROM: packages/shared-transport/README.md
│   ├── kata.md               # FROM: .claude/rules/kata.md + packages/kata/
│   └── mobile.md             # FROM: .claude/rules/mobile.md
├── integrations/
│   ├── index.md
│   ├── cloudflare.md         # NEW: Workers, DOs, D1, R2 footprint (see Part 2 of baseplane migration research)
│   ├── claude-agent-sdk.md   # NEW: SDK version, how runner wraps it
│   ├── better-auth.md        # NEW: D1 adapter, email-only, no GH OAuth
│   ├── capacitor.md          # NEW: Android shell, Firebase, OTA bundle pipeline
│   └── github.md             # NEW: issue/PR linking convention from chain-status-item.tsx
├── testing/
│   ├── index.md
│   ├── prod-test-users.md    # FROM: ~/.claude/projects/.../MEMORY.md — already documented
│   └── dev-up.md             # FROM: scripts/verify/dev-up.sh + .claude/rules/worktree-setup.md
└── _archive/
    └── (dropzone for dissolved layers, e.g. when a primitive is retired)
```

### Linked-but-outside (mkdocs `nav:` references them by path)

- **Rules:** `.claude/rules/index.md` + the 11 rule files (deployment, gateway, kata, mobile, etc.)
- **Specs:** `planning/specs/` — 62 specs; mkdocs nav can include the spec index page only and let users navigate from there, or list all 62 (baseplane lists `planning/specs/index.md` in nav, not individual specs)
- **Research:** `planning/research/` — 91 files; same pattern as specs
- **Progress:** `planning/progress.md`

### "Changes when" cadence (adapted to duraclaw)

| Layer        | Changes when                                                  |
|--------------|---------------------------------------------------------------|
| Theory       | A new SDK/runtime invariant lands, or an existing one breaks  |
| Primitives   | A new shared UI/UX building block stabilises                  |
| Modules      | A package is added or its surface changes                     |
| Integrations | An external dependency is added/upgraded/swapped              |
| Specs        | Per-feature, in-flight                                        |
| Rules        | A stack-level convention changes (new linter, new framework)  |

---

## Part 5 — Phased rollout

### P0 — Bootstrap (≈90 minutes)

**Goal:** A `docs.duraclaw.<domain>` URL serving an index page and empty section stubs, deployed on every push to main.

1. `mkdir -p docs/{theory,primitives,modules,integrations,testing,_archive}` and add a stub `index.md` to each.
2. Write `docs/index.md` mirroring baseplane's hierarchy table (already drafted in Part 4 above).
3. Write `mkdocs.yml`:
   ```yaml
   site_name: Duraclaw Docs
   site_url: https://docs.<chosen-domain>
   repo_url: https://github.com/baseplane-ai/duraclaw
   theme:
     name: material
     palette:
       scheme: slate
       primary: indigo
       accent: indigo
     features: [navigation.instant, navigation.tracking, content.code.copy, search.suggest]
   nav:
     - Home: index.md
     - Theory: theory/
     - Primitives: primitives/
     - Modules: modules/
     - Integrations: integrations/
     - Testing: testing/
     - Specs: '!include planning/specs/'   # via mkdocs-monorepo or use_directory_urls trick
     - Rules: '!include .claude/rules/'
     - Research: '!include planning/research/'
   plugins: [search]
   markdown_extensions: [admonition, pymdownx.superfences, pymdownx.tabbed, attr_list, tables]
   ```
   Note: pulling content from `.claude/rules/` (above docs_dir) requires either the `mkdocs-monorepo-plugin`, the `mkdocs-include-markdown-plugin`, or a build-time symlink. Pick one — symlink is simplest for P0.
4. Add `.github/workflows/docs.yml`:
   ```yaml
   on:
     push:
       branches: [main]
       paths: [docs/**, mkdocs.yml, .claude/rules/**, planning/specs/**, planning/research/**]
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-python@v5
           with: { python-version: '3.12' }
         - run: pip install mkdocs-material mkdocs-include-markdown-plugin
         - run: mkdocs build --strict
         - uses: peaceiris/actions-gh-pages@v4
           with:
             github_token: ${{ secrets.GITHUB_TOKEN }}
             publish_dir: ./site
   ```
   Caveat: this repo currently has no `.github/workflows/` (per the migration research, all deploys run from `baseplane-infra`). This would be the first GHA workflow. Check with infra owner whether docs publish should also live in `baseplane-infra` for consistency, or whether a public docs-publish workflow is fine in-repo.
5. Pick a domain. Options: `docs.duraclaw.dev` (new), `docs.baseplane.ai/duraclaw` (subpath, not natively supported by GH Pages without a redirect Worker), `duraclaw-docs.pages.dev` (CF Pages — could replace GH Pages entirely if we'd rather stay on Cloudflare). **Recommendation: CF Pages** if we already have account access — same vendor as everything else, no GH Pages infra to introduce, CNAME is internal.
6. Verify locally: `pip install mkdocs-material && mkdocs serve`.

**Exit criteria:** `mkdocs build --strict` is green, the published URL renders the index page with empty section stubs, and `--strict` is enforced in CI.

### P1 — Seed content (≈4-6 hours)

**Goal:** Each layer has at least one substantial doc; nothing is empty.

1. **Theory (highest leverage).** Move `.claude/rules/session-lifecycle.md` → `docs/theory/session-lifecycle.md` and `.claude/rules/client-data-flow.md` → `docs/theory/client-data-flow.md`. These are theory wearing rule clothing. Replace the originals with thin stubs that link to the theory docs (so `paths:` frontmatter still works for editors that look up rules by file glob). Author 3-4 new theory docs from CLAUDE.md invariants: DO authority, transport (BufferedChannel + DialBackClient), identity model, observability (logEvent / event_log).
2. **Modules.** One page per package. Source from existing READMEs and `.claude/rules/<package>.md`. Most are already half-written — this is consolidation, not authoring.
3. **Integrations.** Five short pages (Cloudflare, Anthropic SDK, Better Auth, Capacitor, GitHub). Mostly content already in `CLAUDE.md` "Tech Stack" + the recent baseplane-migration research doc.
4. **Testing.** Lift `~/.claude/projects/-data-projects-duraclaw-dev3/memory/MEMORY.md` "Prod test users" entry into `docs/testing/prod-test-users.md`. Lift `dev-up.sh` walkthrough.

**Exit criteria:** every layer has ≥1 page with real content; `mkdocs build --strict` green; no broken internal links.

### P2 — Primitives + retarget kata reviews (ongoing)

1. **Primitives layer.** This is the hardest because we have to *decide* what counts as a primitive in duraclaw. Candidates: design tokens (`.interface-design/system.md`), `ai-elements/` components, chain-status item, tab+draft yjs primitive, message-list virtualised pattern. Author one primitive doc per stable building block, with screenshot or wireframe.
2. **Retarget `theory-primitives-review.md`.** Rewrite the prompt against duraclaw's actual theory docs (the 6-7 from P1) and primitives (whatever ships in P2). This unblocks the kata spec-review workflow.
3. **Retire CLAUDE.md duplication.** Anything moved into `docs/theory/` should be replaced by a one-line link in CLAUDE.md to keep the project root signal-dense.

**Exit criteria:** `theory-primitives-review` runs on a real spec; CLAUDE.md is shorter, not longer.

---

## Part 6 — Trade-offs and risks

| Risk                                                          | Likelihood | Mitigation                                                                                  |
|---------------------------------------------------------------|------------|----------------------------------------------------------------------------------------------|
| Doc rot — content stops matching the code                     | High       | `mkdocs build --strict` in CI; quarterly "doc burn-down" pass; rules layer has `paths:` frontmatter that AI sessions auto-load |
| Hierarchy drift — people put theory in modules etc.          | Medium     | Lock the "Changes when" table in `docs/index.md`; review in PR template                     |
| Python toolchain in a Node monorepo                           | Low        | CI-only; devs who want local preview install `pip` in a venv. mkdocs is python-stable.       |
| Pulling `.claude/rules/` from above `docs_dir`                | Low        | Use `mkdocs-include-markdown-plugin` or `mkdocs-monorepo-plugin`; both well-maintained       |
| Public docs leaking sensitive content (test creds, prod URLs) | Medium     | Audit the seeded content before first publish; add `lychee` link-check to CI; never source from `.env` files |
| `theory-primitives-review` continues to misfire if not retargeted | High      | Either delete it now or commit to retargeting in P2; do not leave it in limbo               |
| GH Pages vs CF Pages decision deferred                        | Low        | Either works; recommendation is CF Pages for vendor consistency                              |
| First `.github/workflows/` in the repo collides with `baseplane-infra` deploy convention | Low | Check with infra owner; alternative is to add the docs publish step to `baseplane-infra` instead |

---

## Part 7 — Open decisions for the user

These are the choices that gate P0:

1. **Public or private docs?** Baseplane's `docs.baseplane.ai` is internal-by-meta-description but appears unauthenticated. Duraclaw equivalent could be public (cheap, easy, helpful for contributors) or private (CF Access in front, more setup). Default recommendation: **public**, mirror baseplane.
2. **Domain?** `docs.duraclaw.dev` (new domain, $11/yr), `docs.baseplane.ai/duraclaw` (subpath, needs a Worker), or `<sub>.baseplane.ai` (e.g. `dura-docs.baseplane.ai`)? Default: **dura-docs.baseplane.ai** — reuses existing zone, no new domain to register.
3. **GitHub Pages vs Cloudflare Pages?** Both work. Default recommendation: **Cloudflare Pages** for vendor consistency with the rest of the stack (Workers, DOs, D1, R2 already on CF) and to avoid introducing the first `.github/workflows/` in this repo if `baseplane-infra` is preferred for ops.
4. **Move `planning/research/` and `planning/specs/` into the docs nav, or just link the index pages?** Baseplane links the index. Defaulting to that — listing 62 specs in mkdocs nav is noise.
5. **Retire the baseplane-shaped `theory-primitives-review` prompt now or in P2?** Now would mean replacing it with a placeholder; P2 means living with a broken prompt for a few weeks. Default: **placeholder now, fill in P2.**
6. **Does this work fall under task or implementation mode when we execute it?** P0 is a small task; P1+P2 together are large enough to warrant an issue + implementation spec. I'd suggest opening a single issue ("Bootstrap docs/ with baseplane-style hierarchy") and letting P0 land via task mode, then writing an implementation spec for P1+P2.

---

## References

- baseplane docs index (probed via curl): `https://docs.baseplane.ai`
- baseplane source repo (linked from header, not accessed): `github.com/baseplane-ai/baseplane`
- mkdocs-material: `https://squidfunk.github.io/mkdocs-material/`
- duraclaw existing assets cited by path:
  - `CLAUDE.md` — Architecture / Identity / DO observability sections
  - `.claude/rules/` — 11 rule files
  - `.kata/prompts/theory-primitives-review.md` — the broken prompt
  - `planning/specs/` (62), `planning/research/` (91)
  - `.interface-design/system.md` — design tokens
  - `packages/*/README.md`
- prior research: `planning/research/2026-04-28-baseplane-to-codevibesmatter-migration.md` — relevant for the org-rename + domain decisions
