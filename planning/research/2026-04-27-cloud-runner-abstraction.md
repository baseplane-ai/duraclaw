---
date: 2026-04-27
topic: Cloud runner abstraction — Kimi adapter and overseer-as-cloud-host role
type: feature
status: complete
github_issue: null
items_researched: 6
related:
  - planning/research/2026-04-10-pluggable-agent-gateway.md
  - planning/research/2026-04-26-gemini-runner-adapter.md
  - planning/research/2026-04-25-acp-codex-runner.md
  - planning/research/2026-04-22-session-do-partyserver-migration-feasibility.md
---

# Research: Cloud runner abstraction — Kimi adapter and overseer-as-cloud-host role

## Context

Two new asks landed in conversation:

1. **Kimi as a runner backend.** `sinameraji/kimiflare` ships a working
   TypeScript agent against Kimi-K2.6 on Cloudflare Workers AI (262k
   context, OpenAI-compat tools, ~$0.95 / $4.00 per Mtok in/out, $0.16
   for cached input). We want the model option, not the TUI.
2. **Kimi as an overseer.** A second, read-only agent role that watches
   the primary runner's `GatewayEvent` stream and can co-sign gates,
   review plans, or grade results. The cheap-model + 262k-context shape
   is well-suited to this.

Both asks point at the same architectural shift: **the runner abstraction
today conflates *which model* with *where the runner runs*.** Today
every runner is a Bun process on the VPS. The Kimi-as-overseer use case
wants a runner that lives in a Cloudflare Worker, has no worktree, and
participates in the conversation as a peer to the VPS runner — not as a
sub-system of it.

The user also flagged: "CF has a bunch of first-party packages for their
agents but I think we might want to keep our universal abstractions
instead." This doc validates that call with concrete details and lays
out the abstraction that lets Kimi-as-runner and Kimi-as-overseer fall
out of the same change.

Classification: **feature research** — preparing for spec phase on a
roadmap-level architectural rename + two new adapter implementations.

## Scope

| # | Item | Sources |
|---|------|---------|
| 1 | Current `RunnerAdapter` surface and where vps-process is baked in | codebase (`adapters/*`, `shared-types`, `dial-back-client`, `buffered-channel`, agent-gateway, session-do) |
| 2 | Cloudflare first-party agent stack (April 2026) — what each piece does and where it conflicts with our abstraction | developers.cloudflare.com, `cloudflare/agents`, AI SDK v5 |
| 3 | `kimiflare` internals — what's lift-worthy into a different host | git clone of `sinameraji/kimiflare` v0.13.7 |
| 4 | The shape of a `RunnerHost` split (`vps-process` ⟂ `cloud`) | architecture synthesis |
| 5 | Kimi adapter as concrete instantiation | items 1+3 combined |
| 6 | Overseer role as concrete instantiation | item 4 + DO event-log surface |

Out of scope: pricing cliff modelling, exact D1 schema for Kimi models,
CF Worker cold-start measurement, MCP-over-HTTP server design.

## Findings

### 1. Current `RunnerAdapter` is the right *contract*, but its host is implicit

The adapter contract
(`packages/session-runner/src/adapters/types.ts:18-50`) has nothing
process-specific in it:

```ts
interface RunnerAdapter {
  readonly name: AgentName
  readonly capabilities: AdapterCapabilities
  run(opts: AdapterStartOptions): Promise<void>
  pushUserTurn(message: { role: 'user'; content: string | ContentBlock[] }): void
  interrupt(): Promise<void>
  dispose(): Promise<void>
}
```

`AdapterStartOptions` is similarly host-neutral —
`{sessionId, project, model, prompt, resumeSessionId, env, signal,
codexModels, onEvent}`. There is no `cwd`, no PID, no signal handler,
no expectation of a filesystem.

But the **runner-host wiring around the adapter is not host-neutral**:

