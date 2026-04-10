---
date: 2026-04-10
topic: Cloudflare Agents SDK — Think, Voice, AIChatAgent for SessionAgent
status: complete
github_issue: null
---

# Research: Cloudflare Agents SDK for Duraclaw's SessionAgent

## Context

Duraclaw's SessionAgent extends base `Agent` and relays to the VPS cc-gateway. Evaluating what the higher-level SDK classes offer for this relay pattern, and whether voice input can serve as an interaction channel.

## SDK Hierarchy

```
Agent (base, agents@0.10.0)               — state, RPC, WebSocket, SQL, scheduling, fibers
  │
  AIChatAgent (@cloudflare/ai-chat@0.4.0) — + message persistence, resumable streams, tool support
  │
  Think (@cloudflare/think@0.2.0)         — + session trees, branching, FTS5, workspace, sub-agents

  withVoiceInput (@cloudflare/voice@0.0.5) — mixin: STT over WebRTC (input channel)
```

---

## What SessionAgent Does Today (base Agent)

- Extends `Agent<Env, SessionState>`
- Manual message persistence (custom SQL inserts, `storedToUIMessages` converter)
- Manual broadcast to WebSocket clients
- Custom `WsChatTransport` bridging AI SDK's `useChat` to the DO
- Custom reconnect scheduling (`reconnectVps` via alarm)
- HTTP endpoints for gate resolution (`/tool-approval`, `/answers`)

All of this is hand-rolled code that higher-level SDK classes provide for free.

---

## AIChatAgent — What SessionAgent Would Gain

| Custom code today | AIChatAgent provides |
|---|---|
| Manual SQL message inserts + `storedToUIMessages` converter | Auto message persistence to DO SQLite |
| Custom broadcast to all WS clients | Multi-client broadcast built in |
| `WsChatTransport` reconnect logic | Resumable streaming (buffers chunks during disconnect, replays on reconnect) |
| `/tool-approval` + `/answers` HTTP endpoints | Built-in tool approval pattern (`needsApproval: true`) |
| `useChat` + custom transport on client | `useAgentChat` React hook (drop-in) |
| Manual concurrency handling | Configurable strategies: queue, latest, merge, drop, debounce |

### The relay override

AIChatAgent assumes the DO runs inference via `onChatMessage()` returning `streamText().toUIMessageStreamResponse()`. SessionAgent is a relay. The override would:

1. Open WS to cc-gateway
2. Send `ExecuteCommand` or `ResumeCommand`
3. Pipe `GatewayEvent` stream back as `UIMessageChunk` stream
4. Return the stream as a Response

This is the same relay logic that exists today, just shaped as a Response return instead of manual broadcast. Non-trivial to wire up but eliminates ~300 lines of custom transport/persistence code.

### Client-side impact

`useAgentChat` replaces `useChat` + `WsChatTransport`. The chat view component simplifies significantly — no custom transport initialization, no manual history loading, no stream reconnection logic.

---

## Think — Patterns to Steal (Don't Extend)

Think requires `getModel()`, `getSystemPrompt()`, `getTools()` — assumes DO-side inference. Not usable for relay agents. But the patterns are directly relevant to roadmap features:

| Think pattern | Roadmap feature | How to adopt |
|---|---|---|
| Tree-structured message history | Phase 3.2 Session Rollback/Rewind | Implement branching in DO SQLite — fork at a message instead of truncating |
| FTS5 full-text search | Phase 3.3 Session History Search | Add FTS5 virtual table over messages table |
| Sub-agent RPC (`this.subAgent()`) | Phase 10.5 Agent Orchestration | Use for supervisor→worker agent communication |
| Context blocks | Dynamic system prompts per session | Composable prompt segments loaded/unloaded at runtime |
| Compaction | Phase 3.2b Context Compaction | Summarize + restart pattern already in roadmap |

These can be implemented directly in SessionAgent's DO SQLite without extending Think.

---

## Voice — Input Channel for Session Interaction

