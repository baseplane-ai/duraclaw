---
date: 2026-04-26
topic: Codex runner revival against post-#98 refactors (Path A — per-SDK wrappers)
type: feature
status: complete
github_issue: 107
items_researched: 5
supersedes_research: planning/research/2026-04-25-acp-codex-runner.md
---

# Research: Codex runner revival (Path A)

## Context

Spec #98 ("ACP-speaking session-runner with Codex") was approved on 2026-04-25
and closed the same day in commit `4556960` with a pivot to **Path A** — per-SDK
wrappers — leaving Spec #30 P2-P4 reinstated as the path forward. Since that
close, four refactors landed on `main`:

- **#101** (P1.1, P1.2, P1.3) — split monolithic `SessionDO` into 26 focused
  modules, renamed `sdk_session_id` → `runner_session_id`, added
  `AdapterCapabilities` type + persistence, moved event-shape translation into
  the runner via `event-translator.ts`. Merged via PR #106.
- **#102** — collapsed runner↔DO wire from 14 commands + 26 events to 8
  commands + 21 events. Removed: `abort`, `rewind`, `get-context-usage`,
  `set-model`, `set-permission-mode`, `stop-task`, `heartbeat`, `context_usage`,
  `rewind_result`, `mode_transition*`. Added: `session_state_changed`,
  `compact_boundary`, `api_retry`. Folded `context_usage` into
  `ResultEvent.context_usage?` attachment. Merged via PR #105 (commit
  `f33a105`).
- **DO-authoritative status** (commits `024a987`, `ea01ca5`, `f0e9eac`,
  `7d3d6d5`) — killed `useDerivedStatus`, made status DO-stamped on every WS
  frame, replaced live D1 writes with a write-once-at-result pattern. Hook is
  `useSessionStatus` at `apps/orchestrator/src/db/session-local-collection.ts:126`.
- **#103** — narrow `caam` auth-rotation (Claude-specific). PR #104 open.
  Does **not** affect Codex's `OPENAI_API_KEY` path; that remains plain
  `buildCleanEnv()` pass-through.

This research re-anchors the codex-runner work against current `main`. The
prior research doc (`2026-04-25-acp-codex-runner.md`) is partly superseded —
ACP path is closed, but its `@openai/codex-sdk` notes (§R3) stand.

## Scope

Five items, all read-only against the post-merge codebase:

1. Spec #101 SessionDO refactor — actual landed module layout, `SessionMeta`,
   `AdapterCapabilities`, capability persistence, `session.init` handler.
2. Spec #102 wire peel-back — actual landed `GatewayCommand` and
   `GatewayEvent` unions; runner-side dispatch and emission paths.
3. DO-authoritative status pivot — pipeline shape, `useSessionStatus` hook,
   capability-attach point.
4. #103 caam — scoping; whether `OPENAI_API_KEY` plugs in.
5. `@openai/codex-sdk@0.125.0` — public API, streaming, resume / thread
   persistence, capability mapping for the post-#102 wire.

## Findings

### 1. SessionDO refactor — landed

#### New module layout

`apps/orchestrator/src/agents/session-do/` — 26 modules behind a thin facade.

