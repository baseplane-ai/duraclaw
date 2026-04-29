---
date: 2026-04-29
topic: Intelligent LLM routing based on task needs
type: feature + library-eval + feasibility
status: complete
github_issue: null
items_researched: 5
workflow: RE-8704-0429
---

# Research: Intelligent LLM Routing for Duraclaw

## Context

User asked to scope intelligent model routing in duraclaw. Today, model selection is **set once per session at spawn** and never changes. This wastes capacity (Opus on tasks Haiku could do), prevents budget enforcement, and leaves no surface for "spend $X on this task" semantics. Primary routing signal: **cost/latency budget** (per user request — not classification, not embedding similarity).

Research mode `RE-8704-0429`. Five parallel deep-dives:

1. Duraclaw current state — model selection
2. Claude Agent SDK model API capabilities
3. Cost/latency budget routing patterns (10 surveyed)
4. Prior-art libraries and services (9 surveyed)
5. Duraclaw telemetry & feedback signals

## Scope

| Item | Outcome |
|---|---|
| Map current model-selection surface | `cmd.model` flows orchestrator → runner → SDK; locked per session |
| Catalog SDK routing capabilities | Per-call init override ✅, mid-`query()` switch ❌, subagent override ✅, budget cap ✅ (already wired but unused) |
| Survey routing patterns | 10 patterns; winner: reactive escalation + predictive budget pacing + tier-table heuristic |
| Survey routing libs/services | 9 evaluated; verdict: build custom, steal from RouteLLM/LiteLLM patterns |
| Audit telemetry gap | Cost & duration per-session present; per-turn breakdown + cache tokens + project rollups missing |

## Findings

### 1. Current state — model selection in duraclaw

**Selection is per-session, set at spawn, immutable for session lifetime.**

| Layer | What it does |
|---|---|
| UI (`settings.tsx:38–50`) | Hardcoded catalog `claude-{opus-4-7,opus-4-6,sonnet-4-6,haiku-4-5}` and Codex `gpt-5.1`/`gpt-5.4`/`o4-mini` |
| D1 (`migrations/0008,0025`) | `user_preferences.model` (Claude), `.codex_model` (Codex). Defaults `opus-4-6` / `gpt-5.1` |
| Spawn form (`SpawnAgentForm.tsx:53`) | Per-spawn override; default `opus-4-6` |
| DO (`rpc-lifecycle.ts:88,132,194,252`) | Stamps `cmd.model` onto `SessionMeta.model` and `agent_sessions.model` |
| Runner (`claude-runner.ts:606`) | `if (cmd.model) options.model = cmd.model` → SDK locked for session lifetime |

**Key inconsistencies (low-cost cleanup):**
- `useUserDefaults` localStorage default `opus-4-7` vs D1 schema default `opus-4-6` (`use-user-defaults.ts:7` vs `0008_replace_user_preferences.sql:32`)
- Identity is **orthogonal** to model (identity = HOME credential; not a model selector)
- Sub-agents inherit parent model implicitly (no SDK config exercising `AgentDefinition.model`)
- `max_budget_usd` is wired in shared-types and runner (`claude-runner.ts:610`) but **no UI to set it** — silent dead code

```
Current data flow:
  User Settings ──PUT /api/preferences──▶ D1 user_preferences.model
                                              │
   Spawn form ─cmd.model─▶ DO ─SpawnConfig.model─▶ Gateway
                                                       │
                                                       ▼
                                               Runner: options.model = cmd.model
                                                       │
                                                       ▼
                                                  SDK query()  ◀── locked
```

### 2. Claude Agent SDK capabilities (v0.2.119, pinned in session-runner)

