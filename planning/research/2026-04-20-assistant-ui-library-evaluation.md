# assistant-ui Library Evaluation for Duraclaw

**Date:** 2026-04-20
**Type:** Library/tech evaluation
**Status:** Research complete — recommendation: **don't adopt wholesale; cherry-pick patterns from `@assistant-ui/react-opencode`**

## TL;DR

`assistant-ui` (github.com/assistant-ui/assistant-ui — MIT, 9.6k★, YC-backed, very active: pushed 2026-04-20, 1,344 tagged releases) is a high-quality React library of composable chat primitives. Its stack aligns well with ours (React 19, Tailwind, Radix, shadcn-style slot composition), and it ships a custom-backend adapter (`useExternalStoreRuntime`) that could front our `SessionDO` WS stream.

However, adopting it whole-cloth would:

1. **Fight our streaming model.** assistant-ui expects message objects to be *replaced per frame* via `setMessages`. We stream token-by-token by mutating `part.text` on a stable message row in a TanStack DB collection (`gateway-event-mapper.mergeFinalAssistantParts`, `use-coding-agent.ts:259–279`). Bridging requires materialising every delta as a fresh message array — wasteful and at odds with our IVM-driven reactive pipeline.
2. **Fight our branching model.** assistant-ui treats branches as a client-side tree derived from `parentId` and `setMessages`. Our branches are **server-authoritative**: `SessionDO.getHistory(leafId)` produces snapshots; clients are read-only consumers (`branch-info-collection.ts`). We'd be wiring our snapshots into their tree and re-deriving sibling state we already have.
3. **Duplicate `packages/ai-elements`.** We already run a 45-component bespoke library (Conversation, Message, Tool, PromptInput, Artifact, Reasoning, Confirmation, Suggestion, CodeBlock, ToolCallList) built on the same Radix + Tailwind + streamdown foundation that assistant-ui uses.

The **high-value part** is their `@assistant-ui/react-opencode` adapter (opencode is a Claude-Code-style agent tool) — studying its event→part mapping and tool-UI composition is likely more actionable than swapping libraries.

## What assistant-ui Is

Composable React primitives (Radix-style, shadcn-themed) for AI chat: streaming, tool calls, attachments, markdown, voice input, accessibility, auto-scroll, retries. Works across AI SDK, LangGraph, Mastra, LangChain, A2A, AG-UI, `opencode`, and custom backends.

**Package layout** (github API `/packages` listing):

| Core | Adapters |
|------|----------|
| `react`, `core`, `assistant-stream` | `react-ai-sdk`, `react-langgraph`, `react-langchain`, `react-a2a`, `react-ag-ui`, `react-data-stream`, `react-opencode`, `react-google-adk` |
| `react-markdown`, `react-streamdown`, `react-syntax-highlighter`, `react-lexical`, `react-hook-form` | `react-devtools`, `react-o11y` |
| `cloud`, `cli`, `create-assistant-ui`, `safe-content-frame`, `react-native` | |

**Signal of health:** pushed 2026-04-20 (today), 1,344 releases, open discussions, MIT license, multi-contributor. Low adoption risk.

## Stack Fit

| Dim | Duraclaw today | assistant-ui expects | Match |
|-----|----------------|----------------------|-------|
| React | 19.2.4 | 19.x | ✅ |
| Tailwind | 4.2.2 | 3.x / 4.x | ✅ |
| Radix primitives | yes (full suite in ai-elements) | yes | ✅ |
| shadcn-style slots | yes (ai-elements is slot-composed) | yes | ✅ |
| Markdown/streaming | `streamdown`, `shiki` | same (`react-streamdown`, `react-syntax-highlighter`) | ✅ (identical) |

Stack compatibility is not the blocker. Data-model compatibility is.

## Integration Surface: `useExternalStoreRuntime`

Confirmed shape (`www.assistant-ui.com/docs/runtimes/custom/external-store`):

```ts
useExternalStoreRuntime<T>({
  messages: readonly T[],              // our state
  convertMessage: (m, i) => ThreadMessageLike,
  onNew: (msg: AppendMessage) => Promise<void>,
  onEdit?, onReload?, onCancel?, onAddToolResult?,
  setMessages?: (ms: readonly T[]) => void,  // required for branch switching
  isRunning: boolean,
})
```

