---
initiative: askuserquestion-gate-fix
type: project
issue_type: bug
status: approved
priority: high
github_issue: 38
created: 2026-04-14
updated: 2026-04-15
approved: 2026-04-15
phases:
  - id: p1
    name: "Migrate PreToolUse hooks to canUseTool callback"
    tasks:
      - "Write characterization test proving PreToolUse doesn't fire for AskUserQuestion"
      - "Write unit tests defining canUseTool contract (AskUserQuestion, permissions, timeout, abort)"
      - "Replace PreToolUse hooks with canUseTool callback in claude.ts"
      - "Remove PreToolUse hooks array, keep PostToolUse for file-change tracking"
      - "Run tests to verify all pass"
    test_cases:
      - id: "canuse-askuser-sends-event"
        description: "When canUseTool fires with toolName='AskUserQuestion', gateway sends ask_user event with questions array"
        type: "unit"
      - id: "canuse-askuser-waits-for-answer"
        description: "canUseTool blocks until pendingAnswer is resolved, then returns { behavior: 'allow', updatedInput: { ...input, answers } }"
        type: "unit"
      - id: "canuse-askuser-timeout"
        description: "canUseTool rejects after 5 minutes if no answer received"
        type: "unit"
      - id: "canuse-permission-sends-event"
        description: "When canUseTool fires with any other tool, gateway sends permission_request event"
        type: "unit"
      - id: "canuse-permission-allow-deny"
        description: "canUseTool returns { behavior: 'allow' } or { behavior: 'deny', message: 'Denied' } based on pendingPermission resolution"
        type: "unit"
      - id: "server-answer-resolves-pending"
        description: "Gateway server 'answer' command resolves ctx.pendingAnswer with provided answers"
        type: "unit"
  - id: p2
    name: "Update GateResolver for structured AskUserQuestion UI"
    tasks:
      - "Write component tests for structured question rendering"
      - "Render questions array with header chip, question text, and option cards"
      - "Support single-select (click option to select) and multi-select (toggle options)"
      - "Support free-text 'Other' answer with text input fallback"
      - "Format answers as { [questionText]: selectedLabel } keyed by question text"
      - "Support multiple questions (1-4) rendered sequentially"
      - "Run tests to verify"
    test_cases:
      - id: "gate-renders-question-text"
        description: "GateResolver renders question text and header chip from gate.detail.questions[0]"
        type: "unit"
      - id: "gate-renders-options"
        description: "GateResolver renders option cards with label and description for each option"
        type: "unit"
      - id: "gate-select-option"
        description: "Clicking an option highlights it and enables the Submit button"
        type: "unit"
      - id: "gate-other-input"
        description: "User can type a custom 'Other' answer in the text input instead of selecting an option"
        type: "unit"
      - id: "gate-multi-select"
        description: "When multiSelect is true, user can toggle multiple options before submitting"
        type: "unit"
      - id: "gate-answer-format"
        description: "Submitted answer is formatted as { [questionText]: selectedLabel } for the resolveGate call"
        type: "unit"
      - id: "gate-multiple-questions"
        description: "When questions array has 2+ items, all are rendered with their own options"
        type: "unit"
  - id: p3
    name: "End-to-end gate flow verification"
    tasks:
      - "Start a session that triggers AskUserQuestion"
      - "Verify ask_user event flows from gateway to SessionDO to browser"
      - "Verify GateResolver renders in ChatThread with structured question UI"
      - "Verify answer submission flows from browser to SessionDO to gateway to SDK"
      - "Verify session resumes after answer is provided"
    test_cases:
      - id: "e2e-gate-renders"
        description: "When Claude calls AskUserQuestion, GateResolver appears with question text, header, and option cards"
        type: "smoke"
      - id: "e2e-answer-resumes"
        description: "After selecting an option and submitting, the session resumes and Claude continues"
        type: "smoke"
      - id: "e2e-reconnect-gate"
        description: "Disconnecting and reconnecting while gate is pending re-renders the GateResolver"
        type: "smoke"
---

## Overview

The AskUserQuestion tool call from the Claude Agent SDK is never intercepted by the gateway, and the GateResolver UI doesn't render the structured question format (options with labels/descriptions, multi-select, header chips) that AskUserQuestion provides. Two fixes are needed:

