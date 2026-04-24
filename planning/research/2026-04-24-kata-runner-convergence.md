---
date: 2026-04-24
topic: kata-runner convergence onto shared RunnerAdapter
type: feasibility
status: complete
github_issue: null
items_researched: 3
blocks_on: GH#30 P1
---

# Research: Kata ↔ session-runner convergence onto shared RunnerAdapter

## Context

Kata was migrated into the monorepo at `packages/kata/` and now ships
alongside `packages/session-runner/`. Both packages independently wrap
coding-agent CLIs (Claude, Codex, Gemini) for their own purposes. Spec
#30 (`planning/specs/30-runner-adapter-pluggable.md`) generalizes
session-runner onto a pluggable `RunnerAdapter` interface.

This research scopes a **sibling spec** that blocks on #30 P1 and
prepares the shared interface for kata's eventual consumption. Kata's
actual migration is deliberately out of scope — it will be filed as a
follow-up issue at the sibling spec's close.

## Scope

**Items researched:**
1. Existing #30 spec + 2026-04-20 research — to avoid duplicating or
   contradicting locked decisions.
2. Kata's provider/step-runner layer — to characterize the call pattern
   and identify the minimal interface-level work needed for kata to
   converge.
3. session-runner + shared-types intersection — to verify the housing
   decision and understand how the streaming interface orchestrates
   multi-turn work.

**Fields per item:** current interface shape, call pattern, inputs /
outputs, spawn mechanics, SDK coupling, consumers, housing options.

**Sources:** in-repo reads only (no web/git history — everything
relevant is checked into the repo).

## Findings

### Item 1 — Existing #30 spec

- **Housing is hard-locked** — `RunnerAdapter` interface lives at
  `packages/shared-types/src/runner-adapter.ts` per spec lines 16 + 170.
  This is a P1 deliverable, not a deferred decision.
- **Interface is pure types.** Reading spec lines 172–243: the full
  `RunnerAdapter` + `AdapterStartOptions` + `AdapterCapabilities` +
  `ProviderEntry` + `NotSupported` set references only strings,
  `AbortSignal`, and the existing `GatewayEvent` / `GatewayCommand`
  wire-protocol types (which already live in `shared-types`). **No SDK
  types leak in.** Earlier concern about SDK-dep leakage into
  `shared-types` consumers (mobile, orchestrator) is moot.
- **Adapter implementations are the SDK-coupled layer** — they live at
  `packages/session-runner/src/adapters/*.ts` per spec B1. The interface
  consumer gets pure types; the implementer deals with SDK specifics.
- **Phase plan** (verbatim summary from spec body):
  - P1: extract interface, refactor claude-runner → ClaudeAdapter,
    capability bitmap, registry, optional `agent`/`model` on
    ExecuteCommand/ResumeCommand, `GET /capabilities`.
  - P2: CodexAdapter (in-process @openai/codex-sdk, SIGKILL-fallback
    abort).
  - P3: GeminiCliAdapter (subprocess respawn per turn).
  - P4: PiMonoAdapter (full provider roster via `availableProviders`).
  - P5: HermesAdapter (deferred scaffold).
- **Lifecycle contract (spec lines 246–260).** `run()` is called exactly
  once; multi-turn dispatch is via direct `streamInput()` calls. Abort
  is two-phase (`interrupt()` soft → `signal.abort()` hard after 2s).
  `dispose()` is idempotent. NotSupported is non-fatal.
- **Explicit out-of-scope** — per-user API key storage, model-picker UX
  revamp, mid-session adapter switch (forbidden), Claude feature-parity
  on non-Claude adapters, Hermes Python bridge impl, runtime cost
  dashboards.
- **Pending spikes** — Codex TS SDK tool-hook surface, Gemini CLI
  JSONL schema, pi-mono main-branch activity.

### Item 2 — Kata's provider layer

**Current interface** (`packages/kata/src/providers/types.ts:40-56`):

