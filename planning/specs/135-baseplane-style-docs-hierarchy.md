---
initiative: docs-hierarchy
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 135
created: 2026-04-28
updated: 2026-04-28
research:
  - planning/research/2026-04-28-baseplane-style-docs-stack.md
phases:
  - id: p0
    name: "Skeleton — docs/ tree + index pages"
    tasks:
      - "Create directory tree: `docs/{theory,primitives/{ui,arch},modules,integrations,testing,_archive}/`"
      - "Write `docs/index.md`: hierarchy table (Theory/Primitives/Modules/Integrations/Specs/Rules with Location + Contents + Changes-When), Layer Tests table (Survives-X-but-not-Y per layer), Disambiguation Shortcuts list (5 bullets), and a one-paragraph note disambiguating `docs/` (this knowledge tree, plain markdown) from `packages/docs-runner/` (the live yjs collaborative-document feature, unrelated)"
      - "Write `docs/theory/index.md` stub. The body MUST contain the canonical sentence verbatim: \"New theory content must fit one of these categories — if it doesn't, the categories need revision, not a new file.\" (this exact string is grepped by V2). Surround it with the framing prose: 'Theory documents what must be true about duraclaw — zero implementation references (no internal file paths, no class names, no import paths), with a carve-out for named external dependencies in `boundaries.md` and where their existence shapes an invariant elsewhere. The 6 categorical files below are fixed.' Then list the 6 forthcoming files."
      - "Write `docs/primitives/index.md` stub stating the layer test (Survives a stack rewrite but NOT a UI redesign) and naming the two sublayers (`ui/`, `arch/`) with the disambiguation rule: UI = visual structure or interaction pattern; Arch = abstract building block independent of UI"
      - "Write `docs/modules/index.md` stub stating the module test (nav entry / package surface + cohesive responsibility + single domain question) and the convention `docs/modules/{package}.md` flat + `INVENTORY.md`"
      - "Write `docs/integrations/index.md` stub: 'Reference data for external services duraclaw integrates with — versions, scopes, footprints, gotchas. One file per integration.'"
      - "Write `docs/testing/index.md` stub: 'Manual testing recipes that don't fit in package READMEs — long-lived test data, walkthroughs, environment recipes.'"
      - "Write `docs/_archive/index.md` stub: 'Dropzone for dissolved layers and superseded docs. Keeps the trail for git-blame and reading-order recovery without polluting active layers.'"
    test_cases:
      - "`find docs -type d | sort` matches the expected tree (8 directories including `docs/`, both primitive sublayers, _archive)"
      - "`find docs -name 'index.md' -type f | wc -l` ≥ 8"
      - "`grep -F 'Survives' docs/index.md` matches (placement-tests table present)"
      - "`grep -F 'packages/docs-runner' docs/index.md` matches (disambiguation note present)"
  - id: p1
    name: "Seed Theory + Modules + Integrations + Testing; atomic Rules→Theory split"
    estimated_sessions: "2-3"
    suggested_split: "P1a = theory (6 files) + atomic rules→theory split (2 files); P1b = modules (8 files) + integrations (5 files) + testing (2 files). Land P1a first as a coherent rules→theory migration; P1b is per-package documentation that can be parallelised across implementation sessions."
    tasks:
      - "Author `docs/theory/domains.md`: entity types in duraclaw — sessions, identities, projects, worktrees, runners, gates. For each: definition + ownership + lifecycle phase set (e.g. session: idle/spawning/running/awaiting-gate/cooled-down). No file paths, no class names. Source: extract invariants from `CLAUDE.md` and the entity references across `apps/orchestrator/src/db/schema.ts`."
      - "Author `docs/theory/data.md`: state-authority model — DO SQLite is the durable truth-gate; D1 `agent_sessions` is the idle/background fallback; OPFS-backed TanStack DB collections are client-side reactive caches; SDK transcript files mirror DO `session_transcript` (migration v17+). Lossless resume = SessionStore reads transcript. Source: merge `.claude/rules/client-data-flow.md` invariants (DO-authoritative status frame stamping; sessionStatus extraction; sessionLocalCollection role) with CLAUDE.md 'Identity Management' section. NO library/file mentions in prose."
      - "Author `docs/theory/dynamics.md`: how work moves — spawn (DO triggerGatewayDial → POST /sessions/start → detached runner → dial-back); follow-up (stream-input or resume or forkWithHistory orphan path); reaper (>30min idle = SIGTERM/grace/SIGKILL); failover (rate_limit → cooldown identity → resume under next LRU identity); gate lifecycle (ask_user / permission_request → resolve-gate). Source: merge `.claude/rules/session-lifecycle.md` content with CLAUDE.md 'session-lifecycle' rule excerpt. NO file paths in prose."
      - "Author `docs/theory/topology.md`: system layout — Browser → CF Worker (Vite SPA + Hono routes + Auth) → SessionDO (1 per session, owns SQLite history + event_log) → agent-gateway (VPS systemd, spawn/list/reap only, never the SDK host) → session-runner (per session, owns one SDK query, dials DO via shared-transport). Mobile shell is a thin Capacitor client over the Worker. Each box's responsibility, the directionality of every edge, and what survives each side's restart (DO redeploy / gateway restart / runner crash / Worker redeploy). Source: CLAUDE.md 'Architecture' diagram + 'Key invariants' bullets."
      - "Author `docs/theory/trust.md`: token boundaries — Better Auth session cookie (browser ↔ Worker, email/password only, no GitHub OAuth); CC_GATEWAY_API_TOKEN bearer (Worker ↔ gateway, timing-safe compare, open-if-unset for dev); active_callback_token per session (DO ↔ runner via wss URL query param, timing-safe compared at WS accept, single-shot per spawn); DOCS_RUNNER_SECRET bearer (docs-runner role on collab WS); identity HOMEs (per-runner HOME directory contains `~/.claude/.credentials.json`, no cross-identity bleed via process env). Source: `apps/orchestrator/src/lib/auth.ts:47-74`, gateway auth code, DO onConnect handlers. Pure invariant prose, no implementation references."
      - "Author `docs/theory/boundaries.md`: external dependencies that shape duraclaw — claude-agent-sdk (the SDK we wrap; its session file is the resume contract); Cloudflare (Workers + Durable Objects + D1 + R2 — runtime constraints: 30s wall, 128MB, no Node APIs); GitHub (issue/PR linking convention, no OAuth dependency); Capacitor + Firebase (mobile shell + push); Better Auth (D1 adapter, email-password). For each: what duraclaw assumes about it, and what would break if it changed. Source: CLAUDE.md 'Tech Stack' + `planning/research/2026-04-28-baseplane-to-codevibesmatter-migration.md` for CF/GH coupling depth."
      - "**Atomic rules→theory split for `session-lifecycle.md`:** in ONE commit, (a) ensure dynamics content is in `docs/theory/dynamics.md`, (b) replace `.claude/rules/session-lifecycle.md` body with a thin stub: keep the `paths:` frontmatter (whatever it contains), then a 1-line explainer ('Implementation pointers for session lifecycle. Invariants live in `docs/theory/dynamics.md`.') followed by 3-6 bullet pointers to actual code paths (e.g. `apps/orchestrator/src/agents/session-do.ts`, runner spawn handlers). Result: `wc -l .claude/rules/session-lifecycle.md` < 15."
      - "**Atomic rules→theory split for `client-data-flow.md`:** same pattern — invariant content in `docs/theory/data.md`, rule file becomes a stub with `paths:` frontmatter + 1-line explainer + code pointers (`apps/orchestrator/src/hooks/use-session-status.ts`, `apps/orchestrator/src/collections/`, etc.). Result: `wc -l .claude/rules/client-data-flow.md` < 15."
      - "Author `docs/modules/orchestrator.md`: package surface — what apps/orchestrator owns (Worker entrypoint, all DO classes, Hono routes under /api/, React 19 + TanStack Router SPA, Better Auth, D1 schema). Source: existing `.claude/rules/orchestrator.md` + `apps/orchestrator/scripts/README.md`. Module test: nav entry = `dura.baseplane.ai`; entity cluster = sessions/identities/projects; domain question = 'where do user sessions live and how do they sync?'"
      - "Author `docs/modules/agent-gateway.md`: source = `.claude/rules/gateway.md` (already comprehensive). Add the module-test section."
      - "Author `docs/modules/session-runner.md`: source = `.claude/rules/session-runner.md` + `packages/session-runner/src/main.ts` surface. Module test."
      - "Author `docs/modules/docs-runner.md`: source = spec `planning/specs/27-docs-as-yjs-dialback-runners.md` + `packages/docs-runner/src/main.ts`. Disambiguation note at top: 'Distinct from `docs/` knowledge tree.'"
      - "Author `docs/modules/shared-transport.md`: source = `packages/shared-transport/README.md`. Note: BufferedChannel and DialBackClient may eventually graduate to `docs/primitives/arch/` in P2 — for now they are the module's surface."
      - "Author `docs/modules/kata.md`: source = `.claude/rules/kata.md` + `packages/kata/README.md`. Module test."
      - "Author `docs/modules/mobile.md`: source = `.claude/rules/mobile.md`. Module test."
      - "Author `docs/modules/INVENTORY.md`: table with columns `Module | Package | Domain Question | Owns | Consumes`. One row per module above."
      - "Author `docs/integrations/cloudflare.md`: Workers (account ID via env), DOs (5 classes, 7 migration tags), D1 (`duraclaw-auth`), R2 (`duraclaw-mobile`, `duraclaw-session-media`), custom domain `dura.baseplane.ai`. Source: `apps/orchestrator/wrangler.toml` + the migration research doc."
      - "Author `docs/integrations/claude-agent-sdk.md`: package version, where session files live (project-scoped on disk), the resume contract, hooks duraclaw uses (SessionStore, query()). Source: `packages/session-runner/package.json` + `packages/session-runner/src/`."
      - "Author `docs/integrations/better-auth.md`: D1 adapter, email-password only, no GitHub OAuth provider. Source: `apps/orchestrator/src/lib/auth.ts:47-74`."
      - "Author `docs/integrations/capacitor.md`: SDK version, Android shell only (iOS deferred), Firebase `google-services.json`, OTA bundle pipeline (R2 `duraclaw-mobile`). Source: `apps/mobile/` + CLAUDE.md mobile section + `scripts/build-mobile-ota-bundle.sh`."
      - "Author `docs/integrations/github.md`: issue/PR linking convention via `GH_REPO` constant; no OAuth. Source: `apps/orchestrator/src/components/chain-status-item.tsx:58`."
      - "Author `docs/testing/prod-test-users.md`: 3 admin users seeded via /api/bootstrap; creds in `.env.test-users.prod` per worktree; BOOTSTRAP_TOKEN left set on prod Worker. Source: user MEMORY.md 'Prod test users' entry."
      - "Author `docs/testing/dev-up.md`: walkthrough of `scripts/verify/dev-up.sh` — what it generates (`.dev.vars`), what it starts (gateway + orchestrator), the worktree port-derivation rule. Source: `.claude/rules/worktree-setup.md` + the script."
    test_cases:
      - "`ls docs/theory/*.md | wc -l` returns 7 (6 categorical + index.md)"
      - "`ls docs/modules/*.md | wc -l` returns 8 (7 modules + INVENTORY.md)"
      - "`ls docs/integrations/*.md | wc -l` returns 6 (5 integrations + index.md)"
      - "`ls docs/testing/*.md | wc -l` returns 3 (2 testing + index.md)"
      - "`wc -l .claude/rules/session-lifecycle.md` < 15 AND `grep -F 'docs/theory/dynamics.md' .claude/rules/session-lifecycle.md` matches"
      - "`wc -l .claude/rules/client-data-flow.md` < 15 AND `grep -F 'docs/theory/data.md' .claude/rules/client-data-flow.md` matches"
      - "Theory invariant cross-check: `grep -rE '(packages/|apps/|src/|\\.ts|\\.tsx)' docs/theory/` returns 0 matches (zero file paths in theory prose)"
      - "Cross-link check: every `docs/modules/*.md` references at least one `docs/theory/*.md` doc; every `docs/integrations/*.md` references at least one module"
  - id: p2
    name: "Primitives + CLAUDE.md aggressive trim + retarget kata prompt"
    tasks:
      - "Author `docs/primitives/ui/index.md`: layer test ('survives a stack rewrite but NOT a UI redesign'), list of UI primitives below. Cite that the existing `.interface-design/system.md` is the design-tokens primitive."
      - "Author `docs/primitives/ui/design-system.md`: lift `.interface-design/system.md` content + add a 'Where this lives in code' pointer. Concept + tokens + tone, no Tamagui-specific syntax."
      - "Author `docs/primitives/ui/ai-elements.md`: catalog of `packages/ai-elements/` components by behavior contract (e.g. 'Message — renders a turn with optional tool-use children, supports streaming partials'). Wireframe-level descriptions, no React imports."
      - "Author `docs/primitives/ui/chain-status.md`: behavior contract for the chain-status item — what states it has, what each communicates, what triggers transitions. Source: `apps/orchestrator/src/components/chain-status-item.tsx`. Stack-independent."
      - "Author `docs/primitives/ui/tabs-and-drafts.md`: behavior contract for the tab+draft yjs primitive — collaborative draft, presence, conflict resolution. Source: `planning/specs/3-yjs-multiplayer-draft-collab.md` + the merged spec series 5/8/12."
      - "Author `docs/primitives/arch/index.md`: layer test (same — survives stack rewrite, not UI redesign). Note: arch primitives are baseplane-style platform primitives, not infrastructure."
      - "Author `docs/primitives/arch/buffered-channel.md`: monotonic-seq ring buffer with overflow-emits-gap-sentinel semantic. Source: `packages/shared-transport/src/buffered-channel.ts`. Stack-independent — a different transport library would still need this primitive."
      - "Author `docs/primitives/arch/dial-back-client.md`: child-dials-parent WS pattern with reconnect backoff (1/3/9/27/30s). Behavior contract, not implementation."
      - "Author `docs/primitives/arch/synced-collections.md`: TanStack-DB-collection ↔ DO ↔ D1 sync pattern — write-through to D1, broadcast back to all peers, resync on reconnect. Source: `apps/orchestrator/src/collections/` + spec 35-agent-sessions-synced-collection."
      - "Author `docs/primitives/arch/dialback-runner.md`: detached-spawn-with-dialback pattern (gateway spawns; runner dials DO; gateway restart is a non-event). Source: this is the cross-cutting pattern across session-runner and docs-runner."
      - "**CLAUDE.md aggressive trim:** retain (top to bottom) — title + Project Overview (2 sentences), Architecture diagram (keep), Monorepo Structure (keep), Tech Stack as a links table to docs/integrations/, Key Commands (keep), Conventions (keep — short), one-paragraph 'Where docs live' digest with links: `docs/theory/` (invariants), `docs/primitives/` (building blocks), `docs/modules/` (per-package surfaces), `docs/integrations/` (external deps), `planning/specs/` (in-flight features), `.claude/rules/` (code-level patterns). REMOVE: 'Identity Management' detailed prose (now in `docs/theory/data.md` + `docs/theory/trust.md`), 'DO observability' detailed prose (now in `docs/theory/topology.md` or as a new `observability.md` if we extend the 6 categories — DO NOT add a 7th category, fold it into topology). Result target: `wc -l CLAUDE.md` between 80 and 130 (currently ~155)."
      - "**Retarget `.kata/prompts/theory-primitives-review.md`:** rewrite the Theory section to reference duraclaw's actual 6 categorical files (`docs/theory/{domains,data,dynamics,topology,trust,boundaries}.md`) and what each covers. Rewrite the Platform Primitives section as a table that maps the OLD baseplane primitives to duraclaw equivalents (DataForge → Drizzle/D1 schema; Relationships → Drizzle relations; Workflows → DO state machines + kata phases; Templates → `planning/spec-templates/`; CommandBus → TanStack DB collection writes + WS dispatch; EventBus → DialBackClient + BufferedChannel) so a reviewer flags spec violations against duraclaw's primitives, not baseplane's. Add a new 'UI Primitives' section listing `docs/primitives/ui/` entries. Strip every reference to non-existent baseplane files."
      - "Run the retargeted review prompt against one existing duraclaw spec (e.g. `planning/specs/119-session-store-failover.md`) as a smoke test; do not commit the review output, just confirm the prompt produces a sane critique that references real duraclaw theory docs."
    test_cases:
      - "`ls docs/primitives/ui/*.md | wc -l` ≥ 4 (index + 3+ primitives)"
      - "`ls docs/primitives/arch/*.md | wc -l` ≥ 4 (index + 3+ primitives)"
      - "`wc -l CLAUDE.md` returns a value between 80 and 130"
      - "`grep -E '(DataForge|CommandBus|EventBus|domains\\.md|data\\.md|dynamics\\.md|experience\\.md|governance\\.md|boundaries\\.md)' .kata/prompts/theory-primitives-review.md` returns ONLY references that explicitly say `docs/theory/{name}.md` (i.e. duraclaw paths) or describe the baseplane→duraclaw primitive map; no orphan baseplane references"
      - "Smoke test: invoke the retargeted prompt against `planning/specs/119-session-store-failover.md`; review output mentions at least one of `docs/theory/data.md`, `docs/theory/trust.md`, or `docs/theory/dynamics.md`"
      - "CLAUDE.md still contains the architecture diagram + monorepo structure + key commands (regression check)"