| Layer | What's baked in | File |
|---|---|---|
| Spawn argv | 7 positional args including `pidFile`, `exitFile`, `metaFile` | `agent-gateway/src/handlers.ts:190-202` |
| Process bootstrap | `pidFile` written at startup, `metaFile` updated every 10s, `exitFile` atomic-once on death | `session-runner/src/main.ts:308+, ~437` |
| Termination | `SIGTERM → 2s watchdog → SIGKILL` | `session-runner/src/main.ts:~437` |
| Reaper | gateway scans `$SESSIONS_DIR` for stale `.pid` / `.meta.json` / `.exit` files every 5 min | `agent-gateway/src/reaper.ts` |
| Codex tooling | spawns `codex-cli` as a child process | `adapters/codex.ts` |
| Resume | `runner_session_id` is an on-disk SDK transcript (Claude) or a CLI thread id (Codex) | `claude.ts`, `codex.ts` |

A CF Worker host has none of: PID, persistent FS, SIGTERM, child-process
spawn, on-disk transcript. Six things break, all in the wiring — none in
the adapter contract itself. **That's exactly the layer the abstraction
needs to surface.**

The dial-back contract is **already host-neutral**. `DialBackClient`
(`packages/shared-transport/src/dial-back-client.ts`) reconnects with
`[1, 3, 9, 27, 30, 30…]s` backoff, treats `4401` /
`4410` / `4411` as terminal, and exhausts after 20 post-connect
failures without 10s stability. It dials `wss://.../agents/session-agent/<do-id>?role=gateway&token=...`
— a Worker can dial that exactly the same way a Bun process does, with
the same Agents SDK pattern. `BufferedChannel` (10K events / 50MB ring,
gap sentinel persisted to a `.gap` sidecar) only needs the sidecar on
the VPS; in a Worker it'd live in DO storage or be skipped (the cloud
runner is short-lived, so an overflow gap is much less likely).

**Bottom line on item 1:** The contract is already at the right layer.
The host assumptions are baked into the runner-process bootstrap
(main.ts) and the gateway spawn path. To add a cloud host, we add a
second spawn path (DO → Worker) and a second bootstrap shell — the
adapter doesn't change.

#### Extension points for a new adapter (`'kimi'`)

| # | File | Change |
|---|---|---|
| 1 | `packages/shared-types/src/index.ts:15` | Widen `AgentName` from `'claude' \| 'codex'` to include `'kimi'` |
| 2 | `packages/session-runner/src/adapters/index.ts` | Register factory |
| 3 | `packages/session-runner/src/adapters/kimi.ts` | New adapter class |
| 4 | `packages/session-runner/src/main.ts:504-555` | Dispatch branch (or move all adapters to `run(opts)` and drop the if-chain — recommended) |
| 5 | `apps/orchestrator/src/agents/session-do/rpc-lifecycle.ts:30` | Add `'kimi'` to `KNOWN_AGENTS` |

That's it for the vps-process Kimi adapter. The cloud-host work is
additional and discussed separately in §4–§7.

### 2. Cloudflare first-party stack — survey by layer

The user's instinct ("keep our universal abstractions") holds up. The CF
stack is excellent at the *infrastructure* layer and starts conflicting
with us at the *runner-loop* layer.

| Piece | What it does | Layer | Conflicts with `RunnerAdapter`? |
|---|---|---|---|
| **`agents` base SDK** (`extends Agent`) | DO + SQLite + WS + `@callable()` + `setState` + scheduling | infrastructure | No — we already use it for `SessionDO` |
| **Workers AI binding** (`env.AI.run`) | In-Worker model call, no API key | provider call | No — same shape via OpenAI-compat HTTP, see below |
| **AI Gateway** | Reverse proxy: logs / cache / rate-limit / fallback. URL-prefix swap | transport | No — orthogonal, applies via base-URL change |
| **AI SDK v5 (`ai` + `workers-ai-provider`)** | Provider-neutral `streamText` / tool-call loop / Zod | provider call + thin loop | **Lives inside one adapter** — doesn't replace the abstraction |
| **`AIChatAgent`** (`@cloudflare/ai-chat`) | DO-resident chat persistence + AI SDK loop + resumable streaming | runner loop | **Yes — wrong layer.** Owns message shape, persistence schema, and the loop |
| **`@cloudflare/think`** | "Claude-Code-shaped" agentic loop with `maxSteps`, `ResumableStream`, `beforeToolCall` hook, in-DO file workspace | runner loop | **Yes — strong overlap.** Assumes runner-IS-DO. Re-does BufferedChannel / gate protocol with CF primitives |
| **`McpAgent`** | Build MCP servers on Workers (Streamable HTTP / OAuth) | tooling | No — but no first-party MCP *client*, so the cloud runner has no stdio-MCP path |
| **Workflows** | Durable step pipeline, restartable | orchestration | Adjacent — could replace some reaper/scheduler pieces, but a separate question |