```ts
export interface AgentProvider {
  name: string
  defaultModel?: string
  models: ModelOption[]
  capabilities: ProviderCapabilities  // 4 bits: toolFiltering, maxTurns, textOnly, permissionBypass
  fetchModels?: () => Promise<ModelOption[]>
  run(prompt: string, options: AgentRunOptions): Promise<string>
}
```

**Call pattern** — one-shot, text-in / text-out. `step-runner.ts:199-256`
constructs a prompt from a template + named context sources, calls
`provider.run()` once, receives concatenated text, extracts optional
score regex, saves artifact. No multi-turn, no streaming consumption,
no SDK hooks.

**AgentRunOptions** (providers/types.ts:58-94) — the knobs kata actually
passes:
- `cwd` (→ maps to #30's `project`)
- `model`, `env`, `timeoutMs`
- `allowedTools` — per-tool filter, default `[]` (text-only)
- `maxTurns` — default `3` for judge/review
- `permissionMode` — default `'bypassPermissions'`
- `settingSources`, `canUseTool`, `onMessage`, `abortController`

**Spawn mechanics** — Claude via dynamic `@anthropic-ai/claude-agent-sdk`
import; Gemini/Codex via `spawn`/`spawnSync` with JSONL stream parsing.
Each provider owns its timeout+SIGTERM.

**Kata-specific concerns** (stay in kata):
- Prompt templating + named-context assembly (`prompt.ts`, `step-runner.ts`).
- Score regex extraction, artifact save with `{date}` substitution.
- Retry with exponential backoff for rate limits (`retry.ts`).
- Step orchestration from `.kata/` + batteries YAML.
- Large-prompt temp-file delivery (`prompt.ts`).

**Generic concerns** (candidates for shared adapter):
- CLI discovery + subprocess spawn (already covered by #30 adapter impls).
- JSONL stream parsing (already covered by #30 Codex/Gemini adapters).
- Model enumeration + capability query (already in #30's
  `AdapterCapabilities` + `ProviderEntry`).
- Env cleanup (e.g. `CLAUDECODE` nesting detection).
- Timeout + `AbortController` propagation.

**Gap analysis** — what kata uses that #30's `AdapterStartOptions`
doesn't carry:

| Field | #30 `AdapterStartOptions` | Kata `AgentRunOptions` |
|---|---|---|
| `sessionId`, `project`, `prompt`, `env`, `signal` | ✓ | ~ (no sessionId) |
| `model` | ✓ | ✓ |
| `maxTurns` | **✗ missing** | ✓ |
| `allowedTools` | **✗ missing** | ✓ |
| `permissionMode` | via `setPermissionMode()` setter | ✓ (initial-value) |
| `timeoutMs` | adapter-internal | ✓ |

### Item 3 — session-runner + shared-types housing

**shared-types** (`packages/shared-types/src/index.ts`):
- Wire-protocol union types (`GatewayCommand`, `GatewayEvent`,
  `SessionMessage`, `SyncedCollectionFrame`, …).
- Project / session metadata (`ProjectInfo`, `SessionSummary`,
  `KataSessionState`, …).
- **Zero production dependencies.** DevDeps only (`tsup`, `typescript`).
  Pure types hub.
- Consumed by `@duraclaw/session-runner` and `apps/orchestrator`
  (declared deps) — ~30 imports across orchestrator DO, mobile, session
  hooks.

**session-runner Claude surface** — Claude SDK imported at
`packages/session-runner/src/claude-runner.ts:403`. Multi-turn loop at
lines 750–785: yield initial prompt → process messages via
`processQueryMessages()` → check idle-stop → wait for next user
`stream-input` via `queue.waitForNext()` → resume with
`query({...options, resume: sdkSessionId})`. Each turn increments
`ctx.meta.turn_count`. Extract targets for #30 P1 ClaudeAdapter:
`ClaudeRunner` class (327-344), query options (405-442), `canUseTool`
callback (429-442), `processQueryMessages()` (485-719), multi-turn loop
(750-785).

**Housing verdict** — keep `RunnerAdapter` in `packages/shared-types`
per #30 P1. Pure-types verification (see Item 1) resolves the concern
about new packages. SDK coupling stays exclusively in
`packages/session-runner/src/adapters/*.ts` implementations.

## Comparison — interface shapes

| Axis | #30 `RunnerAdapter` | Kata `AgentProvider` | Convergence verdict |
|---|---|---|---|
| Lifecycle | Long-lived, multi-turn | One-shot | **Unify on streaming.** Kata's step-runner drives single-turn by calling `run()` once and not sending `stream-input` afterwards. |
| Return shape | `Promise<void>` + `onEvent` stream | `Promise<string>` | Kata writes a small adapter in `step-runner.ts` that collects `onEvent`'s `type:'assistant'`/`type:'result'` frames and extracts final text. |
| Model catalog | `AdapterCapabilities.availableProviders: ProviderEntry[]` | `ModelOption[]` + `fetchModels()` | `ProviderEntry` is a strict superset. Kata's `fetchModels()` becomes a helper on top of the shared capability. |
| Capability bitmap | 11 bits | 4 bits | Kata's 4 bits are subsumed. |
| Initial params | 10 fields, missing `maxTurns`/`allowedTools`/initial-`permissionMode`/`timeoutMs` | 12 fields incl. those | **Extend `AdapterStartOptions`** with the four missing fields — this is the sibling spec's core work. |

## Recommendations

**Sibling-spec shape (locked):**

> `feat(runner-adapter): extend AdapterStartOptions for kata convergence`

1. Blocks on #30 P1 landing.
2. P1: Extend `AdapterStartOptions` in `packages/shared-types/src/runner-adapter.ts` with:
   - `maxTurns?: number`
   - `allowedTools?: ReadonlyArray<string>`
   - `permissionMode?: PermissionMode` (initial value; `setPermissionMode()` still drives mid-session changes)
   - `timeoutMs?: number`
   All optional, backwards-compatible with #30 P1.
3. P1: Update `ClaudeAdapter` to honor the four new fields when present. These map directly to existing `query()` options already used by current `claude-runner.ts`.
4. P2: Document kata convergence call pattern in the spec (and as a comment block in `runner-adapter.ts`): step-runner drives `run()` once, collects text from `onEvent`'s `type:'assistant'` / `type:'result'` frames, never sends `stream-input`, disposes on completion.
5. P2 close: File follow-up issue `feat(kata): migrate kata/providers onto @duraclaw/shared-types RunnerAdapter`.

**Explicit non-goals:**
- No new interface (`OneShotProvider`, `StreamingRunnerAdapter`, etc.) — per user directive: single streaming interface, kata converges by driving it one-turn.
- No kata step-runner refactor (tracked in follow-up).
- No changes to #30's housing, lifecycle contract, or phase plan.
- No package extraction (housing is verified correct in `shared-types`).
- No deletion of `packages/kata/src/providers/*.ts` (follow-up).

**Coordination with #30:**
- P2/P3/P4 adapter authors (Codex, Gemini, pi-mono) must honor the extended `AdapterStartOptions` fields when present. This is an additive contract; adapters that can't honor a field (e.g. per-tool filtering on Gemini CLI) return a no-op or equivalent graceful behavior — same as #30's existing "capability-false → skip" model.

## Open Questions

- None blocking. Pre-spec spikes from #30 (Codex TS SDK tool-hook
  surface, Gemini CLI JSONL schema, pi-mono activity) are orthogonal —
  they apply to adapter implementations, not to this interface
  extension.

## Next Steps

1. Write sibling spec at `planning/specs/<N>-runner-adapter-kata-extension.md` via `kata-spec-writing` skill, with B-IDs and verification plan (P2 task).
2. Spec review via `kata-spec-review` (P3 task).
3. Close + push + file follow-up issue (P4 task).