1. **Gateway (P1):** Replace PreToolUse hooks with the SDK's native `canUseTool` callback. The SDK no longer fires PreToolUse hooks for AskUserQuestion, so the current interception code is dead. The `canUseTool` callback fires for all tool calls and supports injecting answers via `updatedInput`.

2. **UI (P2):** Rewrite GateResolver's `ask_user` branch to render structured questions with selectable option cards, multi-select support, header chips, and an "Other" free-text fallback — matching the SDK's `AskUserQuestionInput` schema.

## Root Cause

The gateway adapter (`packages/agent-gateway/src/adapters/claude.ts:200-339`) uses `options.hooks.PreToolUse` to intercept AskUserQuestion and permission prompts. However, the SDK removed PreToolUse hook firing for AskUserQuestion — the hook never triggers, so the `ask_user` event is never emitted and the GateResolver UI is never shown.

The SDK's native mechanism for tool interception is the `canUseTool` callback (`Options.canUseTool`), which:
- Fires for **all** tool calls, including internal tools like AskUserQuestion
- Receives `(toolName, input, { toolUseID, signal, ... })`
- Returns `PermissionResult` with optional `updatedInput` for injecting answers
- Is the designated SDK API for permission handling — PreToolUse hooks were a secondary mechanism

## Feature Behaviors

### B1: Gateway intercepts AskUserQuestion via canUseTool

**Core:**
- **ID:** gateway-askuser-canuse
- **Trigger:** Claude SDK calls AskUserQuestion tool during a session
- **Expected:** The `canUseTool` callback detects `toolName === 'AskUserQuestion'`, sends an `ask_user` GatewayEvent to the orchestrator WebSocket with the tool's `questions` array and `toolUseID`, then blocks waiting for `ctx.pendingAnswer` to resolve. When resolved, returns `{ behavior: 'allow', updatedInput: { ...input, answers } }`.
- **Verify:** Unit test: configure `canUseTool` callback. Call it with `toolName: 'AskUserQuestion'`, `input: { questions: [...] }`, `options: { toolUseID: 'tu-1', signal }`. Assert the WS receives an `ask_user` event. Resolve `ctx.pendingAnswer`. Assert return is `{ behavior: 'allow', updatedInput: { questions: [...], answers: {...} } }`.
**Source:** `packages/agent-gateway/src/adapters/claude.ts` (replacing lines 200-257)

#### API Layer
- **Event emitted:** `{ type: 'ask_user', session_id, tool_call_id, questions }` (matches existing `AskUserEvent` in shared-types — no changes)
- **Answer consumed via:** `AnswerCommand { type: 'answer', session_id, tool_call_id, answers }` routed by `server.ts:556-570` which calls `ctx.pendingAnswer.resolve(cmd.answers)` (no changes)
- **Timeout:** 5 minutes, after which the callback rejects and the session fails

### B2: Gateway intercepts permission prompts via canUseTool