**Why the conflict at the loop layer matters.** `@cloudflare/think` and
`AIChatAgent` make the loop an extension of the DO. Their assumption is
that the agent process and the persistence layer are the same thing. We
deliberately split them so the agent can live where the *tools* are: a
VPS worktree with `git`, `rg`, `pnpm`, `bun`, MCP stdio servers, and
arbitrary `bash`. Fold the loop back into the DO and the VPS adapters
all stop working.

**Their `beforeToolCall` is a different shape from our gate protocol.**
`think`'s hook is an in-process callback that returns `allow / block /
substitute`. Our `permission_request` GatewayEvent is a wire-protocol
message that pauses the runner, traverses dial-back to the DO, surfaces
in the UI, and returns via `PermissionResponseCommand`. They serve the
same purpose; they're not interchangeable. Adopting `think` for
cloud-host overseers would mean carrying two gate models simultaneously.

**`ResumableStream` is browser-side only.** It handles "browser refresh
mid-stream"; it does not handle our orphan / fork-with-history /
runner_session_id-based resume. The orphan-recovery code in `SessionDO`
(falls through to `forkWithHistory(content)` when the runner is alive
but unreachable) is a multi-layer protocol no first-party piece offers.

**MCP-stdio is a real asymmetry, not an abstraction problem.** A Worker
can't spawn stdio processes. The CF stack has no MCP client at all (it
provides `McpAgent` for *building* servers). VPS-host runners get
MCP-stdio for free via Claude Agent SDK; cloud-host runners can only
consume HTTP/SSE MCP. **Model this in `AdapterCapabilities`, don't
hide it.**

#### What we *should* adopt

- **AI Gateway** — pure URL-prefix swap (`https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/workers-ai/...`). Logs, cache, analytics for free. Already partially in use; expand to cover the new Kimi adapter. Cache-friendly prompt design (kimiflare's session-stable prefix split + `stableStringify`) makes the cache earn its keep.
- **`agents` base SDK** — already in. Continue.
- **Workers AI via OpenAI-compat HTTP, not the `env.AI` binding** — Kimi K2.6 is reachable both ways. Targeting HTTP makes the same Kimi adapter code work on a VPS *and* inside a Worker. Targeting `env.AI` ties the adapter to Worker hosts only and is a needless lock-in.
- **AI SDK v5** — *optional* internal-to-the-adapter dependency. If the Kimi adapter wants AI SDK to abstract OpenAI-shaped tool-calling, it can; if it wants to lift kimiflare's hand-rolled SSE accumulator (~100 LOC, very clean), that's also fine. `RunnerAdapter` doesn't care.

#### What we should *not* adopt

- `AIChatAgent` and `@cloudflare/think` — wrong layer, would force two parallel loop implementations, would not work for Claude/Codex/Gemini-CLI.
- The `env.AI` binding as primary call site — see above.
- `ResumableStream` as a replacement for our resume protocol — handles a different problem.

### 3. `kimiflare` internals — what's mechanically lift-worthy

The repo (`sinameraji/kimiflare` v0.13.7, ~9.8k LOC TS) is cleanly
layered. Everything below `src/app.tsx` (the Ink TUI) is reusable.

**Single integration seam: `AgentCallbacks`** (`src/agent/loop.ts:13-27`)
— a callback interface the loop emits into. Wire its events into our
`onEvent: (event: GatewayEvent) => void` and the rest is mechanical
translation.

**Liftable, in priority order:**

| Module | LOC | What it gives us |
|---|---|---|
| `agent/client.ts` | ~330 | Workers AI fetch (direct + AI Gateway URL forms), SSE accumulator with tool-call delta merging keyed by index, retry on CF code 3040 / 5xx with exp backoff to 5 attempts, session affinity headers |
| `agent/loop.ts` | ~250 | Multi-iteration tool-call loop, anti-loop guardrail (signature-based dedupe of repeated calls), historical-reasoning stripping for token reduction |
| `agent/messages.ts` | ~150 | Message normalisation, `stableStringify` (deterministic JSON for AI Gateway cache hits) |
| `util/sse.ts` | 50 | Vanilla `data:`-only SSE line reader |
| `tools/executor.ts` | ~200 | Permission cache keyed by `sessionKey`; bash session-allow keyed by **first token of the command** (`bash:git`, `bash:pnpm`) so allow-once whitelists by command family |
| `tools/reducer.ts` + `artifact-store.ts` + `expand-artifact.ts` | ~400 | Tool-result artifact pattern — store raw, return summary + `artifactId`, model can request expansion. Per-tool reduction policies. Unobtrusive but powerful for long sessions |
| `mcp/manager.ts` + `adapter.ts` | ~150 | Thin wrapper over `@modelcontextprotocol/sdk` for stdio + SSE; tool names namespaced `mcp_${server}_${tool}` |

**Genuinely novel ideas worth absorbing into our broader architecture
beyond just the Kimi adapter:**

1. **Tool-result artifact store.** Reduces what the model sees while
   keeping raw available for `expand_artifact`. Per-tool reduction
   policies (grep keeps top-3-per-file, bash dedupes consecutive lines
   except for diff commands, web_fetch HTML→text cap). This is a real
   token-reduction lever and is model-agnostic — could go upstream to
   the SessionDO event-log layer eventually.
2. **HyDE-on-write embeddings** (memory module) — embed
   `hypothetical_queries | content`, not just content. Improves recall
   without query-time cost.
3. **Two-tier model split** — main model for completions, plumbing
   model (`@cf/meta/llama-4-scout-17b-16e-instruct`) for verification /
   topic-key / synthesis. Cuts memory-system cost meaningfully. Direct
   parallel to our overseer idea: cheap model watching expensive model.
4. **Anti-loop guardrail** — sliding-window signature dedupe (~25
   LOC). Model-agnostic.
5. **Bash session-allow keyed by first token** — same trick we'd
   want for our `permission_request` flow generally, not Kimi-specific.

**Skip:** TUI (Ink, themes, paste collapse, type-ahead queue),
sessions JSON store (we have D1), CF-pricing display, update checker,
`code-mode` (interesting but separate project). The memory module is
borderline — high quality, but agent-memory is a separate roadmap epic
and we shouldn't pull it in piecemeal.

### 4. The `RunnerHost` split

What we have implicitly today:

```
RunnerAdapter  = which model the runner wraps   (claude / codex / [gemini])
[RunnerHost]   = where the runner runs          (always vps-process today)
```

What we want explicitly:

```
RunnerAdapter  : claude | codex | gemini | kimi | ...
RunnerHost     : vps-process | cloud
Capabilities   : { fs, bash, network, mcp_stdio, mcp_http, ... }
```

A spawn request carries all three. The DO's `triggerGatewayDial` becomes
*one* of two spawn paths; the other is `triggerCloudSpawn` (DO → Worker
fetch / sub-DO RPC).

#### What changes vs. today

| Concern | `vps-process` (today) | `cloud` (new) |
|---|---|---|
| Spawner | `agent-gateway` HTTP `POST /sessions/start` | DO directly (Worker fetch / sub-DO / scheduled invoke) |
| Bootstrap | argv with `pidFile/exitFile/metaFile`; `main.ts` writes pid, listens for SIGTERM | Worker handler instantiates adapter; `AbortSignal` is the only termination |
| Worktree | Yes — local FS | No — read-only tools or virtual workspace |
| Idle cost | Bun process held until reaper (30 min default) | ~Zero (stateless invocation) |
| Per-turn cost | Cheap (warm SDK / loop state in memory) | Expensive (rehydrate from event_log / D1 each turn) |
| Reaper | Required | N/A |
| Resume | `runner_session_id` is an on-disk transcript | `runner_session_id` is a logical pointer; rehydrate from event_log + D1 |
| Termination | SIGTERM → 2s → SIGKILL | `controller.abort()` |
| MCP stdio | Yes | No (HTTP/SSE only) |
| Bash / fs tools | Yes | No |
| Dial-back | Same `wss://.../agents/session-agent/<do-id>?role=gateway&token=...` | Same |

