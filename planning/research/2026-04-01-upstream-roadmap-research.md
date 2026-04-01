---
date: 2026-04-01
topic: Upstream technology roadmaps and their impact on Duraclaw
status: complete
github_issue: null
---

# Research: Upstream Technology Roadmaps

## Context

Comprehensive research across all 7 upstream dependencies to determine what's coming in the
next 3-6 months, what Duraclaw should wait for vs build now, and what features are about to
become free via SDK upgrades.

---

## 1. Cloudflare Agents SDK (`agents`)

**Current:** v0.7.0 | **Latest:** v0.9.0 (2026-04-01)

### What shipped since v0.7

| Version | Key Features |
|---------|-------------|
| v0.7.1-v0.7.9 | Observability enrichments, alarm/schedule bug fixes, `sessionAffinity` getter, MCP localhost fix |
| **v0.8.0** | **Reactive `agent.state`** on `useAgent()`, **strongly-typed `AgentClient`** with `stub` proxy for RPC, **idempotent `schedule()`**, **Zod v4 required**, rewritten `keepAlive()` |
| v0.8.1-v0.8.7 | Workflow instance methods in dev, alarm resilience, MCP `transport: "auto"` (Streamable HTTP + SSE), `agents/vite` export, MCP SDK 1.28.0 |
| **v0.9.0** | `broadcastTransition` state machine, `TurnQueue` for chat turn serialization, `ContinuationState` lifecycle container |

### Official roadmap (GitHub issue #2)

**Shipped:** HTTP/WS, scheduling, state, RPC, email, MCP (full), multi-agent (A2A, supervisor, `getAgentByName`), AI SDK v6 migration, observability, queues, resumable streaming, cross-domain auth, workflows, Hono integration, human-in-the-loop.

**In progress / planned:**
- Third-party service adapters/connectors
- Built-in sync engine client/server
- Evals framework
- Admin panel UI

**Speculative (no timeline):**
- CLI (migrations, provisioning)
- `import {Agent} from "cloudflare:workers"` (baked into runtime)
- Python support
- Self-hosting guide

### Breaking changes planned (issue #844 — "speculative, not anytime soon")
- `Agent<Env, State, Props>` -> `Agent<{state, props, ...}>` (single options type)
- Inline PartyServer (remove dependency)
- Remove `agents/ai-chat`, `agents/codemode` (standalone packages)
- Remove AI v4/v5 code

### Impact on Duraclaw

| Action | Priority |
|--------|----------|
| **Upgrade to v0.9.0** — reactive `agent.state` eliminates manual state sync patterns, typed RPC via `stub` proxy | HIGH |
| Adopt idempotent `schedule()` for session scheduling | MEDIUM |
| Evaluate `TurnQueue` for chat message serialization | LOW |
| Watch for breaking v1.0 — plan migration when announced | WATCH |

**Release cadence:** Minor every 1-3 weeks, patches multiple times per week.

