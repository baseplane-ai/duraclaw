# SDK Convergence Spec

**Date:** 2026-04-01
**Prerequisite:** [UI Gap Analysis](../research/2026-04-01-ui-gap-analysis.md)
**Status:** Draft

---

## Problem

The orchestrator UI hand-rolls ~500 lines of chat state management, streaming protocol,
and WebSocket transport that the Vercel AI SDK and CF Agents SDK already provide.
Meanwhile both SDKs are in `package.json` but barely used (AI SDK: 0%, Agents SDK: ~20%).

This creates:
- Maintenance burden on custom protocol types (`UIStreamChunk`, `BrowserCommand`, `DisplayMessage`)
- Missing features that the SDKs give for free (tool state machine, file parts, reasoning blocks, auto-reconnect, real-time state sync)
- Blocked feature work (markdown rendering, file attachments, slash commands) that would be trivial with proper SDK adoption

## Constraints Discovered

Deep-diving the SDK source revealed critical architectural facts:

1. **`ChatTransport` is request-response, not bidirectional.** `sendMessages()` returns a `Promise<ReadableStream>` — one stream per request. There is no persistent server-push channel.

2. **Tool approvals are local-only.** `addToolApprovalResponse()` updates React state but does NOT send anything to the server. The server learns of approvals only when the client re-submits the full conversation.

3. **`useAgent()` uses PartySocket (separate WS).** It cannot share a connection with a custom chat WebSocket. It uses the CF Agent protocol (`CF_AGENT_STATE` frames).

4. **One active stream at a time.** `AbstractChat` clears `activeResponse` when a new request starts. No concurrent streams.

## Design

### Architecture: Two Connections, Two Concerns

```
Browser
├── useAgent(SessionDO)          ← PartySocket WS (auto-reconnect)
│   └── Real-time SessionState sync (status, cost, duration, pending prompts)
│
└── useChat({ transport: WsChatTransport })  ← Chat WS
    └── Message streaming (text, tools, reasoning, files)
        └── Long-lived stream per session turn
```

**Connection 1: Agent State (PartySocket via `useAgent`)**
- Real-time `SessionState` sync — kills the 3-second polling
- Auto-reconnect with exponential backoff (PartySocket built-in)
- Carries: status, cost, duration, pending_question, pending_permission
- Client reads state, sends tool approvals / question answers via `agent.call()`

**Connection 2: Chat Stream (Custom `ChatTransport`)**
- `sendMessages()` opens a ReadableStream over WS that emits `UIMessageChunk`
- Stream stays open for the entire turn (may be long-lived during tool execution)
- Carries: text-delta, tool-input, tool-output, reasoning, file-changed, finish
- `reconnectToStream()` re-attaches to an in-progress turn after disconnect

### Key Insight: Decouple Streaming from Control

Today, our single WS mixes streaming content AND control messages (approvals, answers).
The SDK architecture naturally separates these:

- **Content flows through `ChatTransport`** → `useChat()` manages message state
- **Control flows through `useAgent()`** → real-time state + RPC for approvals/answers

When the user approves a tool or answers a question:
1. Client calls `agent.call('submitToolApproval', { toolCallId, approved })` via PartySocket
2. SessionDO receives the RPC, forwards to gateway
3. Gateway continues execution
4. New chunks flow back through the chat stream
5. `useChat()` updates message state automatically

### SessionDO Changes

SessionDO must speak two protocols on two connection types:

