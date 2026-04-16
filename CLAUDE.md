# CLAUDE.md — Duraclaw

## Project Overview

Duraclaw orchestrates Claude Code sessions across multiple VPS worktrees. It consists of a Cloudflare Workers frontend (orchestrator) that manages session lifecycle via Durable Objects, and a VPS-side executor that runs the Claude Agent SDK.

## Architecture

```
Browser
  |
TanStack Start (CF Worker) -- React UI + API routes
  |
SessionAgent DO (1 per session) -- state, scheduling, client sync
  | WebSocket over CF tunnel
VPS Executor (Bun) -- Claude Agent SDK execution only
  |
Worktrees (baseplane-dev1..dev6)
```

## Monorepo Structure

```
apps/
  orchestrator/          # CF Workers + TanStack Start (React 19, Vite 7)
packages/
  agent-gateway/         # VPS executor (Bun WebSocket server)
  kata/                  # Workflow management CLI
planning/
  spec-templates/        # Feature, bug, epic spec templates
```

## Tech Stack

- **Runtime**: TypeScript 5.8, React 19, Vite 7
- **Monorepo**: pnpm workspaces + Turbo
- **Orchestrator**: Cloudflare Workers, Durable Objects (Agents SDK v0.7), TanStack Start
- **Auth**: Better Auth with D1 (Drizzle adapter)
- **Executor**: Bun WebSocket server wrapping `@anthropic-ai/claude-agent-sdk`
- **Linting**: Biome (spaces, no semicolons, single quotes in biome-managed files)

## Key Commands

```bash
pnpm build              # Build all packages
pnpm typecheck          # Typecheck all packages
pnpm dev                # Dev mode (all packages)

# Orchestrator
cd apps/orchestrator
pnpm dev                # Local dev (Vite + miniflare)
pnpm ship               # Build + wrangler deploy

# Executor
cd packages/agent-gateway
bun run src/server.ts   # Run executor locally
```

## Packages

### apps/orchestrator (CF Workers)

- **Durable Objects**: `SessionAgent` (1 per session, owns state + SQLite message history), `SessionRegistry` (singleton, worktree locks + session index)
- **Auth**: Better Auth with D1 via Drizzle. Per-request auth instance (D1 only available in request context). Login at `/login`, API at `/api/auth/*`
- **Environment** (wrangler secrets): `CC_GATEWAY_URL`, `CC_GATEWAY_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- **D1 Database**: `duraclaw-auth` (placeholder ID in wrangler.toml — needs `wrangler d1 create`)
- **Entry point**: `src/server.ts` exports DO classes + TanStack Start default handler

### packages/agent-gateway (VPS Executor)

- **Transport**: Bun WebSocket server on `127.0.0.1:9877`
- **Protocol**: Receives `VpsCommand` JSON messages, streams back `VpsEvent` messages. Each WS = one session.
- **Auth**: Bearer token on WS upgrade (timing-safe compare). Optional — open if `CC_GATEWAY_API_TOKEN` not set.
- **HTTP endpoints**: `GET /health` (no auth), `GET /worktrees` (auth required)
- **Worktree discovery**: Configurable via `WORKTREE_PATTERNS` env var (comma-separated prefixes, default: `baseplane`)
- **Systemd**: `duraclaw-agent-gateway.service`, install via `./packages/agent-gateway/systemd/install.sh`
- **SDK mode**: `bypassPermissions`, strips `CLAUDECODE*` env vars to prevent nested sessions

### packages/kata (Workflow CLI)

- 8 modes: planning, implementation, research, task, debug, verify, freeform, onboard
- Phase tracking, stop condition gates, session persistence
- Run via `kata enter <mode>`

## VPS Communication Protocol

**VpsCommand** (orchestrator -> executor):
- `execute`: Run new session in worktree
- `resume`: Resume with `sdk_session_id`
- `abort`: Signal AbortController
- `answer`: Resolve pending AskUserQuestion

**VpsEvent** (executor -> orchestrator):
- `session.init`: SDK initialized, returns model + tools
- `assistant`: Assistant message content
- `tool_result`: Tool execution results
- `user_question`: AskUserQuestion intercepted
- `result`: Session completed/failed with duration + cost
- `error`: Fatal error

## Deployment Checklist (not yet done)

1. `wrangler d1 create duraclaw-auth` — update database_id in wrangler.toml
2. `wrangler secret put CC_GATEWAY_URL` / `CC_GATEWAY_SECRET` / `BETTER_AUTH_SECRET`
3. `wrangler d1 migrations apply duraclaw-auth` — create auth tables
4. Install Bun on VPS if needed
5. `./packages/agent-gateway/systemd/install.sh` — deploy executor service
6. `cd apps/orchestrator && pnpm ship` — deploy to CF Workers
7. Verify CF tunnel routes to VPS executor

## Progress Tracking

- **Roadmap:** `planning/specs/roadmap-v2-full-vision.md` — full vision with all detail
- **Progress:** `planning/progress.md` — phase/subphase status tracker
- **Specs:** `planning/specs/` — individual feature specs (linked from progress tracker)

## UI Testing

Use `chrome-devtools-axi` (not curl/WebFetch) for browser verification of UI changes — it handles SPAs, JS rendering, and interaction.

**Test user credentials:**
- Email: `agent.verify+duraclaw@example.com`
- Password: `duraclaw-test-password`
- Name: `agent-verify`

**Common workflow:**
```bash
chrome-devtools-axi open <url>          # Navigate to page
chrome-devtools-axi snapshot            # Get accessibility tree with @refs
chrome-devtools-axi click @<ref>        # Click an element
chrome-devtools-axi fill @<ref> <text>  # Fill an input field
chrome-devtools-axi screenshot          # Visual capture
chrome-devtools-axi eval <js>           # Run JS in page context
```

**Login flow example:**
```bash
chrome-devtools-axi open http://localhost:43173/login
chrome-devtools-axi snapshot
chrome-devtools-axi fill @<email-ref> agent.verify+duraclaw@example.com
chrome-devtools-axi fill @<password-ref> duraclaw-test-password
chrome-devtools-axi click @<submit-ref>
chrome-devtools-axi snapshot            # Verify redirect to dashboard
```

**GitHub operations:** Use `gh-axi` instead of `gh` for issues, PRs, runs, releases.

## Conventions

- Commit messages: `type(scope): description` (feat, fix, chore, refactor, docs, test)
- Biome formatting: 2-space indent, 100 char line width, LF endings
- Path alias: `~/` maps to `./src/` in orchestrator
- Git workflow: commit and push directly to `main` on `origin` (github.com/baseplane-ai/duraclaw). No PR workflow — CI runs remotely after push.
