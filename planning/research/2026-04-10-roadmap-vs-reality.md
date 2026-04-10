---
date: 2026-04-10
topic: Roadmap vs Reality — Gaps, Forks, and Learnings
status: complete
github_issue: null
---

# Research: Roadmap vs Reality — Duraclaw Specs + Baseplane Commits

## Context

Cross-referencing the duraclaw v2 roadmap (10 phases, 35+ subphases) against:
1. Approved specs and research docs in duraclaw (12 specs, 9 research docs)
2. Recent agent orchestration commits in the baseplane monorepo (90+ commits, Mar 20 - Apr 10)
3. Actual progress (Phase 0 complete, Phases 1-10 not started)

Goal: identify gaps between plan and reality, forks where the two repos diverge, and learnings from what baseplane has already shipped.

---

## 1. Progress Summary

### Duraclaw (this repo)

| Area | Status |
|------|--------|
| Phase 0 (Foundation) | **Done** — SPA migration, auth, mobile layout, CLI parity, schema versioning |
| Phases 1-10 | **Not started** — no specs written for any roadmap subphase |
| Gateway features | Shipped: kata-status, sessions endpoints, org/user context, OpenAPI spec, ContentBlock support, rewind/stop plumbing |
| Approved specs (not roadmap) | #13 SDK expansion, #15 Tauri tray, #16 pluggable gateway, #12 cass API |
| Research | 9 completed docs covering SDK gaps, upstream roadmaps, packaging, multi-provider interfaces |

### Baseplane (consumer repo)

| Area | Status |
|------|--------|
| CodingAgent DO | Shipped — full lifecycle (idle→running→waiting_gate→completed), WebSocket streaming, DO SQLite persistence |
| Agent Orch UI | Shipped — SpawnAgentForm, ChatThread, SessionSidebar, KataStatePanel, image rendering |
| ChipAgent convergence | Done — migrated from custom 20-event protocol to Cloudflare AIChatAgent SDK, deleted 900+ LOC |
| QOL Phase 1-4 | Shipped — Q&A display, search, timer, connection status, image upload, rewind/fork, auto-reconnect, tab navigation |
| Protocol additions | ContentBlock (text + images), rewind command, kata_state event, auto-reconnect with backoff |

---

## 2. Gaps: Roadmap Items With No Path Forward

### 2.1 Roadmap Phase 1-10: Zero specs written