| Module | LOC | Owns |
|---|---|---|
| `index.ts` | 463 | Agent base class, `SessionMeta` interface (lines 96-130), `@callable` RPC stubs delegating to `*Impl` functions via `ctx.moduleCtx`, `onStart()` builds `SessionDOContext` with live state binding (lines 201-205, fixed in `4a31e6a`). |
| `gateway-event-handler.ts` | 946 | `handleGatewayEvent()` switch routing every `GatewayEvent` to side-effect modules. `session.init` case at lines 49-100 — reads `event.capabilities`, calls `updateState({runner_session_id, model, capabilities})`, fires `syncRunnerSessionIdToD1Impl` and `syncCapabilitiesToD1Impl`. |
| `client-ws.ts` | 383 | WS connection lifecycle (onConnect/onMessage/onClose/onError). |
| `runner-link.ts` | 362 | Gateway WS dial, callback-token mint, `getGatewayConnectionId`, `maybeRecoverAfterGatewayDrop`, `triggerGatewayDial`, `forceStopViaHttp`. |
| `message-parts.ts` | 354 | Assistant→parts and partial→parts translation, fingerprinting, runaway-turn guards. |
| `rpc-lifecycle.ts` | 353 | Spawn/resume/stop/abort/interrupt/forceStop/reattach `@callable` entry points. |
| `hydration.ts` | 345 | Cold-start: `hydrateMetaFromSql()` (lines 75-116) reads `session_meta WHERE id=1` row, iterates `META_COLUMN_MAP`, special-cases `capabilities_json` (`JSON.parse`) and `lastRunEnded` (INTEGER→bool). Called from `runHydration()` at line 302. |
| `http-routes.ts` | 328 | HTTP endpoints (health, message export). |
| `branches.ts` | 307 | `rewind`, `resubmit`, `forkWithHistory` (drops `runner_session_id: null` at line 297, wraps prior conversation in `<prior_conversation>...</prior_conversation>` at line 263). |
| `mode-transition.ts` | 293 | Kata chain mode-change handling. |
| `rpc-gates.ts` | 291 | Gate state machine + resolution. |
| `status.ts` | 284 | `updateState` / `persistMetaPatch`, D1 syncs (`syncResultToD1`, `syncRunnerSessionIdToD1`, `syncCapabilitiesToD1` at line 162). All call `broadcastSessionRow` from `lib/broadcast-session.ts`. |
| `broadcast.ts` | 280 | `broadcastMessages`, `broadcastGatewayEvent`, `persistMessageSeq`. Owns `broadcastStatusFrame` and `broadcastStatusToOwner` (the DO-authoritative status pipeline). |
| `rpc-messages.ts` | 248 | `sendMessage` `@callable`. |
| `rpc-queries.ts` | 247 | `getMessages`, `getStatus`, `getContextUsage`, `getBranchHistory`, `requestSnapshot`. |
| `watchdog.ts` | 221 | Alarm dispatch (liveness, recovery grace, gate timeout). |
| `gates.ts` | 209 | `GATE_PART_TYPES`, gate prediction + promotion. |
| `history.ts` | 196 | `safeAppendMessage`, `safeUpdateMessage`, `persistTurnState`, `bumpTurnCounter`. |
| `hydrate-from-gateway.ts` | 171 | Hydrate runner metadata on `session.init`. |
| `awaiting.ts` | 162 | Awaiting-turn timeout + recovery. |
| `types.ts` | 143 | `SessionDOContext` (lines 17-41) — `do`, **live `state` getter**, `session`, `sql`, `env`, `ctx`, `broadcast`, `getConnections`, `logEvent`. `DEFAULT_META`, `META_COLUMN_MAP` (line 134: `runner_session_id: 'runner_session_id'`). |
| `dispatch-push.ts` | 136 | Push notification dispatch. |
| `title.ts` | 90 | Haiku title application + never-clobber gate. |
| `event-log.ts` | 86 | `logEvent`, `getEventLog` RPC, 7-day GC. |
| `resume-scheduler.ts` | 80 | Rate-limit gate, pending-resume tracking. |
| `feature-flags.ts` | 39 | D1 feature-flag cache (5min TTL). |

Migrations live in `apps/orchestrator/src/agents/session-do-migrations.ts`.
Latest version is **v18** (lines 324-352): renames `sdk_session_id` →
`runner_session_id` in `session_meta` and adds `capabilities_json TEXT` column.
Both ops idempotent on re-run.

A parallel D1 migration `apps/orchestrator/migrations/0023_runner_session_id.sql`
renames `agent_sessions.sdk_session_id` → `runner_session_id`.

#### `SessionMeta` shape (canonical, post-merge)

`apps/orchestrator/src/agents/session-do/index.ts:96-130`:

