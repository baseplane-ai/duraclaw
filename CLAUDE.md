# CLAUDE.md — Duraclaw

## Project Overview

Duraclaw orchestrates Claude Code sessions across multiple VPS worktrees. A Cloudflare Workers frontend (orchestrator) owns session lifecycle via Durable Objects, and a VPS-side `agent-gateway` spawns per-session `session-runner` processes that each own one Claude Agent SDK query and dial the DO directly.

## Architecture

```
Browser
  │
  ▼
CF Worker (TanStack Start) ─── React UI + API routes
  │
  ▼
SessionDO (1 per session) ─── state + SQLite message history
  ▲          │
  │          │ HTTPS POST /sessions/start
  │          ▼
  │      ┌─ agent-gateway (VPS, systemd) ─ spawn/list/status/reap
  │      │            │
  │      │            │ spawn detached, passes callback_url + token
  │      │            ▼
  │      └── session-runner (per session) ── owns Claude SDK query()
  │                   │                      uses BufferedChannel ring (10K/50MB)
  └───────────────────┘
         dial-back WSS — direct to DO, reconnects with 1/3/9/27/30s backoff
```

Key invariants:
- `agent-gateway` never runs the SDK. It's a spawn/list/reap control plane.
- `session-runner` never embeds the DO. It dials `CC_GATEWAY_URL`'s partner `WORKER_PUBLIC_URL` (`wss://dura…/agents/session-agent/<do-id>?role=gateway&token=…`).
- Gateway restart / CF Worker redeploy are non-events for an in-flight runner; the BufferedChannel buffers while the WS is down, replays on reconnect, emits a single gap sentinel only on overflow.

## Monorepo Structure

```
apps/
  orchestrator/          # CF Workers + TanStack Start (React 19, Vite 7)
packages/
  agent-gateway/         # VPS control plane (Bun HTTP server, systemd)
  session-runner/        # Per-session SDK owner (spawned by gateway)
  shared-transport/      # BufferedChannel + DialBackClient (runner → DO WS)
  shared-types/          # GatewayCommand / GatewayEvent / SessionState types
  ai-elements/           # Shared UI component library
  kata/                  # Workflow management CLI
planning/
  spec-templates/        # Feature, bug, epic spec templates
```

## Tech Stack

- **Runtime**: TypeScript 5.8, React 19, Vite 7
- **Monorepo**: pnpm workspaces + Turbo
- **Orchestrator**: Cloudflare Workers, Durable Objects (Agents SDK v0.7), TanStack Start
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
pnpm ship               # Build + wrangler deploy (do NOT run manually — see Deployment)

# Gateway (local)
cd packages/agent-gateway
bun run src/server.ts   # Starts on 127.0.0.1:$CC_GATEWAY_PORT (default 9877)