**Core:**
- **ID:** gateway-permission-canuse
- **Trigger:** Claude SDK calls any tool other than AskUserQuestion during a session (and the SDK's permission mode requires a decision)
- **Expected:** The `canUseTool` callback sends a `permission_request` GatewayEvent to the orchestrator WebSocket with `toolName`, `input`, and `toolUseID`, then blocks waiting for `ctx.pendingPermission` to resolve. When resolved with `true`, returns `{ behavior: 'allow' }`. When resolved with `false`, returns `{ behavior: 'deny', message: 'Denied by user' }`.
- **Verify:** Unit test: call `canUseTool` with `toolName: 'Bash'`, `input: { command: 'ls' }`. Assert `permission_request` event sent. Resolve with `true`. Assert return is `{ behavior: 'allow' }`. Repeat with `false`, assert `{ behavior: 'deny', message: 'Denied by user' }`.
**Source:** `packages/agent-gateway/src/adapters/claude.ts` (replacing lines 259-305)

#### API Layer
- **Event emitted:** `{ type: 'permission_request', session_id, tool_call_id, tool_name, input }` (matches existing `PermissionRequestEvent` — no changes)
- **Permission consumed via:** `PermissionResponseCommand { type: 'permission-response', ... }` routed by `server.ts:437-452` (no changes)

### B3: PostToolUse hooks preserved for file tracking

**Core:**
- **ID:** posttooluse-file-tracking
- **Trigger:** Any tool completes execution (Edit, Write, etc.)
- **Expected:** PostToolUse hooks remain unchanged — they detect Edit/Write tool completions and emit `file_changed` events. This is unaffected by the canUseTool migration.
- **Verify:** Existing tests for PostToolUse continue to pass.
**Source:** `packages/agent-gateway/src/adapters/claude.ts:310-338` (unchanged)

### B4: SessionDO ask_user gate handling (unchanged)

**Core:**
- **ID:** session-do-askuser-gate
- **Trigger:** SessionDO receives `ask_user` GatewayEvent
- **Expected:** No changes — appends `tool-ask_user` part, sets `waiting_gate`, dispatches push notification. Already implemented correctly at session-do.ts:973-1019.
- **Verify:** Existing behavior — covered by the e2e flow.

### B5: GateResolver renders structured AskUserQuestion UI

**Core:**
- **ID:** gateresolver-askuser-ui
- **Trigger:** ChatThread renders `tool-ask_user` part in `approval-requested` state while session is `waiting_gate`
- **Expected:** GateResolver renders the structured question format from `gate.detail.questions` array. For each question:
  - Displays `header` as a chip/tag label
  - Displays `question` text
  - Renders each `option` as a selectable card showing `label` and `description`
  - If `multiSelect` is true, allows toggling multiple options; otherwise single-select
  - Provides an "Other" free-text input for custom answers
  - Submit button sends `onResolve(gate.id, { answer: selectedLabel })` for single-select, or `onResolve(gate.id, { answer: 'label1, label2' })` for multi-select (comma-separated)
- **Verify:** Component test: render GateResolver with `gate.detail: { questions: [{ question: 'Which?', header: 'Library', options: [{ label: 'lodash', description: 'Utility library' }, { label: 'ramda', description: 'FP library' }], multiSelect: false }] }`. Assert header chip, question text, and option cards render. Click 'lodash' card, click Submit, assert `onResolve` called with `{ answer: 'lodash' }`.
**Source:** `apps/orchestrator/src/features/agent-orch/GateResolver.tsx` (rewriting lines 69-109)

#### UI Layer
- **Component:** `GateResolver` (existing, `ask_user` branch needs full rewrite)
- **Question data shape** (from SDK `AskUserQuestionInput`):
  ```typescript
  questions: Array<{
    question: string;      // "Which library should we use?"
    header: string;        // "Library" (chip label, max 12 chars)
    options: Array<{
      label: string;       // "lodash"
      description: string; // "General-purpose utility library"
      preview?: string;    // Optional code/mockup preview (markdown)
    }>;                    // 2-4 options
    multiSelect: boolean;  // false = single-select, true = multi-select
  }>;
  ```
- **Answer format** (from SDK `AskUserQuestionOutput`):
  The SDK expects answers as `{ [questionText]: answerString }` keyed by question text. Multi-select answers are comma-separated. The existing `resolveGate` sends `{ answer: string }` — the GateResolver formats the answer string before calling `onResolve`.
- **States:**
  - `idle`: Shows question(s) with option cards, "Other" text input, and disabled Submit button
  - `option-selected`: An option card is highlighted, Submit button enabled
  - `other-typed`: Text input has content, Submit button enabled
  - `resolving`: All controls disabled, Submit shows loading state
- **Accessibility:** Option cards are buttons with `aria-pressed` for selection state. "Other" input has associated label. Submit button has descriptive text.

### B6: resolveGate answer flow (unchanged)

**Core:**
- **ID:** resolve-gate-answer-flow
- **Trigger:** User submits answer via GateResolver
- **Expected:** No changes — SessionDO sends `answer` command to gateway, updates part state, clears gate. Located at session-do.ts:595-645.
- **Verify:** Existing behavior — covered by the e2e flow.

## Non-Goals

- **Shared types changes:** Event shapes (`AskUserEvent`, `PermissionRequestEvent`, `AnswerCommand`) are unchanged.
- **SessionDO changes:** Gate handling logic is unchanged — the fix is in the gateway adapter and GateResolver UI.
- **Other adapters:** Only the Claude adapter is affected. Codex and OpenCode adapters don't support AskUserQuestion.
- **Preview rendering:** AskUserQuestion options can include `preview` content (markdown mockups, code snippets). This fix shows `label` and `description` only; preview rendering is deferred.
- **Annotations:** The SDK supports `annotations` (per-question notes from the user). Not implemented in this fix.
- **Auto-resolve mode:** No headless/batch auto-answer support — always relay to user.

## Implementation Phases

### Phase 1: Migrate to canUseTool in claude.ts (1-2 hours)

**Scope:** `packages/agent-gateway/src/adapters/claude.ts` and `claude.test.ts` only.

**Test-first ordering:** Write tests before changing production code. The existing `claude.test.ts` has zero coverage of hook/permission/gate behavior — all tests below are new.

1. **Write characterization test for current PreToolUse behavior** — Add a test that calls the PreToolUse hook with `tool_name: 'AskUserQuestion'` and verifies the expected behavior. This test demonstrates the bug: PreToolUse hooks don't fire for AskUserQuestion in the SDK (confirmed in live session testing — the SDK removed PreToolUse firing for this internal tool as of v0.2.x).

2. **Write unit tests for canUseTool behavior** — Before migrating, write tests that define the expected canUseTool contract:
   - `canUseTool` receives `(toolName, input, { toolUseID, signal })` — note `input` is the tool input directly (not wrapped in `{ tool_name, tool_input }` like PreToolUse hooks)
   - AskUserQuestion interception → `ask_user` event sent → answer resolution → returns `{ behavior: 'allow', updatedInput: { questions, answers } }`
   - Permission interception → `permission_request` event sent → allow returns `{ behavior: 'allow' }`, deny returns `{ behavior: 'deny', message: 'Denied by user' }`
   - Timeout after 5 minutes → rejects
   - Abort signal → rejects (test with both SDK-provided `opts.signal` and gateway's `ac.signal`)

3. **Replace PreToolUse hooks with `canUseTool` callback** — Add `options.canUseTool` callback to SDK options:
   ```typescript
   options.canUseTool = async (
     toolName: string,
     input: Record<string, unknown>,
     opts: { signal: AbortSignal; toolUseID: string }
   ): Promise<PermissionResult> => {
     if (toolName === 'AskUserQuestion') {
       // Send ask_user event, wait for answer, return with updatedInput
     }
     // All other tools: send permission_request, wait for response
   }
   ```

4. **Remove PreToolUse hooks** — Delete the entire `PreToolUse` array from `options.hooks`. Keep only `PostToolUse` for file tracking. Note: line references to PostToolUse (currently 310-338) will shift after removing ~110 lines of PreToolUse code — reference by description rather than line numbers.

5. **Preserve existing patterns** — The `pendingAnswer` and `pendingPermission` context fields, timeout logic, and abort signal handling remain the same — only the callback wrapper changes.

6. **Run tests** — Verify all new unit tests pass with the canUseTool implementation.

**Note on `PermissionResult` fields:** The SDK's `PermissionResult` type includes optional fields (`updatedPermissions`, `decisionClassification`, `interrupt`, `toolUseID`) beyond `behavior` and `updatedInput`/`message`. These are intentionally not used — we only need `behavior: 'allow'` with optional `updatedInput` for AskUserQuestion, and `behavior: 'deny'` with `message` for denied permissions.

### Phase 2: Update GateResolver for structured questions (1-2 hours)

**Scope:** `apps/orchestrator/src/features/agent-orch/GateResolver.tsx` and new test file.

**Test-first ordering:** Write component tests before modifying GateResolver.

1. **Write component tests** — Define expected rendering and interaction:
   - Renders question text and header chip from `gate.detail.questions[0]`
   - Renders option cards with `label` and `description`
   - Single-select: clicking an option highlights it exclusively
   - Multi-select: clicking toggles option selection
   - "Other" text input works as fallback
   - Submit sends correctly formatted answer
   - Multiple questions (2+) all render

2. **Rewrite the `ask_user` branch of GateResolver** — Replace the simple text input (lines 69-109) with structured question rendering:
   - Read `gate.detail.questions` (array, not single `question` string)
   - For each question: render `header` chip, `question` text, option cards
   - Option cards: `label` as title, `description` as subtitle, selectable
   - Single-select: clicking one deselects others
   - Multi-select: toggle selection with visual indicator
   - "Other" text input always available below options
   - Submit button: enabled when option selected or text entered
   - Answer format: selected `label` value (or comma-separated for multi-select, or custom text for "Other")

3. **Update answer format for resolveGate** — The SDK expects answers as `{ [questionText]: answerString }`. The current `resolveGate` sends `{ answer: string }`. For single-question (common case), send `{ answer: selectedLabel }`. For multiple questions, the GateResolver collects answers per question and formats them.

4. **Run tests** — Verify all component tests pass.

### Phase 3: End-to-end verification (1 hour)

1. **Live session test** — Start a session that triggers AskUserQuestion, verify the full flow works end-to-end.
2. **Edge cases** — Test timeout, abort while gated, reconnect while gated.

## Verification Plan

### V1: Unit test — canUseTool AskUserQuestion interception
```bash
cd /data/projects/duraclaw/packages/agent-gateway
bun test src/adapters/claude.test.ts --filter "AskUserQuestion"
```
Expected: All AskUserQuestion-related tests pass.

### V2: Unit test — canUseTool permission handling
```bash
cd /data/projects/duraclaw/packages/agent-gateway
bun test src/adapters/claude.test.ts --filter "permission"
```
Expected: Permission allow/deny tests pass.

### V3: Unit test — GateResolver structured question rendering
```bash
cd /data/projects/duraclaw/apps/orchestrator
pnpm vitest run src/features/agent-orch/GateResolver.test.tsx
```
Expected: All GateResolver tests pass — question text, header chip, option cards, selection, multi-select, "Other" input, submit.

### V4: Smoke test — GateResolver renders in browser
```bash
chrome-devtools-axi open http://localhost:43173/login
# ... login flow ...
# Navigate to session, trigger AskUserQuestion
chrome-devtools-axi snapshot
```
Expected: GateResolver appears with question text, input, and submit button.

### V5: Smoke test — Answer submission resumes session
Submit an answer and verify session continues.
Expected: GateResolver disappears, session status returns to `running`.

### V6: Smoke test — Reconnect re-renders gate
Close and reopen browser while gate is pending.
Expected: GateResolver re-renders with the same question content.

## Implementation Hints

### Key Types (from SDK sdk.d.ts)

**canUseTool signature (line 146):**
```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
  }
) => Promise<PermissionResult>;
```

**PermissionResult (line 1534):**
```typescript
type PermissionResult = {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;  // inject answers here
} | {
    behavior: 'deny';
    message: string;
};
```

### Code Pattern for canUseTool

```typescript
options.canUseTool = async (toolName, input, opts) => {
  const { toolUseID: id, signal } = opts

  if (toolName === 'AskUserQuestion') {
    send(ws, {
      type: 'ask_user',
      session_id: sessionId,
      tool_call_id: id,
      questions: (input as any).questions ?? [],
    })

    const answers = await new Promise<Record<string, string>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ctx.pendingAnswer = null
        reject(new Error('AskUserQuestion timed out after 5 minutes'))
      }, 5 * 60 * 1000)

      ctx.pendingAnswer = {
        resolve: (a) => { clearTimeout(timeout); resolve(a) },
        reject: (e) => { clearTimeout(timeout); reject(e) },
      }

      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        ctx.pendingAnswer = null
        reject(new Error('Session aborted'))
      }, { once: true })
    })

    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }

  // Permission prompt for all other tools
  send(ws, {
    type: 'permission_request',
    session_id: sessionId,
    tool_call_id: id,
    tool_name: toolName,
    input,
  })

  const allowed = await new Promise<boolean>((resolve, reject) => {
    // ... same timeout + abort pattern as above ...
    ctx.pendingPermission = { resolve, reject }
  })

  return allowed
    ? { behavior: 'allow' }
    : { behavior: 'deny', message: 'Denied by user' }
}
```

### Gotchas

1. **CRLF in SDK .d.ts files** — Use `tr -d '\r'` when piping through grep, or use Read tool directly.
2. **`canUseTool` vs `hooks`** — Both are set as SDK options. Setting `canUseTool` means the SDK sends `control_request` with `subtype: 'can_use_tool'` for every tool that needs a permission decision. The SDK handles the IPC internally.
3. **PostToolUse hooks still work** — Only PreToolUse behavior changed for AskUserQuestion. PostToolUse hooks for file tracking are unaffected.
4. **permissionMode: 'default'** — The gateway sets `permissionMode: 'default'`. The SDK determines which tools need canUseTool based on this mode. AskUserQuestion always fires canUseTool regardless of mode.