Sources: [GitHub releases](https://github.com/cloudflare/agents/releases), [Roadmap issue #2](https://github.com/cloudflare/agents/issues/2), [Breaking changes #844](https://github.com/cloudflare/agents/issues/844)

---

## 2. Vercel AI SDK (`ai`)

**Current:** v6.0.142 | **Latest stable:** v6.0.142 | **Beta:** v7.0.0-beta.55

### v7 is actively in development

55 beta releases since 2026-03-05. Pre-release checklist: [#12999](https://github.com/vercel/ai/issues/12999). Epic: [#14011](https://github.com/vercel/ai/issues/14011). No release date set. The team says: "very little friction to upgrade."

### Confirmed v7 features

| Feature | Issue | Status |
|---------|-------|--------|
| Stable telemetry (extracted to `@ai-sdk/otel`) | — | Done in beta |
| External loop control (custom agent loops) | [#13570](https://github.com/vercel/ai/issues/13570) | In progress |
| DurableAgent (Workflow runtime compat) | — | In progress |
| Per-tool timeouts | [#13536](https://github.com/vercel/ai/issues/13536) | Done |
| Top-level reasoning APIs (non-text reasoning) | [#12516](https://github.com/vercel/ai/issues/12516) | Done |
| Stable `context` with strict typing | [#9214](https://github.com/vercel/ai/issues/9214) | In progress |
| Live/Realtime APIs (OpenAI Realtime) | [#13897](https://github.com/vercel/ai/issues/13897) | In progress |
| Async/webhook APIs (long-running tasks) | [#12381](https://github.com/vercel/ai/issues/12381) | In progress |
| Compaction (token counting + compaction) | [#10565](https://github.com/vercel/ai/issues/10565) | In progress |
| Remote/uploaded file APIs | [#12995](https://github.com/vercel/ai/issues/12995) | In progress |
| **ModelMessage chunks as persistence format** | — | Planned |
| Tool output streaming (`yields` array) | [#9960](https://github.com/vercel/ai/issues/9960) | In progress |
| Tool input editing during approval | [#10720](https://github.com/vercel/ai/issues/10720) | In progress |
| `deferToolExecution` for streamText | [#13388](https://github.com/vercel/ai/issues/13388) | Done |

### v7 breaking changes

- **CJS exports removed** — ESM only
- `providerOptions` -> `options`, `providerMetadata` -> `metadata`
- `stepCountIs` -> `isStepCount`
- Node.js 20 dropped (22+ required)
- OpenTelemetry extracted to `@ai-sdk/otel`
- V4 Language Model Specification (`@ai-sdk/provider@4.0.0`)

### Known bugs affecting Duraclaw

- **Stale body/headers in ChatTransport** ([#13464](https://github.com/vercel/ai/pull/13464)) — dynamic state via transport body can be stale
- **Abort signal for resumed streams** ([#12924](https://github.com/vercel/ai/pull/12924)) — `stop()` was no-op on reconnected streams

### Impact on Duraclaw

| Action | Priority |
|--------|----------|
| **Stay on v6 stable** — v7 beta is too volatile for production | HIGH |
| Watch ModelMessage persistence format — could simplify our DO SQLite storage | WATCH |
| Tool output streaming will improve long-running tool UX | WAIT FOR v7 |
| Tool input editing during approval — useful for our permission flow | WAIT FOR v7 |
| Compaction API — could help with long sessions | WAIT FOR v7 |
| Plan v7 migration for when stable ships (ESM-only is fine for us) | PLAN |

**Release cadence:** ~1 patch/day on v6, ~2 betas/day on v7.

Sources: [v7 epic #14011](https://github.com/vercel/ai/issues/14011), [v7 milestone](https://github.com/vercel/ai/milestone/5), [npm](https://www.npmjs.com/package/ai)

---

## 3. TanStack Start (`@tanstack/react-start`)

**Current:** ^1.121.0 | **Latest:** v1.167.16 (2026-03-30)

### Status: Release Candidate (not yet 1.0)

Official stance: "This is the build we expect to ship as 1.0, pending final feedback, docs polish, and a few last-mile fixes." No specific date announced. [Discussion #5999](https://github.com/TanStack/router/discussions/5999) asking about 1.0 date remains unanswered.

### Breaking changes between v1.121 and v1.167

| Version | Breaking Change |
|---------|----------------|
| v1.121.0 | Vinxi-to-Vite migration, `APIRoute` -> `ServerRoute` |
| v1.127.3 | `router.isShell()` is now a function |
| v1.131.0 | Query integration -> `@tanstack/react-router-ssr-query` |
| v1.132+ (RC) | `validator` -> `inputValidator`, `getWebRequest()` -> `getRequest()`, `parseCookies()` -> `getCookies()`, response modes removed |
| v1.105.0 | `<Meta>` -> `<HeadContent>`, `<Scripts>` moved |
| v1.111.10 | Package renamed `@tanstack/start` -> `@tanstack/react-start` |

### Cloudflare Workers support

First-class. Official CF docs page exists. Uses `@cloudflare/vite-plugin`. Full bindings support. Static prerendering available at v1.138.0+.

### React Server Components

**NOT currently supported.** Will land as "non-breaking v1.x addition" after 1.0. No timeline.

### Vite 8 compatibility

**Not working yet.** Known incompatibilities. Stick with Vite 7 for now.

### Impact on Duraclaw

| Action | Priority |
|--------|----------|
| **Upgrade to ~1.167** — 46 versions behind, multiple breaking changes | HIGH |
| Migration work needed: `validator` -> `inputValidator`, `getWebRequest()` -> `getRequest()`, response modes removed | HIGH |
| Wait for 1.0 stable before major new feature work on routing | MEDIUM |
| RSC not available — current server functions approach is correct | OK |
| Don't upgrade to Vite 8 yet | BLOCKED |

**Release cadence:** Near-daily patches, monorepo-versioned with TanStack Router.

Sources: [RC blog post](https://tanstack.com/blog/announcing-tanstack-start-v1), [Beta tracking #2863](https://github.com/TanStack/router/discussions/2863), [CF Workers docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)

---

## 4. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**Current:** (bundled with cc-gateway) | **Latest:** v0.2.89

### Key 2026 features (by theme)

**Session management:**
- `listSessions()` with pagination
- `getSessionInfo()` — single-session metadata
- `getSessionMessages()` — conversation history with pagination + `includeSystemMessages`
- `forkSession()` — branch conversations from a point
- `renameSession()` / `tagSession()`

**Subagent support:**
- `listSubagents()` / `getSubagentMessages()` — retrieve subagent history
- `agentProgressSummaries` — periodic AI-generated progress summaries
- `task_progress` events with real-time metrics
- `task_started` system messages

**Performance:**
- `startup()` — pre-warm CLI subprocess for ~20x faster first queries
- Memory optimization (fixed unbounded UUID tracking)
- `getContextUsage()` — context window usage breakdown

**Budget & control:**
- `taskBudget` — API-side token budget awareness
- `EffortLevel` type exported (`'low' | 'medium' | 'high' | 'max'`)

**MCP improvements:**
- `enableChannel()` — SDK-driven MCP channel activation
- `reloadPlugins()` — refresh commands/agents/MCP status
- Fixed Streamable HTTP compatibility, connection races

**Hooks:**
- `includeHookEvents` — hook lifecycle messages
- `ConfigChange` hook event for security auditing
- `TeammateIdle` and `TaskCompleted` hook events

### Impact on Duraclaw

| Action | Priority |
|--------|----------|
| **Upgrade SDK in cc-gateway** — session management APIs are exactly what we need | HIGH |
| Use `forkSession()` for session forking feature (gap analysis item #27) | HIGH |
| Use `taskBudget` to expose budget limits in UI (gap analysis item #25) | HIGH |
| Use `getContextUsage()` for context usage display | MEDIUM |
| Use `startup()` for faster session initialization | MEDIUM |
| Use `agentProgressSummaries` for subagent progress in UI | MEDIUM |
| `listSessions()` / `getSessionMessages()` could replace our DO-level storage for history | EVALUATE |

**Release cadence:** Tracks Claude Code releases (~weekly), currently at v0.2.89.

Sources: [CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## 5. Better Auth

**Current:** (in orchestrator) | **Latest:** v1.5.6 (2026-03-22)

### Major news: native D1 support

v1.5.0 added **native Cloudflare D1 as a first-class database option**. Pass the D1 binding directly — no Drizzle adapter required. Uses D1's `batch()` for atomicity instead of interactive transactions. This is a significant improvement over our current Drizzle adapter approach.

### Breaking changes (1.4 -> 1.5)

| Change | Action |
|--------|--------|
| Drizzle adapter -> `@better-auth/drizzle-adapter` (separate package) | Install + update imports |
| API Key plugin -> `@better-auth/api-key` | Install if using |
| `userId` -> `referenceId` on ApiKey table | DB migration |
| `@better-auth/core/utils` barrel removed | Use subpath imports |
| After hooks execute post-transaction | Review hooks |

### New capabilities in v1.5

- **OAuth 2.1 Provider plugin** — turn your app into an auth server (OIDC, dynamic registration)
- **MCP Authentication** — remote MCP auth client for token verification
- **Agent Auth plugin** — agent-to-agent authentication
- **Session update endpoint** — update custom session fields at runtime
- **Secret key rotation** — non-destructive rotation
- **Redis secondary storage** for verification tokens
- **Rate limiting hardened** — sign-in/sign-up 3 req/10s default

### Impact on Duraclaw

| Action | Priority |
|--------|----------|
| **Upgrade to v1.5.6** — native D1 support eliminates Drizzle adapter complexity | HIGH |
| Evaluate dropping Drizzle adapter in favor of native D1 dialect | HIGH |
| MCP Auth plugin could be useful for cc-gateway authentication | MEDIUM |
| Agent Auth plugin relevant for multi-agent orchestration | WATCH |
| OAuth 2.1 Provider — not needed now but enables future integrations | LOW |

**Release cadence:** ~9 releases/month, very high velocity.

Sources: [v1.5 blog](https://better-auth.com/blog/1-5), [GitHub releases](https://github.com/better-auth/better-auth/releases)

---

## 6. Cloudflare Workers / D1 / Durable Objects Platform

### Durable Objects

| Feature | Status |
|---------|--------|
| SQLite storage GA | Shipped (April 2025), 10GB per object |
| Free tier | 100K requests/day, SQLite DOs only |
| SQLite billing | Started Jan 2026 (25B reads, 50M writes, 5GB included on paid) |
| WS max message size | Increased to 32 MiB |
| Hibernatable WS event timeout | Up to 7 days |
| `getByName` on namespace | Shipped (August 2025) |
| Data Studio inspection | Shipped (October 2025) |

### D1

| Feature | Status |
|---------|--------|
| **Global read replication** | Public beta (April 2025) — auto-provisioned replicas, free |
| 40-60% latency reduction | Shipped (January 2025) |
| Auto read-only query retries | Shipped (September 2025) |
| Per-account storage | Increased to 1 TB |
| `PRAGMA optimize` | Supported |
| Jurisdictions (data localization) | Shipped (November 2025) |

### Workers Runtime

| Feature | Status |
|---------|--------|
| **Dynamic Workers** | Open beta (March 2026) — spawn Workers at runtime, 100x faster than containers |
| CPU time up to 5 minutes | Shipped |
| 11 native Node.js modules | Shipped (http, https, crypto, fs, net, tls, dns, process, zlib) |
| 10x cold start reduction | Shipped (Birthday Week 2025) |
| Workers VPC | Shipped (Developer Week 2025) |
| Vite plugin — optional wrangler config | Shipped |
| Vite plugin — programmatic config in vite.config.ts | Shipped |

### Impact on Duraclaw

| Action | Priority |
|--------|----------|
| **Enable D1 read replication** — free latency improvement for auth queries | HIGH |
| **Evaluate Dynamic Workers** — could replace VPS executor entirely (sandbox Claude sessions in Workers) | RESEARCH |
| Use `getByName` for simpler DO stub construction | LOW |
| Data Studio for debugging DO state | NICE TO HAVE |
| CPU 5-min limit relevant for long executor operations | OK |

Sources: [DO SQLite GA](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/), [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/)

---

## 7. React 19 / Vite 7 (and Vite 8)

### React 19

**Current:** 19.x | **Latest:** 19.2.4 (January 2026)

Key 19.2 features:
- **`<Activity />` component** — hide/show UI with state preservation (replaces conditional rendering)
- **`useEffectEvent` hook** — separate event logic from Effects
- **Partial Pre-rendering** — static + dynamic split
- **Batched Suspense reveals for SSR**
- **Performance Tracks** in Chrome DevTools

Coming (experimental):
- `<ViewTransition />` — declarative animations via browser View Transition API (in canary)
- Fragment Refs
- Automatic Effect Dependencies (research phase)
- Compiler IDE Extension

**No React 20 announced.** Shipping incrementally in 19.x.

### Vite

**Current:** 7.x | **Latest:** Vite 8.0.3 (March 2026)

**Vite 8 is the big release:**
- **Rolldown replaces esbuild + Rollup** — 10-30x faster builds
  - Linear: 46s -> 6s
  - Ramp: 57% reduction
  - Beehiiv: 64% reduction
- **Oxc replaces Babel** for React Refresh in `@vitejs/plugin-react` v6
- **Built-in `resolve.tsconfigPaths`** — native tsconfig path aliases
- **WASM SSR support**
- **Integrated DevTools**
- Same Node.js requirements as Vite 7

Planned for 8.x+: Full Bundle Mode (3x faster dev), module-level persistent cache, Module Federation.

### Impact on Duraclaw

| Action | Priority |
|--------|----------|
| **Don't upgrade to Vite 8 yet** — TanStack Start incompatible | BLOCKED |
| Upgrade React to 19.2 — `<Activity />` useful for session switching | MEDIUM |
| `<ViewTransition />` will be great for route transitions when stable | WATCH |
| Plan Vite 8 upgrade after TanStack Start confirms compat | PLAN |

Sources: [React 19.2 blog](https://react.dev/blog/2025/10/01/react-19-2), [Vite 8 announcement](https://vite.dev/blog/announcing-vite8), [React Labs post](https://react.dev/blog/2025/04/23/react-labs-view-transitions-activity-and-more)

---

## Synthesis: Duraclaw Roadmap Implications

### Things to upgrade NOW (high-value, low-risk)

1. **Agents SDK v0.7 -> v0.9** — reactive state, typed RPC, idempotent scheduling
2. **Better Auth -> v1.5.6** — native D1, breaking changes manageable
3. **Claude Agent SDK -> v0.2.89** — session management APIs, forkSession, taskBudget, startup() pre-warming
4. **TanStack Start -> ~v1.167** — 46 versions behind, must migrate breaking changes

### Things to WAIT for (coming soon, don't build yourself)

| Don't build | Wait for | Timeline |
|-------------|----------|----------|
| Custom token counting | AI SDK v7 compaction API | ~2-3 months |
| Tool output progress UI | AI SDK v7 tool output streaming | ~2-3 months |
| Tool input editing in approvals | AI SDK v7 approval workflow | ~2-3 months |
| Custom session persistence format | AI SDK v7 ModelMessage chunks | ~2-3 months |
| Route transition animations | React `<ViewTransition />` | ~3-6 months |
| Full Bundle Mode dev perf | Vite 8.x | ~3-6 months |

### Things to BUILD NOW (not coming from upstream)

| Feature | Why build now |
|---------|--------------|
| Mobile responsive layout | No SDK provides this |
| Syntax highlighting (shiki/prism) | SDK gives markdown, we add highlighting |
| Session history page | SDK provides `listSessions()`, we build the UI |
| Slash command system | SDK provides hooks, we build the UX |
| Auto-growing textarea | Pure UI work |
| Toast notifications | Pure UI work |
| Empty states / onboarding | Pure UI work |
| Settings page | Pure UI work |
| Error boundaries | Pure UI work |

### Things to RESEARCH further

| Topic | Why |
|-------|-----|
| **Dynamic Workers replacing VPS executor** | CF's Dynamic Workers (open beta) could eliminate the VPS entirely — sandbox Claude Agent SDK sessions in edge-spawned Workers. 100x faster than containers, millisecond startup. This would be an architecture-level change. |
| **AI SDK v7 DurableAgent** | Vercel is building DurableAgent for the Workflow runtime — could this run on CF Durable Objects? Would unify our agent loop. |
| **Better Auth MCP/Agent Auth** | Could simplify cc-gateway auth and enable multi-agent auth patterns. |

---

## Revised Phase Order (updated from gap analysis)

### Phase 0 — Dependency Upgrades (NEW — do first)
1. Upgrade Agents SDK to v0.9.0
2. Upgrade Better Auth to v1.5.6 (native D1)
3. Upgrade Claude Agent SDK in cc-gateway
4. Upgrade TanStack Start to ~v1.167 (breaking change migration)

### Phase 1 — Core Chat Quality (was Phase 2)
5. Syntax highlighting (shiki)
6. Auto-growing textarea + Enter to send
7. File change events inline
8. Structured tool result display improvements

### Phase 2 — Session Management (was Phase 5, now unlocked by SDK upgrade)
9. Session history page (leverage `listSessions()`)
10. Session forking (leverage `forkSession()`)
11. Session search/filter
12. Session delete/rename/tag (leverage SDK APIs)
13. Budget/turn limits in new session dialog (leverage `taskBudget`)
14. Context usage display (leverage `getContextUsage()`)

### Phase 3 — Mobile & Responsive (unchanged)
15. Sidebar -> mobile drawer
16. `dvh` units, safe-area-inset
17. Touch-optimized spacing
18. Bottom sheet for permissions

### Phase 4 — Chat Features (unchanged)
19. Slash command system
20. File attachment/drag-drop
21. Input history
22. Auto-reconnect

### Phase 5 — Polish (unchanged)
23. Toast notifications
24. Empty states & onboarding
25. Accessibility pass
26. Error boundaries
27. Settings page

### Phase 6 — Wait for v7 (NEW)
28. Migrate to AI SDK v7 when stable
29. Adopt tool output streaming
30. Adopt compaction API
31. Adopt ModelMessage persistence
32. Migrate to Vite 8 when TanStack Start compatible

---

## Open Questions

- Should we evaluate Dynamic Workers as a replacement for the VPS executor? This is the most architecturally significant upstream development.
- When AI SDK v7 stabilizes, should we adopt DurableAgent or stay with our current SessionDO pattern?
- Should we switch to Better Auth's native D1 dialect or keep the Drizzle adapter for schema migration tooling?