---

## Overview

Adopt baseplane's layered docs hierarchy (Theory → Primitives → Modules → Integrations + Specs + Rules) as in-repo markdown under `docs/`, so the kata workflow's `theory-primitives-review` prompt has real duraclaw theory + primitives to review against, and so future readers find a stable home for each kind of knowledge instead of grep-spelunking through `CLAUDE.md`, scattered package READMEs, and ambiguously-categorised `.claude/rules/` files. No renderer, no docs site, no publish workflow — this is purely organisational.

## Feature Behaviors

### B1: docs/ skeleton with hierarchy index

**Core:**
- **ID:** docs-skeleton
- **Trigger:** P0 directories created and committed
- **Expected:** `docs/{theory,primitives/{ui,arch},modules,integrations,testing,_archive}/` exist; each layer has an `index.md` stub stating its purpose; `docs/index.md` carries (1) a hierarchy table with exactly 6 rows — Theory, Primitives, Modules, Integrations, Specs, Rules — each with Location + Contents + Changes-When columns; (2) a Layer Tests table covering the same 5 in-tree layers + Specs + Rules ("Survives X but not Y" placement test per layer); (3) a Disambiguation Shortcuts list with 5 bullets (file path / class name / abstract invariant / wireframe / domain entity / single-issue scope); (4) a paragraph disambiguating `docs/` (knowledge tree) from `packages/docs-runner/` (live yjs feature). Note: Testing and `_archive/` are sibling concerns (manual recipes / dropzone) and do NOT get rows in the main hierarchy table — they're called out separately at the bottom of `docs/index.md`.
- **Verify:** `find docs -type d | sort` matches expected tree (8 dirs); `find docs -name 'index.md' | wc -l` ≥ 8; `grep -F 'Survives' docs/index.md` matches; `grep -F 'packages/docs-runner' docs/index.md` matches; `grep -cE '^\| \*\*(Theory|Primitives|Modules|Integrations|Specs|Rules)\*\*' docs/index.md` returns 6.

