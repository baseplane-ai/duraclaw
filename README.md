<!--
  README design notes (see planning/research/2026-04-26-readme-overhaul.md):
  - Human-facing. Agent-facing rules live in CLAUDE.md. Do not duplicate.
  - ~280 lines max. Defer to per-package READMEs and .claude/rules/.
  - Architecture ASCII block is mirrored from CLAUDE.md — keep them in sync.
  - Hero image is generated; see docs/hero/ for variants.
-->

<p align="center">
  <img src="docs/hero/duraclaw-hero.png" alt="Duraclaw — a lobster claw cradling a constellation of glowing terminal sessions" width="100%">
</p>

<h1 align="center">Duraclaw</h1>

<p align="center">
  <strong>Multi-session Claude Code orchestration on Cloudflare Workers and a VPS runner fleet.</strong><br>
  Many concurrent sessions across worktrees, on the web and on Android,<br>
  with a workflow CLI that holds sessions to phase contracts so they actually finish.
</p>

<p align="center">
  <a href="#architecture"><img alt="runtime" src="https://img.shields.io/badge/runtime-CF%20Workers%20%2B%20DO-orange?style=flat-square"></a>
  <a href="#architecture"><img alt="runner" src="https://img.shields.io/badge/runner-Bun%20%2B%20systemd-orange?style=flat-square"></a>
  <a href="apps/orchestrator"><img alt="ui" src="https://img.shields.io/badge/UI-React%2019%20%2B%20TanStack%20Start-orange?style=flat-square"></a>
  <a href="apps/mobile"><img alt="mobile" src="https://img.shields.io/badge/mobile-Capacitor%208%20Android-orange?style=flat-square"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-orange?style=flat-square"></a>
</p>

