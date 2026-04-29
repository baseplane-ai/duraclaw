---
paths:
  - "apps/orchestrator/src/agents/session-do.ts"
  - "apps/orchestrator/src/agents/**"
  - "packages/session-runner/src/**"
  - "packages/agent-gateway/src/reaper.ts"
---
# Session lifecycle (rule stub)
Invariants live in [`docs/theory/dynamics.md`](../../docs/theory/dynamics.md). This file just points at code.

- Per-session DO entrypoint: `apps/orchestrator/src/agents/session-do.ts`
- Runner entrypoint: `packages/session-runner/src/main.ts`
- Reaper: `packages/agent-gateway/src/reaper.ts`
- Failover + orphan recovery: inside `session-do.ts` (search `recordRateLimit`, `forkWithHistory`)