**The dial-back transport doesn't change.** A Worker dials the DO with
the same Agents SDK pattern, presents the same `callback_token`, gets
validated the same way (timing-safe compare against
`active_callback_token`), and emits the same `GatewayEvent` stream. The
DO can't tell — and shouldn't care — whether the WS peer is a Bun
process or a Worker.

**Capability bitmap grows.** `AdapterCapabilities` already exists; it
gains `requiresFilesystem`, `supportsMcpStdio`, `supportsMcpHttp`,
`readOnly`. The DO refuses to bind tool-use channels for capabilities a
runner doesn't have, and the runner refuses inbound commands for tools
it isn't permitted to run — defence in depth, same pattern as auth
tokens.

**Capability is an axis on `RunnerHost`, not on `RunnerAdapter`.** The
same Kimi adapter is full-capability when run on a VPS host and
read-only when run in a cloud overseer. That's the unlock.

#### Why split host from adapter rather than just "make a new overseer thing"

Two reasons:

1. **Symmetry pays.** Once host is first-class, the *same Kimi adapter
   code* runs in both modes. If we built "Kimi adapter" and "Kimi
   overseer" as separate things, we'd carry two implementations of the
   tool-call loop, the SSE accumulator, the retry policy. Same trap as
   the second runner-adapter we'd write without §1's contract.
