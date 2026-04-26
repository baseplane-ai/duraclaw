# CLAUDE.md — Duraclaw

## Project Overview

Duraclaw orchestrates Claude Code sessions across multiple VPS worktrees. A Cloudflare Workers frontend (orchestrator) owns session lifecycle via Durable Objects, and a VPS-side `agent-gateway` spawns per-session `session-runner` processes that each own one Claude Agent SDK query and dial the DO directly.

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

- **Runtime**: TypeScript 5.8, React 19, Vite 8
- **Monorepo**: pnpm workspaces + Turbo
- **Orchestrator**: Cloudflare Workers, Durable Objects (Agents SDK v0.7), plain Vite 8 SPA + Hono API (TanStack Router on the client; no TanStack Start)
- **Auth**: Better Auth with D1 (Drizzle adapter)
- **Gateway**: Bun HTTP server — spawn/list/status/reap only
- **Session-runner**: Bun-executable that wraps `@anthropic-ai/claude-agent-sdk` and dials the DO via `shared-transport`
- **Linting**: Biome (spaces, no semicolons, single quotes in biome-managed files)

## Key Commands

```bash
pnpm build              # Build all packages (tsup for workspace libs)
pnpm typecheck          # Typecheck all packages
pnpm test               # Run vitest suites across the workspace
pnpm dev                # Dev mode (all packages)

# Orchestrator
cd apps/orchestrator
pnpm dev                # Local dev (Vite + miniflare)
pnpm ship               # Build + wrangler deploy (do NOT run manually -- see Deployment)

# Gateway (local)
cd packages/agent-gateway
bun run src/server.ts   # Starts on 127.0.0.1:$CC_GATEWAY_PORT (default 9877)

# Session-runner binary build
pnpm --filter @duraclaw/session-runner build   # Emits dist/main.js with #!/usr/bin/env bun shebang
```

## Conventions

- **DO observability — use `logEvent()`, not `console.log`**: Inside
  `SessionDO`, all structured/diagnostic logs MUST go through
  `this.logEvent(level, tag, message, attrs?)` (migration v17). This
  writes to the per-DO `event_log` SQLite table (durable, 7-day
  retention, GC'd on `onStart`) AND mirrors to `console.log` for live
  `wrangler tail`. Use tag prefixes consistently: `gate` for
  AskUserQuestion / permission lifecycle, `conn` for WS connection
  events, `rpc` for callable entry/exit. Query via the `getEventLog()`
  RPC (`{tag?, sinceTs?, limit?}`) — no external log infra needed for
  per-session replay. Runner-side logs still go to `console.log` (they
  land in `/run/duraclaw/sessions/{id}.log` on the VPS).
- Commit messages: `type(scope): description` (feat, fix, chore, refactor, docs, test)
- Biome formatting: 2-space indent, 100 char line width, LF endings
- Path alias: `~/` maps to `./src/` in orchestrator
- Git workflow — **scope determines whether a PR is involved**, not habit.
  Always commit and push to **the currently checked-out branch** on
  `origin` (github.com/baseplane-ai/duraclaw); never switch branches to
  push elsewhere. Respect whatever branch the human/session left you on.
  - **Task-scoped work** (task / debug / freeform mode, small fixes,
    docs, chores, quick refactors): commit directly to `main` and push.
    No branch, no PR. CI runs remotely after push. Do NOT open a PR for
    task-scoped work — stale PRs pile up when commits have already
    landed on `main` directly, and they have to be closed manually.
  - **Feature-scoped work** (implementation mode off an approved spec,
    multi-commit epics, anything that needs review before landing): work
    on a feature branch (`feature/<issue>-...`, `feat/...`, `fix/...`),
    push to that branch, open a PR, and land via a proper merge (squash
    or merge-commit). Never push a feature branch's commits to `main`
    out-of-band while its PR is open — that strands the PR as
    superseded-but-not-closed, which is exactly the stale-PR failure
    mode this rule exists to prevent. If a rebase has rewritten branch
    history, push with `--force-with-lease` (never plain `--force`).
  - If you're unsure which bucket a change falls into, ask before
    opening a PR. A PR that duplicates commits already on `main` is
    worse than no PR.

## Progress Tracking

- **Roadmap:** `planning/specs/roadmap-v2-full-vision.md` — full vision with all detail
- **Progress:** `planning/progress.md` — phase/subphase status tracker
- **Specs:** `planning/specs/` — individual feature specs (linked from progress tracker)
