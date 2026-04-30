# CLAUDE.md — Duraclaw

## Project Overview

Duraclaw orchestrates Claude Code sessions across multiple VPS worktrees. A Cloudflare Workers orchestrator owns session lifecycle via Durable Objects; a VPS-side `agent-gateway` spawns per-session `session-runner` processes that dial the DO directly.

## Architecture

```
Browser
  |
  v
CF Worker (Vite SPA + Hono) --- React UI + API routes
  |
  v
SessionDO (1 per session) --- state + SQLite message history
  ^          |
  |          | HTTPS POST /sessions/start
  |          v
  |      +- agent-gateway (VPS, systemd) - spawn/list/status/reap
  |      |            |
  |      |            | spawn detached, passes callback_url + token
  |      |            v
  |      +-- session-runner (per session) -- owns Claude SDK query()
  |                   |                      uses BufferedChannel ring (10K/50MB)
  +-------------------+
         dial-back WSS -- direct to DO, reconnects with 1/3/9/27/30s backoff
```

Key invariants:
- `agent-gateway` never runs the SDK. It's a spawn/list/reap control plane.
- `session-runner` never embeds the DO. It dials `CC_GATEWAY_URL`'s partner `WORKER_PUBLIC_URL` (`wss://dura.../agents/session-agent/<do-id>?role=gateway&token=...`).
- Gateway restart / CF Worker redeploy are non-events for an in-flight runner; the BufferedChannel buffers while the WS is down, replays on reconnect, emits a single gap sentinel only on overflow.
- Session status derives from `messagesCollection` via `useDerivedStatus`; D1 `agent_sessions` is the idle/background fallback, not a truth-gate.
- Per-project state (e.g. docs-runner DO id, settings) lives in the D1 `projectMetadata` table — see `apps/orchestrator/src/db/schema.ts` and `planning/specs/27-docs-as-yjs-dialback-runners.md`.
- **Arcs as session parents (GH#116)** — every `agent_sessions` row points at an `arcs` row via `arcId` FK. An arc is the durable parent that owns a workflow's external ref (GH issue / Linear / plain), reserves a worktree (FK → `worktrees.id` from #115), and parents a tree of sessions advancing through modes. Three explicit primitives drive session progression on the SessionDO: `advanceArc` (mints a successor session in the same arc — auto-advance + manual mode change), `branchArc` (mints a child arc with a parent FK and a wrapped-history prompt), and `rebindRunner` (clears `runner_session_id` and re-dials a fresh runner against the same session row — orphan recovery). Kata is a consumer of `agent_sessions.mode` (free-form text) and validates mode names against its own `kata.yaml` registry; the orchestrator schema no longer carries kata-specific columns.

## Monorepo Structure

```
apps/
  orchestrator/          # CF Workers + Vite 8 SPA + Hono API (React 19, TanStack Router)
  mobile/                # Capacitor 8 Android shell (thin client, GH#26)
packages/
  agent-gateway/         # VPS control plane (Bun HTTP server, systemd)
  session-runner/        # Per-session SDK owner (spawned by gateway)
  shared-transport/      # BufferedChannel + DialBackClient (runner -> DO WS)
  shared-types/          # GatewayCommand / GatewayEvent / SessionSummary types
  ai-elements/           # Shared UI component library
  kata/                  # Workflow management CLI
planning/
  spec-templates/        # Feature, bug, epic spec templates
```

## Tech Stack

| Concern | Tool | Reference |
|---------|------|-----------|
| Runtime | TypeScript 5.8, React 19, Vite 8 | — |
| Monorepo | pnpm workspaces + Turbo | — |
| Orchestrator | Cloudflare Workers + Durable Objects (Agents SDK v0.7), Vite 8 SPA + Hono, TanStack Router | [`docs/integrations/cloudflare.md`] |
| Auth | Better Auth on D1 (Drizzle adapter) | [`docs/integrations/better-auth.md`] |
| Gateway | Bun HTTP server — spawn/list/status/reap only | [`docs/modules/agent-gateway.md`] |
| Session-runner | Bun executable wrapping `@anthropic-ai/claude-agent-sdk`, dials DO via `shared-transport` | [`docs/integrations/claude-agent-sdk.md`] |
| Mobile shell | Capacitor 8 Android (thin client) | [`docs/integrations/capacitor.md`] |
| Linting | Biome (spaces, no semicolons, single quotes) | — |

## Key Commands

```bash
pnpm build              # Build all packages (tsup for libs; bun build for VPS binaries)
pnpm typecheck          # Typecheck all packages
pnpm test               # Run vitest suites across the workspace
pnpm dev                # Dev mode (all packages)

# Orchestrator
cd apps/orchestrator
pnpm dev                # Local dev (Vite + miniflare)
pnpm ship               # Build + wrangler deploy (do NOT run manually -- see Deployment)

# Gateway (local dev)
cd packages/agent-gateway
bun run src/server.ts   # Starts on 127.0.0.1:$CC_GATEWAY_PORT (default 9877)
                        # Docs-runner uses $CC_DOCS_RUNNER_PORT (also derived per-worktree, see .claude/rules/worktree-setup.md)

# VPS binary bundles (gateway + both runners) — single self-contained
# files via `scripts/bundle-bin.sh` (bun build --target=bun + atomic mv).
# Production systemd runs the bundle, never source. See .claude/rules/deployment.md.
pnpm --filter @duraclaw/agent-gateway  build   # -> packages/agent-gateway/dist/server.js
pnpm --filter @duraclaw/session-runner build   # -> packages/session-runner/dist/main.js (shebanged, +x)
pnpm --filter @duraclaw/docs-runner    build   # -> packages/docs-runner/dist/main.js   (shebanged, +x)
```

## Conventions

- DO logging discipline (use `logEvent()`, not `console.log`, with stable tag prefixes) lives in [`docs/theory/topology.md`].
- Commit messages: `type(scope): description` (feat, fix, chore, refactor, docs, test).
- Biome formatting: 2-space indent, 100 char line width, LF endings.
- Path alias: `~/` maps to `./src/` in orchestrator.
- Git workflow — scope determines whether a PR is involved, not habit. Always push to the currently checked-out branch on `origin` (github.com/baseplane-ai/duraclaw); never switch branches to push elsewhere.
  - Task-scoped work (small fixes, docs, chores, quick refactors): commit directly to `main` and push. No branch, no PR.
  - Feature-scoped work (implementation off an approved spec, multi-commit epics, anything needing review): work on a feature branch, push, open a PR, land via merge. Never push a feature branch's commits to `main` out-of-band while its PR is open. Rebased branches: `--force-with-lease` only.
  - When unsure, ask before opening a PR. A PR that duplicates commits already on `main` is worse than no PR.

## Where docs live

These layers form duraclaw's knowledge tree (modeled on baseplane). When in doubt about where to put new content, see [`docs/index.md`] for the layer test.

- [`docs/theory/`] — invariants (domains, data, dynamics, topology, trust, boundaries)
- [`docs/primitives/`] — stack-independent building blocks (UI + arch)
- [`docs/modules/`] — per-package surfaces (one file per package + INVENTORY.md)
- [`docs/integrations/`] — external dependencies (Cloudflare, claude-agent-sdk, Better Auth, Capacitor, GitHub)
- [`docs/testing/`] — manual testing recipes
- `planning/specs/` — in-flight features
- `.claude/rules/` — code-level patterns auto-attached via `paths:` frontmatter

## Identity Management

See [`docs/theory/data.md`] for the lossless-resume + identity-failover invariants and [`docs/theory/trust.md`] for the identity-HOME boundary model. Operational steps (adding an identity) live in [`scripts/setup-identity.sh`].

## Progress Tracking

- **Roadmap:** `planning/specs/roadmap-v2-full-vision.md` — full vision with all detail
- **Progress:** `planning/progress.md` — phase/subphase status tracker
- **Specs:** `planning/specs/` — individual feature specs (linked from progress tracker)