`@cloudflare/voice` (v0.0.5, experimental) provides STT/TTS/VAD over WebRTC. The relevant piece for coding agents is `withVoiceInput` — STT-only mixin.

### How it works

1. **Client:** `useVoiceInput` React hook — tap-to-speak button, streams audio via WebRTC
2. **Edge:** Audio hits nearest CF edge, transcribed by Workers AI (`@cf/deepgram/nova-3`) — no API keys needed
3. **DO:** `withVoiceInput` mixin on SessionAgent receives transcribed text
4. **Action:** Transcribed text feeds into existing `sendMessage()` / `resolveGate()` / `submitAnswers()` path

No new backend logic. Voice is just another input modality that produces text.

### Use cases for coding sessions

| Interaction | Voice command | Existing path |
|---|---|---|
| Approve tool | "approve" / "allow" | `resolveGate(gateId, { approved: true })` |
| Deny tool | "deny" | `resolveGate(gateId, { approved: false })` |
| Answer question | dictate answer | `submitAnswers(toolCallId, answers)` |
| Follow-up prompt | speak instruction | `sendMessage(text)` |
| Abort session | "stop" / "abort" | `abort()` |

### Why this matters

The roadmap's north star is "full mobile sessions." Voice input means:
- Approve gates from your phone without typing
- Dictate follow-up prompts while looking at code on another screen
- Hands-free interaction when away from keyboard

### Integration point

```typescript
// SessionAgent with voice input mixin
class SessionAgent extends withVoiceInput(Agent<Env, SessionState>) {
  // existing relay logic unchanged
  
  onTranscript(text: string, connection: Connection) {
    // Route transcribed text to appropriate action
    // based on current session state
    if (this.state.status === 'waiting_permission') {
      if (text.match(/approve|allow|yes/i)) {
        this.resolveGate(this.state.pending_permission.tool_call_id, { approved: true })
      }
    } else {
      this.sendMessage(text)
    }
  }
}
```

Client adds a mic button next to the text input:

```typescript
const { startListening, stopListening, transcript, isListening } = useVoiceInput({ agent })
```

### Caveats

- v0.0.5 — experimental, API may change
- WebRTC requires HTTPS
- STT accuracy for technical terms (function names, file paths) needs testing
- No TTS needed — session output is text/code, read on screen

---

## Base Agent v0.10.0 — Features to Adopt Now

### Durable fibers

```typescript
await this.runFiber('gateway-relay', async () => {
  const ws = connectToGateway()
  await this.stash({ connected: true, session_id })
  for await (const event of ws) {
    this.broadcastEvent(event)
  }
})
```

If DO hibernates mid-session, fiber resumes on wake via `onFiberRecovered()`. Replaces the custom `reconnectVps` alarm scheduling.

### Scheduling

- `schedule(delaySec, callback, payload)` — one-time delayed task
- `scheduleEvery(intervalSec, callback, payload)` — recurring (idempotent in `onStart`)
- `queue(callback, payload)` — immediate background work

### MCP client

```typescript
this.mcp.addServer('gateway', gatewayUrl)
const tools = await this.mcp.getTools()
```

Relevant if the gateway exposes capabilities as MCP tools (future).

---

## Recommendations

### Now

1. **Adopt durable fibers** for the gateway relay. `runFiber()` gives free crash recovery, replacing custom `reconnectVps` scheduling. Low effort, high value.

### When building Phase 1-2 UI

2. **Migrate SessionAgent to AIChatAgent.** This is the right time because you're rewriting the chat UI anyway. The `onChatMessage()` relay override + `useAgentChat` client hook eliminates ~300 lines of custom transport code.

### When building mobile interaction (Phase 1.3 or later)

3. **Add `withVoiceInput` mixin** to SessionAgent. Tap-to-speak for gate approvals and prompts. Test STT accuracy for technical vocabulary first.

### Patterns to implement in DO SQLite (not via Think)

4. **Tree history** for session fork/rewind (Phase 3.2)
5. **FTS5** for session search (Phase 3.3)
6. **Sub-agent RPC pattern** for multi-agent orchestration (Phase 10.5)