| Capability | Available? | Citation |
|---|---|---|
| Per-call model override at `query()` init | ✅ string only, not a function | `claude-runner.ts:606`, `shared-types/index.ts:41–94` |
| Mid-session switch within a single `query()` | ❌ | `docs/integrations/claude-agent-sdk.md:27`; SDK design |
| Sub-agent per-agent model (`AgentDefinition.model`) | ✅ | [Subagents docs](https://code.claude.com/docs/en/agent-sdk/subagents) |
| `total_cost_usd` event | ✅ | `SDKResultMessage.total_cost_usd` |
| `usage` event with input/output/cache tokens | ✅ all 4 fields emitted | SDK type defs |
| `modelUsage` per-model breakdown when subagents differ | ✅ | SDK type defs |
| `maxBudgetUsd` (SDK auto-aborts on overrun) | ✅ already wired | `claude-runner.ts:610` |
| Hooks (PreToolUse, PostToolUse, etc.) | ✅ — but **cannot mutate model** mid-stream | [Hooks docs](https://code.claude.com/docs/en/agent-sdk/hooks) |
| Cross-vendor (Bedrock / Vertex / Foundry) | ✅ via env vars | SDK overview |
| Non-Anthropic vendors (Gemini, GPT) directly | ❌ would bypass SDK entirely | — |

**Implication.** Inside an active `query()`, the only mid-session "routing" lever is **subagent dispatch**. The clean surfaces are:

- **Pre-flight (orchestrator)** — pick the model when the DO calls `triggerGatewayDial`
- **Subagent registry** — declare typed subagents with `{ name, model }` and let Claude delegate

Hooks help with budget *guardrails* (deny tool calls) but not with model *selection*.

### 3. Routing patterns surveyed (10)

Full survey in deep-dive notes; ranking for **agentic, multi-turn coding on a cost/latency budget**:

| # | Pattern | Complexity | Cost savings | Agent fit |
|---|---|---|---|---|
| 1 | **Reactive escalation on tool-call/schema failure** | Heuristic | 60–80% | **Very high** (agent-native) |
| 2 | **Predictive budget pacing** (track session burn, downshift before overrun) | Heuristic→learned | 70–85% | **Very high** (Nemotron-Cascade 2 validated) |
| 3 | Confidence-escalation cascade (FrugalGPT, RouteLLM) | Learned scorer | 60–70% | High |
| 4 | Tier-table heuristic | Trivial | 60–80% | Moderate (brittle on boundaries) |
| 5 | Unified cascade-routing (de Koninck et al., ICML 2025) | DP optimizer | 65–75% | High (SWE-Bench +14%) |
| 6 | Multi-signal confidence (semantic + layer convergence + learned) | Learned predictor | 55–65% | Moderate (high overhead) |
| 7 | LLM-as-router (tiny dispatcher) | Tiny classifier | 50–70% | Moderate (amortization risk) |
| 8 | Latency-aware SLO routing (SCORE, SOLA) | Constrained opt | Cost secondary | Moderate |
| 9 | OmniRouter (batch global optimization) | DP / Lagrangian | 65–75% | Low (batch ≠ sequential) |
| 10 | Speculative decoding cascade | System-level | 10–20% (latency only) | Low for routing |

Sources: [FrugalGPT](https://arxiv.org/abs/2305.05176), [RouteLLM](https://arxiv.org/abs/2406.18665), [Unified Cascade-Routing](https://arxiv.org/abs/2410.10347), [OmniRouter](https://arxiv.org/abs/2502.20576), [Token-Budget-Aware Routing](https://arxiv.org/abs/2604.09613), [Nemotron-Cascade 2](https://research.nvidia.com/labs/nemotron/nemotron-cascade-2/).

**Winning combination for duraclaw:** tier-table (P0 baseline) → predictive budget pacing (P3) → reactive escalation (P4) → learned classifier (P5).

### 4. Prior-art libraries surveyed (9)

| Lib | Type | Verdict | Why |
|---|---|---|---|
| RouteLLM | OSS, Apache 2 | **Steal patterns** | BERT/MF preference classifier; ~85% cost reduction on MT-Bench. Python-only; would need TS port |
| LiteLLM Router | OSS, MIT | **Steal patterns** | Per-key budget, latency p50/p95 tracking, fallback chains. Python-first, Node SDK secondary |
| Anyscale routers | OSS research | **Steal patterns** | RL-trained router (bandit formulation); generalizes across model pairs |
| Portkey | OSS + managed | **Wrap (lite)** if scaling | Native Anthropic; cost & latency guardrails. Adds latency, requires deps |
| OpenRouter | Managed | Skip | OpenAI-API drop-in; bypasses SDK |
| NotDiamond | Managed SaaS | Skip | OpenAI-API middleware; breaks Agent SDK loop |
| Martian | Managed SaaS | Skip | Same as above |
| Helicone | OSS + managed | Skip | OpenAI-SDK wrapper; observability-first |
| Vercel AI SDK | Framework | Skip | Different abstraction; doesn't help Agent SDK case |

**Verdict: build custom.** Every external service either wraps the chat-completions API (forcing us out of `claude-agent-sdk`, defeating its purpose) or runs as a Python sidecar (incompatible with Bun + CF Workers in-process). RouteLLM and LiteLLM offer the *patterns* to steal; the implementation is ~500 LOC TypeScript inside the orchestrator.

### 5. Telemetry & feedback gap

Cost and duration are captured **at session aggregate** today, mostly via SDK delegation:

| Signal | Present? | Where? | Gap |
|---|---|---|---|
| Per-turn `total_cost_usd` | ✅ session-level only | `agent_sessions.total_cost_usd`, accumulated in `gateway-event-handler.ts:580` | No per-turn rows; only the running sum |
| Per-turn `duration_ms` | ✅ session-level only | `agent_sessions.duration_ms` (`claude-runner.ts:1051`) | Wall-clock only; no breakdown (gate wait vs. SDK exec) |
| `input_tokens`, `output_tokens` | ✅ in `context_usage_json` blob | `WireContextUsage` (`shared-types:849`); UI status-bar | Not normalized columns; not per-turn |
| `cache_creation_input_tokens`, `cache_read_input_tokens` | ❌ **not extracted** | — | SDK emits them; runner ignores |
| Time-to-first-token | ❌ | — | Would need partial-event timestamp |
| Project-level cost rollup | ❌ | — | Would need D1 view or new table |
| Identity-level cost rollup | ❌ | — | GH#119 P3 tracks identity but not cost |
| Codex/Gemini cost | ❌ adapters return `null` | `codex.ts:266`, `gemini.ts:321` | Need pricing tables or vendor-emitted cost |
| `[router:*]` log tags | ❌ | — | Add to `event_log` for audit trail |

**No `[cost]`/`[tokens]` log tags exist.** Logging discipline (`docs/theory/topology.md:51`) reserves prefixes `gate`, `conn`, `rpc`, `reap`, `failover`, `error`. A router would add `router:budget`, `router:decision`, `router:escalate`.

## Comparison: Where can the router live?

| Locus | Granularity | Reach | SDK compatibility | Build cost | Verdict |
|---|---|---|---|---|---|
| **Orchestrator pre-flight** | Per-session | New sessions | Native — `cmd.model` already wired | S | ✅ **MVP** |
| **Subagent dispatch** | Per-subagent | Within session | SDK-native via `AgentDefinition.model` | M | ✅ **Phase 2** |
| Session-runner per-turn | Per-turn within `query()` | Within session | ❌ Not supported by SDK | — | Skip |
| Cross-vendor proxy | Any | All sessions | Breaks SDK agent loop | XL | Skip |
| Resume-and-respawn for escalation | Per-turn (coarse) | Within session | Workable but loses context mid-resume | M | Phase 4 fallback |

## Recommendations

### Immediate (P0 — Budget at the door)

Smallest, highest-leverage move: **expose `max_budget_usd` in the UI and tie it to a tier preset**. The SDK already enforces the cap. No router logic, no telemetry expansion — just plug a switch into a dead-coded surface.

- Add a "Budget" field to `SpawnAgentForm` (`SpawnAgentForm.tsx`) and `settings.tsx` defaults
- Add tier presets: `cheap → haiku-4-5 + $0.25 cap`, `balanced → sonnet-4-6 + $1.00 cap`, `premium → opus-4-7 + $5.00 cap`, `unlimited → opus-4-7 + null`
- Reconcile the `opus-4-7` vs `opus-4-6` default mismatch (`use-user-defaults.ts:7` vs migration `0008`)
- D1 schema: add `agent_sessions.budget_usd_cap`, `user_preferences.default_budget_usd_cap`

**Effort:** ~1–2 days. **Reach:** every new session has a hard ceiling. **No** SDK changes; **no** new telemetry; **no** routing logic yet.

### Near-term (P1 — Per-turn telemetry)

Required before predictive pacing or cascading work. Without per-turn rows, you can't compute burn rate or train a classifier.

- Extract `cache_creation_input_tokens` and `cache_read_input_tokens` from SDK `usage` events
- Add a `session_turns` table or per-turn JSON array on `agent_sessions` capturing: `{turn_id, model, input_tok, output_tok, cache_create_tok, cache_read_tok, cost_usd, duration_ms, ts}`
- Surface session cost + duration in `status-bar.tsx` (currently only context tokens)
- Add `[cost]` log tag and emit `logEvent('info','cost', …)` per turn in DO

**Effort:** ~3–5 days.

### Phase 2 (Subagent tier dispatch)

Inside a session, route work via typed subagents. SDK-native, no resume/respawn dance.

- Define `agents` config with at minimum: `{ summarizer: 'haiku', coder: 'sonnet', architect: 'opus' }`
- System prompt: instruct main loop (Sonnet) to delegate by task shape
- Each subagent inherits its declared model; SDK handles dispatch

**Effort:** ~1 week. Real cost savings (RouteLLM-class) once Claude is steered to delegate cheap work.

### Phase 3 (Predictive budget pacing — DO-side)

Once per-turn telemetry exists, the DO can downshift the *next spawn* in a project:

- For each project, compute burn rate `cost_usd / time_window`
- If burn rate > budget pace, downgrade subsequent spawns one tier (Opus → Sonnet → Haiku) and shorten budget caps
- Surface budget overruns in UI as warnings (then hard-stop on cap)

**Effort:** ~1 week. **Risk:** late-session quality drop; mitigated by reserving 20–30% of budget for high-stakes turns (per FrugalGPT pattern).

### Phase 4 (Reactive escalation)

When Haiku spawn returns failure (schema validation, tool-call error, low-confidence signal), orchestrator re-spawns with Sonnet via `resume`. Coarse but workable — the only intra-session escalation path the SDK supports without losing context entirely.

### Phase 5 (Learned classifier)

Once we have ~1000 labeled session-turn rows, train a RouteLLM-style preference classifier (BERT or matrix-factorization). Predicts: "would Haiku have produced an equivalent answer?"

## Open questions (to resolve before P0 spec)

1. **Budget unit** — per-session $ cap, per-day $ cap, per-project $ cap, or all three? (Affects D1 schema)
2. **Project-level vs. user-level budget** — does the budget travel with the project (multi-user share a pot) or with the user (cross-project)? Project-level + user-level are not mutually exclusive but multiply schema work
3. **Multi-vendor scope** — Codex and Gemini adapters exist (`codex.ts`, `gemini.ts`) but emit `null` cost. Do we extend routing to them in P0 (requires per-vendor pricing tables) or stay Claude-only?
4. **Default policy for unbudgeted sessions** — hard cap at $X, soft warn-then-cap, or unlimited (current behavior)? Recommend "soft warn at $1, hard cap at $10" as a starting default
5. **Identity coupling** — should different identities have different default models / budgets (e.g., personal-account identity gets Sonnet + $5; team identity gets Opus + $25)? GH#119 P3 didn't model this
6. **Escalation trigger semantics for P4** — exit code from runner? SDK `usage`-derived signal? Custom user feedback button? Different triggers imply very different infra

## Next steps

1. Decide on the open questions above (informal interview, then create issue)
2. Open a GitHub issue: **"Intelligent LLM routing — P0: budget at the door"** as a feature spec, link this research doc
3. Schedule planning mode for the P0 spec
4. Telemetry expansion (P1) can run in parallel with P0 — no dependency

## Sources

**Codebase (this repo)**
- `apps/orchestrator/src/hooks/use-user-defaults.ts:7-8`
- `apps/orchestrator/src/routes/_authenticated/settings.tsx:38-50,134-200`
- `apps/orchestrator/src/features/agent-orch/SpawnAgentForm.tsx:29-53`
- `apps/orchestrator/src/agents/session-do/rpc-lifecycle.ts:88,132,194,252`
- `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts:580-596`
- `apps/orchestrator/src/agents/session-do/types.ts:88-149`
- `apps/orchestrator/src/agents/session-do/event-log.ts:11-45`
- `apps/orchestrator/src/db/schema.ts:127-194`
- `apps/orchestrator/migrations/0008_replace_user_preferences.sql:32`
- `apps/orchestrator/migrations/0025_codex_model_pref.sql:11`
- `packages/session-runner/src/main.ts:270,395,397`
- `packages/session-runner/src/claude-runner.ts:606,610,1051,1065-1119`
- `packages/session-runner/src/codex.ts:266`
- `packages/session-runner/src/gemini.ts:321`
- `packages/shared-types/src/index.ts:41-94,603-629,830-857`
- `docs/theory/topology.md:51`
- `docs/integrations/claude-agent-sdk.md:27`

**External**
- Claude Agent SDK: [overview](https://code.claude.com/docs/en/agent-sdk/overview), [subagents](https://code.claude.com/docs/en/agent-sdk/subagents), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [TypeScript API](https://code.claude.com/docs/en/agent-sdk/typescript)
- Patterns: [FrugalGPT](https://arxiv.org/abs/2305.05176), [RouteLLM](https://arxiv.org/abs/2406.18665), [Unified Cascade-Routing](https://arxiv.org/abs/2410.10347), [OmniRouter](https://arxiv.org/abs/2502.20576), [Token-Budget-Aware Routing](https://arxiv.org/abs/2604.09613), [Confidence-Aware Routing](https://arxiv.org/abs/2510.01237), [Confidence Tokens](https://arxiv.org/abs/2410.13284), [Nemotron-Cascade 2](https://research.nvidia.com/labs/nemotron/nemotron-cascade-2/)
- Libs: [RouteLLM repo](https://github.com/lm-sys/RouteLLM), [LiteLLM Router](https://docs.litellm.ai/docs/routing), [Portkey](https://portkey.ai/docs/introduction/what-is-portkey), [OpenRouter](https://openrouter.ai/docs), [Anyscale router blog](https://www.anyscale.com/blog/building-an-llm-router-for-high-quality-and-cost-effective-responses), [LMSYS RouteLLM blog](https://www.lmsys.org/blog/2024-07-01-routellm/)
