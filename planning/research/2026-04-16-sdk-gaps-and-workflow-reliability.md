---
date: 2026-04-16
topic: Closing Claude Agent SDK gaps + making workflow gating actually enforceable
status: complete
type: feature-research + feasibility
github_issue: null
related:
  - planning/research/2026-04-10-agent-sdk-gap-analysis.md
  - planning/research/2026-04-16-pty-gateway-frankentui-vs-xterm.md
---

# Research: Closing SDK Gaps + Workflow Reliability

## Why this matters

Two observations drive this doc:

1. **The Agent SDK has a feature subset of the Claude Code TUI.** Documented in the
   2026-04-10 analysis — `interrupt`, `setModel`, `rewindFiles`, `getContextUsage`,
   rate-limit events, session-state transitions, task events, etc. are either partial
   or unwired in `packages/agent-gateway/src/adapters/claude.ts`.
2. **Stop hooks are advisory, not enforcing.** Just observed live in this session:
   kata's stop-conditions hook returned `decision: "block"` with a clear reason
   (task #3 was incomplete). The TUI displayed the reason, the agent (me) saw it
   as guidance, and the session continued / closed anyway. That is **exactly how
   the hook is designed to behave**. It's a nudge, not a guard rail.

Combining: the SDK has gaps, AND the mechanisms we *do* use to enforce workflow
correctness are fundamentally cooperative. Closing the gap requires two tracks
in parallel — wire the missing SDK features, and move workflow enforcement off
cooperation onto mechanisms the agent cannot ignore.

## Part A — Why Stop hooks can't keep workflows alive

### The contract

From [Claude Agent SDK hooks doc](https://code.claude.com/docs/en/agent-sdk/hooks):

> `Stop` — *Agent execution stop* — *Save session state before exit*

The hook fires when the agent has chosen to stop. The callback may return
`decision: "block"` + `reason`, which is fed back into the next turn as context.
The agent then reads the context and decides what to do. There is no kernel-level
enforcement of "you must keep going until X is true." The explicit
`stop_hook_active` flag in the input exists specifically so the hook itself
knows to not create an infinite loop — which only makes sense if the protocol
assumes the *agent* is the decision-maker, not the hook.

### Two well-known rough edges

- **Plugin-delivered Stop hooks are broken.** See
  [anthropics/claude-code#10412](https://github.com/anthropics/claude-code/issues/10412).
  Exit code 2 + `decision: "block"` from hooks installed via the plugin system
  is silently dropped; the same hook in `.claude/hooks/` works. Duraclaw uses
  direct-install via `kata`, so we dodge this, but any plugin-based distribution
  of stop gates is currently unreliable.
- **`systemMessage` may not surface in all SDK output modes.** Again from the
  SDK docs: *"The `systemMessage` field adds context to the conversation that
  the model sees, but it may not appear in all SDK output modes."* So hook
  reasons delivered via `systemMessage` can be invisible to our orchestrator UI
  even when the model sees them.

### What this means for kata

`packages/kata/src/commands/hook.ts` is doing the right thing per the contract —
the `decision: "block"` output is correctly shaped. The kata can_exit machinery
(stop conditions in `batteries/kata.yaml` — `tasks_complete`, `committed`,
`pushed`, `tests_pass`, `feature_tests_added`, `spec_valid`) is semantically sound.
The reliability ceiling is the agent's cooperation. When I (or any model) decides
"close enough", there is nothing to physically prevent it.

### Also: the Gateway isn't even wiring Stop hooks

`packages/agent-gateway/src/adapters/claude.ts:340` currently only registers a
`PostToolUse` hook (for file-change events). No `Stop`, no `UserPromptSubmit`,
no `SessionStart`, no `PreToolUse`. The kata hooks we've been relying on run at
the TUI layer on Ben's machine via `~/.claude/settings.json` +
`.claude/hooks/`. The moment a session runs through the orchestrator / gateway
path, none of those kata guards are active. **This is its own parity gap** —
gateway sessions today are less guarded than local TUI sessions.

---

## Part B — How to make workflow gating actually reliable

Cooperation layer (Stop hook) is what we have. For genuine enforcement, move
down the stack to layers the model cannot talk its way past.

### 1. PreToolUse deny — true enforcement

PreToolUse `permissionDecision: "deny"` **actually blocks** the tool call.
The model can't route around it, because the action never executes.

High-value gates to implement as PreToolUse:

| Gate | Matcher | Condition to deny |
|---|---|---|
| **Commit without tests** | `Bash` with `git commit` | `tests_pass` not set for current phase |
| **Push without commit** | `Bash` with `git push` | uncommitted staged changes OR tasks open |
| **PR without issue update** | `Bash` with `gh pr create` | issue has no closing comment for this session |
| **Merge without review** | `Bash` with `gh pr merge` | no review agent run recorded |
| **Edit without mode** | `Edit`/`Write`/`MultiEdit` | `currentMode === 'default'` (already done — see `handleModeGate`) |
| **TaskUpdate bulk-complete** | `TaskUpdate` with `status=completed` | task has open `blockedBy` (already done — `handleTaskDeps`) |

Kata already has two of these (`handleModeGate`, `handleTaskDeps`). The pattern
extends cleanly to the rest by matching `Bash` and inspecting `tool_input.command`.

### 2. Git pre-commit hook — ground truth

Pre-commit is executed by `git` itself, not the agent. Already active in this
repo (saw it run during the last commit: `pnpm lint:errors && pnpm typecheck`).
Expand it to enforce:

- Tasks in `.kata/sessions/<current>/workflow/*.json` all `completed` (or session
  explicitly in a mode without that condition).
- For implementation mode: required tests exist matching the spec's behaviors.
- `planning/progress.md` updated if spec changed.

This cannot be bypassed short of `--no-verify`, which we already instruct the
agent not to use.

### 3. Continue-loop pattern — turn the Stop hook into a real keep-alive

Instead of relying on the model to voluntarily keep working when it sees
`decision: "block"`, have the orchestrator **automatically re-prompt** when the
SDK's `Stop` event fires with `block`. Pseudocode at the gateway:

```ts
// adapters/claude.ts
options.hooks.Stop = [{
  hooks: [async (input) => {
    const canExit = await kataCanExit(input.session_id)
    if (canExit) return {}
    // Inject reason AND drive a follow-up turn
    return {
      decision: 'block',
      reason: canExit.reasons.join('\n'),
      systemMessage: 'STOP BLOCKED — continue until conditions are met.',
    }
  }]
}]

// In the multi-turn loop, when the SDK emits a `result` whose `stop_reason`
// indicates hook block, auto-enqueue a follow-up turn with the reason as the
// user message, up to N auto-continues before escalating to human.
```

This turns cooperative advisory into a closed loop. The model still has free
will on any given turn, but the orchestrator forces a retry until the kata
conditions actually pass. Cap the loop at, say, 3 auto-continues to avoid
runaway cost; after that, escalate via `AskUserQuestion` or a notification.

Note: this is exactly the
[egghead.io "continuous Stop hook"](https://egghead.io/force-claude-to-ask-whats-next-with-a-continuous-stop-hook-workflow~oiqzj)
pattern, applied server-side at the gateway.

### 4. Close-command pattern — replace verbs the agent might skip

Instead of allowing raw `git commit` / `git push` / `gh pr create` at session
end, provide a single `kata close` that does all of it atomically and runs the
gates first. Then the gate is *inside* the close command — not a hook that can
be walked past, not an instruction that can be misread. `kata close` either
does everything or does nothing.

Combine with PreToolUse denying raw `git commit` in kata modes with
`stop_conditions`: the only way to commit is `kata close`, which enforces the
gates internally.

### 5. Orchestrator-side enforcement — DO refuses to emit `result`

A weaker lever: the `SessionAgent` Durable Object currently forwards the SDK's
`result` event to the client. It could check kata state first and, if stop
conditions aren't met, not emit `result` — instead emit a synthesized "session
still running" event and re-drive. Similar to the Stop-hook loop but happening
in the DO, not the SDK hook. This is architecturally cleaner because the DO
already owns session state and message history, but it means the DO grows a
kata-awareness surface.

### Reliability ladder summary

| Mechanism | Enforcement | Agent can bypass? | Effort |
|---|---|---|---|
| Stop hook `decision: block` (today) | Advisory | Yes (trivially) | Zero |
| PreToolUse deny | Hard — tool doesn't run | No | Small |
| Continue-loop at gateway | Mechanical retry | No (loop cap is the ceiling) | Small-Medium |
| `kata close` wrapper + PreToolUse deny on raw `git` | Hard | No, unless bypass is authorized | Medium |
| Git pre-commit hook | Hard at git layer | Only with `--no-verify` | Small |
| DO-side result gating | Hard at orchestrator | No | Medium |

**Recommendation:** ship #1 (PreToolUse deny) + #3 (continue-loop) + #4
(`kata close` wrapper). That covers the 90% case — tests-must-pass,
issue-must-close, tasks-must-complete — without over-engineering.

---

## Part C — The actual SDK gaps (refined from 2026-04-10)

Reprioritized with today's reliability lens. Each gap now has an explicit
"reliability tier" — whether closing it improves workflow enforcement or only
observability.

### Tier 1 — High value, ship next

| # | Gap | SDK API | Reliability impact | Effort |
|---|---|---|---|---|
| 1 | **Stop hook not wired at gateway** | `options.hooks.Stop` | Huge — enables the continue-loop (Part B §3) | S |
| 2 | **`interrupt()`** | `query.interrupt()` | Soft-stop without killing session — needed for "pause & replan" UX | S |
| 3 | **`setModel()` + `setPermissionMode()`** | `query.setModel` / `setPermissionMode` | Mid-session control — downgrade model, tighten permissions | S |
| 4 | **`rewindFiles()`** | `enableFileCheckpointing` + `query.rewindFiles(messageId)` | Undo/rollback — currently stubbed in protocol as "not implemented" | M |
| 5 | **`getContextUsage()`** | `query.getContextUsage()` | Show context % in UI, auto-compact warnings | S |
| 6 | **Forward `session_state_changed`** | Already emitted by SDK, not forwarded | idle / running / requires_action state for UI indicators | S |
| 7 | **Forward `rate_limit_event`** | Already emitted, not forwarded | Visibility into Anthropic rate-limit throttling | S |
| 8 | **`thinking` + `effort` options** | `ExecuteCommand` | Control reasoning depth per session | S |

All of Tier 1 is additive — no architectural churn, just wiring more SDK
surface through our `VpsCommand` / `GatewayEvent` protocol.

### Tier 2 — Close when demand arrives

Forward `task_started` / `task_progress` / `task_notification`, implement
`forkSession`, replace custom `listSdkSessions` with SDK's `listSessions` +
`getSessionMessages`, add MCP server config plumbing
(`mcpServers`, `reconnectMcpServer`, `toggleMcpServer`).

### Tier 3 — Keep watching, don't adopt yet

Bridge API, Assistant API, V2 Session API (`unstable_v2_createSession`),
plugins, prompt suggestions, agent progress summaries, sandbox, custom spawner,
betas. Monitor but no action.

### The honest ceiling

Even with all of Tier 1 + Tier 2 closed, the SDK remains a *subset* of TUI
behavior. New TUI features (DEC 2026 alt-screen, Kitty kbd protocol, Remote
Control, AutoDream, prompt-suggestion UI) land in TUI first. Our strategy for
that:

- Tier 1/2 closes **the gap that hurts today**.
- For **structural parity** (everything TUI can do forever), accept the subset
  and keep the 2026-04-16-pty-gateway research open as a hedge: an opt-in
  `PtyClaudeAdapter` gives "raw TUI" access when the SDK falls behind enough
  to block a user need.

---

## Part D — Recommended sequencing

### Sprint 1 (low risk, high payoff)

1. Wire `Stop` hook in `claude.ts`, emit a new `GatewayEvent` (`stop_blocked`)
   carrying the reason. Orchestrator UI shows it as a banner; SessionAgent
   enqueues an auto-continue turn (up to N).
2. Forward `session_state_changed` and `rate_limit_event` through the protocol.
3. Add `interrupt` command to the protocol → `query.interrupt()`.
4. Add `setModel` + `setPermissionMode` commands.
5. Add `context-usage` command → `query.getContextUsage()`.
6. Add `thinking` + `effort` to `ExecuteCommand`.

Estimated: one engineer, ~1 sprint. All Tier 1 items except file checkpointing.

### Sprint 2 (touches filesystem semantics)

7. Implement `rewindFiles` — remove the "not implemented" stub, wire the
   protocol end-to-end, add SessionAgent replay logic to rebuild DO state to
   the rewind point.
8. Add `PreToolUse` deny on raw `git commit` / `git push` / `gh pr create` in
   kata modes with relevant `stop_conditions`, via a new kata hook handler in
   `packages/kata/src/commands/hook.ts`.
9. Add `kata close` subcommand that runs gates + commit + push + PR atomically.
10. Expand repo pre-commit hook to check kata session state.

### Sprint 3 (optional, when demand justifies)

11. Tier 2 items — task events, forkSession, SDK session listing replacement,
    MCP plumbing.

---

## Part E — Open questions

- **Continue-loop safety cap.** What's the right N? 3 auto-continues before
  escalating via `AskUserQuestion` seems safe, but needs real-session data.
  Should it be per-mode configurable?
- **DO vs gateway for the loop.** The Stop hook fires inside the SDK at the
  gateway. The auto-continue turn conceptually lives in the orchestrator DO
  (since it owns message history). Cleanest boundary: SDK emits Stop-blocked
  as a protocol event, DO decides whether to re-drive.
- **PreToolUse regex on Bash commands.** Matching "is this a `git commit`?"
  requires parsing the command string. Kata's `handleModeGate` already does
  regex against `kata ...` — extend that approach. Edge cases: aliases,
  `sh -c`, heredocs.
- **`kata close` vs existing skill.** We already have a `kata-close` skill.
  Promoting it to a first-class subcommand means deduplicating the logic —
  one-time cost.
- **How do we know the continue-loop worked?** Need telemetry: every Stop-block
  + auto-continue should log a structured event so we can measure how often
  the loop actually prevents premature exits vs how often the agent finishes
  on the first retry anyway.

---

## Sources

- [Claude Agent SDK hooks doc](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [anthropics/claude-code#10412 — Plugin stop hooks broken](https://github.com/anthropics/claude-code/issues/10412)
- [anthropics/claude-code#12667 — Stop hook UX shows 'error' for intentional blocking](https://github.com/anthropics/claude-code/issues/12667)
- [Continuous Stop hook workflow (egghead.io)](https://egghead.io/force-claude-to-ask-whats-next-with-a-continuous-stop-hook-workflow~oiqzj)
- [Claude Code Stop Hook: Force Task Completion (claudefa.st)](https://claudefa.st/blog/tools/hooks/stop-hook-task-enforcement)
- Internal:
  - `planning/research/2026-04-10-agent-sdk-gap-analysis.md`
  - `planning/research/2026-04-16-pty-gateway-frankentui-vs-xterm.md`
  - `packages/agent-gateway/src/adapters/claude.ts`
  - `packages/kata/src/commands/hook.ts`
  - `packages/kata/batteries/kata.yaml`
