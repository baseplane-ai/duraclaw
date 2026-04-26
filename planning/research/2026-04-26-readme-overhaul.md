# README Overhaul — Research

> Research type: **Feature research + inspiration cataloging.** Map current
> documentation surface, identify the gap, propose an overhauled
> root-`README.md` with concrete recommendations and a phased rollout.
>
> Workflow: `RE-72bf-0426`. Author: research-mode session 2026-04-26.

---

## TL;DR

1. **There is no root `README.md`** in `baseplane-ai/duraclaw`. Every
   per-package README exists (gateway, session-runner, shared-transport,
   mobile, kata) but the front door of the repo is empty.
2. The raw material for an excellent README already exists — it's just
   spread across `CLAUDE.md`, `AGENTS.md`, the per-package READMEs, and
   `.claude/rules/*.md`. The overhaul is **synthesis, not authoring**.
3. The target audience is **not external open-source users today** — it's
   (a) future-self / new contributors landing on the repo, (b) anyone who
   clicks through from the published `kata` README ("Part of the duraclaw
   monorepo"), and (c) Claude agents bootstrapping into a fresh worktree.
   Recommended structure optimizes for those three readers in that order.
4. Recommended deliverable: a **~250-line root `README.md`** that orients
   the reader in 30 seconds, links out to the deep docs that already
   exist, and has zero duplication of `CLAUDE.md` content.
5. One open decision the human needs to settle before P1: **is the repo
   staying private, or is open-sourcing on the horizon?** The README
   shape diverges meaningfully between the two.

---

## 1. Current state inventory

### What exists today

| File | Size | Audience | Purpose |
|---|---|---|---|
| `CLAUDE.md` | 6.0 KB | Claude agents (project instructions) | Architecture, conventions, deployment, git workflow rules |
| `AGENTS.md` | 8.7 KB | Contributors/agents | Verification policy, phase-verification map, evidence rules, done-gate |
| `.claude/rules/*.md` (11 files) | ~30 KB | Claude agents (path-scoped instructions) | Per-subsystem rules: gateway, mobile, orchestrator, session-runner, shared-transport, session-lifecycle, kata, deployment, worktree-setup, testing, client-data-flow |
| `packages/agent-gateway/README.md` | High quality | VPS operators / contributors | Endpoints, directory contract, env vars, systemd ops |
| `packages/session-runner/README.md` | High quality | Contributors | Argv, lifecycle, multi-turn, build |
| `packages/shared-transport/README.md` | High quality | Contributors | BufferedChannel + DialBackClient mechanics |
| `apps/mobile/README.md` | Excellent (327 lines) | Mobile devs | Architecture, prereqs, build, sign, FCM, source map |
| `packages/kata/README.md` | Excellent (TOC, 800+ lines) | External users (kata is npm-adjacent) | Full kata docs |
| `apps/orchestrator/scripts/README.md` | Operational | Contributors | Scripts in that dir |
| `.devcontainer/README.md` | Operational | Devcontainer users | Devcontainer config |
| `planning/progress.md` | Living tracker | Internal | Phase/subphase status |
| `planning/research/2026-04-01-product-roadmap.md` | Vision doc | Internal | Full product narrative |

### What's missing

- **No root `README.md`.** GitHub renders the file listing instead of any
  project overview, and clicking the repo from the published `kata`
  README lands the reader on a blank canvas.
- **No "what is duraclaw"** elevator pitch anywhere outside the first
  paragraph of `CLAUDE.md` (which is agent-focused, not reader-focused).
- **No quickstart** that says "clone -> setup -> dev". Worktree-setup.md
  has the right command (`scripts/setup-clone.sh --from .../.env`) but
  it's buried in `.claude/rules/`.
- **No screenshot / GIF / architecture diagram image.** The ASCII diagram
  in `CLAUDE.md` is good but won't show in marketing surface.
- **No license / contribution / code-of-conduct.** Required if the repo
  ever goes public; missing in the private state too.
- **No status badge** for CI / deploy. The infra pipeline is mentioned in
  `.claude/rules/deployment.md` but there's no public signal of what's
  green.

### Repo signals about audience

- Repo is `baseplane-ai/duraclaw` — under the company org, currently
  private (inferable: there's no LICENSE, secrets-by-1Password
  references, internal Tailscale device IDs in mobile rules).
- `packages/kata/README.md` says "Part of the
  [duraclaw](https://github.com/baseplane-ai/duraclaw) monorepo" — that
  link presumes the repo exists and is reachable. If kata is intended to
  be discoverable externally, this link is the only marketing channel
  duraclaw currently has.
- `apps/mobile/README.md` references private 1Password vaults and dev
  Pixel device IDs — the docs are written assuming an internal reader.

---

## 2. Audience analysis

Three concrete reader personas. Order matters — the first lines of the
README must serve persona A, then B, then C in that order.

### Persona A — Future-self / new contributor (primary)

Engineer joining the project six months from now (or returning after a
break). They need:

- **In 10 seconds**: what does duraclaw do, and what does the architecture
  look like?
- **In 60 seconds**: how do I get a worktree running locally?
- **In 5 minutes**: which package owns what, and where do I read deeper?

This persona is **not impressed by marketing language.** They want
truthful technical orientation, fast.

### Persona B — Inbound from `kata` README (secondary)

Someone who found `kata` (e.g. via a blog post, npm, GitHub search),
reads its README, follows the "part of the duraclaw monorepo" link, and
lands on this repo. They need:

- A **one-paragraph "what is duraclaw"** so they can decide if it's
  interesting beyond kata.
- A signal that **kata is genuinely a first-class package here**, not an
  afterthought (i.e. that the parent project is alive and credible).
- A clear pointer back to `packages/kata/` so they can keep reading
  about kata if duraclaw isn't relevant to them.

### Persona C — Claude agent bootstrapping into a fresh worktree

When an agent runs `kata enter <mode>` in a new worktree, it doesn't
read the root README directly — `SessionStart` injects `CLAUDE.md`. But
the README is still load-bearing because:

- Agents follow links from `CLAUDE.md` ("see `planning/specs/`...").
- A README that redundantly states what's in `CLAUDE.md` wastes context
  if the agent reads both.
- The README **must not duplicate `CLAUDE.md`** — it should defer to it
  for agent-facing rules, with a one-line pointer.

### Audience non-goals (deliberate)

- **Not** an open-source marketing site. Until/unless we publicly
  open-source duraclaw, the README should not pretend the audience is
  an HN reader.
- **Not** a tutorial. Tutorials live in per-package READMEs and
  `apps/mobile/README.md`.
- **Not** a roadmap. `planning/progress.md` and the roadmap research
  doc already serve that.

---

## 3. Inspiration catalog — patterns from existing READMEs

I pulled patterns from the in-repo READMEs that are already strong, so
the root README feels native to the codebase rather than imported from a
template.

### From `packages/kata/README.md` — the gold standard

**What works:**

- **Numbered Table of Contents at top** lets the reader jump.
- **"What kata does" section opens with the problem statement**, not the
  solution. ("You ask Claude to implement a feature. It writes some code,
  says 'looks good!', and stops...") — concrete, sympathetic, then
  transitions to "**kata adds the enforcement layer.**"
- **Three-line architecture summary** before any deeper explanation.

**What to borrow:**

- The "you have a problem -> here's the framing -> here's the solution"
  opening pattern.
- The TOC for any README >150 lines.
- Keeping sub-section headers as questions/intents
  ("How it works", "Stop conditions"), not nouns ("Architecture").

### From `apps/mobile/README.md` — operational excellence

**What works:**

- "Architecture (one paragraph)" — one paragraph, no waffling.
- Comparison **table** (web vs Capacitor) compresses what would be three
  paragraphs into seven rows.
- "Common failures" troubleshooting table at the end — saved-bacon
  format.
- "Source map (for code archaeology)" — file -> behavior table. Genius
  for onboarding.

**What to borrow:**

- The one-paragraph architecture summary as the second section.
- The "source map" table pattern at repo level (where do I look for X?).

### From `packages/agent-gateway/README.md` — surgical brevity

**What works:**

- Opens with what it is **AND what it isn't** ("Does NOT run the Claude
  Agent SDK — that lives in @duraclaw/session-runner. Does NOT dial
  the Durable Object — the runner dials the DO directly").
- Endpoint table is the API contract, not prose.

**What to borrow:**

- Negative space — saying what duraclaw is NOT (e.g. "duraclaw is not
  a Claude wrapper / chatbot UI / coding agent — it's the orchestration
  fabric for...").

### From `CLAUDE.md` — the architecture diagram

The ASCII architecture box in `CLAUDE.md` is already excellent. **Reuse
it verbatim** — there's no point redrawing.

```
Browser
  |
  v
CF Worker (TanStack Start) --- React UI + API routes
  |
  v
SessionDO (1 per session) --- state + SQLite message history
  ^          |
  |          | HTTPS POST /sessions/start
  ...
```

### Reference patterns from external projects (briefly)

I'm not copying any external README wholesale — the in-repo material is
already strong enough that we don't need to import a stranger's voice.
Two external patterns worth noting only:

- **Cloudflare's `workers-sdk` repo** — uses a "Packages in this
  repository" table that links each subdirectory's README. Good model
  for the monorepo nav we'll need.
- **Anthropic's `claude-agent-sdk-typescript` README** — minimal: hero
  paragraph, install, one example, link to docs. Worth aspiring to that
  density.

---

## 4. Gap analysis — what an overhauled README must do

| Need | Source today | Gap |
|---|---|---|
| One-line "what is duraclaw" | First sentence of `CLAUDE.md` | Not surfaced anywhere a non-agent will see |
| Architecture diagram | `CLAUDE.md` ASCII box | Reusable but currently agent-only |
| Quickstart (clone -> dev) | `.claude/rules/worktree-setup.md` | Buried in agent rules |
| Monorepo map (which package does what) | Implicit in `CLAUDE.md` "Monorepo Structure" + per-package READMEs | No top-level **table linking out** |
| Tech stack | `CLAUDE.md` "Tech Stack" | OK to defer to `CLAUDE.md` |
| Verification commands | `AGENTS.md` + `package.json` scripts | Good — link out |
| Deployment model | `.claude/rules/deployment.md` | Good — link out, but mention "no manual `pnpm ship`" up front |
| Contributing / git workflow | `CLAUDE.md` "Conventions" | Defer, but README should have a 2-line "see CLAUDE.md and AGENTS.md for contributor rules" |
| License | — | **Decision needed** (see §6) |
| Status badges | — | **Optional** — only useful if CI is publicly observable |
| Screenshot / hero image | — | **Nice-to-have**, not blocker |

---

## 5. Recommended structure

A ~250-line root `README.md`, no longer. Anything longer becomes
maintenance debt that drifts from `CLAUDE.md`.

```markdown
# Duraclaw

> One-line tagline. (e.g. "Multi-session Claude Code orchestration on
> Cloudflare Workers + a VPS runner fleet.")

[Optional: 1-2 status badges if we make CI publicly observable]
[Optional: hero screenshot of the multi-session dashboard]

## What it is

Two paragraphs. First paragraph: the problem (running many Claude Code
sessions across worktrees is painful — context lives in tmux, no shared
inbox, no mobile, no resume across redeploys). Second paragraph: the
shape of the solution (orchestrator on Workers + DOs, per-session
runner on VPS, dial-back WS, mobile shell, kata workflow CLI).

## What it is not

Three bullets clarifying scope:
- Not a Claude wrapper / standalone chatbot — duraclaw runs sessions
  produced by `@anthropic-ai/claude-agent-sdk`.
- Not self-hostable as a one-click app yet — it assumes a CF Workers
  account and a VPS you control.
- Not a replacement for the Claude Code CLI — it complements it.

## Architecture

Reuse the ASCII diagram from `CLAUDE.md` verbatim (single source of
truth — when one moves, both move).

One paragraph below the diagram explaining the three key invariants
(gateway never runs SDK; runner never embeds DO; gateway restart and
worker redeploy are non-events).

## Repository map

Table:

| Path | What | Read more |
|---|---|---|
| `apps/orchestrator` | CF Worker + TanStack Start (React UI, DOs, auth) | `.claude/rules/orchestrator.md` |
| `apps/mobile` | Capacitor Android shell | `apps/mobile/README.md` |
| `packages/agent-gateway` | VPS spawn/list/reap control plane | `packages/agent-gateway/README.md` |
| `packages/session-runner` | Per-session SDK owner | `packages/session-runner/README.md` |
| `packages/shared-transport` | BufferedChannel + DialBackClient | `packages/shared-transport/README.md` |
| `packages/shared-types` | GatewayCommand / GatewayEvent shapes | — |
| `packages/ai-elements` | Shared UI component library | — |
| `packages/kata` | Workflow management CLI | `packages/kata/README.md` |
| `planning/` | Specs, progress, research | `planning/progress.md` |

## Quickstart

The exact `git clone` + `scripts/setup-clone.sh` block from
`.claude/rules/worktree-setup.md`. Plus `pnpm dev` and a pointer to
`AGENTS.md` for verification commands.

## Common commands

Compact table of the top ~6 from `package.json` scripts:
`pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`,
`pnpm verify:smoke`, `pnpm kata`.

Note: **do not run `pnpm ship` manually** — see Deployment.

## Deployment

Three sentences: the infra pipeline owns deploys, push to `main`
triggers it, both the orchestrator (CF Workers) and gateway (systemd
on VPS) ship together. Link to `.claude/rules/deployment.md` for the
mobile-OTA bundle contract.

## Contributing

Two paragraphs:
- For humans: read `CLAUDE.md` for architecture/conventions and
  `AGENTS.md` for the verification policy.
- For agents (Claude Code): `CLAUDE.md` is auto-loaded; `kata enter
  <mode>` to get scaffolded into a workflow.

Git workflow: scope-determined. Task-scoped commits go straight to
`main`; feature work goes through a branch + PR. Link to the relevant
section of `CLAUDE.md`.

## License

[Decision pending — see §6]

## Roadmap

One sentence + link to `planning/progress.md`. No phase tracking inline.
```

### Why this shape

- **Above the fold (first screen) is exclusively orientation** — what,
  what-not, architecture diagram. Persona A and B both served.
- **Repository map is a single table** — the agent (Persona C) and the
  human contributor (Persona A) both need this and benefit from it
  being one click away.
- **Quickstart and Common commands together fit on one screen** — Persona
  A is unblocked.
- **Everything else is a delegation** — by linking out instead of
  inlining, the README stays small enough to maintain alongside the
  source-of-truth docs.

---

## 6. Open decisions for the human

These are the questions I can't answer alone — the README shape diverges
based on them.

1. **Open-source posture.** Is duraclaw staying a private repo, or is
   open-sourcing on the roadmap?
   - **Private**: README can use private 1Password / Tailscale references
     freely, and skip LICENSE / CODE_OF_CONDUCT / SECURITY.md. Status
     badges optional.
   - **Public**: README needs a LICENSE (MIT / Apache-2 / BUSL?), needs
     to scrub anything internal-only (the mobile README has 1Password
     vault names that would need to move to a non-checked-in
     `OPS.md`), and needs a clear "this is a personal/in-progress
     project, expect rough edges" framing.
2. **Tagline.** What's the one-line pitch? Candidates from the source
   material:
   - "Multi-session Claude Code orchestration on Cloudflare Workers +
     a VPS runner fleet." (technical)
   - "Run many Claude Code sessions across worktrees, on the web and
     mobile." (user-facing)
   - "An orchestration fabric for fleets of Claude Code sessions."
     (positioning)
3. **Hero asset.** Worth taking a screenshot of the multi-session
   dashboard? Or is the ASCII architecture diagram enough?
4. **Badges.** Do we expose CI status anywhere public? If not, badges
   add visual noise without signal — recommend skipping.
5. **Should `AGENTS.md` and `CLAUDE.md` be referenced by name in the
   README?** Pro: names the contracts contributors will hit. Con:
   exposes the agent-tooling layer to readers who don't care.
   Recommendation: **yes** — the project is opinionated about
   agent-driven workflows, and the README should set that expectation
   honestly rather than hiding it.

---

## 7. Phased rollout — small / medium / large

### Small (1 hour)

Land just the **orientation surface**: tagline, what-it-is/isn't,
architecture diagram, repository map table. Stop there. Resolves
Persona B (kata inbound link) immediately. Persona A still has to dig
into per-package READMEs but at least knows where to dig.

### Medium (recommended, ~3 hours)

Full structure from §5 minus license and hero asset. Resolves Persona A
and B fully. Persona C is unaffected (still served by `CLAUDE.md`).
Includes:

- Tagline + what-is/what-isn't
- Architecture diagram (reused from `CLAUDE.md`)
- Repository map table
- Quickstart (clone + setup-clone.sh + dev)
- Common commands compact table
- Deployment summary (link out)
- Contributing pointer (link to `CLAUDE.md` + `AGENTS.md`)
- Roadmap pointer (link to `planning/progress.md`)

### Large (~1 day, if going public)

Adds:

- LICENSE file + license section
- CODE_OF_CONDUCT.md + SECURITY.md
- Hero screenshot of the dashboard
- Status badges
- Scrub of per-package READMEs to remove internal-only references
  (1Password vault names, internal Tailscale IPs in
  `.claude/rules/mobile.md`)
- A `CONTRIBUTING.md` that supersedes the "git workflow" section of
  `CLAUDE.md` for external contributors (CLAUDE.md remains
  agent-focused)

---

## 8. Recommendations

- **Default to "Medium" scope.** It's the right size for the current
  audience and doesn't require the open-source decision to be settled.
- **Resolve Decision #1 (open-source posture) before "Large"** is even
  on the table.
- **Do not duplicate `CLAUDE.md`.** The README must defer to it for
  conventions/architecture details. Specifically:
  - Don't restate the tech stack — link to `CLAUDE.md` "Tech Stack".
  - Don't restate verification commands — link to `AGENTS.md`.
  - Don't restate per-package mechanics — link to that package's README.
- **Reuse the architecture ASCII diagram exactly** as it appears in
  `CLAUDE.md`. When one drifts, both must update — accept the
  duplication for the readability win, but flag in a comment that the
  source of truth is `CLAUDE.md`.
- **Leave per-package READMEs alone in this overhaul.** They're already
  strong. Only touch them if "Large" scope kicks in (scrub for
  open-sourcing).
- **Treat `CLAUDE.md` as agent-facing and `README.md` as human-facing.**
  This split is the design constraint — every section of either file
  should justify its placement against this rule.

---

## 9. Sources cited

In-repo (primary):

- `/data/projects/duraclaw-dev4/CLAUDE.md`
- `/data/projects/duraclaw-dev4/AGENTS.md`
- `/data/projects/duraclaw-dev4/package.json`
- `/data/projects/duraclaw-dev4/packages/agent-gateway/README.md`
- `/data/projects/duraclaw-dev4/packages/session-runner/README.md`
- `/data/projects/duraclaw-dev4/packages/shared-transport/README.md`
- `/data/projects/duraclaw-dev4/apps/mobile/README.md`
- `/data/projects/duraclaw-dev4/packages/kata/README.md`
- `/data/projects/duraclaw-dev4/.claude/rules/orchestrator.md`
- `/data/projects/duraclaw-dev4/.claude/rules/gateway.md`
- `/data/projects/duraclaw-dev4/.claude/rules/mobile.md`
- `/data/projects/duraclaw-dev4/.claude/rules/session-runner.md`
- `/data/projects/duraclaw-dev4/.claude/rules/shared-transport.md`
- `/data/projects/duraclaw-dev4/.claude/rules/session-lifecycle.md`
- `/data/projects/duraclaw-dev4/.claude/rules/deployment.md`
- `/data/projects/duraclaw-dev4/.claude/rules/worktree-setup.md`
- `/data/projects/duraclaw-dev4/.claude/rules/kata.md`
- `/data/projects/duraclaw-dev4/planning/progress.md`

External (pattern reference, not copied):

- Cloudflare `workers-sdk` README — "Packages in this repository" table
  pattern.
- Anthropic `claude-agent-sdk-typescript` README — minimal-density
  pattern.