The roadmap has 35+ subphases from Phase 1 (Chat Quality) through Phase 10 (Platform Evolution). **None of them have implementation specs.** All recent spec work has gone to items *not on the roadmap* — the pluggable gateway (#16), tray app (#15), SDK expansion (#13), and cass API (#12).

**Risk:** The roadmap is becoming aspirational rather than actionable. The approved specs represent a different execution path.

### 2.2 Orchestrator UI is frozen

Phase 0 shipped the SPA + mobile layout + CLI parity. But the orchestrator UI hasn't been touched since Apr 1 (SDK convergence). Meanwhile, baseplane built a full agent orchestration UI (spawn form, chat thread, sidebar, kata panel, image support) that consumes the same cc-gateway.

**Gap:** Duraclaw's *own* frontend is paused while its gateway evolves rapidly. The roadmap's Phase 1-3 (chat quality, dashboard, session management) are where this matters most.

### 2.3 No testing strategy for multi-provider

The pluggable gateway spec (#16) calls for integration tests against real Claude, Codex, and OpenCode SDKs. But there's no CI infrastructure for running these — the CI pipeline (P0.1d) only does typecheck + lint. Running real SDK tests requires API keys, installed CLIs, and running sidecars.

### 2.4 Dashboard (Phase 2) is the "core differentiator" but has no plan

The roadmap calls the multi-session dashboard "THE differentiator" — live streaming tiles, attention queue, cost tracking. Baseplane already has a working version (CodingAgent tiles, gate resolver, session sidebar). Duraclaw has nothing beyond the empty `dashboard.tsx` wired to `/`.

---

## 3. Forks: Where Duraclaw Specs Diverge From Baseplane Implementation

### 3.1 Executor abstraction: AgentAdapter vs CodingAgent DO

| Aspect | Duraclaw Spec (#16) | Baseplane Implementation |
|--------|---------------------|--------------------------|
| **Where** | VPS gateway (`agent-gateway/`) | Cloudflare DO (`CodingAgent`) |
| **Interface** | `AgentAdapter { execute, resume, abort, getCapabilities }` | `@callable` methods on DO: `spawn, resolveGate, sendMessage, stop, rewind` |
| **Provider selection** | `cmd.agent` field routes to adapter | Hardcoded to cc-gateway (Claude only) |
| **Permission model** | All adapters run `bypassPermissions` (full-auto) | Gate-based: `permission_request` pauses execution, `resolveGate` resumes |
| **State machine** | Stateless (adapter per-request) | Stateful DO (idle→running→waiting_gate→completed) |

**Fork impact:** Duraclaw's pluggable gateway adds multi-provider at the VPS level, but baseplane's CodingAgent DO has no concept of provider selection. When #16 ships, baseplane will need to pass the `agent` field through its CodingAgent → cc-gateway WebSocket connection, and handle capability differences (e.g., Codex has no gates).

### 3.2 Permission model divergence

Duraclaw spec #16 explicitly removes permission interception — all adapters run full-auto with `bypassPermissions`. But baseplane's CodingAgent has a sophisticated gate system (`permission_request` → `waiting_gate` → `resolveGate`) that the agent-orch UI is built around.

**Fork:** If duraclaw's gateway drops permission callbacks, baseplane's gate UI becomes dead code for non-Claude agents. The `canApproveTools` capability flag partially addresses this, but the orchestrator UI needs to know whether to show the gate resolver.

### 3.3 Rewind semantics

| Aspect | Duraclaw Roadmap (Phase 3.2) | Baseplane Implementation |
|--------|------------------------------|--------------------------|
| **Unit** | Message-level (`forkSession(upToMessageId)`) | Turn-index-level (`rewind(turn_index)`) |
| **Code revert** | `rewindFiles(messageId)` with `enableFileCheckpointing` | Not implemented |
| **Protocol** | Not yet in gateway protocol | `RewindCommand { type: 'rewind', turn_index }` shipped |
| **Fork support** | `forkSession` (new SDK session) | Truncation (same session) |

**Fork:** Baseplane implemented simpler turn-index truncation. Duraclaw roadmap wants message-level fork + file checkpoint revert. The gateway protocol now has `RewindCommand` with `turn_index` — this is closer to baseplane's approach than the roadmap's `forkSession` approach.

### 3.4 Image/file upload path

Baseplane shipped `ContentBlock` support (text + base64 images) in the protocol and UI (Apr 8-9). Duraclaw added `ContentBlock[]` to `ExecuteCommand` and `ResumeCommand` in the shared types (Apr 9) but the orchestrator UI has no image upload.

The roadmap places image paste + file upload in Phase 3.5. Baseplane already has it working end-to-end.

### 3.5 Kata state integration

Both repos have kata state flowing: duraclaw ships `GET /projects/:name/kata-status` and WebSocket `kata_state` events. Baseplane's CodingAgent persists kata state in DO SQLite `kv` table and displays it in `KataStatePanel`.

**Aligned** — this is one area where both repos converged on the same design.

---

## 4. Learnings From Baseplane's Implementation

### 4.1 AIChatAgent convergence deleted 900+ LOC

Baseplane's ChipAgent migration from custom protocol to Cloudflare's `AIChatAgent` SDK deleted `agent-loop.ts`, `ChipConnection.ts`, `ChipMessageCache.ts`, and a 20-event custom protocol. Gained: multi-tab broadcast, stream resumption, structured tool approvals — all for free from the SDK.

**Lesson for duraclaw:** The orchestrator's `SessionAgent` DO still uses custom state management. When Agents SDK 0.9+ ships reactive state and typed RPC, consider the same convergence — delete custom sync code and use SDK primitives.

### 4.2 Auto-reconnect with exponential backoff is table stakes

Baseplane added auto-reconnect to cc-gateway WebSocket with 3 retries (1s, 2s, 4s) before marking sessions failed. Duraclaw's roadmap puts this in Phase 1.4 (error handling).

**Lesson:** This is more urgent than "Phase 1" priority suggests. Gateway disconnects happen frequently (DO hibernation, VPS restarts). Baseplane learned this from production.

### 4.3 Hibernation-safe WebSocket tracking

Baseplane switched from in-memory `Set<WebSocket>` to Agents SDK's `getConnections()` for tracking connections. Without this, events are lost when DOs hibernate and resume.

**Lesson for duraclaw:** `SessionAgent` DO should verify its WebSocket tracking is hibernation-safe. If it stores connections in memory, they'll be lost on hibernate.

### 4.4 Tool tiering for voice agents

Baseplane's ChipAgent uses tiered tool selection (CORE/EXCLUDED tiers) to fit within Gemini Live's 40-tool cap. This is an unexpected constraint from multi-model support.

**Lesson:** When duraclaw adds multi-model support (Phase 10.4), each model may have different tool limits. The capability system should include `maxTools` or similar constraints.

### 4.5 ContentBlock is the right abstraction

Both repos independently converged on `ContentBlock = { type: 'text' } | { type: 'image', source: { type: 'base64', media_type, data } }` for message content. This is the right primitive for multi-modal agent interactions.

---

## 5. Recommendations

### 5.1 Reconcile the two execution paths

The roadmap says: Phase 0 → Phase 1 (chat quality) → Phase 2 (dashboard) → ...

Reality says: Phase 0 → SDK expansion (#13) → pluggable gateway (#16) → tray app (#15)

**Recommendation:** Acknowledge the fork. The approved specs (#13, #15, #16) are the real execution path. Update `planning/progress.md` to track them alongside (or instead of) the Phase 1-10 roadmap. The roadmap remains the vision; the specs are the plan.

### 5.2 Import baseplane's UI patterns before building Phase 1-2

Baseplane has working implementations of:
- Chat thread with image rendering
- Session sidebar with search + grouping
- Spawn form with project/model selection
- Gate resolver (permission/question handling)
- Kata state panel
- Auto-reconnect

Before writing Phase 1-2 specs, audit what can be adapted from baseplane's `apps/web/src/features/agent-orch/` to avoid rebuilding the same patterns.

### 5.3 Align rewind semantics before both implementations harden

Duraclaw's gateway has `RewindCommand { turn_index }`. Baseplane uses this. The roadmap wants `forkSession(upToMessageId)`. These are incompatible.

**Recommendation:** Pick one. Turn-index truncation is simpler and already shipped. Message-level fork is more powerful but requires SDK support for `forkSession`. If the SDK's fork API is mature, prefer it and update the protocol. If not, standardize on turn-index.

### 5.4 Add `agent` field passthrough in baseplane's CodingAgent

When duraclaw ships #16 (pluggable gateway), baseplane's CodingAgent needs to pass `agent: "codex"` or `agent: "opencode"` through to the gateway. This is a one-line protocol change but the DO's state machine assumes Claude-style gates. Non-gating agents (Codex, OpenCode) will never enter `waiting_gate` state.

### 5.5 Ship SDK expansion (#13) before anything else

Issue #13 (SDK feature expansion) is the foundation for both #16 (pluggable gateway) and the roadmap's Phase 3 (rollback, compaction). It adds:
- Store SDK Query object (enables all query methods)
- Command queuing (pre-session setup)
- Hook migration (canUseTool → SDK hooks)
- Rewind, interrupt, model switch commands

This is the highest-leverage work right now.

---

## 6. Open Questions

1. **Should the roadmap be revised?** Phase 1-10 assumes linear execution, but approved specs (#13, #15, #16) are orthogonal infrastructure work. Is the roadmap still the plan, or just the vision?

2. **Who builds the orchestrator UI?** Duraclaw's frontend is frozen. Baseplane has a working agent-orch UI. Should duraclaw's orchestrator UI be abandoned in favor of baseplane's, or do both continue independently?

3. **Multi-provider gates:** If Codex and OpenCode run full-auto, does the gate system become Claude-only? Should the orchestrator UI conditionally show/hide gate controls based on `AdapterCapabilities`?

4. **Tray app vs headless:** The tray app spec (#15) includes headless mode for VPS. Is the tray app a distraction from the core orchestration work, or is it the packaging story that makes everything distributable?

---

## Next Steps

- Discuss whether to revise the roadmap or track specs as a parallel path
- Prioritize #13 (SDK expansion) as the critical-path dependency
- Audit baseplane's agent-orch UI code for reusable patterns
- Decide on rewind semantics (turn-index vs message-level fork)
