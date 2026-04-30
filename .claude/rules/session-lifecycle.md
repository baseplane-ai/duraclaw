---
paths:
  - "apps/orchestrator/src/agents/**"
  - "packages/session-runner/src/**"
  - "packages/agent-gateway/src/reaper.ts"
---
# Session lifecycle (rule stub)
Invariants live in [`docs/theory/dynamics.md`](../../docs/theory/dynamics.md). This file just points at code.

- Per-session DO: `apps/orchestrator/src/agents/session-do/` (split into modules; `index.ts` is the facade)
- Three primitives (post-GH#116): `advanceArc` (advance-arc.ts), `branchArc` (branches.ts), `rebindRunner` (rebind-runner.ts)
- Runner entrypoint: `packages/session-runner/src/main.ts`
- Reaper: `packages/agent-gateway/src/reaper.ts`
