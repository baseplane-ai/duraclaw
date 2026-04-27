---
date: 2026-04-26
topic: GeminiCliAdapter for session-runner (epic #30 P3)
type: feature
status: complete
github_issue: 110
items_researched: 5
supersedes_section: planning/research/2026-04-20-runner-adapter-evaluation.md (Gemini section)
---

# Research: GeminiCliAdapter for session-runner

## Context

Issue #110 scopes a `GeminiCliAdapter` in `packages/session-runner` — P3 of epic #30 — alongside the existing `ClaudeAdapter` and `CodexAdapter` shipped via PR #108 (merged 2026-04-26). The 2026-04-20 runner-adapter evaluation already had a Gemini section, but two things make this research necessary:

1. **PR #108 changed the adapter contract**. The 2026-04-20 doc assumed `AbortController` / `emit()` / a `requestUserInput` callback; the actually-shipped contract is `AbortSignal` / `onEvent()` / no callback. Capability bitmaps are now wire-emitted in `SessionInitEvent`. The registry is concrete, keyed on a narrowed `AgentName = 'claude' | 'codex'`.
2. **Gemini CLI's signal-handling bug (google-gemini/gemini-cli#15873) is now fixed** in v0.32.0 (PR #16965, merged Feb 26 2026). The 2026-04-20 doc's "broken signals — must use SIGTERM → 2s → SIGKILL" guidance can be relaxed to "SIGINT → 2s → SIGKILL fallback".

Classification: **feature research** — refresh prior eval, populate concrete event/auth/model surface for the spec phase.

## Scope

| # | Item | Sources |
|---|------|---------|
| 1 | Post-#108 baseline + 2026-04-20 staleness gap | codebase (`adapters/*`, shared-types, spec 107) |
| 2 | `gemini` CLI `stream-json` event schema | google-gemini/gemini-cli docs/issues/PRs |
| 3 | Process control: signal handling, resume cost, residency | gemini-cli issues, web |
| 4 | Auth posture + `gemini_models` D1 table necessity | gemini-cli docs, codex_models precedent in codebase |
| 5 | CodexAdapter pattern deep-read (template for Gemini spec) | codebase |

## Findings

### Item 1 — Post-#108 baseline + 2026-04-20 gap

**Adapter contract Gemini must satisfy** (`packages/session-runner/src/adapters/types.ts:18-50`):

```ts
interface AdapterStartOptions {
  sessionId: string
  project: string
  model?: string
  prompt: string | ContentBlock[]
  resumeSessionId?: string
  env: Readonly<Record<string, string>>
  signal: AbortSignal              // ← was AbortController in 2026-04-20
  codexModels?: ReadonlyArray<{ name: string; context_window: number }>
  onEvent: (event: GatewayEvent) => void   // ← was emit() in 2026-04-20
}

interface RunnerAdapter {
  readonly name: AgentName
  readonly capabilities: AdapterCapabilities
  run(opts: AdapterStartOptions): Promise<void>
  pushUserTurn(message: { role: 'user'; content: string | ContentBlock[] }): void
  interrupt(): Promise<void>
  dispose(): Promise<void>
}
```

**Key divergences from 2026-04-20 research**:

| Aspect | 2026-04-20 assumption | Post-#108 reality | File:line |
|--------|----------------------|-------------------|-----------|
| Abort | `AbortController` on opts | `AbortSignal` only | `types.ts:25` |
| Event emit | `emit(event)` | `onEvent(event)` | `types.ts:27` |
| User-input gate | `requestUserInput` callback | Removed; adapter synthesises `ask_user`/`permission_request` itself | `types.ts:18-28` |
| Capability bitmap | "Proposed in adapter" | Required on `SessionInitEvent.capabilities` (optional but expected) | `shared-types/index.ts:366-374` |
| AgentName | Free `string` | Narrowed `'claude' \| 'codex'` — Gemini must extend | `shared-types/index.ts:15` |
| codex_models inject | Not detailed | `cmd.codex_models?: ReadonlyArray<{name,context_window}>` injected at spawn | `shared-types/index.ts:48-52` |
| Lifecycle template | "TBD" | CodexAdapter's `run(opts)` + `PushPullQueue` is the canonical pattern; Claude's `runLegacy` bridge is the exception, not the rule | `codex.ts:66-153`, `claude.ts:64-82` |

**Recommendation**: Gemini spec must assume the post-#108 contract. The 2026-04-20 research is a *capability* reference (what's possible / not possible with Gemini) but the *interface* is now spec 107 + PR#108.

---

### Item 2 — `gemini` CLI `stream-json` event schema

**Flag**: `gemini --output-format stream-json` — added in v0.11.0 (Oct 2025) via [PR #10883](https://github.com/google-gemini/gemini-cli/pull/10883). Valid choices: `text | json | stream-json`. Used in headless / non-interactive mode (`--prompt` or stdin, no shell).

**Event catalog** (newline-delimited JSON, one event per line):

| Event | Key fields | Purpose |
|-------|------------|---------|
| `init` | `type`, `timestamp`, `session_id`, `model` | Session metadata at start (session_id added in [PR #14504](https://github.com/google-gemini/gemini-cli/pull/14504), Dec 2025) |
| `message` | `type`, `role` (`user`\|`assistant`), `content`, `timestamp`, `delta?: bool` | User input or assistant response; `delta:true` for streaming chunks |
| `tool_use` | `type`, `tool_name`, `tool_id`, `parameters`, `timestamp` | Tool invocation request |
| `tool_result` | `type`, `tool_id`, `status`, `output`, `timestamp` | Tool execution result |
| `error` | `type`, `message`, `timestamp` | Non-fatal errors during execution |
| `result` | `type`, `status`, `stats: {total_tokens, input_tokens, output_tokens, duration_ms, tool_calls}`, `timestamp` | Final completion + aggregated metrics |

**Sources**: [Headless Mode docs](https://geminicli.com/docs/cli/headless/), PR #10883, PR #14504, [Issue #14435](https://github.com/google-gemini/gemini-cli/issues/14435).

**Mapping to our `GatewayEvent`** (`packages/shared-types/src/index.ts:130-456`):

| Gemini | GatewayEvent | Notes |
|--------|--------------|-------|
| `init` | `session.init` | `session_id` → `runner_session_id`; `model` → `model`; `tools: []` (no schema available) |
| `message{role:user}` | (no emission) | Echo only; runner already knows the input |
| `message{role:assistant, delta:true}` | `partial_assistant` | content block `{type:'text', id, delta}` |
| `message{role:assistant, final}` | `assistant` | content block `{type:'text', text}` |
| `tool_use` | (buffered) | Accumulate; emit as `{type:'tool_use', id, tool_name, input}` block inside next `assistant` event |
| `tool_result` | `tool_result` | `tool_id` → `uuid`; `output` → `content` |
| `result` | `result` | `total_cost_usd: null` (Gemini doesn't surface cost); synthesise `context_usage` from `stats` |
| `error` | `error` | Pass-through |

**Streaming granularity**: Token-level deltas via `delta:true` are supported. Whether successive `delta:true` events carry *incremental* or *cumulative* content is **[uncertain]** — must be confirmed via fixture recording. Codex's `partial_assistant` shape is incremental, so the adapter likely needs delta-tracking state.

**Schema stability**: No formal schema published, no version pinning. PR #14504 (Dec 2025) added `session_id` mid-flight, confirming ongoing evolution. **Mandates fixture-recording** before P3 implementation.

---

### Item 3 — Process control: signals, resume, residency

**Signal handling** — *materially different from 2026-04-20 evaluation*:

- google-gemini/gemini-cli#15873 (orphaned 100% CPU process) is **CLOSED/COMPLETED** as of v0.32.0-preview.0 via [PR #16965](https://github.com/google-gemini/gemini-cli/pull/16965) (merged 2026-02-26). Handlers now registered for SIGHUP/SIGTERM/SIGINT with TTY-loss detection (5s polling) and `isShuttingDown` race guard.
- **Recommended abort path**: SIGINT → wait 2s → SIGKILL (matches `.claude/rules/session-runner.md:12` watchdog). The 2s timeout is the safety net for older `gemini` binaries on the box; the v0.32.0+ binary will exit cleanly on SIGINT.

**Resume model**:
- Transcript location: `~/.gemini/tmp/<project_hash>/chats/`
- Resume command: `gemini --resume <UUID>` (or by index, or `--resume` for most recent)
- Auto-saves prompt/response, tool I/O, token usage, reasoning summaries
- Default retention 30 days; configurable via `settings.json` (`sessionRetention.maxAge`, `maxSessionTurns`)
- **Cold-start latency: [uncertain]** — published anecdotal data: 20–50s on Windows, faster on Linux ([Issue #21853](https://github.com/google-gemini/gemini-cli/issues/21853)). Empirical measurement on the VPS is a **P0 spike** before final spec sign-off.

**Resident vs respawn-per-turn**:

| Dimension | Respawn per turn | Resident (REPL/stdin) |
|-----------|------------------|------------------------|
| Latency / turn | 20–50s cold-start (Windows); <20s Linux | ~1–2s amortised |
| Complexity | Simple — spawn, pipe stdout, await exit | High — stdin muxing, state machine across turns |
| Reliability | Process isolation, clean abort per turn | Vulnerable to v0.32-pre signal bugs and stdin corruption |
| Concurrency hazards | Minimal | High — same-session file races (see below) |
| Resume warmth | Built-in via `--resume <id>` | N/A |

**Concurrency hazards** (don't run two `gemini` processes against the same session simultaneously):
- ProjectRegistry save race ([#22583](https://github.com/google-gemini/gemini-cli/issues/22583))
- Policy persistence TOCTOU ([#18504](https://github.com/google-gemini/gemini-cli/issues/18504))
- MemoryTool TOCTOU ([#20746](https://github.com/google-gemini/gemini-cli/issues/20746))
- Session creation race ([#7770](https://github.com/google-gemini/gemini-cli/issues/7770))

→ **Serialise turns at the runner level** (one `gemini` invocation in flight per session), which is exactly what the `PushPullQueue` pattern from CodexAdapter gives us for free.

**Recommendation**: **Respawn `gemini --resume <id>` per turn**, single in-flight, SIGINT→2s→SIGKILL on abort. Mirrors CodexAdapter's structure; eliminates resident-process hazards; gives clean abort coherence per turn at the cost of cold-start latency.

---

### Item 4 — Auth posture + `gemini_models` D1 table

**Gemini CLI auth flows**:
- `GEMINI_API_KEY` env var (primary, headless-friendly) — keys from [Google AI Studio](https://ai.google.dev/gemini-api/docs/api-key)
- `GOOGLE_API_KEY` (fallback name)
- `GOOGLE_APPLICATION_CREDENTIALS` (Vertex AI service account JSON) + `GOOGLE_CLOUD_PROJECT`
- OAuth "Sign in with Google" — opens browser → unusable on headless VPS
- OAuth device-code flow exists but is interactive (paste auth URL, return activation code) — also unsuitable for an unattended runner

**API-key tier note**: bare `GEMINI_API_KEY` from AI Studio limits access to Gemini 2.5 Flash; OAuth (or paid AI Studio tier) unlocks Pro models. This is a *user-account* concern, not an adapter concern, but worth surfacing in the spec.

**Codex auth precedent** (`packages/session-runner/src/adapters/codex.ts:70-76`):
```ts
const codexPath = opts.env.CODEX_BIN_PATH ?? opts.env.CODEX_PATH ?? undefined
this.codex = new Codex({ env: { ...opts.env }, codexPathOverride: codexPath })
```
Env is a pass-through; the spawner (gateway/orchestrator) controls what lands in `process.env` → `AdapterStartOptions.env` (`main.ts:527`). No pre-validation; SDK fails naturally if creds missing.

**`codex_models` D1 table** (`apps/orchestrator/src/db/schema.ts:292-300`, migration `0024_codex_models.sql`):
```ts
sqliteTable('codex_models', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  contextWindow: integer('context_window').notNull(),
  maxOutputTokens: integer('max_output_tokens'),  // nullable
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt, updatedAt,
})
```
Admin CRUD at `apps/orchestrator/src/api/admin-codex-models.ts:46-194` (admin-only routes). DO injects `{name, context_window}` rows at spawn (`runner-link.ts:177-192`) by reading `WHERE enabled = 1`.

**Recommendation: add `gemini_models` table mirroring `codex_models`**. Rationale:
1. Gemini's model lineup (2.5 Flash, 2.5 Pro, 2.0 Flash, 1.5 family, …) is actively evolving — decouples runner deploys from catalogue updates.
2. Context windows vary by model (Flash 1M, Pro 2M) — needed for `context_usage` percentage math.
3. Operational parity with Codex; admin already understands the surface.
4. Initial seed: `gemini-2.5-flash` (1M), `gemini-2.5-pro` (2M), `gemini-2.0-flash` (1M).

**Recommendation: env var = `GEMINI_API_KEY`** (most direct; `gemini` CLI's documented primary). Pass through `AdapterStartOptions.env`; do not pre-validate at adapter (mirror Codex — let CLI fail naturally with whatever message it produces, surface via the `error` GatewayEvent).

---

### Item 5 — CodexAdapter pattern (template for Gemini spec)

CodexAdapter (`packages/session-runner/src/adapters/codex.ts`, ~500 lines) is the closest reference. Anatomy distilled:

| Section | Codex impl | Gemini equivalent |
|---------|-----------|-------------------|
| **Lifecycle** | `run()` — instantiate SDK → resume-or-start → first-turn → multi-turn loop on `PushPullQueue<string>` (`codex.ts:66-153`) | Same shape; replace SDK calls with `Bun.spawn(['gemini', '--resume', id, '-p', prompt, '--output-format', 'stream-json'])` per turn |
| **Subprocess control** | SDK handles spawn; adapter only hands env + path override | We own the spawn; track `currentChild: Bun.Subprocess \| null`, wire stdout pipe → JSONL parser |
| **Event mapping** | SDK events → switch in main loop, helpers `emitItemUpdate`/`emitItemCompleted` (`codex.ts:282-406`) | JSONL parse → switch on `event.type` → identical helper structure (see Item 2 mapping table) |
| **Capabilities** | `supportsContextUsage: true`, all others false; `availableProviders` from `codex_models` (`codex.ts:49-64`) | Same shape; provider `'google'`, models from `gemini_models` |
| **`pushUserTurn`** | `coerceInput` → `turnQueue.push(text)` (`codex.ts:463-470`) | Identical |
| **Abort** | Per-turn `AbortController`, outer signal forwards to per-turn + queue close, `dispose()` idempotent (`codex.ts:172-175, 472-496`) | Same; per-turn abort kills child via SIGINT → 2s → SIGKILL |
| **Resume** | `resumeThread(id)` with try/catch → emit `error` + return on miss (DO triggers `forkWithHistory`) (`codex.ts:78-105`) | `gemini --resume <id>` — non-zero exit / "not found" stderr → emit error + return (same fallback path) |
| **Context usage** | `buildContextUsage(usage)` — token math + model lookup, 128k fallback + one-time warning (`codex.ts:408-445`) | Identical structure; pull from `result.stats`; `gemini_models` lookup |
| **Tests** | `codex.test.ts` mocks SDK constructor, asserts session.init, partial/final assistant, result with usage, abort lifecycle | `gemini.test.ts` mocks `Bun.spawn` (or factories the spawn helper) + JSONL fixtures |

**Files to add**:
- `packages/session-runner/src/adapters/gemini.ts`
- `packages/session-runner/src/adapters/gemini.test.ts`
- `apps/orchestrator/migrations/0025_gemini_models.sql`
- `apps/orchestrator/src/api/admin-gemini-models.ts`
- (UI panel mirroring codex-models-panel — separate UX issue or in scope, TBD in interview)

**Files to modify**:
- `packages/session-runner/src/adapters/index.ts` — register `gemini: () => new GeminiAdapter()`
- `packages/shared-types/src/index.ts` — extend `AgentName` to `'claude' | 'codex' | 'gemini'`; add optional `gemini_models?: ReadonlyArray<{name, context_window}>` to `ExecuteCommand` + `ResumeCommand`
- `apps/orchestrator/src/db/schema.ts` — add `geminiModels` table
- `apps/orchestrator/src/agents/session-do/runner-link.ts` — inject `gemini_models` into spawn payload when `cmd.agent === 'gemini'` (mirror lines 177-192)

**Files unchanged**:
- `packages/session-runner/src/adapters/types.ts` — interface is universal
- `packages/session-runner/src/adapters/claude.ts`
- `packages/session-runner/src/main.ts` — adapter dispatch is generic
- `packages/session-runner/src/event-translator.ts`

## Comparison: Gemini vs Codex vs Claude

| Capability | Claude | Codex | Gemini |
|------------|--------|-------|--------|
| First-party SDK | ✅ Anthropic SDK | ✅ `@openai/codex-sdk` | ❌ — own JSONL parse |
| Multi-turn architecture | Long-lived `query()` channel | Per-turn `runStreamed()` via SDK | Per-turn subprocess respawn |
| Resume mechanism | SDK `resume(id)` | SDK `resumeThread(id)` | `gemini --resume <id>` |
| Signal-clean abort | ✅ | Best-effort (SIGKILL fallback) | ✅ in v0.32.0+ (SIGINT clean); SIGKILL fallback for older |
| Thinking deltas | ✅ | ❌ (finalised only) | ❌ |
| Per-tool permission gate | ✅ | ❌ | ❌ (headless full-auto) |
| Subagents | ✅ | ❌ | ❌ |
| Set model mid-session | ✅ | ❌ (pinned at start) | ❌ (pinned at start) |
| Context-usage | ✅ native | Synth from token counts + D1 catalogue | Synth from `result.stats` + D1 catalogue |
| USD cost | ✅ | ❌ | ❌ |
| D1 model catalogue needed | ❌ | ✅ `codex_models` | ✅ `gemini_models` (proposed) |
| Adapter complexity (LOC est.) | thin bridge to legacy | ~500 | ~500–700 (own JSONL parser) |

## Recommendations

**Architecture**:
1. **Mirror CodexAdapter section-for-section**. Same `run()` skeleton, same `PushPullQueue<string>` for follow-up turns, same `dispose()` idempotency contract.
2. **Subprocess wrapper, respawn-per-turn**: each `pushUserTurn` triggers a fresh `Bun.spawn(['gemini', '--resume', sessionId, '--output-format', 'stream-json', '-p', prompt])`. Track the handle on `currentChild`; abort = SIGINT → 2s → SIGKILL.
3. **Capture session_id from `init` event** of the *first* turn (no resume); subsequent turns and resumes use it via `--resume <id>`.
4. **Single in-flight invocation per session** — the `PushPullQueue` already enforces this and sidesteps the gemini-cli concurrency hazards (ProjectRegistry race, GEMINI.md TOCTOU).

**Capability bitmap**:
```ts
{
  supportsRewind: false,
  supportsThinkingDeltas: false,
  supportsPermissionGate: false,
  supportsSubagents: false,
  supportsPermissionMode: false,
  supportsSetModel: false,
  supportsContextUsage: true,
  supportsInterrupt: true,        // SIGINT works in v0.32.0+
  supportsCleanAbort: false,      // 2s SIGKILL fallback retained
  emitsUsdCost: false,
  availableProviders: [{ provider: 'google', models: <from gemini_models> }],
}
```

**Auth + models**:
- `GEMINI_API_KEY` threaded via `AdapterStartOptions.env`. No pre-validation at adapter. Document the API-key-vs-OAuth tier limitation in the spec.
- `gemini_models` D1 table with the same shape as `codex_models`. Migration `0025_gemini_models.sql`. Admin CRUD parallel to `admin-codex-models.ts`. Spawn-side injection in `runner-link.ts`.

**Spec section template** (mirror spec 107):
- B1: `RunnerAdapter` interface unchanged (Gemini conforms; no contract edits)
- B2: `AgentName` narrowing extends to `'gemini'`
- B3: (skip — applies to Claude P1, already shipped)
- B4: D1 `gemini_models` table + admin CRUD
- B5: Spawn-side `gemini_models` injection (DO → runner)
- B6: `GeminiCliAdapter` core — subprocess wrapper, JSONL parse, event marshalling, abort path
- B7: Resume via `gemini --resume <id>`; missing-session fallback emits `error` → DO triggers `forkWithHistory`
- B8: `gemini_models`-driven `context_usage` synthesis (mirror `buildContextUsage`)
- B9: Capability bitmap + `availableProviders`

**Verification plan layers** (mirror spec 107 VP1-VP5):
- VP1: Adapter unit tests — mocked subprocess, JSONL fixtures cover every event type, abort/dispose idempotency, resume-fallback path
- VP2: D1 admin CRUD tests for `gemini_models`
- VP3: E2E session lifecycle on a real VPS — spawn → multi-turn → result → abort
- VP4: Mixed-agent tabs — Claude, Codex, Gemini sessions concurrently
- VP5: Signal-handling: SIGINT clean exit (v0.32+), SIGKILL fallback path on a stub older binary

## Open questions

The spec sign-off should resolve these via either an interview decision or a quick spike:

1. **JSONL fixture recording** — exact field shapes for `message{delta:true}` (incremental vs cumulative content?), `tool_use` (single event or partial+complete?), `result.stats` (per-turn or cumulative?). **Spike**: run `gemini --output-format stream-json` against three prompts (text-only, tool-call, multi-turn) on the VPS and capture stdout into `packages/session-runner/src/adapters/__fixtures__/gemini-*.jsonl`.

2. **`gemini --resume` cold-start latency on VPS** — `time gemini --resume <id> -p "x" --output-format stream-json` on the actual production VPS. If >10s, surface in UX (the dial-back WS will buffer fine, but the user sees "thinking" delay).

3. **`gemini` binary version on the VPS** — must be ≥0.32.0 to rely on clean SIGINT. If older, the SIGKILL fallback is load-bearing, not a safety net. Add a version check at gateway preflight (mirror codex's bin path resolution).

4. **Tool-use schema parity** — does Gemini emit a single `tool_use` event with full `parameters` object, or does it stream partial `parameters` like Anthropic's `input_json_delta`? Affects whether the adapter emits `partial_assistant` for tool input progress.

5. **Admin UX for `gemini_models`** — in scope for this issue (panel parallel to codex-models-panel) or punt to a UX follow-up? Spec 107 included the panel; consistency would say yes, scope-control would say no.

6. **`AdapterStartOptions.codexModels` field naming** — current shape is Codex-specific. Does the spec generalise to `models?:` or add a parallel `geminiModels?:`? Spec 107 chose codex-specific; the cleaner long-term shape is a discriminated union or a single `models` field keyed by agent. **Decision needed**: add `geminiModels?:` (Codex precedent) or refactor to generic `models?:` (cleaner but scope-creep).

## P1 Interview Decisions (2026-04-27)

All six open questions resolved. Three spikes completed in-session.

### Spikes completed

**Gemini CLI v0.39.1** confirmed on the VPS (≥0.32.0 ✓). Three JSONL fixtures captured live and committed to `planning/research/2026-04-26-gemini-fixtures/`:

| Fixture | Wall time | Key finding |
|---------|-----------|-------------|
| `text-only.jsonl` | 7.5s | Default model = `auto-gemini-3` (router); `content` is flat string, not array; only `delta:true` events, no `delta:false` finalisation |
| `tool-call.jsonl` | 7.1s | `tool_use` is single event (NOT partial+complete); `tool_result` has NO `output` field; `delta:true` is incremental (not cumulative); `tool_id` is 8-char alphanumeric, not UUID |
| `resume.jsonl` | 6.8s | Same `session_id` echoes in `init`; context preserved; `cached` field shows prompt-cache hits; no resume latency penalty vs fresh spawn |

**Critical auth finding**: `gemini` CLI's headless mode (`--prompt`, `--acp`) **refuses cached OAuth credentials** and requires `GEMINI_API_KEY` env var. Error: "When using Gemini API, you must specify the GEMINI_API_KEY environment variable." This overrides the initial "OAuth like others" posture — runner-side auth is API-key-only.

**`--skip-trust` required**: Without it, yolo/auto-approve mode is overridden to "default" in untrusted folders. Adapter must pass `--skip-trust` on every spawn.

### Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| Q1 | JSONL fixture recording | ✅ Done in-session | Three fixtures captured; see `planning/research/2026-04-26-gemini-fixtures/` |
| Q2 | Resume cold-start latency | ✅ 6.8s wall (~same as fresh) | No resume penalty; 4.2s CLI startup + 3.2s model; acceptable |
| Q3 | Binary version on VPS | ✅ v0.39.1 (≥0.32.0) | Hard preflight gate confirmed at gateway: refuse spawn if `gemini --version` < 0.32.0 |
| Q4 | Tool-use schema | ✅ Single event, confirmed | `tool_use` is one event with full `parameters` object. No partial streaming of tool args |
| Q5 | Admin UX panel | **In scope** — mirror codex-models-panel | Consistency; admin already has the codex pattern |
| Q6 | AdapterStartOptions naming | **Add `geminiModels?:`** mirroring `codexModels?:` | Codex precedent; generic refactor deferred to pre-P4 cleanup |

### Additional decisions (from interview)

| Decision | Choice | Notes |
|----------|--------|-------|
| Auth posture | `GEMINI_API_KEY` required, gateway preflight fail-fast | Headless mode rejects cached OAuth; gateway checks presence before spawn |
| Auth — OAuth support | Out of scope for #110 | Documented as follow-up if Gemini CLI surfaces a headless-compatible OAuth path |
| Default model | `auto-gemini-3` (router) | Matches CLI default; intelligent sub-model routing; users can override via model picker |
| Model seed | `auto-gemini-3` + full 3.x catalog from Google docs | Seed: `auto-gemini-3` (1M), `gemini-3-flash-preview` (200K), `gemini-3-pro-preview` (1M), `gemini-3.1-flash-preview` (200K), `gemini-3.1-pro-preview` (1M). Admin can add/disable via panel |
| Tool-result UX gap | Accept — status only, model summarises | `tool_result` GatewayEvent has `{tool_id, tool_name, status}`, empty content. UI renders checkmark + tool name. Known capability gap documented in bitmap |
| Version gate | Hard preflight at gateway | Refuse spawn if `gemini --version` < 0.32.0 |
| Spawn flags | `gemini -y --skip-trust --resume <id> --output-format stream-json -p <prompt>` | `-y` for yolo/auto-approve; `--skip-trust` for untrusted folders; `--output-format stream-json` for JSONL |

### Architectural bets (hard to reverse)

1. **Respawn-per-turn** (not resident process) — every follow-up turn spawns a fresh `gemini --resume` subprocess. Eliminates stdin muxing complexity and gemini-cli's known concurrency hazards. Cost: ~7s wall per turn (4.2s CLI startup + model inference). Reversing to a resident process would require rewriting the adapter's core loop.

2. **No tool output in UI** — Gemini's JSONL `tool_result` carries status but not stdout/stderr. If Google adds an `output` field later, adapter can surface it; but the UI must not depend on it.

3. **API-key-only auth** — if Gemini CLI later supports headless OAuth (device-code, service-account), adapter can pass-through via env without code changes. But the gateway preflight gate assumes `GEMINI_API_KEY` is the key to check.

4. **`geminiModels?:` field naming** — linear growth per adapter. Generic refactor is a debt entry; must happen before P4 (pi-mono) or the field naming gets unwieldy.

### Open risks

1. **~7s per-turn wall time** — CLI startup overhead is constant. For multi-turn conversations this adds ~7s perceived latency between each response. Dial-back WS buffering smooths the transport but the user waits. Mitigations: (a) surface a "starting Gemini..." indicator in UX, (b) monitor if Google ships a faster startup path.

2. **`stats.models` per-model breakdown** — the auto-router bills across multiple sub-models (e.g., `gemini-2.5-flash-lite` for triage + `gemini-3-flash-preview` for generation). `context_usage` synthesis must decide: use the primary model's token count or aggregate? Spec should declare aggregate.

3. **Schema drift** — no versioned JSONL schema from Google. PR #14504 added `session_id` mid-flight without warning. Adapter should log + skip unknown event types (defensive parsing), not crash.

## Next steps

1. **P2 spec drafting** — produce `planning/specs/110-gemini-cli-runner.md` mirroring spec 107 with B1–B9 from Recommendations above, updated by interview decisions.
2. **P3 spec review** — standard review pass.
3. **P4 close** — commit, push, update issue.
