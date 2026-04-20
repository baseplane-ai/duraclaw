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