#### Data Layer
8 new directories at repo root under `docs/`. 8 new `index.md` files. No code, no schema changes.

---

### B2: Theory layer is exactly 6 fixed categorical files

**Core:**
- **ID:** theory-six-categories
- **Trigger:** P1 theory authoring complete.
- **Expected:** `docs/theory/{domains,data,dynamics,topology,trust,boundaries}.md` exist with substantive content describing duraclaw invariants. **The theory/code firewall:** zero implementation references — no file paths, no class names, no import paths, no component names. **Carve-out for external dependencies:** named externals (claude-agent-sdk, Cloudflare, D1, R2, Better Auth, Capacitor, GitHub, Firebase) ARE permitted because they are the subject matter of `boundaries.md` and may appear in `domains.md`/`data.md` where their existence shapes an invariant. The firewall is about *implementation* references (our code), not *boundary* references (their code we depend on). `docs/theory/index.md` states the discipline: new theory content must fit one of the 6 categories or the categories need revision (not a new file).
- **Verify:** `ls docs/theory/*.md` returns exactly 7 files (6 + index); `grep -rE '(packages/|apps/|src/|\.ts:|\.tsx:)' docs/theory/` returns 0 matches (no internal file paths); `grep -F "New theory content must fit one of these categories — if it doesn't, the categories need revision, not a new file." docs/theory/index.md` matches.

