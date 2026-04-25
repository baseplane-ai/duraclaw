---
date: 2026-04-25
topic: ACP-speaking session-runner with Codex as first non-Claude agent
type: feasibility
status: complete
github_issue: 98
items_researched: 8
---

# Research: ACP-speaking runner with Codex as first non-Claude agent

## Context

duraclaw's `session-runner` currently embeds `@anthropic-ai/claude-agent-sdk` directly. Adding more runners (Codex first) by replicating that pattern produces an N-adapter explosion. The user's hypothesis: **Agent Client Protocol (ACP)** is the unification layer the ecosystem has chosen — the same role MCP plays for tools.

GitHub issue #98 ("feat(session-runner): ACP-speaking runner with Codex as first non-Claude agent") collapsed the migration question into a single wedge: ship one ACP-speaking runner alongside the existing Claude SDK path, with Codex as the first agent to validate the design. This research evaluates that wedge for feasibility, identifies the canonical reference implementations, and surfaces blocking risks before spec.

Classification: **feasibility study** with strong library-evaluation overtones.

## Scope

8 research items, 1 escalated to gating mid-flight (R6), 1 added on-the-fly (R6b):

| # | Item | Status | Gating |
|---|---|---|---|
| R1 | ACP protocol surface (v0.12.2) | complete | - |
| R2 | Codex ACP server mode | complete | - |
| R3 | TS/JS ACP client library availability | complete | - |
| R4 | duraclaw runner architecture & branching points | complete | - |
| R5 | GatewayEvent ↔ ACP gap analysis (all 23 events) | complete | - |
| R6 | Claude Code ACP parity (would dual-track be permanent?) | complete | **GATING** |
| R6b | `@agentclientprotocol/claude-agent-acp` adapter audit | complete | - |
| R7 | forge runner-adapter reference dive | complete | - |

Sources: ACP spec/docs/schema, `@agentclientprotocol/sdk` repo, `@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`, `@openai/codex-sdk`, forge-agents/forge, duraclaw codebase, Anthropic issue tracker, Spec #30 (RunnerAdapter).

## Findings

### R1 — ACP protocol surface