`ThreadMessageLike` = `{ role, content: string | MessagePart[], id?, createdAt?, status?, metadata? }`. Tool calls are `MessagePart.type === 'tool-call'`; tool results come as separate `role: 'tool'` messages and are auto-matched by `toolCallId`.

**Headless primitives exist** (`ThreadPrimitive.Root/Viewport/Messages`, analogous to Radix), but the hooks-level API (e.g. `useThread`, `useComposer`) is not prominently documented — would require code-reading.

## Friction Points (Where Adoption Hurts)

### 1. Streaming: swap-vs-append

Docs demonstrate streaming via:

```ts
setMessages(prev => prev.map(m =>
  m.id === assistantId ? { ...m, content: [{type:'text', text: oldText + chunk}] } : m
))
```

Our path (`gateway-event-mapper.ts:35–46`, `messages-collection.ts`) mutates a `CachedMessage.parts[].text` in-place on a reactive TanStack DB row. Bridging means either:

- **(a)** Keep our collection, derive a fresh `readonly T[]` on every delta and pipe into `useExternalStoreRuntime`. Wastes the IVM — each token re-allocates an array and re-enters React. Measurable cost on long turns.
- **(b)** Drop our delta model and let assistant-ui own streaming. Gives up our `seq`-stamped gap/snapshot protocol (GH#14) that the DO relies on.

Both options regress infrastructure we've already validated.

### 2. Branching: client tree vs. server snapshots

Their model: `ExportedMessageRepository.fromBranchableArray()` builds a tree from `{id, parentId}` pairs; `setMessages` swaps branches.

Our model: `SessionDO` authors a `kind:'snapshot'` frame with `reason:'branch-navigate'` when the user clicks a chevron. Client is a dumb replacer. `BranchInfoRow { siblings[], activeId }` is DO-authored and read-only on the client (`branch-info-collection.ts`, `use-branch-info.ts:24–46`).

To plug into assistant-ui we'd have to synthesise `parentId` edges from our sibling lists — doable, but we're building a client-side tree just to drive a UI state machine that we already drive from snapshots.

### 3. Custom gates (ask_user, permission_request)

Our `GateResolver` in `ChatThread.tsx:46,87–107` is bespoke: it renders approval-UI for `tool-ask_user` / `tool-permission` parts and calls `connection.call('resolveGate', …)` RPC back to the DO. assistant-ui has `onAddToolResult` for this, but it assumes the tool result *is* the resolution payload — we'd be re-casting our `resolve-gate` GatewayCommand to fit.

### 4. We've already built the chat surface

`packages/ai-elements` exports 45 components covering all current surfaces. Replacing it means migrating `ChatThread.tsx`, the 45-component public API across other apps, the `partialAssistantToParts` / `mergeFinalAssistantParts` mapper chain, and the `MessageBranchContextType` branch chevron UX. Non-trivial.

## Where assistant-ui *Would* Win

- **Accessibility polish.** Keyboard shortcuts, ARIA semantics on composed primitives, focus management. Our ai-elements likely has gaps here (worth a dedicated audit).
- **Auto-scroll finesse.** Their viewport primitive handles anchor preservation during streaming better than our 70-px threshold `ResizeObserver`.
- **Voice/dictation.** We have a GH#20 spec for voice; their `ComposerPrimitive` + dictation hooks are production-tested.
- **Devtools.** `@assistant-ui/react-devtools` is real. We have none.
- **opencode adapter as a reference.** `@assistant-ui/react-opencode` models a Claude-Code-like agent. Even if we don't adopt the library, reading how they shape events→`ThreadMessageLike` is the single most valuable artefact from this evaluation.

## Options

| Option | Cost | Value | Verdict |
|--------|------|-------|---------|
| **A. Adopt wholesale** (replace ai-elements with assistant-ui) | High — redo streaming, branching, gates; migrate 45 components | Polished primitives, devtools, accessibility | ❌ Not worth it; fights our data model |
| **B. Adopt selectively** (use `ThreadPrimitive.Viewport` + composer for accessibility + auto-scroll; keep our collection + bespoke message rendering) | Medium — scope a single primitive swap at a time | Targeted wins without data-model fight | 🤔 Defer until we hit a concrete gap |
| **C. Don't adopt; study `react-opencode`** (borrow patterns, improve our own `ai-elements`) | Low — reading + selective porting | Catches up on polish we're missing; zero migration risk | ✅ **Recommended** |
| **D. Re-evaluate after voice/mobile work** | N/A | Voice (GH#20) and Capacitor mobile (GH#26) may surface gaps where their primitives shine | 📅 Track as follow-up |

## Recommendation

**Do not adopt assistant-ui as a dependency now.** Reasons:

1. Our `ai-elements` package + TanStack DB collection model already solve the same problem, and our streaming/branching protocols are server-authoritative in ways assistant-ui doesn't express naturally.
2. Migration cost is high (streaming semantics, branching state, gate UX all need bridging).
3. The biggest win (opencode-style event shaping) can be extracted without taking the dependency.

**Action items (low-cost):**

- [ ] **Clone `assistant-ui/assistant-ui` locally**, read `packages/react-opencode/` — document the event→`MessagePart` mapping in a follow-up research note; compare with our `gateway-event-mapper.ts`.
- [ ] **Accessibility audit** of `packages/ai-elements` using assistant-ui's Thread primitive as reference spec (keyboard nav, focus trap on modals, ARIA roles on message list).
- [ ] **Auto-scroll review** — compare our `Conversation` viewport (`conversation.tsx`) against `ThreadPrimitive.Viewport` anchor-preservation logic; port improvements if any.
- [ ] **Re-evaluate at voice (GH#20)** — if `ComposerPrimitive` + their dictation story saves meaningful effort vs. building from scratch, reconsider selective adoption behind the composer only.

## Addendum: Tool-Call UI Comparison (Follow-up)

The question "aren't their tool components more mature than ai-elements?" is correct — on **five** specific dimensions. But the gap is in *primitives*, not *per-tool renderers*. `@assistant-ui/react-opencode` ships a projection layer only (events → `MessagePart`); per-tool UIs are consumer-registered.

### Side-by-side

| Dimension | ai-elements (today) | assistant-ui |
|---|---|---|
| **Per-tool UI registry** | None. `ChatThread.tsx` renders one generic `<Tool>` for every tool; branching on tool name happens ad-hoc | First-class. `makeAssistantToolUI({ toolName, render })` registers a `ToolCallMessagePartComponent` per tool name via `aui.tools().setToolUI()`. Fallback to default if unregistered. (`packages/core/src/react/model-context/makeAssistantToolUI.ts`, `useAssistantToolUI.ts`) |
| **Streaming tool args** | Waits for full JSON. `ToolInput` does `JSON.stringify(input, null, 2)` on complete input (`tool.tsx:117`). Separate `input-streaming` state exists but renders pending UI, not the partial args | `ToolCallMessagePart` has both `args: TArgs` **and** `argsText: string` — the partial-JSON buffer that updates per delta, so a Bash renderer can show `bash -c "npm "` mid-stream (`packages/core/src/types/message.ts:56–71`) |
| **Status model** | 7 ad-hoc string states mixing input/output/approval: `'input-streaming'`, `'input-available'`, `'output-available'`, `'output-denied'`, `'output-error'`, `'approval-requested'`, `'approval-responded'` (`tool.tsx`) | Clean 4-state discriminated union: `ToolCallMessagePartStatus = { type: 'running' } \| { type: 'requires-action', reason: 'interrupt' } \| { type: 'complete' } \| { type: 'incomplete', reason: 'cancelled'\|'length'\|… }` (`message.ts:89–112`) |
| **Approval / HITL flow** | App-wired. `<Confirmation>` renders the UI shell (Request / Accepted / Rejected / Actions). Approve/deny logic lives in app (`GateResolver` → `resolveGate` RPC) | Baked into the part object. The tool renderer receives `addResult(result: TResult \| ToolResponse<TResult>)` and `resume(payload: unknown)` callbacks wired to the runtime. `interrupt?: { type: 'human', payload }` field models the pause point (`MessagePartComponentTypes.ts:55–67`) |
| **Artifact slot** | No dedicated field; tool-specific state piggybacks on `output` | `ToolCallMessagePart.artifact?: unknown` — first-class place to stash rehydrate-stable rich state (diff tree, terminal buffer, generated image). Survives snapshot replay by design |
| **Step nesting** | None | `parentId?: string` lets tool calls nest under step-start / step-finish boundaries — directly maps to Claude Code's multi-step plan → tool sequences |
| **Ships ready-made Read/Bash/Edit viewers?** | No — single generic `<Tool>` | No — `react-opencode` is a projection layer only; consumer writes each `makeAssistantToolUI({ toolName: 'read', render: <ReadViewer /> })` |

### What this changes

The tool-primitive gap is real and worth closing — **independent** of whether we adopt the library. The five items above are extractable patterns we could port into `packages/ai-elements/`:

1. **`ToolUIRegistry`** — a React context + `registerToolUI(name, component)` helper so `ChatThread.tsx` can render `<FileEditDiff>` for `Edit` tool-calls, `<TerminalView>` for `Bash`, etc., with a generic fallback. Replaces the ad-hoc switch that doesn't exist today.
2. **Add `argsText` to `CachedMessage` tool parts.** Mirror `assistant-stream`'s partial-JSON buffer. Our `gateway-event-mapper.partialAssistantToParts` already handles streaming text — extend to tool input deltas. Unlocks live-typing Bash commands / Edit filenames.
3. **Collapse the status model** to the 4-state union. The current 7-string ad-hoc set is brittle (the mapping in `statusLabels` / `statusIcons` is duplicated across `tool.tsx` / `confirmation.tsx` / `tool-call-list.tsx`).
4. **`addResult` / `resume` closure on tool-call parts.** The `GateResolver` → `resolveGate` RPC can be wrapped in a callback attached to the part itself, so renderers don't need to import the connection object.
5. **`artifact` field** for rich tool-specific state (we'd use it for FileEdit diffs, terminal ANSI buffers, generated artifacts — all things we currently stuff into `output` or lose on snapshot replay).
6. **`parentId` for step nesting** — groundwork for the step-folding UI we don't have yet.

### Revised recommendation

Original recommendation (don't adopt wholesale) stands. But elevate one follow-up:

- [ ] **New spec issue: "Tool-UI primitive upgrade in ai-elements"** — port the `ToolUIRegistry` + `argsText` + clean status model + `artifact` + `addResult/resume` closure patterns from assistant-ui into our existing `tool.tsx` / `tool-call-list.tsx` / `gateway-event-mapper.ts`. Low risk (additive to ai-elements), high leverage (unlocks per-tool viewers for Read / Edit / Bash / Write), and avoids the streaming/branching migration cost that killed wholesale adoption.

### Additional sources (addendum)

- `/tmp/assistant-ui-probe/packages/core/src/react/model-context/makeAssistantToolUI.ts` (11-line factory)
- `/tmp/assistant-ui-probe/packages/core/src/react/model-context/useAssistantToolUI.ts` (toolName→render hook)
- `/tmp/assistant-ui-probe/packages/core/src/react/types/MessagePartComponentTypes.ts:55–67` (`ToolCallMessagePartProps` with `addResult`, `resume`)
- `/tmp/assistant-ui-probe/packages/core/src/types/message.ts:56–112` (`ToolCallMessagePart` + status union)
- `/tmp/assistant-ui-probe/packages/react-opencode/src/openCodeMessageProjection.ts:233–248` (event→tool-call mapping — confirms no per-tool renderers shipped)

## Sources Cited

- github.com/assistant-ui/assistant-ui (repo metadata via `gh-axi api repos/assistant-ui/assistant-ui`)
- github.com/assistant-ui/assistant-ui/tree/main/packages (folder listing)
- www.assistant-ui.com/docs/runtimes/custom/external-store (ExternalStoreAdapter API)
- Duraclaw files:
  - `packages/shared-types/src/index.ts:646–658` (SessionMessage)
  - `apps/orchestrator/src/db/messages-collection.ts:32–45` (CachedMessage)
  - `apps/orchestrator/src/agents/gateway-event-mapper.ts:35–46,118–137` (streaming mapper)
  - `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:201–291` (WS frame handler)
  - `apps/orchestrator/src/db/branch-info-collection.ts` + `hooks/use-branch-info.ts:24–46` (branch model)
  - `apps/orchestrator/src/features/agent-orch/ChatThread.tsx:1–200` (main chat surface)
  - `packages/ai-elements/src/index.ts` (component exports)
  - `packages/ai-elements/package.json` (deps)