#### Data Layer
6 new theory files + index. Each has YAML frontmatter `category: {name}` for future tooling.

---

### B3: Atomic Rules→Theory split for the two mis-categorised rule files

**Core:**
- **ID:** rules-theory-split
- **Trigger:** P1 atomic split commit lands.
- **Expected:** In a single commit per file, the invariant prose from `.claude/rules/session-lifecycle.md` is in `docs/theory/dynamics.md` and the rule file becomes a thin stub (≤15 lines) with `paths:` frontmatter preserved, a 1-line link to `docs/theory/dynamics.md`, and 3-6 bullets pointing at concrete code locations. Same pattern for `.claude/rules/client-data-flow.md` → `docs/theory/data.md`.
- **Verify:** `wc -l .claude/rules/session-lifecycle.md` < 15; `grep -F 'docs/theory/dynamics.md' .claude/rules/session-lifecycle.md` matches; `head -1 .claude/rules/session-lifecycle.md` shows `---` (frontmatter retained); same trio for the other file. Optionally: `git log -p --follow` shows both move + stub-replace as adjacent commits.
**Source:** `.claude/rules/session-lifecycle.md`, `.claude/rules/client-data-flow.md`

#### Data Layer
Two `.claude/rules/*.md` files shrink to stubs. Two `docs/theory/*.md` files absorb the invariant prose. AI sessions that previously matched the rule via `paths:` frontmatter still match — the stub is small but not gone.