> **Status — active development.** Built and used in-house at
> [@baseplane-ai](https://github.com/baseplane-ai); the repo is public so you
> can read the code and lift ideas, but it isn't packaged for one-click
> self-hosting yet — running it assumes a Cloudflare Workers account, D1, R2,
> and a Linux VPS you control.

---

## Table of Contents

1. [What it is](#what-it-is)
2. [What it is not](#what-it-is-not)
3. [Architecture](#architecture)
4. [Repository map](#repository-map)
5. [Tech stack](#tech-stack)
6. [Quickstart](#quickstart)
7. [Common commands](#common-commands)
8. [Deployment](#deployment)
9. [Contributing](#contributing)
10. [Roadmap](#roadmap)

---

## What it is

Running a fleet of Claude Code sessions across worktrees is painful with
the stock CLI: context lives in tmux panes, there's no shared inbox, no
mobile, no resume across SSH disconnects, and no way to triage *"which
session is asking me a question right now?"* across a dozen of them.

Duraclaw is the orchestration fabric that fixes that.

A Cloudflare Workers frontend (TanStack Start + React 19) owns session
lifecycle through three [Durable
Objects](https://developers.cloudflare.com/durable-objects/) — `SessionDO`
(per-session state + SQLite message history + event log), `UserSettingsDO`
(per-user prefs and push-subscription registry), and `SessionCollabDO`
(realtime collab via Y.js for multi-tab session views). Better Auth on
D1 handles sign-in; R2 stores the mobile OTA bundle.

A VPS-side `agent-gateway` spawns one detached `session-runner` per
session — that runner owns one `@anthropic-ai/claude-agent-sdk` `query()`
and dials its Durable Object directly over a buffered WebSocket.
Gateway restarts and Worker redeploys are non-events: the
`BufferedChannel` (10K events / 50 MB ring) replays on reconnect, and
SDK transcripts persist on disk for resume.

Layered on top:

- a **Capacitor 8 Android shell** that ships the same React UI as a
  thin native client, with **Capgo web-bundle OTA** for JS-only
  releases and a native-APK fallback poll for Capacitor / plugin
  bumps;
- a **dual-channel push system** — Web Push (VAPID) for browsers, FCM
  HTTP v1 for Android — fanning out from the same `UserSettingsDO`
  subscription registry;
- [**`kata`**](packages/kata/) — a structured-workflow CLI that adds
  phase tasks, context injection, and **exit-gate enforcement** to
  Claude Code sessions. Sessions can't quietly close mid-feature: the
  stop-hook blocks until the phase contract is satisfied or
  explicitly waived.

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
  |                            + SessionDO / UserSettingsDO / SessionCollabDO
  v
SessionDO (1 per session) --- state + SQLite message history + event_log
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

> **1. The gateway never runs the SDK.**
> It's a spawn / list / status / reap control plane, nothing more.
>
> **2. The runner never embeds the Durable Object.**
> It dials the DO over WebSocket and validates against a per-spawn token.
>
> **3. Gateway restart and Worker redeploy are non-events.**
> The `BufferedChannel` (10K events / 50 MB ring) buffers while the WS
> is down and replays on reconnect, emitting one gap sentinel only on
> overflow.

For deeper details, see [`CLAUDE.md`](CLAUDE.md) and the per-subsystem
rules under [`.claude/rules/`](.claude/rules/).

## Repository map

| Path | What it does | Read more |
|---|---|---|
| [`apps/orchestrator`](apps/orchestrator) | CF Worker + TanStack Start: React UI, three Durable Objects (`SessionDO`, `UserSettingsDO`, `SessionCollabDO`), Better Auth on D1, dual-channel push fan-out | [`.claude/rules/orchestrator.md`](.claude/rules/orchestrator.md) |
| [`apps/mobile`](apps/mobile) | Capacitor 8 Android shell + Capgo web-bundle OTA + native-APK fallback updater | [`apps/mobile/README.md`](apps/mobile/README.md) |
| [`packages/agent-gateway`](packages/agent-gateway) | VPS spawn / list / reap control plane (Bun HTTP + systemd) | [`packages/agent-gateway/README.md`](packages/agent-gateway/README.md) |
| [`packages/session-runner`](packages/session-runner) | Per-session Claude Agent SDK owner (one `query()` per process) | [`packages/session-runner/README.md`](packages/session-runner/README.md) |
| [`packages/shared-transport`](packages/shared-transport) | `BufferedChannel` ring + `DialBackClient` (runner → DO WS, 1/3/9/27/30s backoff) | [`packages/shared-transport/README.md`](packages/shared-transport/README.md) |
| [`packages/shared-types`](packages/shared-types) | `GatewayCommand` / `GatewayEvent` shapes shared across the wire | — |
| [`packages/ai-elements`](packages/ai-elements) | Vendored + customized fork of [Vercel AI Elements](https://ai-sdk.dev/elements) — 50+ chat / code / tool React components (`Conversation`, `Reasoning`, `ToolCallList`, `CodeBlock`, `Terminal`, `FileTree`, ...) over a 25-component Radix UI primitive layer, with [Streamdown](https://github.com/vercel/streamdown) for streaming markdown and [Shiki](https://shiki.style/) for syntax highlighting | — |
| [`packages/kata`](packages/kata) | Structured-workflow CLI for Claude Code: modes (research, planning, implementation, debug, task, verify, freeform), phase tasks, exit-gate enforcement | [`packages/kata/README.md`](packages/kata/README.md) |
| [`planning/`](planning) | Specs, progress tracker, research docs | [`planning/progress.md`](planning/progress.md) |
| [`scripts/verify/`](scripts/verify) | Real-curl + browser verification harnesses (no mocks) | [`AGENTS.md`](AGENTS.md) |

## Tech stack

Every major library duraclaw is built on, grouped by concern. Versions float on the latest minor unless otherwise pinned — see the per-package `package.json` for exact ranges.

**Frontend (`apps/orchestrator`)**

- [React 19](https://react.dev/) + [React DOM](https://react.dev/) — UI runtime
- [TanStack Start](https://tanstack.com/start) + [TanStack Router](https://tanstack.com/router) — full-stack React framework + file-based routing
- [TanStack DB](https://tanstack.com/db) + [TanStack Query](https://tanstack.com/query) + [TanStack Virtual](https://tanstack.com/virtual) — local-first reactive collections, query cache, list virtualization
- [Vite 8](https://vite.dev/) + [`@cloudflare/vite-plugin`](https://www.npmjs.com/package/@cloudflare/vite-plugin) + [`@vitejs/plugin-react`](https://www.npmjs.com/package/@vitejs/plugin-react) — dev server + production build
- [Tailwind CSS 4](https://tailwindcss.com/) + [`@tailwindcss/vite`](https://tailwindcss.com/) + [`tw-animate-css`](https://www.npmjs.com/package/tw-animate-css) — styling
- [Zustand](https://zustand.docs.pmnd.rs/) — client state, [Zod 4](https://zod.dev/) — schema validation
- [`@dnd-kit/*`](https://dndkit.com/) — drag and drop, [`@use-gesture/react`](https://use-gesture.netlify.app/) + [`@react-spring/web`](https://www.react-spring.dev/) — gesture / animation
- [Sonner](https://sonner.emilkowal.ski/) — toasts, [`react-top-loading-bar`](https://www.npmjs.com/package/react-top-loading-bar) — route progress
- [`react-markdown`](https://github.com/remarkjs/react-markdown) + [`remark-gfm`](https://github.com/remarkjs/remark-gfm) + [`rehype-sanitize`](https://github.com/rehypejs/rehype-sanitize) — markdown rendering
- [`input-otp`](https://input-otp.rdsx.dev/), [`cmdk`](https://cmdk.paco.me/) — input primitives

**Realtime / collab**

- [Yjs](https://yjs.dev/) + [`y-partyserver`](https://www.npmjs.com/package/y-partyserver) + [`y-protocols`](https://www.npmjs.com/package/y-protocols) + [`y-indexeddb`](https://www.npmjs.com/package/y-indexeddb) — CRDT collab inside `SessionCollabDO`
- [PartyServer](https://github.com/threepointone/partyserver) + [PartySocket](https://github.com/threepointone/partysocket) — Durable-Object-friendly WebSocket framework
- [`agents`](https://www.npmjs.com/package/agents) — Cloudflare Agents SDK (Durable-Object-backed agent runtime)

**AI / chat UI**

- [Vercel AI SDK (`ai`)](https://sdk.vercel.ai/) + [`@ai-sdk/react`](https://sdk.vercel.ai/) — streaming chat primitives
- **[Vercel AI Elements](https://ai-sdk.dev/elements)** — vendored as `@duraclaw/ai-elements` and customized
- [Streamdown](https://github.com/vercel/streamdown) (`streamdown` + `@streamdown/cjk` / `code` / `math` / `mermaid`) — Vercel's streaming markdown
- [Shiki](https://shiki.style/) — syntax highlighting, [`ansi-to-react`](https://www.npmjs.com/package/ansi-to-react) — terminal color rendering
- [`tokenlens`](https://www.npmjs.com/package/tokenlens) — token accounting, [`@xyflow/react`](https://reactflow.dev/) — graph diagrams
- [`react-jsx-parser`](https://www.npmjs.com/package/react-jsx-parser) — runtime JSX previews, [`media-chrome`](https://www.media-chrome.org/) — media controls, [`@rive-app/react-webgl2`](https://rive.app/) — Rive animations
- [Motion](https://motion.dev/), [`embla-carousel-react`](https://www.embla-carousel.com/), [`use-stick-to-bottom`](https://www.npmjs.com/package/use-stick-to-bottom)

**UI primitives**

- [Radix UI](https://www.radix-ui.com/) — accordion, alert-dialog, avatar, checkbox, collapsible, dialog, direction, dropdown-menu, hover-card, label, popover, progress, radio-group, scroll-area, select, separator, slot, switch, tabs, tooltip, use-controllable-state, icons
- [Lucide React](https://lucide.dev/) — icon set
- [`class-variance-authority`](https://cva.style/) + [`clsx`](https://github.com/lukeed/clsx) + [`tailwind-merge`](https://github.com/dcastil/tailwind-merge) — variant authoring + class merging

**Backend (Cloudflare Workers)**

- [Cloudflare Workers](https://workers.cloudflare.com/) + [Durable Objects](https://developers.cloudflare.com/durable-objects/) — runtime + per-session state
- [D1](https://developers.cloudflare.com/d1/) — SQL store for auth (via [Drizzle ORM](https://orm.drizzle.team/) + [`drizzle-kit`](https://orm.drizzle.team/kit-docs/overview))
- [R2](https://developers.cloudflare.com/r2/) — mobile OTA bundle storage
- [Hono](https://hono.dev/) — edge HTTP router, [Wrangler](https://developers.cloudflare.com/workers/wrangler/) — Workers tooling

**Auth**

- [Better Auth](https://www.better-auth.com/) + [`better-auth-capacitor`](https://www.npmjs.com/package/better-auth-capacitor) — sessions on web, bearer tokens on native
- [`jose`](https://github.com/panva/jose) — JWT signing for FCM HTTP v1

**Push notifications**

- [`@pushforge/builder`](https://www.npmjs.com/package/@pushforge/builder) — Web Push (VAPID) payload builder
- [`@capacitor/push-notifications`](https://capacitorjs.com/docs/apis/push-notifications) — FCM bridge on Android

**Mobile (`apps/mobile`)**

- [Capacitor 8](https://capacitorjs.com/) — `@capacitor/core`, `@capacitor/android`, `@capacitor/app`, `@capacitor/network`, `@capacitor/preferences`, `@capacitor/push-notifications`
- [`@capacitor-community/sqlite`](https://github.com/capacitor-community/sqlite) — native SQLite swap for OPFS
- [`@capgo/capacitor-updater`](https://capgo.app/) — web-bundle OTA channel
- [`@tanstack/capacitor-db-sqlite-persistence`](https://tanstack.com/db) — TanStack DB persistence on native

**PWA**

- [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) + [`workbox-precaching`](https://developer.chrome.com/docs/workbox/) + [`workbox-window`](https://developer.chrome.com/docs/workbox/)

**VPS runner stack (`packages/agent-gateway` + `packages/session-runner`)**

- [Bun](https://bun.sh/) — runtime for the gateway HTTP server and the per-session runner binary
- [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — the agent SDK each runner owns
- [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) — lower-level client
- systemd — process supervision for the gateway

**`packages/kata` (workflow CLI)**

- [`js-yaml`](https://github.com/nodeca/js-yaml) — phase / mode config parsing
- [Zod](https://zod.dev/) — config validation
- [`tsx`](https://github.com/privatenumber/tsx) — dev runner

**Build / tooling (root)**

- [pnpm workspaces](https://pnpm.io/workspaces) + [Turbo](https://turbo.build/repo) — monorepo + task orchestration
- [tsup](https://tsup.egoist.dev/) — library builds, [TypeScript 5.8](https://www.typescriptlang.org/) — typing
- [Biome](https://biomejs.dev/) — lint + format, [Vitest 4](https://vitest.dev/) + [`@testing-library/react`](https://testing-library.com/) + [`jsdom`](https://github.com/jsdom/jsdom) — tests

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

> **Heads up — don't run `pnpm ship`, `wrangler deploy`, or the gateway
> install script manually.** Deploys are owned by the infra pipeline; doing
> it by hand bypasses the mobile OTA bundle upload and strands every
> Android client on the previous web bundle. See [Deployment](#deployment).

For the full verification command set (`verify:auth`, `verify:gateway`,
`verify:session`, `verify:browser`, ...) and the verification policy
that goes with them, see [`AGENTS.md`](AGENTS.md).

## Deployment

The infra pipeline owns deploys. Pushing to `main` on `origin` triggers
a build that ships:

1. The **orchestrator** to Cloudflare Workers, with `VITE_APP_VERSION`
   stamped in from `git rev-parse --short HEAD`.
2. The **agent-gateway** to its systemd unit on the VPS.
3. The **mobile OTA web bundle** (and `version.json` pointer) to the
   `duraclaw-mobile` R2 bucket so the Android shell picks up the new
   bundle on next launch via Capgo.

Mechanics, environment variables, and the OTA contract live in
[`.claude/rules/deployment.md`](.claude/rules/deployment.md) and
[`apps/mobile/README.md`](apps/mobile/README.md).

## Contributing

**Humans** — start with [`CLAUDE.md`](CLAUDE.md) for architecture and
conventions, then [`AGENTS.md`](AGENTS.md) for the verification policy
(every roadmap subphase ships with its own verification delta — that's
not optional). Per-package READMEs go deep on each subsystem.

**Claude agents** — [`CLAUDE.md`](CLAUDE.md) is auto-loaded as project
instructions. To start a structured session with phase tasks, context
injection, and exit-gate enforcement, run `kata enter <mode>` —
available modes: `research`, `planning`, `implementation`, `debug`,
`task`, `verify`, `freeform`. The stop-hook blocks until the phase
contract is satisfied, so a session that wanders off into a side-quest
gets caught at the gate. See
[`packages/kata/README.md`](packages/kata/README.md) for the full mode
list and how the workflow enforcement works.

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