```typescript
export class SessionDO extends Agent<Env, SessionState> {
  // Agent SDK auto-handles PartySocket connections for state sync
  // setState() automatically broadcasts to useAgent() clients

  onConnect(connection: Connection, ctx: ConnectionContext) {
    // Detect connection type from URL or header
    if (ctx.request.url.includes('/chat-stream')) {
      // Chat stream connection — tag it
      connection.setState({ type: 'chat' })
      // Send message history as UIMessageChunk[]
      this.replayHistory(connection)
    }
    // PartySocket connections handled automatically by Agent base class
  }

  onMessage(connection: Connection, data: string) {
    const connState = connection.state as { type?: string }
    if (connState?.type === 'chat') {
      // Chat messages: user-message → forward to gateway
      this.handleChatMessage(connection, JSON.parse(data))
    } else {
      // Agent RPC: tool approvals, question answers
      // Agent base class handles routing
    }
  }

  // When gateway emits events, translate to UIMessageChunk and push to chat connections
  private broadcastChatChunk(chunk: UIMessageChunk) {
    for (const conn of this.getConnections()) {
      if ((conn.state as any)?.type === 'chat') {
        conn.send(JSON.stringify(chunk))
      }
    }
  }

  // State changes broadcast automatically to PartySocket clients via setState()
}
```

### Client-Side Transport

```typescript
// lib/ws-chat-transport.ts
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

export class WsChatTransport implements ChatTransport<UIMessage> {
  private ws: WebSocket | null = null
  private sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  async sendMessages(options: {
    messages: UIMessage[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    // Get the last user message (the new one)
    const lastMessage = options.messages[options.messages.length - 1]

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        // Connect to SessionDO chat stream endpoint
        const url = `${wsUrl}/api/sessions/${this.sessionId}/chat-stream`
        this.ws = new WebSocket(url)

        this.ws.onopen = () => {
          // Send only the new user message
          this.ws!.send(JSON.stringify({
            type: 'user-message',
            content: lastMessage.parts
              .filter(p => p.type === 'text')
              .map(p => p.text)
              .join(''),
          }))
        }

        this.ws.onmessage = (event) => {
          const chunk: UIMessageChunk = JSON.parse(event.data)
          controller.enqueue(chunk)

          // Close stream when turn completes
          if (chunk.type === 'finish') {
            controller.close()
          }
        }

        this.ws.onclose = () => {
          try { controller.close() } catch {}
        }

        this.ws.onerror = (err) => {
          controller.error(err)
        }

        options.abortSignal?.addEventListener('abort', () => {
          this.ws?.close()
        })
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // If SessionDO has an active turn, re-attach to it
    // Return null if no active stream
    return null // TODO: implement reconnection
  }
}
```

### Client-Side Chat View (Simplified)

```tsx
// components/chat-view.tsx — AFTER convergence
import { useChat } from '@ai-sdk/react'
import { useAgent } from 'agents/react'
import { isTextUIPart, isToolUIPart, isReasoningUIPart } from 'ai'
import { WsChatTransport } from '~/lib/ws-chat-transport'

export function ChatView({ sessionId }: { sessionId: string }) {
  // Connection 1: Real-time state sync
  const agent = useAgent<SessionState>({
    agent: 'session-do',
    name: sessionId,
  })

  // Connection 2: Chat message streaming
  const { messages, sendMessage, status } = useChat({
    id: sessionId,
    transport: useMemo(() => new WsChatTransport(sessionId), [sessionId]),
  })

  // Tool approval handler — goes through agent RPC, not chat stream
  const handleToolApproval = async (toolCallId: string, approved: boolean) => {
    await agent.call('submitToolApproval', { toolCallId, approved })
  }

  const handleQuestionAnswer = async (toolCallId: string, answers: Record<string, string>) => {
    await agent.call('submitAnswers', { toolCallId, answers })
  }

  return (
    <div className="flex h-dvh flex-col">
      <SessionHeader state={agent.state} />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg}>
            {msg.parts.map((part, i) => {
              if (isTextUIPart(part)) return <MarkdownRenderer key={i} text={part.text} />
              if (isReasoningUIPart(part)) return <ThinkingBlock key={i} text={part.text} />
              if (isToolUIPart(part)) return (
                <ToolBlock
                  key={i}
                  part={part}
                  onApprove={(id) => handleToolApproval(id, true)}
                  onDeny={(id) => handleToolApproval(id, false)}
                />
              )
              return null
            })}
          </MessageBubble>
        ))}
      </div>

      {/* Pending question from agent state */}
      {agent.state?.pending_question && (
        <QuestionPrompt
          questions={agent.state.pending_question}
          onSubmit={handleQuestionAnswer}
        />
      )}

      <PromptInput
        onSend={(text) => sendMessage({ content: text })}
        disabled={status === 'streaming' || status === 'submitted'}
      />
    </div>
  )
}
```