- ACP is JSON-RPC 2.0 with stdio (NDJSON) transport, schema v0.12.2 (Apr 23 2026), maintained by Zed → recently moved to `agentclientprotocol` org.
- 40+ implementations in the wild (Zed, Cursor, GitHub Copilot CLI, OpenHands, forge, claude-code-acp, codex-acp, gemini-cli ACP mode).
- Core surfaces: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update` (notifications), `session/request_permission`, `unstable_forkSession`, `unstable_setSessionModel`.
- Stop reasons: `end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`.
- Extension pattern: underscore-prefixed methods + `_meta` fields per side.

### R2 — Codex ACP server mode

- Codex itself does **not** speak ACP natively — it speaks ASP (App Server Protocol, OpenAI's own).
- Two adapters bridge:
  1. **`@zed-industries/codex-acp`** (Rust): wraps Codex CLI as ACP server. Used in Zed's public Codex integration.
     - Stability: pre-prod. R2 flagged risk — release cadence high, version-specific failures observed.
  2. **`@openai/codex-sdk`**: alternative direct SDK. Useful only if we go Path A (per-SDK adapter).
- Codex feature surface (via codex-acp): permissions, streaming text, tool calls, session resume — covers ACP baseline.
- Does **not** have: PostToolUse hooks, structured AskUserQuestion-style gates, background `task_*` events, `rewindFiles` (none of these are in ACP either).

### R3 — TS/JS ACP client library

- **`@agentclientprotocol/sdk` v0.20.0** is the canonical TS SDK. Bun-compatible, used by forge, Zed, OpenHands, Cursor.
- Provides `ClientSideConnection`, `AgentSideConnection`, `ndJsonStream`, full schema types.
- Stable surface; no drop-in alternatives recommended.
- Node.js compat: works, with one caveat — Bun's `WritableStream` is preferred for stdio framing; Node needs a small wrapper (forge's `client.ts:174-186` shows the pattern).

### R4 — duraclaw runner architecture

- **`agent?: string` discriminator already exists** on `ExecuteCommand`/`ResumeCommand` in `packages/shared-types/src/index.ts:38`. **No shared-types changes needed** for the wedge.
- Spec #30 (APPROVED) defines `RunnerAdapter` interface + `AdapterCapabilities` + `AdapterStartOptions`, P1 unimplemented. The wedge **depends on Spec #30 P1** landing first (or being folded into the new spec).
- Single-binary, internal-registry design is already sanctioned by Spec #30 — gateway spawns `session-runner` with `.cmd` JSON specifying `agent`; runner dispatches in `main.ts:519`.
- Branching points (refactor targets):
  - `packages/session-runner/src/main.ts:519` — `new ClaudeRunner()` becomes registry lookup.
  - `packages/session-runner/src/claude-runner.ts:525-773` — Claude-specific message loop becomes one of N adapter implementations.
  - `packages/agent-gateway/src/handlers.ts:166` — `.cmd` JSON write already passes `agent` field through.
- BufferedChannel + DialBackClient (`packages/shared-transport`) are agent-agnostic and reused as-is.

### R5 — GatewayEvent ↔ ACP gap analysis

23 GatewayEvent types analyzed:

**Clean ACP maps (6):**
- `partial_assistant` ← `agent_message_chunk`
- `tool_result` ← `tool_call_update`
- `permission_request` ← `request_permission`
- `error` ← `session/update` error content
- `stopped` ← session closure (synthesized on subprocess clean exit)
- `result` ← `stop_reason` + `usage`

**Need synthesis or extension (5):**
- `session.init` — ACP has no agent-originated init event; synthesize from `initialize` metadata + tool list.
- `assistant` — finalized turn with mixed blocks; ACP streams chunks, synthesize finalized form.
- `ask_user` — **no ACP mechanism for structured user input queries**. Requires either ACP extension or runtime policy (block, no-op, or fall back to free-form).
- `file_changed` — synthesize from Edit/Write `tool_call_update` inspection; lossy without pre-state.
- `context_usage` — no ACP token-usage metric. Either skip for ACP runners or extend protocol.

**Won't fire for Codex (12, capability-gated):**
- `heartbeat`, `gap` — duraclaw transport-level, unaffected.
- `rate_limit` — Anthropic-specific.
- `task_started`, `task_progress`, `task_notification` — Claude SDK background tasks; no ACP equivalent.
- `rewind_result` — Claude SDK `rewindFiles`; no ACP equivalent.
- `kata_state`, `title_update`, `tool_use_summary` — duraclaw or Claude-SDK-only.
- `mode_transition*`, `chain_advance`, `chain_stalled` — DO-synthesized, not runner-originated.

**Capability gating** is the design pattern: Codex sessions disable rewind UI, optional context_usage, define ask_user policy.

### R6 — Claude Code ACP parity (GATING)

- **Anthropic explicitly closed [claude-code#6686](https://github.com/anthropics/claude-code/issues/6686) as NOT PLANNED.** Claude Code will not natively speak ACP.
- The ecosystem solution is the `@agentclientprotocol/claude-agent-acp` adapter (community-maintained, Apache-licensed).
- R6's verdict: **NO-GO if the wedge is sold as "ACP unifies all runners"** (i.e., Claude migrates to ACP too).
- Reframed for issue #98's actual scope ("just the acp runner for codex as a single issue"): **the gate clears**. The wedge does not require Claude to migrate.

### R6b — `@agentclientprotocol/claude-agent-acp` adapter audit

Adapter v0.31.0 (Apr 24 2026) wraps Claude Agent SDK as ACP server. Audited 15 surfaces:

| Surface | Status |
|---|---|
| canUseTool gates | PARTIAL (works for tools, AskUserQuestion blocked) |
| **AskUserQuestion** | **NO — explicitly blocklisted** with comment: *"Disable this for now, not a great way to expose this over ACP at the moment"* |
| **Background task events** | **NO — empty `// Todo: process via status api` switch cases** |
| PostToolUse hooks | PARTIAL (registered internally, not exposed to clients) |
| Session resume by sdk_session_id | YES — clean drop-in |
| forkSession | YES (`unstable_forkSession`) |
| Streaming text + thinking | YES |
| Tool-use blocks | YES (except AskUserQuestion) |
| Performance | PARTIAL — 11s init delays, recurring crashes (#516, #560), v0.30.0 regression |
| getContextUsage | YES (`usage_update` accumulation) |
| **`rewindFiles`** | **NO — not exposed** |
| Rate-limit events | NO (silently dropped, acceptable) |
| Model selection | YES |
| Working directory | YES |
| Stability | MODERATE — 84 releases in 3 weeks, 61 open issues |

**Verdict:** Not a drop-in replacement for Claude SDK direct usage. Three structural gaps (AskUserQuestion, task events, rewindFiles) are on critical duraclaw paths. **Confirms dual-track: Claude SDK direct, ACP for others. Revisit Q3 2026.**

### R7 — forge runner-adapter reference dive

Forge (`forge-agents/forge`) is a Bun monorepo with a production-grade ACP implementation. The ACP module (`packages/forge/src/acp/`) is ~2.5K LOC across 6 files:

- `client.ts` (643 LOC) — ACP protocol client wrapping `@agentclientprotocol/sdk`
- `orchestrator.ts` (516 LOC) — multi-agent coordination & session lifecycle
- `subprocess.ts` (243 LOC) — process spawning + stream management
- `agents.ts` (261 LOC) — registry-driven agent definitions
- `translator.ts` (232 LOC) — notification → UI event translation
- `connection.ts` (218 LOC) — agent connection orchestration + auth flow

**Crib list for duraclaw's spike:**
- `client.ts` + `subprocess.ts` → adapt to Node.js + WSS-tunneled stdio
- `translator.ts` → use as-is for ACP→GatewayEvent mapping
- `orchestrator.ts` → template for session lifecycle (scale down for cloud model)
- `agents.ts` registry pattern → reuse as `ACPAdapter`'s internal table
- `test/acp/` → copy fixtures + patterns

**duraclaw delta:** transport (stdio → WSS tunnel), permissions (TUI modal → WSS bidirectional RPC), lifecycle (in-memory → DO + KV). The ACP protocol layer itself is identical.

## Comparison: Path A vs Path B

| | Path A: Per-SDK Codex adapter | Path B: Generic ACP adapter |
|---|---|---|
| **What** | New `OpenAICodexAdapter` mirrors `ClaudeAdapter`, uses `@openai/codex-sdk` | New `ACPAdapter` spawns any ACP server subprocess |
| **Code reuse** | New adapter per agent (N×M explosion) | New registry entry per agent |
| **First-agent risk** | Low — `@openai/codex-sdk` is stable | Moderate — `@zed-industries/codex-acp` pre-prod (R2) |
| **Future-proof** | No | Yes — Codex, OpenHands, Gemini CLI, Cursor, future agents |
| **Reference impl** | None | forge's `client.ts` + `translator.ts` |
| **Aligns w/ Spec #30** | Yes | Yes |
| **Lines of new code** | ~700 LOC per agent | ~700 LOC once + ~50 LOC per agent registry entry |

## Recommendations

### Primary: Path B (generic ACPAdapter)

Rationale:
1. ACP exists precisely to avoid the N×M adapter explosion. Path A puts us back into it.
2. forge's reference (~2.5K LOC) is essentially copy-paste-able.
3. Codex stability concerns are a *first-agent selection* problem, not a *path* problem. If `codex-acp` proves crash-prone in spike, swap to Gemini CLI (`@google/gemini-cli` ACP mode) or OpenHands without rewriting the adapter.
4. Spec #30's `RunnerAdapter` interface accommodates either path; Path B keeps it singular.

### First non-Claude agent: Codex via `@zed-industries/codex-acp`, fallback Gemini CLI

- Spike codex-acp first; if R2's stability concerns materialize in practice, swap to Gemini CLI without spec rework.
- Document explicit kill-switch criteria during spec phase (e.g., crash rate threshold, init time SLA).

### Architecture: dual-track, single binary

```
session-runner binary (single)
├── main.ts dispatch — reads cmd.agent
├── adapters/
│   ├── claude-adapter.ts   ← refactored from claude-runner.ts (Spec #30 P1)
│   └── acp-adapter.ts      ← NEW: spawns ACP subprocess via @agentclientprotocol/sdk
└── shared:
    ├── BufferedChannel       (unchanged)
    ├── DialBackClient        (unchanged)
    └── GatewayEvent emit     (unchanged)
```

- Claude path stays SDK-direct (R6b confirms claude-agent-acp is not viable yet).
- ACP path handles Codex + future non-Claude agents.
- Capability bits (`AdapterCapabilities` from Spec #30) plumbed to DO; UI gates rewind, context_usage, ask_user behavior accordingly.

### Sequencing

1. **Spec #30 P1 (RunnerAdapter implementation) is a hard prerequisite.** Either land it first as a separate PR, or fold it into issue #98 as Phase 0.
2. Issue #98 then becomes:
   - **B1**: `ACPAdapter` implementing `RunnerAdapter` interface
   - **B2**: `cmd.agent` dispatch in `main.ts`
   - **B3**: ACP→GatewayEvent translator (6 clean maps + 5 syntheses)
   - **B4**: `AdapterCapabilities` plumbed to DO + UI gating
   - **B5**: First non-Claude agent E2E (Codex via codex-acp; fallback Gemini CLI)

## Open questions

1. **`ask_user` policy for ACP runners** — block-with-error, no-op, or free-form fallback? (Lean: block-with-clear-error to fail fast.)
2. **First-agent selection** — confirm `@zed-industries/codex-acp` over Gemini CLI, with explicit kill-switch criteria.
3. **Spec #30 P1 sequencing** — separate PR or folded Phase 0 of #98?
4. **Session resume for ACP runners** — punt orphan-recovery to Phase 2? (v1: Codex sessions are non-resumable across runner death.)
5. **Auth env propagation** — confirm gateway propagates `OPENAI_API_KEY` to ACP subprocesses the same way it propagates `ANTHROPIC_API_KEY`.
6. **AskUserQuestion ACP extension** — track upstream `claude-agent-acp` issue/PR for AskUserQuestion support; revisit dual-track unification when it lands (Q3 2026 estimate).

## Next steps

1. ✅ This research doc.
2. → **P1 (kata-interview)**: confirm Path B, first-agent choice, ask_user policy, Spec #30 P1 sequencing, with the user.
3. → **P2 (kata-spec-writing)**: spec issue #98 with B1–B5 above. Mark Spec #30 P1 as gating dependency.
4. → **P3 (kata-spec-review)**: review against Spec #30 interface, capability semantics, and forge reference.
5. → **P4 (kata-close)**: commit + push to main, label issue #98 ready-for-implementation.

## Sources

- [ACP spec & schema](https://agentclientprotocol.com)
- [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) v0.20.0
- [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) v0.31.0
- [`@zed-industries/codex-acp`](https://zed.dev/acp/agent/codex-cli)
- [`@openai/codex-sdk`](https://developers.openai.com/codex/changelog)
- [forge-agents/forge](https://github.com/forge-agents/forge) — reference ACP runner
- [claude-code#6686 (NOT PLANNED)](https://github.com/anthropics/claude-code/issues/6686)
- duraclaw codebase: `packages/session-runner/src/{main.ts,claude-runner.ts}`, `packages/shared-types/src/index.ts`, `packages/agent-gateway/src/handlers.ts`
- duraclaw spec: `planning/specs/30-runner-adapter-pluggable.md` (APPROVED, P1 unimplemented)
- duraclaw spec: `planning/specs/85-runner-adapter-kata-extension.md` (blocked on #30 P1)
- duraclaw rules: `.claude/rules/session-lifecycle.md`