---

### B4: Modules layer — flat one-file-per-package + INVENTORY.md

**Core:**
- **ID:** modules-flat
- **Trigger:** P1 modules authoring complete.
- **Expected:** `docs/modules/{orchestrator,agent-gateway,session-runner,docs-runner,shared-transport,kata,mobile}.md` exist (7 files), each with a "module test" section (nav-entry / package-surface / cohesive-responsibility / single-domain-question), a 'Owns' bullet list, a 'Consumes' bullet list, and links into `docs/theory/` and `docs/integrations/` where relevant. `docs/modules/INVENTORY.md` is a table with columns `Module | Package | Domain Question | Owns | Consumes` and one row per module.
- **Verify:** `ls docs/modules/*.md` returns 8 files; `grep -F 'Domain Question' docs/modules/INVENTORY.md` matches; `wc -l docs/modules/INVENTORY.md` returns ≤ 30 lines.

#### Data Layer
8 new files under `docs/modules/`. No code.

---

### B5: Integrations layer — one file per external dependency

**Core:**
- **ID:** integrations-layer
- **Trigger:** P1 integrations authoring complete.
- **Expected:** `docs/integrations/{cloudflare,claude-agent-sdk,better-auth,capacitor,github}.md` exist (5 files), each with sections: Version + Footprint + Assumptions duraclaw makes + What would break if it changed.
- **Verify:** `ls docs/integrations/*.md` returns 6 files (5 + index); each file contains a heading `## Assumptions` and `## What would break if`.

---

### B6: Testing layer — manual recipes

**Core:**
- **ID:** testing-layer
- **Trigger:** P1 testing authoring complete.
- **Expected:** `docs/testing/{prod-test-users,dev-up}.md` exist; `prod-test-users.md` content matches the user MEMORY.md entry (BOOTSTRAP_TOKEN, `.env.test-users.prod` per worktree); `dev-up.md` walks through `scripts/verify/dev-up.sh` and the worktree-port-derivation rule.
- **Verify:** `ls docs/testing/*.md` returns 3 files; `grep -F 'BOOTSTRAP_TOKEN' docs/testing/prod-test-users.md` matches; `grep -F 'dev-up.sh' docs/testing/dev-up.md` matches.

---

### B7: _archive/ exists and is empty (P0); used as dropzone (later)

**Core:**
- **ID:** archive-dropzone
- **Trigger:** P0 skeleton.
- **Expected:** `docs/_archive/` exists with an `index.md` stub stating the dropzone convention. No content yet (we have no dissolved layers to archive in this spec).
- **Verify:** `ls docs/_archive/` returns `index.md` only; `cat docs/_archive/index.md | grep -F 'dropzone'` matches.

---

### B8: Primitives layer — UI / Arch sublayers, ≥3 primitives each

**Core:**
- **ID:** primitives-ui-arch
- **Trigger:** P2 primitives authoring complete.
- **Expected:** `docs/primitives/ui/` contains at least `index.md`, `design-system.md`, `ai-elements.md`, plus 1-2 more from {chain-status, tabs-and-drafts}. `docs/primitives/arch/` contains at least `index.md`, `buffered-channel.md`, `dial-back-client.md`, plus 1-2 more from {synced-collections, dialback-runner}. Each primitive doc passes the layer test: stack-independent, no library imports, no component names.
- **Verify:** `ls docs/primitives/ui/*.md | wc -l` ≥ 4; `ls docs/primitives/arch/*.md | wc -l` ≥ 4; `grep -rE 'import |from \"@' docs/primitives/` returns 0 matches.

---

### B9: CLAUDE.md aggressively trimmed to a digest