```ts
export interface SessionMeta {
  status: SessionStatus
  session_id: string | null
  project: string
  project_path: string
  model: string | null
  prompt: string
  userId: string | null
  started_at: string | null
  completed_at: string | null
  num_turns: number
  total_cost_usd: number | null
  duration_ms: number | null
  created_at: string
  updated_at: string
  result: string | null
  error: string | null
  summary: string | null
  runner_session_id: string | null
  /**
   * Adapter capability flags reported by the runner on `session.init`.
   * `null` until the runner first reports (or for legacy runners that
   * never report). Persisted as JSON in `session_meta.capabilities_json`.
   */
  capabilities: AdapterCapabilities | null
  active_callback_token?: string
  lastKataMode?: string
  lastRunEnded?: boolean
  title?: string | null
  title_confidence?: number | null
  title_set_at_turn?: number | null
  title_source?: 'user' | 'haiku' | null
}
```

#### `AdapterCapabilities` shape

`packages/shared-types/src/index.ts:310-322`:

```ts
export interface AdapterCapabilities {
  supportsRewind: boolean
  supportsThinkingDeltas: boolean
  supportsPermissionGate: boolean
  supportsSubagents: boolean
  supportsPermissionMode: boolean
  supportsSetModel: boolean
  supportsContextUsage: boolean
  supportsInterrupt: boolean
  supportsCleanAbort: boolean
  emitsUsdCost: boolean
  availableProviders: ReadonlyArray<{ provider: string; models: string[] }>
}
```

#### Runner-side adapter abstraction — **not yet introduced**

No `RunnerAdapter` interface exists in either
`packages/shared-types/src/` or `packages/session-runner/src/`. The runner
hardcodes the Claude SDK code path; `event-translator.ts` is a content-block
marshaling utility, not a plugin point. Introducing the adapter interface
is the codex spec's responsibility.

`ExecuteCommand.agent?: string` and `ResumeCommand.agent?: string` already
exist on the wire (default `'claude'`), so the DO already accepts a
non-Claude agent name on spawn — the runner just doesn't act on it yet.

### 2. Wire surface — landed

`packages/shared-types/src/index.ts` post-merge.

#### `GatewayCommand` (8 variants)

Lines 5-13:

```ts
export type GatewayCommand =
  | ExecuteCommand
  | ResumeCommand
  | StreamInputCommand
  | InterruptCommand
  | StopCommand
  | PingCommand
  | PermissionResponseCommand
  | AnswerCommand
```

Removed in #102: `abort`, `rewind`, `get-context-usage`, `set-model`,
`set-permission-mode`, `stop-task`.

#### `GatewayEvent` (21 variants)

Lines 106-128:

```ts
export type GatewayEvent =
  | SessionInitEvent
  | PartialAssistantEvent
  | AssistantEvent
  | ToolResultEvent
  | AskUserEvent
  | PermissionRequestEvent
  | FileChangedEvent
  | ResultEvent
  | ErrorEvent
  | KataStateEvent
  | StoppedEvent
  | RateLimitEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationEvent
  | ChainAdvanceEvent
  | ChainStalledEvent
  | GapSentinelEvent
  | TitleUpdateEvent
  | SessionStateChangedEvent
  | CompactBoundaryEvent
  | ApiRetryEvent
```

Removed in #102: `heartbeat`, `context_usage`, `rewind_result`,
`mode_transition*` (×4).

Added in #102: `session_state_changed` (5-state enum
`idle | running | requires_action | compacting | api_retry`),
`compact_boundary`, `api_retry`.

#### Key shapes