### Gateway Event → UIMessageChunk Translation

SessionDO translates `GatewayEvent` to `UIMessageChunk`. This is the only translation layer:

```typescript
// In session-do.ts
function gatewayEventToChunks(event: GatewayEvent): UIMessageChunk[] {
  switch (event.type) {
    case 'partial_assistant':
      return event.content.flatMap(block => {
        if (block.type === 'text')
          return [
            { type: 'text-start' as const },
            { type: 'text-delta' as const, textDelta: block.delta },
          ]
        if (block.type === 'tool_use')
          return [
            { type: 'tool-input-start' as const, toolCallId: block.id, toolName: block.tool_name },
            { type: 'tool-input-delta' as const, toolCallId: block.id, inputTextDelta: block.input_delta },
          ]
        return []
      })

    case 'assistant':
      // Full message — emit text-end for any open text parts
      return [{ type: 'text-end' as const }]

    case 'tool_result':
      return [{
        type: 'tool-output-available' as const,
        toolCallId: event.uuid,
        output: event.content,
      }]

    case 'permission_request':
      return [{
        type: 'tool-approval-request' as const,
        approvalId: event.tool_call_id,
        toolCallId: event.tool_call_id,
      }]

    case 'ask_user':
      // Questions go through agent state, not chat stream
      // setState updates pending_question → useAgent syncs automatically
      return []

    case 'file_changed':
      // Custom data part for file changes
      return [{
        type: 'data-file-changed' as const,
        id: `fc-${Date.now()}`,
        data: { path: event.path, tool: event.tool, timestamp: event.timestamp },
      }]

    case 'result':
      return [{ type: 'finish' as const, finishReason: event.is_error ? 'error' : 'stop' }]

    case 'error':
      return [{ type: 'error' as const, errorText: event.error }]

    default:
      return []
  }
}
```

---

## Implementation Phases

### Phase 1: Agent State Sync (Kill Polling)

**Files changed:**
- `apps/orchestrator/src/agents/session-do.ts` — tag connections by type
- `apps/orchestrator/src/lib/components/chat-view.tsx` — add `useAgent()`, remove `setInterval` polling
- `apps/orchestrator/src/routes/__root.tsx` — add `useAgent()` for ProjectRegistry sidebar sync

**What changes:**
- SessionDO tags PartySocket connections vs chat connections
- `useAgent()` replaces the 3-second `fetch('/api/sessions/$id')` poll
- `SessionHeader` reads from `agent.state` instead of polled state
- Sidebar uses `useAgent()` on ProjectRegistry for real-time session list

**What stays the same:**
- Chat streaming still uses existing custom WS transport (temporarily)
- All message rendering unchanged
- Gateway protocol unchanged

**Risk:** Low. Additive change, existing WS still works.

### Phase 2: Chat Stream Protocol (UIMessageChunk)

**Files changed:**
- `apps/orchestrator/src/agents/session-do.ts` — `gatewayEventToChunks()` translation
- `packages/shared-types/src/index.ts` — add `UIMessageChunk` re-exports
- `apps/orchestrator/src/lib/ws-chat-transport.ts` — NEW, implements `ChatTransport`

**What changes:**
- SessionDO emits `UIMessageChunk` to chat connections instead of custom `UIStreamChunk`
- New `WsChatTransport` class wraps WS in `ReadableStream<UIMessageChunk>`
- Tool approvals route through agent RPC, not chat WS

**What stays the same:**
- Gateway protocol (`GatewayEvent`/`GatewayCommand`) — no changes to cc-gateway
- SQLite message storage format — SessionDO still stores messages
- Chat-view.tsx — still renders manually (Phase 3 replaces this)

**Risk:** Medium. Protocol change requires careful testing of all event types.

### Phase 3: useChat() Adoption (Replace Manual State)