**Core:**
- **ID:** claude-md-digest
- **Trigger:** P2 CLAUDE.md trim commit.
- **Expected:** CLAUDE.md retains: title, 2-sentence Project Overview, Architecture diagram, Monorepo Structure, Tech Stack table (with links into `docs/integrations/`), Key Commands, Conventions, and a 'Where docs live' digest with links to all 6 layers. Removed: long-form 'Identity Management' prose (now in theory/data + theory/trust), long-form 'DO observability' prose (now in theory/topology). Total length 80-130 lines (window widened from initial 80-120 estimate to allow architecture diagram + monorepo tree to render in full without forcing micro-trims).
- **Verify:** `wc -l CLAUDE.md` returns a value in [80, 130]; `grep -F 'docs/theory/' CLAUDE.md` matches; `grep -F 'Identity Management' CLAUDE.md | wc -l` ≤ 1 (heading at most, no prose section).
**Source:** `CLAUDE.md`

---

### B10: kata theory-primitives-review prompt retargeted

**Core:**
- **ID:** kata-prompt-retarget
- **Trigger:** P2 prompt rewrite committed.
- **Expected:** `.kata/prompts/theory-primitives-review.md` references duraclaw's 6 theory categories and the duraclaw primitive map (the baseplane→duraclaw equivalence table from the research doc). No orphan references to baseplane theory files (`domains.md`/`data.md`/etc unqualified) or baseplane primitives (DataForge/CommandBus/EventBus) without the duraclaw mapping context. Smoke-test running the prompt against `planning/specs/119-session-store-failover.md` produces a critique that names actual duraclaw theory docs.
- **Verify:** `grep -E 'DataForge|CommandBus|EventBus' .kata/prompts/theory-primitives-review.md` only matches lines that ALSO contain `→` or `duraclaw` (i.e. the mapping table); `grep -F 'docs/theory/' .kata/prompts/theory-primitives-review.md | wc -l` ≥ 6.
**Source:** `.kata/prompts/theory-primitives-review.md`

---

## Non-Goals

- **No docs site.** No `mkdocs.yml`, no GitHub Pages, no Cloudflare Pages, no publish workflow, no domain. The deliverable is plain markdown that renders fine in GitHub and editors.
- **No move of `planning/specs/` or `planning/research/`.** They stay under `planning/` (Specs is already a layer; Research has no baseplane analogue and 91 files would swamp any nav).
- **No move of `planning/reviews/`, `planning/verify/`, `planning/evidence/`.** These are kata workflow artefacts, not knowledge layers.
- **No new theory category beyond the 6.** Observability is folded into Topology, not given its own file. If it doesn't fit, the categories need revision in a future spec — not a 7th file in this one.
- **No 'Verticals' layer.** Baseplane has `docs/verticals/` for industry configurations (construction, healthcare). Duraclaw is one product with one shape; no verticals.
- **No retargeting of other kata prompts.** Only `theory-primitives-review.md` is rewritten in this spec. `code-review.md`, `spec-review.md`, etc. are out of scope.
- **No addition of a `paths:` auto-loader mechanism.** The `paths:` frontmatter is a convention. If we want it to drive automatic context-loading later, that's a separate spec.
- **No migration of the existing 11 `.claude/rules/` files except the two theory-shaped ones.** Other rules (deployment, gateway, kata, mobile, orchestrator, session-runner, shared-transport, testing, worktree-setup) stay as-is — they are correctly rule-shaped.
- **No commit-template / PR-template enforcement of layer placement.** The discipline is documented in `docs/index.md`; enforcement is human.

## Verification Plan

A fresh agent runs these literal commands in order. All must pass.

### V1 — P0 skeleton
```bash
test "$(find docs -type d | sort)" = "$(printf 'docs\ndocs/_archive\ndocs/integrations\ndocs/modules\ndocs/primitives\ndocs/primitives/arch\ndocs/primitives/ui\ndocs/testing\ndocs/theory')"
test "$(find docs -name 'index.md' -type f | wc -l)" -ge 8
grep -F 'Survives' docs/index.md
grep -F 'packages/docs-runner' docs/index.md
grep -F "New theory content must fit one of these categories — if it doesn't, the categories need revision, not a new file." docs/theory/index.md
grep -F 'survives a stack rewrite' docs/primitives/index.md
grep -F 'dropzone' docs/_archive/index.md
```

### V2 — Theory layer (B2)
```bash
test "$(ls docs/theory/*.md | wc -l)" -eq 7
for f in domains data dynamics topology trust boundaries; do
  test -s "docs/theory/$f.md" || { echo "MISSING: docs/theory/$f.md"; exit 1; }
done
# Theory contains zero implementation references:
test "$(grep -rE '(packages/|apps/|src/|\.ts:|\.tsx:)' docs/theory/ | wc -l)" -eq 0
```

### V3 — Rules→Theory split (B3)
```bash
test "$(wc -l < .claude/rules/session-lifecycle.md)" -lt 15
test "$(wc -l < .claude/rules/client-data-flow.md)" -lt 15
grep -F 'docs/theory/dynamics.md' .claude/rules/session-lifecycle.md
grep -F 'docs/theory/data.md' .claude/rules/client-data-flow.md
head -1 .claude/rules/session-lifecycle.md | grep -F '---'
head -1 .claude/rules/client-data-flow.md | grep -F '---'
# Original prose is preserved in theory:
grep -F 'DO-authoritative' docs/theory/data.md
```

