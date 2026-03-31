---
date: 2026-03-31
topic: Orchestrator Architecture — SDK Loop vs. External Control
status: superseded
github_issue: null
---

# Research: Orchestrator Architecture

## Context

Duraclaw orchestrates Claude Code sessions across multiple VPS worktrees. The current design runs the Claude Agent SDK on the VPS with the Cloudflare DO acting as a relay. This research explores where workflow control should live and how the DO and VPS should divide responsibilities.

## Questions Explored

1. Should the SDK run on the VPS or in the DO?
2. What value does an external orchestrator add over the CLI's built-in task management?
3. How much control should the orchestrator exert over running sessions?

## Findings

### Core Insight: Separate Tool Execution from Orchestration

CLI tools (bash, git, file I/O) require a VPS — non-negotiable. But workflow orchestration (task selection, session chaining, evaluation) doesn't need a filesystem. These are distinct concerns currently conflated on the VPS.

### Current Architecture (SDK on VPS)

```
Browser → CF Worker → Durable Object (relay) → WS tunnel → VPS (SDK + tools)
```

The VPS owns the conversation, workflow, and tool execution. The DO is a passthrough.

### Proposed Architecture (SDK in DO, tools on VPS)

```
Browser → CF Agent DO (SDK, workflow, state) → MCP over WS → VPS (tool server only)
```

The DO owns the session. The VPS is a stateless tool backend exposing bash, read, write, git over MCP. Benefits: DO hibernation, SQLite, horizontal scaling — all free.

### The CLI Already Handles Intra-Session Workflow

The Claude Code CLI provides:

- Task queues (TodoWrite/TodoRead)
- Sub-agents with parallelism
- Plan mode
- Hooks (pre/post tool execution)
- CLAUDE.md for persistent project instructions
- Session resume

These handle **intra-session** workflow well. The DO shouldn't reimplement them. The DO's value is what the CLI *can't* do:

| Capability | CLI | DO Orchestrator |
|------------|-----|-----------------|
| Intra-session task breakdown | Yes | No (let CLI handle) |
| Multi-session coordination | No | Yes |
| Persistent state across sessions | No | Yes |
| Scheduling (nightly, on-merge) | No | Yes |
| Queue management (N issues → M worktrees) | No | Yes |
| Cross-session awareness | No | Yes |
| Browser UI | No | Yes |

**The DO is a fleet scheduler, not a workflow engine.**

### External Orchestrator Advantages Over CLI Loops

An external loop can do things the CLI's generic task management cannot:

- **Curate the prompt** — inject issue context, prior session learnings, relevant specs before the SDK starts
- **Control the budget** — "20 minutes / 50k tokens for this task, stop if stuck"
- **Chain sessions** — planning → implementation → verification as separate sessions with tailored context
- **Learn across runs** — "last 3 attempts hit the same type error, include that context"
- **Evaluate output** — the working session has context fatigue by the end; a fresh eval doesn't

## Recommendation: SDK as Black Box + End-of-Turn Eval

Let the SDK run autonomously. The DO supervises at session boundaries:

```
DO: "implement issue #42" → SDK session
SDK: [runs autonomously, uses CLI tools, manages its own tasks]
SDK: done → result back to DO
DO: evaluate — did the diff match the spec? tests pass? →
  if good: commit, move to next task
  if not: spawn follow-up session with corrective feedback
```

### Why this approach

- **Doesn't fight the SDK** — the agentic loop runs unmodified
- **Catches "done but not done"** — fresh eval reviews with clear eyes, no context fatigue
- **Lightweight** — no mid-loop interception, no custom agent loop rebuild
- **Eval can be cheaper** — use a faster/smaller model for the review step

### Responsibility Split

| Concern | Owner | How |
|---------|-------|-----|
| Task selection | DO | Pick next issue from queue, inject context |
| Prompt curation | DO | Pre-load issue context, prior learnings, specs |
| Budget enforcement | DO | Time/token limits, abort if stuck |
| Session chaining | DO | Plan → implement → verify as separate sessions |
| Cross-run learning | DO | Carry forward relevant context from prior attempts |
| End-of-turn eval | DO | Review diff against spec, nudge or follow up |
| Tool execution | VPS | Bash, file I/O, git (stateless) |
| Intra-session tasks | CLI/SDK | TodoWrite, sub-agents, plan mode |
| Context management | CLI/SDK | Window management, compression |

## Open Questions

1. **MCP as VPS protocol** — Replace custom VpsCommand/VpsEvent with MCP? The SDK already speaks MCP. Would simplify the protocol layer significantly.
2. **Eval model choice** — Same model (expensive, thorough) or cheaper model for pass/fail?
3. **Intervention granularity** — Start with session-boundary eval only, or also intercept mid-session on specific signals (e.g., repeated tool failures)?
4. **Session-to-session context** — How much to carry forward? Full conversation, diff + summary, or structured learnings only?
5. **When to crack open the SDK loop** — If session-boundary eval proves insufficient, at what point do we drive the model turn-by-turn from the DO?

## Next Steps

- Prototype the "SDK in DO + MCP tool server on VPS" split
- Define the eval prompt/criteria for end-of-session review
- Decide on MCP vs. custom protocol for VPS communication