2. **Future runner backends inherit the slot.** When OpenAI's
   responses API or Anthropic Workers AI or whatever ships, slotting
   it in is "implement `RunnerAdapter`, advertise capabilities, declare
   compatible hosts" — not "rewrite the runner-host layer."

### 5. Kimi adapter — concrete proposal

**Phase A: Kimi adapter on `vps-process` host.**

- New `KimiAdapter` in `packages/session-runner/src/adapters/kimi.ts`,
  implementing the existing `RunnerAdapter` contract.
- Lift from kimiflare: `agent/client.ts` (Workers AI HTTP + SSE +
  retry), `agent/loop.ts` (loop + anti-loop guardrail), `tools/executor.ts`
  (permission cache + bash-first-token session-allow), `mcp/` (stdio +
  HTTP MCP support — VPS host can use both).
- Target the **OpenAI-compat HTTP endpoint**, not `env.AI` binding —
  same code will work on cloud-host in Phase C.
- Route through **AI Gateway** by default (URL prefix). Set up
  session-stable system prompt split so cached prefix earns hits.
- `AgentName` widens to `'claude' | 'codex' | 'kimi'`.
- New `kimi_models` D1 table parallel to `codex_models` (model name +
  context window + per-Mtok pricing). DO injects on `execute` /
  `resume`.