### V4 — Modules layer (B4)
```bash
test "$(ls docs/modules/*.md | wc -l)" -eq 8
for m in orchestrator agent-gateway session-runner docs-runner shared-transport kata mobile; do
  test -s "docs/modules/$m.md" || { echo "MISSING: docs/modules/$m.md"; exit 1; }
done
grep -F 'Domain Question' docs/modules/INVENTORY.md
# Each module has the test section:
for m in orchestrator agent-gateway session-runner docs-runner shared-transport kata mobile; do
  grep -F 'Module Test' "docs/modules/$m.md" >/dev/null || { echo "$m missing module test"; exit 1; }
done
```

### V5 — Integrations + Testing (B5, B6)
```bash
test "$(ls docs/integrations/*.md | wc -l)" -eq 6
for i in cloudflare claude-agent-sdk better-auth capacitor github; do
  test -s "docs/integrations/$i.md" || { echo "MISSING: $i"; exit 1; }
  grep -F '## Assumptions' "docs/integrations/$i.md" >/dev/null || { echo "$i missing Assumptions"; exit 1; }
  grep -F '## What would break if' "docs/integrations/$i.md" >/dev/null || { echo "$i missing 'What would break if'"; exit 1; }
done
test "$(ls docs/testing/*.md | wc -l)" -eq 3
grep -F 'BOOTSTRAP_TOKEN' docs/testing/prod-test-users.md
grep -F 'dev-up.sh' docs/testing/dev-up.md
```

### V6 — Primitives layer (B8)
```bash
test "$(ls docs/primitives/ui/*.md | wc -l)" -ge 4
test "$(ls docs/primitives/arch/*.md | wc -l)" -ge 4
# No code imports leaked into primitives:
test "$(grep -rE '^import |from \"@' docs/primitives/ | wc -l)" -eq 0
# Specific primitives present:
test -s docs/primitives/ui/design-system.md
test -s docs/primitives/ui/ai-elements.md
test -s docs/primitives/arch/buffered-channel.md
test -s docs/primitives/arch/dial-back-client.md
```

### V7 — CLAUDE.md trim (B9)
```bash
LINES=$(wc -l < CLAUDE.md)
test "$LINES" -ge 80 && test "$LINES" -le 130 || { echo "CLAUDE.md is $LINES lines, want 80-130"; exit 1; }
grep -F 'docs/theory/' CLAUDE.md
grep -F '## Architecture' CLAUDE.md
grep -F '## Monorepo Structure' CLAUDE.md
grep -F '## Key Commands' CLAUDE.md
# Long-form Identity Management prose removed (heading-only is OK):
test "$(grep -F 'Identity Management' CLAUDE.md | wc -l)" -le 1
```

### V8 — Kata prompt retarget (B10)
```bash
grep -F 'docs/theory/' .kata/prompts/theory-primitives-review.md | wc -l | xargs -I{} test {} -ge 6
# Baseplane-specific terms only appear in the mapping context:
for term in DataForge CommandBus EventBus; do
  if grep -F "$term" .kata/prompts/theory-primitives-review.md >/dev/null; then
    grep -F "$term" .kata/prompts/theory-primitives-review.md | grep -E '(→|duraclaw|maps to)' >/dev/null \
      || { echo "$term appears without duraclaw mapping context"; exit 1; }
  fi
done
```

### V9 — Smoke-test the retargeted prompt
Run the kata `theory-primitives-review` skill against `planning/specs/119-session-store-failover.md`. Expected output: a critique that references at least one duraclaw theory file (`docs/theory/data.md`, `docs/theory/trust.md`, or `docs/theory/dynamics.md`). Do not commit the critique; this is a manual smoke test.

### V10 — Cross-link sanity (run AFTER P2 only)

V10 is a final-state check. It scans the entire repo for broken `docs/*.md` links, including from primitive paths that don't exist until P2. Running V10 at the end of P1 will fail on any forward-reference to a P2 primitive. Constraint on P1 implementers: **module docs written in P1 must only link to files that exist after P1** (i.e. theory/, modules/, integrations/, testing/) — *not* to primitives. The "may eventually graduate to docs/primitives/arch/" note in `shared-transport.md`'s P1 task is prose, not a link, by design.

```bash
# Every module doc links into theory or integrations (linkable in P1):
for f in docs/modules/{orchestrator,agent-gateway,session-runner,docs-runner,shared-transport,kata,mobile}.md; do
  grep -E 'docs/(theory|integrations)/' "$f" >/dev/null || { echo "$f has no cross-links"; exit 1; }
done
# No broken internal links to docs/ paths anywhere they're referenced:
for link in $(grep -rohE 'docs/[a-z_/-]+\.md' docs/ CLAUDE.md .claude/rules/ .kata/prompts/ | sort -u); do
  test -f "$link" || { echo "BROKEN LINK: $link"; exit 1; }
done
```

## Implementation Hints

