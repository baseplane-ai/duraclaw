---
github_issue: 8
status: approved
phases:
  - id: p1
    name: "Shared types"
    tasks:
      - "Add optional org_id and user_id to ExecuteCommand"
      - "Add org_id and user_id to SessionContext"
  - id: p2
    name: "Gateway wiring"
    tasks:
      - "Pass org_id/user_id from execute command into SessionContext in server.ts"
  - id: p3
    name: "Tests"
    tasks:
      - "Update type tests for new optional fields"
      - "Verify backwards compatibility"
---

# CC Gateway: Baseplane Integration Adapter

## Summary

Adapt the CC Gateway for Baseplane integration. Add `org_id` and `user_id` context fields to `ExecuteCommand` and track them in gateway session state.

## Changes

### Phase 1: Shared types

- Add optional `org_id?: string` and `user_id?: string` to `ExecuteCommand`
- Add `org_id` and `user_id` to `SessionContext` for gateway-level tracking

### Phase 2: Gateway wiring

- In `server.ts`, pass `org_id`/`user_id` from the execute command into `SessionContext`
- These fields are gateway metadata — not passed to the Claude SDK

### Phase 3: Tests

- Update existing type tests to cover the new optional fields
- Verify backwards compatibility (commands without org/user still work)

## Non-goals

- Cost tracking / budget enforcement
- Executor abstraction
- Session rollback/rewind
- Multi-provider support
- System prompt injection (existing CLAUDE.md / `.claude/` handles project context)

## Acceptance Criteria

- `ExecuteCommand` accepts optional `org_id` and `user_id` fields
- CC Gateway stores org/user context in session state
- Existing commands without org/user fields continue to work
