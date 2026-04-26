<!--
  README design notes (see planning/research/2026-04-26-readme-overhaul.md):
  - Human-facing. Agent-facing rules live in CLAUDE.md. Do not duplicate.
  - ~250 lines max. Defer to per-package READMEs and .claude/rules/.
  - Architecture ASCII block is mirrored from CLAUDE.md — keep them in sync.
-->

<p align="center">
  <img src="docs/hero/duraclaw-hero.png" alt="Duraclaw — many coding sessions flowing into one orchestration core" width="100%">
</p>

# Duraclaw

**Multi-session Claude Code orchestration on Cloudflare Workers and a
VPS runner fleet.** Run many concurrent Claude Code sessions across
worktrees, on the web and on Android, with a workflow CLI
([`kata`](packages/kata/)) that holds sessions to phase contracts so
they actually finish.

> Status: active development. Built and used in-house at
> [@baseplane-ai](https://github.com/baseplane-ai); the repo is public
> so you can read the code and lift ideas, but it isn't packaged for
> one-click self-hosting yet — running it assumes a Cloudflare Workers
> account, D1, R2, and a Linux VPS you control.

---

## Table of Contents

1. [What it is](#what-it-is)
2. [What it is not](#what-it-is-not)
3. [Architecture](#architecture)
4. [Repository map](#repository-map)
5. [Quickstart](#quickstart)
6. [Common commands](#common-commands)
7. [Deployment](#deployment)
8. [Contributing](#contributing)
9. [Roadmap](#roadmap)

---

## What it is

Running a fleet of Claude Code sessions across worktrees is painful with
the stock CLI: context lives in tmux panes, there's no shared inbox, no
mobile, no resume across SSH disconnects, and no way to triage "which
session is asking me a question right now?" across a dozen of them.

Duraclaw is the orchestration fabric that fixes that. A Cloudflare
Workers frontend (TanStack Start + React) owns session lifecycle through
per-session [Durable
Objects](https://developers.cloudflare.com/durable-objects/), each
holding state and a SQLite message history. A VPS-side `agent-gateway`
spawns one detached `session-runner` per session — that runner owns one
`@anthropic-ai/claude-agent-sdk` `query()` and dials its Durable Object
directly over a buffered WebSocket. Gateway restarts and Worker
redeploys are non-events: the buffered channel replays on reconnect, and
SDK transcripts persist on disk for resume.

Layered on top: a Capacitor 8 Android shell that ships the same React
UI as a thin native client, web-bundle OTA updates, and
[`kata`](packages/kata/) — a structured-workflow CLI that adds phase
tasks, context injection, and stop-condition gates to Claude Code
sessions so they don't quit halfway through a feature.

## What it is not

- **Not a Claude wrapper or standalone chatbot.** Sessions run inside
  `@anthropic-ai/claude-agent-sdk` — duraclaw orchestrates them, it
  doesn't reimplement them.
- **Not a one-click self-hosted app yet.** It assumes a Cloudflare
  Workers account, D1, R2, and a Linux VPS you control. The deploy
  pipeline is internal infra (see [Deployment](#deployment)).
- **Not a replacement for the Claude Code CLI.** It complements it —
  the CLI is still the right tool for one-off local sessions.

## Architecture

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

Three invariants hold the design together:

- **The gateway never runs the SDK.** It's a spawn / list / status /
  reap control plane, nothing more.
- **The runner never embeds the Durable Object.** It dials the DO over
  WebSocket and validates against a per-spawn token.
- **Gateway restart and Worker redeploy are non-events** for an
  in-flight runner. The `BufferedChannel` (10K events / 50 MB ring)
  buffers while the WS is down and replays on reconnect, emitting one
  gap sentinel only on overflow.

For deeper details, see [`CLAUDE.md`](CLAUDE.md) and the per-subsystem
rules under [`.claude/rules/`](.claude/rules/).

## Repository map

| Path | What it does | Read more |
|---|---|---|
| [`apps/orchestrator`](apps/orchestrator) | Cloudflare Worker + TanStack Start (React UI, Durable Objects, Better Auth on D1) | [`.claude/rules/orchestrator.md`](.claude/rules/orchestrator.md) |
| [`apps/mobile`](apps/mobile) | Capacitor 8 Android shell + OTA updater | [`apps/mobile/README.md`](apps/mobile/README.md) |
| [`packages/agent-gateway`](packages/agent-gateway) | VPS spawn / list / reap control plane (Bun HTTP + systemd) | [`packages/agent-gateway/README.md`](packages/agent-gateway/README.md) |
| [`packages/session-runner`](packages/session-runner) | Per-session Claude Agent SDK owner | [`packages/session-runner/README.md`](packages/session-runner/README.md) |
| [`packages/shared-transport`](packages/shared-transport) | `BufferedChannel` + `DialBackClient` (runner → DO WS) | [`packages/shared-transport/README.md`](packages/shared-transport/README.md) |
| [`packages/shared-types`](packages/shared-types) | `GatewayCommand` / `GatewayEvent` shapes shared across the wire | — |
| [`packages/ai-elements`](packages/ai-elements) | Shared UI component library | — |
| [`packages/kata`](packages/kata) | Structured-workflow CLI for Claude Code | [`packages/kata/README.md`](packages/kata/README.md) |
| [`planning/`](planning) | Specs, progress tracker, research docs | [`planning/progress.md`](planning/progress.md) |
| [`scripts/verify/`](scripts/verify) | Real-curl + browser verification harnesses | [`AGENTS.md`](AGENTS.md) |

## Quickstart

Each developer runs duraclaw out of a dedicated git worktree under
`/data/projects/`. Ports are auto-derived from the worktree path so
clones don't collide.

```bash
cd /data/projects
git clone git@github.com:baseplane-ai/duraclaw.git duraclaw-dev4
cd duraclaw-dev4

# One-shot setup: copies .env from a sibling worktree, links kata,
# generates .dev.vars, starts the local gateway + orchestrator.
scripts/setup-clone.sh --from /data/projects/duraclaw/.env
```

If you don't have a sibling worktree to copy from:

```bash
cp .env.example .env        # fill in CC_GATEWAY_API_TOKEN + BOOTSTRAP_TOKEN
scripts/verify/dev-up.sh    # generates .dev.vars, starts the stack
```

See [`.claude/rules/worktree-setup.md`](.claude/rules/worktree-setup.md)
for the port-derivation table and per-worktree allocation rules.

## Common commands

Run from the repo root:

| Command | What it does |
|---|---|
| `pnpm dev` | Start every package in dev mode (Vite + miniflare for the orchestrator, watch builds for libs) |
| `pnpm build` | Build all packages via Turbo |
| `pnpm typecheck` | Typecheck everything |
| `pnpm test` | Run vitest suites across the workspace |
| `pnpm verify:smoke` | Real-curl + browser verification baseline (login, gateway, session, browser) |
| `pnpm kata` | Workflow CLI — `pnpm kata enter <mode>` to start a structured session |

> ⚠️ Don't run `pnpm ship`, `wrangler deploy`, or the gateway install
> script manually. Deploys are owned by the infra pipeline — see below.

For the full verification command set (`verify:auth`, `verify:gateway`,
`verify:session`, `verify:browser`, ...) and the verification policy
that goes with them, see [`AGENTS.md`](AGENTS.md).

## Deployment

The infra pipeline owns deploys. Pushing to `main` on `origin` triggers
a build that ships both the orchestrator (Cloudflare Workers) and the
agent-gateway (systemd unit on the VPS), and uploads the mobile OTA
bundle to R2 so the Android shell picks up the new web bundle on next
launch.

Mechanics, environment variables, and the OTA contract live in
[`.claude/rules/deployment.md`](.claude/rules/deployment.md) and
[`apps/mobile/README.md`](apps/mobile/README.md).

## Contributing

**Humans** — start with [`CLAUDE.md`](CLAUDE.md) for architecture and
conventions, then [`AGENTS.md`](AGENTS.md) for the verification policy
(every roadmap subphase ships with its own verification delta — that's
not optional). Per-package READMEs go deep on each subsystem.

**Claude agents** — [`CLAUDE.md`](CLAUDE.md) is auto-loaded as project
instructions. To start a structured session with phase tasks and stop
conditions, run `kata enter <mode>` (`research`, `planning`,
`implementation`, `debug`, `task`, `verify`, `freeform`). See
[`packages/kata/README.md`](packages/kata/README.md) for the full
mode list and how the workflow enforcement works.

**Git workflow** is scope-determined, not habit-determined:

- **Task-scoped work** (small fixes, docs, chores, quick refactors,
  research docs) commits directly to `main` and pushes. No branch, no
  PR. CI runs remotely after push.
- **Feature-scoped work** (anything that needs review before landing,
  multi-commit epics) lives on a `feature/<issue>-...` branch with a
  PR, lands via squash or merge-commit. Don't push a feature branch's
  commits to `main` out-of-band while its PR is open.

If you're not sure which bucket a change falls into, ask before opening
a PR. Stale PRs that duplicate commits already on `main` are worse than
no PR.

## Roadmap

See [`planning/progress.md`](planning/progress.md) for the live
phase / subphase tracker, and
[`planning/research/2026-04-01-product-roadmap.md`](planning/research/2026-04-01-product-roadmap.md)
for the full product narrative.

## License

[MIT](LICENSE) — Copyright (c) 2026 Baseplane.