# Session-runner binary build
pnpm --filter @duraclaw/session-runner build   # Emits dist/main.js with #!/usr/bin/env bun shebang
```

## Packages

### apps/orchestrator (CF Workers)

- **Durable Objects**: `SessionDO` (1 per session, owns state + SQLite message history + `active_callback_token` for runner auth), `ProjectRegistry` (singleton, worktree locks + session index), `UserSettingsDO`
- **Auth**: Better Auth with D1 via Drizzle. Per-request auth instance (D1 only available in request context). Login at `/login`, API at `/api/auth/*`
- **Environment** (wrangler secrets): `CC_GATEWAY_URL` (http(s) URL to gateway), `CC_GATEWAY_SECRET` (bearer matched by gateway), `WORKER_PUBLIC_URL` (wss base the runner uses to dial the DO), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- **D1 Database**: `duraclaw-auth`
- **Entry point**: `src/server.ts` exports DO classes + TanStack Start default handler

### packages/agent-gateway (VPS control plane)

- **Not the SDK host anymore** — that moved to `session-runner`. Gateway just spawns detached runners and exposes HTTP endpoints for the DO.
- **HTTP endpoints**: `POST /sessions/start` (spawn detached runner), `GET /sessions` (list all known), `GET /sessions/:id/status` (exit > pid+live > pid+dead > 404), `GET /health` (no auth), `POST /debug/reap` (dev-only, behind `DURACLAW_DEBUG_ENDPOINTS=1`), plus project-browsing endpoints for UI/debug.
- **Auth**: Bearer token; timing-safe compare. Open if `CC_GATEWAY_API_TOKEN` not set.
- **Session files** under `$SESSIONS_DIR` (default `/run/duraclaw/sessions`, tmpfs, `0700`): `{id}.cmd` (gateway writes, runner reads), `{id}.pid` (runner writes), `{id}.meta.json` (runner writes every 10s), `{id}.exit` (single-writer via `link`+EEXIST), `{id}.log` (gateway-opened stdout/stderr).
- **Reaper**: 5-minute interval + startup pass. Stale (>30min since `last_activity_ts`) → SIGTERM → 10s grace → SIGKILL → markedCrashed. `.cmd` orphans >5min unlinked; terminal files >1h past `.exit` mtime GC'd together with `.log`.
- **Observability**: on each reaper pass logs `[gateway] inflight=N <id:pid/seq/age/idle>` and on each spawn logs `[gateway] /sessions/start sessionId=… execute project=… worktree=…`.
- **Systemd**: `duraclaw-agent-gateway.service` requires `KillMode=process` + `SendSIGKILL=no` + `RuntimeDirectoryPreserve=yes` so restarts don't sweep the detached runner cgroup and `/run/duraclaw/sessions` survives. Install via `./packages/agent-gateway/systemd/install.sh`.

### packages/session-runner (per-session SDK owner)

- One process per session. Spawned detached by gateway with 7 positional argv: `sessionId cmdFile callback_url bearer pidFile exitFile metaFile`.
- Writes `.pid` at startup, reads `.cmd`, dials the DO via `DialBackClient` (from `shared-transport`), then runs `query()` / `query({resume:sdk_session_id})` from `@anthropic-ai/claude-agent-sdk`.
- Emits `session.init` / `partial_assistant` (from `stream_event.content_block_delta.text_delta` and `thinking_delta`) / `assistant` / `tool_result` / `result` / etc. via the channel, assigning monotonic `ctx.nextSeq` to every event.
- Stays alive across turns — after `type=result` it blocks on `queue.waitForNext()` for the next `stream-input` from the DO.
- Exits cleanly on: SDK abort, SIGTERM (2s watchdog), or DialBackClient terminal (`4401 invalid_token`, `4410 token_rotated`, or post-connect reconnect cap exhausted).

### packages/shared-transport

- **`BufferedChannel`**: ring buffer (10K events / 50MB) that sends directly when the WS is attached and queues otherwise. On overflow drops oldest and emits a single `{type:'gap',dropped_count,from_seq,to_seq}` sentinel on next replay.
- **`DialBackClient`**: WS client that dials `callbackUrl?token=<bearer>`, exposes `send()` / `onCommand()`, reconnects with `[1s, 3s, 9s, 27s, 30s×]` backoff. Resets `attempt` after 10s of stable connection. Terminates (fires `onTerminate`) on close codes `4401` / `4410` or after 20 post-connect failures without stability.

### packages/kata (Workflow CLI)

- 8 modes: planning, implementation, research, task, debug, verify, freeform, onboard
- Phase tracking, stop condition gates, session persistence
- Run via `kata enter <mode>`

## Session lifecycle & resume

1. **New session** — browser calls DO `spawn()` → DO `triggerGatewayDial({type:'execute', …})` → `POST /sessions/start` → gateway spawns detached runner → runner dials DO at `wss://…/agents/session-agent/<do-id>?role=gateway&token=…` → DO validates token (timing-safe) against `active_callback_token` → accept → SDK runs → events stream.
2. **Follow-up message, runner still connected** (normal path) — `sendMessage` sees `getGatewayConnectionId()` → sends `stream-input` over existing WS → runner's command queue wakes the multi-turn loop. No re-spawn.
3. **Follow-up after >30min idle** — reaper has killed the runner; DO state is `idle` with persisted `sdk_session_id`. `sendMessage` falls through to `triggerGatewayDial({type:'resume', sdk_session_id})` → new runner, SDK `resume` reads the on-disk transcript (`@anthropic-ai/claude-agent-sdk` session file in the project dir).
4. **Orphan case** — runner alive on VPS but unreachable from DO. `sendMessage` preflights `GET /sessions` on the gateway, finds the orphan by `sdk_session_id`, auto-delegates to `forkWithHistory(content)`: the DO serialises local history as `<prior_conversation>…</prior_conversation>`, drops `sdk_session_id` (forces a fresh one — no `hasLiveResume` collision), and spawns a new `execute` with the transcript-prefixed prompt. User-visible UX is a normal send.

The orphan case is self-healing from the runner side too: on close code `4401`/`4410` from the DO, the runner aborts and exits rather than squatting on the sdk_session_id.

## VPS Communication Protocol

Transport: runner → DO over wss, and gateway → DO via HTTP only (spawn/status). Shapes live in `packages/shared-types/src/index.ts`.

**GatewayCommand** (DO → runner, over dial-back WS):
- `stream-input` — inject a user turn into the live SDK query
- `interrupt`, `rewind`, `get-context-usage` — mid-session controls
- `resolve-gate` — answer to `ask_user` / `permission_request`

**GatewayEvent** (runner → DO, over dial-back WS):
- `session.init`, `partial_assistant` (streaming text / reasoning deltas), `assistant` (finalised turn), `tool_use_summary`, `tool_result`, `ask_user`, `permission_request`, `task_started`/`progress`/`notification`, `rate_limit`, `result`, `heartbeat`, `error`

Every event is stamped with a monotonic `seq` by the runner's BufferedChannel so the DO can detect and act on gap sentinels.

## Deployment

All deploys are handled by the infra server — pushing to `main` on `origin` triggers the pipeline that builds and ships both the orchestrator (CF Workers) and the agent-gateway (systemd on VPS). Do not run `pnpm ship`, `wrangler deploy`, or the gateway install script manually.

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

### Dual browser profiles (multi-user verification)

`chrome-devtools-axi` wraps a single persistent Chrome — `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`
on a second call is ignored because the first Chrome holds the profile lock.
For VPs that need two real signed-in users at once, pre-launch two Chromes
and target each via `CHROME_DEVTOOLS_AXI_BROWSER_URL`:

```bash
scripts/verify/browser-dual-up.sh          # idempotent: launches A on :9222, B on :9223
scripts/verify/axi-a open http://localhost:43173/login   # drive user A
scripts/verify/axi-b open http://localhost:43173/login   # drive user B
scripts/verify/browser-dual-down.sh        # teardown
```

Profiles live at `/tmp/duraclaw-chrome-a` and `/tmp/duraclaw-chrome-b` — each
has its own cookie jar, so sign-in state doesn't cross-contaminate. Headed
mode via `BROWSER_HEADED=1 scripts/verify/browser-dual-up.sh`.

**Ergonomic multi-user helpers** (prefer these over raw `axi-a` / `axi-b`
whenever both users are involved):

```bash
# One-shot: launch both Chromes, seed both accounts, log each in.
scripts/verify/axi-dual-login.sh

# Log one browser in as a specific user (idempotent — no-op if already
# signed in; falls back to sign-up if the user doesn't exist yet).
scripts/verify/axi-login a                      # default $VERIFY_USER_A_*
scripts/verify/axi-login b alt@example.com pw   # override email/password

# Run the same axi command against both browsers in parallel, with
# [A] / [B] prefixed output.
scripts/verify/axi-both snapshot
scripts/verify/axi-both eval 'location.pathname'
```

Defaults come from `scripts/verify/common.sh`:

- User A: `agent.verify+a@example.com` / `duraclaw-test-password-a`
- User B: `agent.verify+b@example.com` / `duraclaw-test-password-b`

Override via `VERIFY_USER_A_EMAIL`, `VERIFY_USER_A_PASSWORD`,
`VERIFY_USER_B_EMAIL`, `VERIFY_USER_B_PASSWORD` if you need different
credentials. Sign-in uses Better Auth's `/api/auth/sign-in/email` called
from inside the page context (via `axi eval`), so the Set-Cookie lands in
the Chrome profile directly — no fragile snapshot-ref scraping.

### Verify-mode local stack

`scripts/verify/dev-up.sh` starts a local orchestrator (miniflare, port
43173) and local agent-gateway (port 9877) for the current worktree. For
the gateway→DO dispatch loop to close end-to-end, the orchestrator's
`apps/orchestrator/.dev.vars` MUST define all four variables:

```
CC_GATEWAY_URL=ws://127.0.0.1:9877
CC_GATEWAY_SECRET=<matches .env in the gateway's cwd>
WORKER_PUBLIC_URL=http://127.0.0.1:43173
BETTER_AUTH_URL=http://localhost:43173
```

Missing `WORKER_PUBLIC_URL` causes the classic "message lands in history,
no assistant turn" silent-fail (GH#8). `sendMessage` now preflights this
and returns an explicit error instead of persisting into limbo — if you see
`Gateway not configured for this worker`, fill in `.dev.vars`.

Gateway-side project resolution is governed by `PROJECT_PATTERNS` /
`WORKTREE_PATTERNS` (comma-separated prefixes). Leaving them unset accepts
every git repo under `/data/projects/`. If you set them, ensure the prefix
covers the worktree you'll dispatch into — the runner logs a verbose miss
line (`[session-runner] project miss: name=...`) when filtered out.

### Portless mode (stable subdomains, multi-worktree-safe)

Direct-port mode (`dev-up.sh`) collides between worktrees because both
`43173` (orchestrator) and `9877` (gateway) are fixed. Portless mode runs
each service behind a stable `.localhost` subdomain so `.dev.vars` is
portable and parallel worktrees can each bring up their own stack.

One-time setup:

```bash
npm install -g portless         # global CLI
portless proxy start            # prompts sudo once (binds 443, trusts CA)
portless hosts sync             # adds *.localhost entries to /etc/hosts
```

Then per-session:

```bash
scripts/verify/portless-up.sh       # launches both under portless
scripts/verify/portless-down.sh     # teardown
```

Subdomain contract:

- Orchestrator: `https://duraclaw-orch.localhost`
- Gateway:      `https://duraclaw-gw.localhost` (WS: `wss://duraclaw-gw.localhost`)

`.dev.vars` in portless mode:

```
BETTER_AUTH_URL=https://duraclaw-orch.localhost
CC_GATEWAY_URL=wss://duraclaw-gw.localhost
WORKER_PUBLIC_URL=https://duraclaw-orch.localhost
CC_GATEWAY_SECRET=<unchanged>
```

The gateway honours portless's injected `PORT` env var (see
`packages/agent-gateway/src/server.ts` — `PORT ?? CC_GATEWAY_PORT ?? 9877`),
so no service-side changes are needed to opt in.

Both scripts write `VERIFY_*` runtime URLs into the shared verify state
file so the existing `scripts/verify/*.sh` suite continues to work against
the portless URLs without modification.

Design rationale and Phase-3 follow-up (assistant-visible runner errors)
in `planning/research/2026-04-18-verify-infra-issue-8.md`.

## Conventions

- Commit messages: `type(scope): description` (feat, fix, chore, refactor, docs, test)
- Biome formatting: 2-space indent, 100 char line width, LF endings
- Path alias: `~/` maps to `./src/` in orchestrator
- Git workflow: commit and push directly to `main` on `origin` (github.com/baseplane-ai/duraclaw). No PR workflow — CI runs remotely after push.