### Key sources to read first
- **Research doc (this spec's foundation):** `planning/research/2026-04-28-baseplane-style-docs-stack.md` — full gap analysis, baseplane→duraclaw primitive map, IA proposal.
- **Baseplane indices for shape reference (read via `curl https://docs.baseplane.ai/{theory,primitives,modules}/`):**
  - `/theory/` — six fixed categorical files discipline
  - `/primitives/` — layer test ("survives stack rewrite, not UI redesign"), complex-primitive-as-directory pattern, disambiguation shortcuts
  - `/modules/` — module test (nav-entry / entity cluster / single domain question), Module Placement Eval (5 questions, score against parents), domain-vs-platform-module split
- **Existing CLAUDE.md "Architecture" + "Identity Management" + "DO observability" sections** are the primary sources for theory content.
- **`.claude/rules/session-lifecycle.md` and `.claude/rules/client-data-flow.md`** are the *primary sources* for `dynamics.md` and `data.md` respectively. The split is "lift content, leave a stub."

### Code patterns

**1. Rule-stub-pointing-at-theory pattern** (for B3):
```md
---
paths:
  - "apps/orchestrator/src/agents/session-do.ts"
  - "apps/orchestrator/src/agents/**"
  - "packages/session-runner/src/**"
---

# Session lifecycle (rule stub)

Invariants live in [`docs/theory/dynamics.md`](../../docs/theory/dynamics.md). This file just points at code.

- DO entrypoint: `apps/orchestrator/src/agents/session-do.ts`
- Runner entrypoint: `packages/session-runner/src/main.ts`
- Reaper: `packages/agent-gateway/src/reaper.ts`
- Failover (rate-limit cooldown): `apps/orchestrator/src/agents/session-do.ts` — `recordRateLimit()`
```

**2. Module file template** (for B4):
```md
# {Package name}

Source package: `packages/{name}/` or `apps/{name}/`.

## Module Test
- **Nav entry / surface:** {what users / other modules see}
- **Owns:** {entities and lifecycles}
- **Domain question:** {single question this module answers}

## Owns
- {entity 1}
- {entity 2}

## Consumes
- [`docs/primitives/arch/buffered-channel.md`]
- [`docs/integrations/cloudflare.md`]

## Theory references
- [`docs/theory/topology.md`] — where this module sits in the system
- [`docs/theory/dynamics.md`] — relevant lifecycle phases
```

**3. Theory file template** (for B2):
```md
---
category: dynamics
---

# Dynamics

> How work moves through duraclaw.

(Pure invariant prose. No file paths. No library names. No component names.)

## Spawn

A new session is born when {condition}. The DO is authoritative for spawn intent; the gateway is the spawn mechanism. Once a runner has dial-backed, the gateway's restart is a non-event for the runner — the gateway is not in the message path.

## Follow-up
...

## Reaper
...

## Failover
...
```

### Gotchas

- **`paths:` frontmatter must be retained** in the rule stubs — losing it changes which files AI sessions auto-attach the rule to. Carry the frontmatter from the original rule file verbatim into the stub.
- **`docs/theory/` is not allowed to reference code paths.** This is the *whole point* of theory. The verification check (`grep -rE '(packages/|apps/|src/|\.ts:|\.tsx:)' docs/theory/`) will fail if you slip a path in. If you find yourself wanting to cite a file, you're writing module/rule/integration content, not theory.
- **The `_archive/` directory should be empty in this spec.** The dispute is "do we move *anything* there now?" — answer is no, this spec doesn't dissolve any layers. Just stake out the convention.
- **CLAUDE.md is auto-loaded into every session.** Trimming aggressively means AI sessions lose information unless they navigate. The 80-120 line target is calibrated to keep architecture diagram + commands + conventions, while moving prose out. Do not go below 80 — that means you've removed something load-bearing.
- **The retargeted kata prompt smoke test (V9) is manual.** Don't commit the smoke-test output; just confirm the prompt runs and references duraclaw paths. The verification step is on the prompt's *content*, not its output.
- **`docs/` clashes naming-wise with `packages/docs-runner/`** — the disambiguation paragraph in `docs/index.md` is mandatory, not decorative. A future contributor will land here looking for the docs-runner package and need the redirect.
- **`packages/docs-runner/tsup.config.bundled_*.mjs` is build-artifact noise** in git status; do not commit it.
- **Atomic-commit discipline for B3:** the rules→theory split is "lift content, replace with stub" in *one commit per file*, not two. Splitting across commits leaves the repo in an awkward middle state where information is duplicated or missing.

### Reference docs
- `planning/research/2026-04-28-baseplane-style-docs-stack.md` — research doc, primary input
- `planning/research/2026-04-28-baseplane-to-codevibesmatter-migration.md` — relevant for the integrations layer (CF/GH coupling depth)
- `https://docs.baseplane.ai/theory/` — six-fixed-categories discipline reference
- `https://docs.baseplane.ai/primitives/` — layer placement tests + complex-primitive-as-directory pattern
- `https://docs.baseplane.ai/modules/` — module test + module placement eval

### Test plan recap
P0 done = V1 passes. P1 done = V2-V5 pass + V10 cross-link sanity passes for the modules/integrations/theory subset. P2 done = V6, V7, V8 pass + V9 smoke test runs cleanly + V10 passes against the now-trimmed CLAUDE.md.