**Files changed:**
- `apps/orchestrator/src/lib/components/chat-view.tsx` — major rewrite
- `apps/orchestrator/src/lib/ws-transport.ts` — DELETE (replaced by ws-chat-transport.ts)

**What changes:**
- `useChat()` replaces all manual `useState` for messages, streaming, tools
- Message rendering switches to `UIMessage.parts` iteration
- Tool approval UI reads from `ToolUIPart.state` (7-state FSM)
- Permission prompts driven by tool part state, not separate state variable
- Question prompts driven by `agent.state.pending_question`

**What gets deleted:**
- `ws-transport.ts` (~110 lines)
- `DisplayMessage` type
- All manual chunk parsing in chat-view.tsx (~300 lines)
- `streamingText`, `streamingTools`, `pendingPermission`, `pendingQuestion` state variables

**Risk:** High. Major rewrite of the primary UI component. Needs thorough testing.

### Phase 4: Rich Message Rendering

**Files added:**
- `apps/orchestrator/src/lib/components/message-parts/text-part.tsx` — markdown + syntax highlighting
- `apps/orchestrator/src/lib/components/message-parts/tool-part.tsx` — 7-state tool display
- `apps/orchestrator/src/lib/components/message-parts/reasoning-part.tsx` — collapsible thinking
- `apps/orchestrator/src/lib/components/message-parts/file-part.tsx` — file display + download

**Dependencies to add:**
- `react-markdown` — markdown rendering
- `shiki` or `rehype-pretty-code` — syntax highlighting
- `remark-gfm` — GitHub-flavored markdown tables, strikethrough

**What changes:**
- Text parts render as markdown with syntax-highlighted code blocks
- Tool parts show full state machine (streaming input → approval → output/error/denied)
- Reasoning parts render as collapsible "Thinking..." blocks
- File change data parts show inline file diff indicators
- Copy button on code blocks

---

## Types

### Deleted Types

```typescript
// These custom types get replaced by AI SDK equivalents:
type UIStreamChunk = ...          // → UIMessageChunk (from 'ai')
type BrowserCommand = ...         // → split: user-message via ChatTransport, approvals via agent.call()
type DisplayMessage = ...         // → UIMessage (from 'ai')
```

### New Types

```typescript
// Connection tagging in SessionDO
type ConnectionState = { type: 'chat' } | { type: 'agent' }

// Custom data part for file changes
type FileChangedData = { path: string; tool: string; timestamp: string }

// Agent RPC methods exposed to client
type SessionDORPC = {
  submitToolApproval: (args: { toolCallId: string; approved: boolean }) => void
  submitAnswers: (args: { toolCallId: string; answers: Record<string, string> }) => void
}
```

---

## Migration Path for Existing Sessions

Existing sessions have messages stored in SQLite with the old format (`{ role, type, data }`).
On history replay:

1. SessionDO's `replayHistory()` reads from SQLite
2. Translates old `StoredMessage` format → `UIMessageChunk[]`
3. Emits `start` → message chunks → `finish` for each historical message
4. `useChat()` processes the replay stream like any other stream

No database migration needed. Translation happens at read time.

---

## Open Questions

1. **Agent RPC support:** The memory note says "Agent class doesn't support RPC."
   If `agent.call()` doesn't work, we fall back to sending JSON over the PartySocket
   connection and handling it in `onMessage()` with connection type detection.

2. **Concurrent connections:** Does SessionDO handle both PartySocket and raw WS
   connections simultaneously? Need to verify the Agent base class doesn't reject
   non-PartySocket connections.

3. **History replay as stream:** Can we emit hundreds of `UIMessageChunk` synchronously
   in `onConnect()`, or do we need to batch/throttle for backpressure?

4. **Stream lifetime:** When a session is `waiting_input` or `waiting_permission`,
   should the chat stream stay open (paused) or close and reconnect when execution resumes?
   Recommendation: keep open, emit `tool-approval-request` chunk, wait for server to
   push `tool-output-available` after approval flows through agent RPC.