- Auth: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` per-user (CAAM
  rotation epic already covers this shape).

**Capabilities advertised** (via `SessionInitEvent.capabilities`):

```ts
{
  supportsRewind: false,           // Kimi has no SDK-level rewind
  supportsThinkingDeltas: true,    // reasoning_content is split out
  supportsPermissionGate: true,    // implemented in adapter
  supportsSubagents: false,
  supportsPermissionMode: false,   // Kimi has no plan/acceptEdits modes
  supportsSetModel: true,
  supportsContextUsage: true,
  supportsInterrupt: true,         // AbortController
  supportsCleanAbort: true,
  emitsUsdCost: true,              // cost from x-aig-cost-cents header or computed
  availableProviders: [{ provider: 'cloudflare-workers-ai', models: ['@cf/moonshotai/kimi-k2.6'] }],
}
```

**What we don't lift** from kimiflare in Phase A: memory module, code-mode,
artifact store. The artifact-store pattern is interesting enough that it
deserves its own follow-up that crosses adapters (probably at the SessionDO
event-log layer), not bolted into one adapter.

**Phase B (later): Kimi adapter on `cloud` host.** Once Phase A is
shipping, the same adapter compiled for a Worker target. This is most of
the §6 work below.

### 6. Overseer role — concrete proposal

**Phase C: Cloud-host plumbing.** First user of cloud-host is the
post-hoc summariser overseer because it has zero command-side risk.

- DO learns `triggerCloudSpawn(ctx, { adapter: 'kimi', host: 'cloud',
  capability: 'read-only', triggerEvent })`. Implementation is a
  `fetch` from the DO to a sibling Worker (same Worker script, separate
  fetch handler) that boots the Kimi adapter inside the Worker, dials
  back to the DO over the same WSS, runs to completion, exits.
- The Worker dial-back uses the same `DialBackClient` and
  `BufferedChannel` (with sidecar persistence disabled — the Worker is
  short-lived). Token validation, close codes, reconnect — all unchanged.
- Read-only enforcement: the DO does not bind `permission_request` /
  `tool_use` channels for read-only runners. The runner's tool registry
  also strips mutating tools at construction. Two locks.

**Trigger points (escalating intrusiveness):**

| Trigger | Latency tolerance | Risk if it fails | Phase |
|---|---|---|---|
| Post-hoc summariser (on `result`) | High (async) | None — it's commentary | C |
| Cost / drift watchdog (periodic, every N events) | Medium | Low — emits `interrupt` only on high-confidence runaway | D |
| Plan reviewer (on `plan` mode → execute transition) | Medium-low (~1-3s) | Medium — gates execution start | E |
| Gate co-signer (on destructive `permission_request`) | Low (<2s) | Medium — adds latency to every dangerous gate | F |

**Cost model.** Kimi at $0.95 / $4.00 per Mtok (and $0.16 cached) is
cheap enough that running an overseer on every result is feasible if we
prompt-cache the policy. Specifically: a session-stable system prompt
(policy rules + tool schemas + project context) goes through AI Gateway
with a cache breakpoint, so the per-invocation marginal cost is
(small new tokens + cached prefix at $0.16 rate). For a 50k-token prefix,
that's $0.008 cached vs $0.0475 uncached per invocation — a 6×
reduction. This is exactly the trick kimiflare's
`buildStaticPrefix` / `buildSessionPrefix` split exists for; we lift the
pattern.

**Output of an overseer pass** is a `GatewayEvent` written to
`event_log` with tag `overseer`, plus optionally a `GatewayCommand`
(currently only `interrupt` is in scope; `resolve-gate` for the gate
co-signer is Phase F). The UI subscribes to `event_log` filtered by tag
to surface overseer commentary.

**Resume / state.** Cloud-host overseers are stateless — each
invocation rehydrates from `event_log`. No `runner_session_id`
semantics. This is also why Phase C starts with the post-hoc role:
zero ambiguity about what state to rehydrate.

**Failure mode to design around.** Overseer in the critical path of
every gate is a new SPOF and a latency tax. Mitigation:

1. Cheap local policy classifier (allow-list of safe tools by name +
   bash-first-token) handles 95%; only ambiguous calls go to Kimi.
   Same trick kimiflare uses for bash session-allow.
2. Budgeted timeouts — overseer has 5s to vote; on timeout, fall
   through to UI gate as today.
3. Staged rollout — Phase C ships with overseer disabled by default,
   opt-in per user, cost-capped per session.

### 7. Phasing

The phasing falls out cleanly from §1, §5, §6:

**Phase 1 — Name the abstraction.** Promote `RunnerHost` to a
first-class type in `shared-types`. Existing Claude / Codex / Gemini
get `host: 'vps-process'`. No behaviour change. Small PR. Lands the
naming so subsequent PRs aren't ambiguous about what they're adding.

**Phase 2 — Kimi adapter on `vps-process`.** Per §5 Phase A. New
`AgentName='kimi'`, full lift from kimiflare's agent/client + loop +
SSE + retry + tools. AI Gateway routing by default.
`kimi_models` D1 table. Deliverable: a session can run on Kimi.
Roadmap-wise this is a P3 sibling to `GeminiCliAdapter` (PR #117) under
the runner-adapter epic (#30).

**Phase 3 — Cloud-host plumbing + post-hoc summariser.** Per §6
Phase C. DO gains `triggerCloudSpawn`. Worker handler boots a
read-only Kimi adapter, dials back, summarises on `result`, exits.
Zero command-side risk; pure observability. This is the proving-ground
for cloud-host.

**Phase 4+ — Expand overseer roles.** Drift watchdog → plan reviewer
→ gate co-signer. Each is a config knob on the cloud runner, not new
infra. Ordered by escalating intrusiveness so the riskier ones land
last with the most operational data behind them.

Each phase ships value on its own and doesn't strand the next one if
priorities shift. If we never get to Phase 4+, Phases 1–3 still pay
for themselves (Kimi as a model option + a free post-hoc reviewer).

### 8. Why we keep our own abstraction — summary

1. **Layer mismatch.** AI SDK v5 abstracts *one provider call*.
   `RunnerAdapter` abstracts *an entire runner-process lifecycle*
   (spawn / resume / orphan / reap, dial-back, BufferedChannel, gate
   protocol, MCP stdio, on-disk transcripts, capability negotiation).
   AI SDK lives *inside* one adapter; it doesn't replace the
   abstraction.
2. **Ownership mismatch.** `@cloudflare/think` and `AIChatAgent`
   assume runner-IS-DO. Our deliberate split (DO owns state, runner
   owns SDK and lives where the tools are) is incompatible. Adopting
   them would force a second, divergent loop implementation while
   making zero of the existing VPS adapters simpler.
3. **Resume / orphan / fork-with-history is ours.** No first-party
   piece offers what `SessionDO` does (timing-safe token validation,
   `runner_session_id` resume, orphan auto-fork, reaper-aware idle
   recovery, BufferedChannel gap sentinels). `ResumableStream` solves
   a much smaller problem (browser refresh mid-stream).
4. **MCP stdio is an asymmetry to model, not hide.** Workers can't
   spawn stdio processes. Surface this in
   `AdapterCapabilities`; don't paper over it.
5. **Workers AI is reachable via portable HTTP.** Targeting
   OpenAI-compat HTTP (not `env.AI` binding) keeps the same Kimi
   adapter compiling for VPS and Worker hosts. AI Gateway is a
   URL-prefix bonus on top.
6. **Adopt CF infra primitives, not opinionated loops.** `agents`
   base SDK, Workers AI, AI Gateway: yes. `AIChatAgent`,
   `@cloudflare/think`, `ResumableStream`: no. The boundary is "does
   it dictate how the loop runs?"

The universal abstraction is `RunnerAdapter` × `RunnerHost`. Everything
else (which model, which transport, which gateway, which loop helper)
is implementation detail of one cell in that grid.

## Risks and open questions

1. **Cloud-host idle vs cold-start.** Cloud-host saves the Bun
   process idle cost but pays a per-invocation rehydration cost.
   Rough math: Bun process idle ≈ ~30MB RAM × 30 min default reaper
   window vs Worker invocation cold-start ≈ ~50ms + rehydrate
   `event_log` tail. For overseer roles (bursty), cloud wins easily.
   For primary runners (long sessions, many turns), VPS wins. The
   abstraction lets us put each role in the right host without
   deciding "cloud or VPS" globally.
2. **Capability filter location.** Belt-and-braces: filter at DO
   (refuse to bind tool channels) AND at runner (refuse inbound
   commands). Need to decide how a Phase 4+ "permission elevation"
   request from a read-only runner is rejected (ignore? error event?
   close WS?).
3. **Resume semantics for cloud-host.** No on-disk transcript means
   `runner_session_id` is a logical pointer, not a file path. The
   overseer use case sidesteps this by being stateless per
   invocation. A hypothetical full cloud-hosted *primary* runner is
   harder — that's a "later" problem, not Phase 1–3.
4. **Cost cap.** Overseer adds tokens. Need a per-session
   `max_overseer_usd` budget that the DO enforces before triggering.
   AI Gateway `cf-aig-metadata` headers may help with attribution.
5. **MCP-HTTP server inventory.** Cloud-host runners need MCP
   servers reachable over HTTP/SSE. The MCP ecosystem skews stdio
   today. May not block Phase 1–3, but worth flagging for Phase 4+
   plan-reviewer roles that want to look up external context.
6. **kimiflare's memory module.** Tempting to lift; out of scope
   for this work. Track as a follow-up under the agent-memory epic.
7. **Codex / Gemini parity for Workers AI.** If OpenAI ships Codex
   on Workers AI or Anthropic ships Claude on Workers AI, the same
   `RunnerHost: cloud` slot opens for them. The abstraction supports
   it; nothing blocks it.

## References

**Internal:**
- `packages/session-runner/src/adapters/types.ts` — adapter contract
- `packages/session-runner/src/adapters/{claude,codex,index}.ts` — current implementations
- `packages/session-runner/src/main.ts:476-555` — runtime adapter dispatch
- `packages/agent-gateway/src/handlers.ts:190-202` — spawn argv
- `packages/agent-gateway/src/reaper.ts` — VPS-host process supervision
- `packages/shared-transport/src/dial-back-client.ts` — reconnect + close codes
- `packages/shared-transport/src/buffered-channel.ts` — ring + gap sentinel
- `packages/shared-types/src/index.ts:15` (AgentName), `:357-369` (AdapterCapabilities), `:30-176` (Command/Event unions)
- `apps/orchestrator/src/agents/session-do/runner-link.ts:197-350` — `triggerGatewayDial`
- `apps/orchestrator/src/agents/session-do/rpc-lifecycle.ts:30,478` — DO-side adapter validation + dispatch
- `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts` — event ingestion
- `planning/research/2026-04-26-gemini-runner-adapter.md` — sibling adapter research
- `planning/research/2026-04-25-acp-codex-runner.md` — Codex baseline
- `planning/research/2026-04-22-session-do-partyserver-migration-feasibility.md` — adjacent abstraction discussion

**Cloudflare:**
- developers.cloudflare.com/agents/ — Agents SDK overview
- developers.cloudflare.com/agents/api-reference/agents-api/ — base class API
- developers.cloudflare.com/agents/model-context-protocol/ — McpAgent
- developers.cloudflare.com/workers-ai/configuration/bindings/ — env.AI shape
- developers.cloudflare.com/workers-ai/function-calling/ — OpenAI-compat tool calling
- developers.cloudflare.com/workers-ai/configuration/ai-sdk/ — workers-ai-provider for AI SDK v5
- developers.cloudflare.com/workers-ai/models/kimi-k2.6/ — Kimi K2.6 model card
- developers.cloudflare.com/ai-gateway/ — gateway docs
- developers.cloudflare.com/ai-gateway/providers/workersai/ — Workers AI + Gateway integration
- github.com/cloudflare/agents — `agents`, `ai-chat`, `think`, `voice`, `codemode`, `shell` packages

**Kimiflare (sinameraji/kimiflare v0.13.7):**
- `src/agent/client.ts` — Workers AI HTTP + SSE accumulator + retry
- `src/agent/loop.ts` — agent loop with anti-loop guardrail
- `src/agent/messages.ts` — `stableStringify` for cache-friendly bodies
- `src/agent/system-prompt.ts` — static / session / dynamic prefix split
- `src/util/sse.ts` — vanilla SSE line reader
- `src/tools/executor.ts` — permission cache + bash-first-token session-allow
- `src/tools/{reducer,artifact-store,expand-artifact}.ts` — artifact pattern
- `src/mcp/{manager,adapter}.ts` — stdio + SSE MCP wrapper
- `src/memory/*.ts` — SQLite + RRF hybrid retrieval, HyDE-on-write embeddings (out of scope, noted for follow-up)