- `SessionInitEvent` (lines 342-351): now carries `capabilities?: AdapterCapabilities`.
- `ResultEvent` (lines 409-426): now carries `context_usage?: WireContextUsage` (snake-case wire sibling of UI's `ContextUsage`, defined at 630-638: `input_tokens`, `output_tokens`, `total_tokens`, `max_tokens`, `percentage`, `model`, `auto_compact_at?`).
- `StreamInputCommand` (lines 56-62): unchanged — still `{type, session_id, message:{role:'user', content}, client_message_id?}`.
- `ResumeCommand` (lines 93-102): includes `agent?: string` (default `'claude'`).
- `ExecuteCommand`: includes `agent?: string`.

#### Runner-side dispatch (post-merge, single-Query model)

`packages/session-runner/src/main.ts:146-241` — `handleIncomingCommand` switch:

- `stream-input` → `ctx.userQueue.push(SDKUserMessage)` (lifetime
  `PushPullQueue`, never `query.streamInput()`)
- `permission-response` → `ctx.pendingPermission.resolve(allowed)`
- `answer` → `ctx.pendingAnswer.resolve(answersObj)`
- `stop` → `ctx.userQueue.close()` + `ctx.abortController.abort()`
- `interrupt` → `ctx.interrupted = true` + `ctx.query?.interrupt()`
- `ping` → `ch.send({type:'pong'})`

The single `query({prompt: queue})` consumes the lifetime queue. This is
Reduction B from #102 — no per-turn `query({resume})` re-construction.

#### Runner-side emission

`packages/session-runner/src/claude-runner.ts:500-957`. The `send()` helper
(lines 252-257) stamps monotonic `seq` and updates `ctx.meta.last_*` before
buffering through `BufferedChannel`. Message loop matches SDK message types
to `GatewayEvent` types; key syntheses for non-Claude adapters are noted
in §5 below.

### 3. DO-authoritative status — landed

#### Pipeline

```
session-runner emits status-affecting GatewayEvent
  → handleGatewayEvent (gateway-event-handler.ts)
    → updateState(patch) (status.ts)
      → broadcastStatusFrame  (broadcast.ts) — stamps every WS frame to active clients
      → broadcastStatusToOwner (broadcast.ts) — pushes {id, status} to UserSettingsDO's session_status collection
        → UserSettingsDO fans out to background sessions
          → client receives via session-local-collection.ts:55-105
            → sessionLocalCollection upsert
              → useSessionStatus hook re-reads (session-local-collection.ts:126-129)
```

D1 `agent_sessions.status` is now **cold-start fallback only** (no live writes
on transitions; write-once at result).

#### Capability-attach point (already chosen by the merge)

Static-per-session capabilities ride `SessionInitEvent.capabilities?` →
persisted to `session_meta.capabilities_json` (DO SQLite, migration v18) →
mirrored to D1 `agent_sessions.capabilities_json` via
`syncCapabilitiesToD1Impl` + `broadcastSessionRow` → client reads from
`sessionsCollection` row. Live status pipeline is independent and unchanged.

The `useSessionStatus` hook returns `SessionStatus | undefined` (undefined =
cold-start; consumer falls back to D1). For UI capability gating the consumer
reads `sessionsCollection`'s `capabilities` field directly; no new hook
needed for v1.

### 4. #103 caam — does not touch codex

`caam` is a Claude-specific external CLI (`codevibesmatter/caam`) that rotates
Anthropic auth profiles in `~/.claude` on rate-limit. All commands are
namespaced (`caam ls claude`, `caam activate claude/<profile>`). No
multi-provider abstraction.

For Codex: `OPENAI_API_KEY` flows via gateway `buildCleanEnv()` pass-through
at `packages/agent-gateway/src/handlers.ts:62-71` (strips `CLAUDECODE*` and
`CLAUDE_CODE_ENTRYPOINT`, passes everything else). Spawn applies env via
`spawn()` opts at `handlers.ts:196`, **not** through the `.cmd` JSON file
(which only carries the `GatewayCommand`).

**Stale Spec #98 task to fix in the new spec**: "Update `handlers.ts` `.cmd`
JSON write to forward `OPENAI_API_KEY` from process env (mirrors
`ANTHROPIC_API_KEY` propagation pattern at the same site)" — wrong
mechanism. `ANTHROPIC_API_KEY` was never in `.cmd` JSON; both keys ride
`buildCleanEnv()`. Net code change required: **none**.

### 5. `@openai/codex-sdk@0.125.0` — Path A

#### Surface

- **Package**: `@openai/codex-sdk@0.125.0` (verified via `npm view`,
  2026-04-26). License Apache-2.0. Depends on `@openai/codex@0.125.0`. Node
  18+.
- **Top-level API** (per upstream README + dev docs):
  ```ts
  class Codex {
    constructor(opts?: { env?: Record<string,string>; config?: object; baseUrl?: string })
    startThread(opts?: {
      workingDirectory?: string
      skipGitRepoCheck?: boolean
      approvalPolicy?: 'never' | 'on-request' | 'untrusted'  // turn-level
    }): Promise<Thread>
    resumeThread(threadId: string): Promise<Thread>
  }

  class Thread {
    readonly id: string
    run(input: string | InputEntry[], opts?: { outputSchema?: JSONSchema; approvalPolicy?: string }): Promise<Turn>
    runStreamed(input: string | InputEntry[]): Promise<{ events: AsyncGenerator<StreamEvent> }>
  }

  type StreamEvent =
    | { type: 'item.started';   item: Item }
    | { type: 'item.updated';   item: Item }
    | { type: 'item.completed'; item: Item }
    | { type: 'turn.completed'; usage: Usage }

  type Usage = {
    input_tokens: number
    output_tokens: number
    cached_input_tokens?: number
    reasoning_tokens?: number
    total_tokens: number
    // NB: no total_cost_usd
  }
  ```
- **In-process from adapter perspective** — SDK manages an underlying
  Codex CLI subprocess opaquely. Adapter never spawns directly.
- **Streaming** — async iterator over `runStreamed().events`.
- **Tool execution** — auto-executed under `approvalPolicy: 'never'`. **No
  per-tool approval callback** (analogous to Claude SDK's `canUseTool`)
  exists; `approvalPolicy` is whole-turn.
- **Abort** — **not supported in v0.125.x**. GitHub issue
  `openai/codex#5494` ("Add abort() / cancel() method") closed
  2026-01-14 as not-planned. Adapter must SIGKILL the SDK's child PID via
  internals; declare `supportsCleanAbort: false`.
- **Usage / cost** — `turn.completed.usage` carries token counts only.
  USD cost must be synthesized externally — for v1 of this spec the user
  has chosen "codex-only minimum", so no pricing module ships; the
  `result` event will emit `total_cost_usd: null`.

#### Resume — supported, file-on-disk

- `codex.resumeThread(threadId)` reads `~/.codex/sessions/<threadId>` (JSONL
  transcript + SQLite metadata index) and rebuilds in-memory state.
- `Thread.id` is a UUID, immutable for the thread's lifetime, persisted
  across runner respawns.
- **Working directory NOT restored** by resume — caller must re-supply via
  `runStreamed()` cwd or by ensuring the runner spawns in the same project
  path. SessionDO already passes `project` through `ResumeCommand`, so this
  is naturally satisfied.
- **No locking** — concurrent `resumeThread()` on the same thread ID
  corrupts the transcript. SessionDO already serializes runner spawns
  per-session, so this is naturally safe.
- **Loss-of-file failure** — if `~/.codex/sessions/<id>` is deleted (worktree
  recreate, disk wipe), `resumeThread()` throws. Adapter emits
  `error{code:'codex_thread_not_found', retryable:false}` and the user
  starts a new session. No `forkWithHistory`-style replay.

The wire fits this naturally:
1. New session: `cmd.agent='codex'`, no `runner_session_id` → adapter calls
   `codex.startThread({workingDirectory: cmd.project, approvalPolicy:'never'})`,
   captures `thread.id`, emits `session.init{runner_session_id: thread.id, capabilities: ...}`.
2. SessionDO persists `runner_session_id` (existing path; same as Claude).
3. Idle reap → 30+ min later, user sends a follow-up → SessionDO issues
   `ResumeCommand{agent:'codex', runner_session_id, project, prompt}`.
4. Adapter calls `codex.resumeThread(runner_session_id)` and resumes.

#### Synthesis required from Codex SDK to post-#102 wire

Codex SDK does not natively emit several of the events #102 added or kept.
Adapter must synthesize:

| Wire field/event | Source on Claude SDK | Source on Codex SDK | Synthesis |
|---|---|---|---|
| `session.init` | `system{subtype:'init'}` SDK msg | `Thread.id` after `startThread`/`resumeThread` | Adapter emits explicitly before first user turn |
| `partial_assistant` | `stream_event{content_block_delta}` | `item.updated` for agent_message | Map delta text/thinking |
| `assistant` (final) | SDK `assistant` msg | `item.completed` for agent_message | Map full content blocks |
| `tool_result` | SDK `tool_use_summary` | `item.completed` for tool calls | Map per-tool output |
| `result` | SDK `result` msg | `turn.completed` | Synthesize; `total_cost_usd: null` (no pricing module in v1) |
| `result.context_usage?` | `query.getContextUsage()` post-turn | None — derive from `turn.completed.usage` + model context-window table | **Required synthesis**: `{input_tokens, output_tokens, total_tokens: input+output, max_tokens: <model lookup>, percentage: total/max, model}` |
| `session_state_changed` | `SDKSessionStateChangedMessage` | None | Adapter emits `running` on each turn start, `idle` on each turn end. No `compacting` / `api_retry`. |
| `compact_boundary` | `SDKCompactBoundaryMessage` | None — Codex has no auto-compact | **Don't emit.** UI fallback already handles absence. |
| `api_retry` | `SDKAPIRetryMessage` | None | **Don't emit.** Banner is optional. |
| `permission_request` / `permission-response` | SDK `canUseTool` callback | None — `approvalPolicy: 'never'` is whole-turn | **Don't emit.** Codex declares `supportsPermissionGate: false`. |
| `ask_user` / `answer` | SDK `AskUserQuestion` tool | None | **Don't emit.** Codex declares no equivalent. (Capability flag for ask_user is not in `AdapterCapabilities` today; if needed, add a follow-up.) |
| `task_started` / `task_progress` / `task_notification` | SDK Task tool subagents | None | **Don't emit.** Codex declares `supportsSubagents: false`. |
| `file_changed` | SDK file-change synthesis | Inspect `item.completed` for Edit/Write/MultiEdit-like tools | Implement per Codex's actual tool set (TBD in interview) |

#### Capabilities for CodexAdapter (proposal)

```ts
{
  supportsRewind: false,
  supportsThinkingDeltas: false,   // Codex `reasoning_tokens` are counted, not streamed
  supportsPermissionGate: false,   // approvalPolicy is turn-level
  supportsSubagents: false,
  supportsPermissionMode: false,
  supportsSetModel: true,          // can override on each thread.run() call (TBD)
  supportsContextUsage: true,      // synthesized from token counts
  supportsInterrupt: false,        // SDK has no abort
  supportsCleanAbort: false,       // SIGKILL fallback
  emitsUsdCost: false,             // v1 has no pricing module
  availableProviders: [
    { provider: 'openai', models: [/* TBD in interview — at minimum gpt-5.1, o4-mini */] },
  ],
}
```

## Comparison

### What was supposed to be built (Spec #98 P0a-P0b stale view) vs what's already done

| Spec #98 task | Today |
|---|---|
| Define `RunnerAdapter` + `AdapterCapabilities` + `AdapterStartOptions` in `packages/shared-types/src/runner-adapter.ts` | `AdapterCapabilities` ✅ landed (in `index.ts`, not separate file). `RunnerAdapter` and `AdapterStartOptions` still **not defined**. |
| Wire `capabilities` into `session.init` + DO consumes + persists | ✅ Landed end-to-end (`SessionInitEvent.capabilities?`, migration v18, `syncCapabilitiesToD1Impl`, `broadcastSessionRow`). |
| Add SQLite migration vN for `capabilities_json` | ✅ v18. |
| `ExecuteCommand.agent?` / `ResumeCommand.agent?` discriminator | ✅ Both fields exist as `agent?: string` with default `'claude'`. Need to narrow to `AgentName` union once we know the names. |
| Reject unknown agents at DO API boundary | Not done. (No DO API endpoint enforces this — runner-side will silently default to Claude today.) |
| UI capability-gate rewind / context bar / ask_user | **Out of scope** per user direction (codex-only minimum). |
| Gateway `GET /capabilities` env-probing endpoint | **Out of scope** per user direction. |
| Missing-credential banner | **Out of scope** per user direction. |
| Forward `OPENAI_API_KEY` via `.cmd` JSON | **Wrong mechanism** — `buildCleanEnv()` already passes it through. No code change needed. |
| Pricing module + rate cards | **Out of scope** per user direction. |

### Spec #30 P1-P4 status

- **P1** (RunnerAdapter interface + ClaudeAdapter extraction + capability
  plumbing): partially landed via #101 (the DO-side capability plumbing is
  done; the runner-side adapter abstraction is not). Codex spec absorbs the
  remaining P1 work.
- **P2** (CodexAdapter via `@openai/codex-sdk`): not started. Codex spec is
  the home.
- **P3-P4** (GeminiAdapter, PiMonoAdapter, HermesAdapter): out of scope per
  user direction. Spec #30 stays superseded; gemini/etc become independent
  follow-up issues.

## Recommendations

### 1. Spec scope

Single new spec, `planning/specs/107-codex-runner-revival.md`:

- **Supersedes** `planning/specs/30-runner-adapter-pluggable.md` (per user
  direction).
- **Extends** the post-#101/#102 scaffolding rather than re-staking
  any of it.

### 2. Phase plan

**P1 — RunnerAdapter interface + ClaudeAdapter extraction**

Goal: zero observable behavior change for Claude.

- Define `RunnerAdapter` + `AdapterStartOptions` in
  `packages/shared-types/src/runner-adapter.ts`.
- Define `AgentName = 'claude' | 'codex'` and narrow `ExecuteCommand.agent`
  / `ResumeCommand.agent` from `string` to `AgentName | undefined`.
- Extract `ClaudeAdapter` from current `claude-runner.ts` + `main.ts`
  message loop. Adapter declares its capability bitmap on `session.init`.
- Adapter registry at `packages/session-runner/src/adapters/index.ts`,
  seeded with `claude` only.
- `main.ts` dispatches via `cmd.agent ?? 'claude'`. Unknown agent emits
  `error{code:'unknown_agent', retryable:false}` and writes `.exit`.
- Regression-test the existing claude path (single golden trace, before vs
  after).

**P2 — CodexAdapter against `@openai/codex-sdk@^0.125`**

- Add the dep.
- Implement `packages/session-runner/src/adapters/codex.ts` using
  `Codex.startThread` / `resumeThread` / `runStreamed`.
- Capability declaration as proposed in §5 above.
- Synthesize `result.context_usage` from `turn.completed.usage` + a
  model-context-window table (TBD in interview).
- Adapter-side `session_state_changed` synthesis — `running` / `idle`
  bookends per turn. No `compacting` / `api_retry`.
- SIGKILL fallback in `dispose()` (no soft interrupt).
- Resume via `codex.resumeThread(runner_session_id)`.
- Add `'codex'` to the registry.

**P3 — Verification + smoke**

- Spawn codex session via UI, prompt → tool call → result; verify
  `SessionMeta.capabilities` reflects Codex's bitmap; verify
  `useSessionStatus` works.
- Idle-reap codex session, send follow-up, verify resume continuity.
- Mixed-agent tabs, no cross-talk.

### 3. Out-of-scope reaffirmations

- ACP wire — closed at #98.
- Gemini CLI / PiMono / Hermes — separate follow-up issues.
- UI capability-gating sites (rewind, context bar, ask_user) — defer; for v1,
  Codex sessions render as-is and any unsupported affordances are simply
  ineffective. Follow-up spec.
- `GET /capabilities` env-probing endpoint + missing-credential banner —
  defer.
- Pricing / rate cards — defer.
- DO API rejection of unknown agents — defer (runner-side fallback covers
  the failure mode).

## Open Questions

1. **Codex model list for `availableProviders`** — `gpt-5.1`, `o4-mini`, what
   else? What's the canonical list as of 2026-04-26? (Interview)
2. **Model context-window table** — what max_tokens value does each Codex
   model report? Is there an authoritative source, or do we hardcode + note
   refresh policy? (Interview)
3. **`AgentName` narrowing scope** — narrow on the wire (shared-types) AND
   in DO, or just runner-side? Narrowing on the wire forces every D1 row
   producer to typecheck; lower-risk for v1 might be runner-only narrowing.
   (Interview)
4. **Codex-on-failure recovery UX** — if `resumeThread()` throws (file
   missing), what does the user see? Spec #98 had a generic
   `error{retryable:false}` path; do we want a Codex-specific
   `code:'codex_thread_not_found'` with friendlier copy? (Interview)
5. **Codex tool-set declaration in `session.init.tools`** — Claude reports
   from SDK system init; what does Codex expose? Hardcode? Or skip
   (`tools: []`)? (Interview)
6. **`forkWithHistory` for Codex** — DO already drops `runner_session_id`
   on fork. Codex adapter on a forked session calls `startThread` (no
   resume). Confirm this is acceptable v1 behavior. (Interview)
7. **TaskStarted/Progress/Notification events** — Claude SDK emits these
   from subagents; CodexAdapter never emits them. Should the DO check
   `capabilities.supportsSubagents` before persisting these, or is "never
   arrives" + existing handler tolerance sufficient? (Probably the latter.)
   (Interview)

## Next Steps

1. Mark P0 task #1 complete.
2. Move to P1: kata-interview to lock the seven open questions above and
   produce an interview record.
3. P2: kata-spec-writing produces `planning/specs/107-codex-runner-revival.md`
   anchored against current `main` line refs.
4. P3: kata-spec-review external review pass.
5. P4: kata-close commits + pushes the spec to `main` directly (planning
   work is doc-only).

## Source files consulted

Code:
- `apps/orchestrator/src/agents/session-do/index.ts` (SessionMeta)
- `apps/orchestrator/src/agents/session-do/types.ts` (SessionDOContext, META_COLUMN_MAP)
- `apps/orchestrator/src/agents/session-do/hydration.ts` (hydrateMetaFromSql)
- `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts` (session.init handler)
- `apps/orchestrator/src/agents/session-do/status.ts` (syncCapabilitiesToD1Impl)
- `apps/orchestrator/src/agents/session-do/branches.ts` (forkWithHistory)
- `apps/orchestrator/src/agents/session-do-migrations.ts` (v18)
- `apps/orchestrator/migrations/0023_runner_session_id.sql`
- `apps/orchestrator/src/db/session-local-collection.ts` (useSessionStatus)
- `apps/orchestrator/src/agents/user-settings-do.ts` (status broadcast)
- `apps/orchestrator/src/lib/broadcast-session.ts`
- `packages/shared-types/src/index.ts` (GatewayCommand, GatewayEvent, AdapterCapabilities, SessionInitEvent, ResultEvent, WireContextUsage)
- `packages/session-runner/src/main.ts` (handleIncomingCommand)
- `packages/session-runner/src/claude-runner.ts` (message loop, send helper)
- `packages/session-runner/src/event-translator.ts` (P1.3)
- `packages/session-runner/src/push-pull-queue.ts` (#102 streamInput)
- `packages/agent-gateway/src/handlers.ts` (buildCleanEnv, spawn)

Specs:
- `planning/specs/30-runner-adapter-pluggable.md` (to be superseded)
- `planning/specs/98-acp-codex-runner.md` (closed, prior approach)
- `planning/specs/101-session-do-refactor.md` (landed)
- `planning/specs/102-sdk-peelback.md` (landed)
- `planning/research/2026-04-25-acp-codex-runner.md` (partly superseded)
- `planning/research/2026-04-26-sdk-peelback-spike.md` (#102 spike)

Commits:
- `299d8f3` (P1.1 split), `dc6c237` (P1.2 caps + rename), `d3e7de0` (P1.3 translator), `4a31e6a` (P1.1 fix), `ee1f9b8` (PR #106 merge)
- `f33a105` (PR #105 #102 merge)
- `024a987`, `ea01ca5`, `f0e9eac`, `7d3d6d5` (DO-authoritative status)
- `0fd2e6e`, `13f2b6d` (#103 caam spec; PR #104 open, not implemented)
- `4556960` (#98 closed)

External:
- `npm view @openai/codex-sdk version` → 0.125.0
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- https://developers.openai.com/codex/sdk
- https://github.com/openai/codex/issues/5494 (abort: closed not-planned)
