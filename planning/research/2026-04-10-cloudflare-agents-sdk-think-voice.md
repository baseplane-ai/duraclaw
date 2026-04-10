---
date: 2026-04-10
topic: Cloudflare Agents SDK — Think, Voice, and Prebuilt Agent Patterns
status: complete
github_issue: null
---

# Research: Cloudflare Agents SDK — Think, Voice, AIChatAgent

## Context

Evaluating Cloudflare's agent SDK hierarchy to understand what prebuilt patterns exist and whether duraclaw's SessionAgent or baseplane's CodingAgent should extend a higher-level class.

## SDK Hierarchy

```
Agent (base, agents@0.10.0)          — state, RPC, WebSocket, SQL, scheduling, fibers
  │
  AIChatAgent (@cloudflare/ai-chat@0.4.0) — + message persistence, resumable streams, tool support
  │
  Think (@cloudflare/think@0.2.0)         — + session trees, branching, FTS5, workspace, sub-agents

  withVoice (@cloudflare/voice@0.0.5)     — mixin: STT/TTS/VAD pipeline over WebRTC
  withVoiceInput                          — mixin: STT-only
```

## @cloudflare/think (v0.2.0)

Full-featured agent class sitting above AIChatAgent. Handles agentic loop, streaming, persistence, client tools, and stream resumption — all DO SQLite-backed.

### Key capabilities

| Feature | Description |
|---------|-------------|
| **Tree-structured history** | Non-destructive regeneration via branching — fork a conversation instead of overwriting |
| **FTS5 search** | Full-text search over conversation history |
| **Context blocks** | Composable, dynamically loadable/unloadable system prompt segments |
| **Workspace** | Virtual filesystem in DO SQLite with built-in file tools (read, write, edit, list, find, grep, delete) + R2 spillover |
| **Sub-agent RPC** | `this.subAgent(MyAgent, "thread-id")` for streaming parent→child agent calls |
| **Compaction** | Built in |
| **PII redaction** | `sanitizeMessageForPersistence()` hook |
| **continueLastTurn()** | Extend previous response |

### Required overrides

- `getModel()` — return AI SDK model instance
- `getSystemPrompt()` — return system prompt string
- `getTools()` — return tool definitions

### Lifecycle hooks

`beforeTurn()`, `beforeToolCall()`, `afterToolCall()`, `onChunk()`, `onChatResponse()`, `configureSession()`

### Peer deps

`agents` SDK, Vercel AI SDK v6, zod 3.25+, `@cloudflare/shell`. Optional: `@cloudflare/codemode` for sandboxed JS execution.

### Relevance

Think assumes the DO **runs inference directly**. Duraclaw's SessionAgent is a **relay** to VPS. Think's tree history, FTS5, and sub-agent RPC are valuable patterns, but the class isn't usable as-is for a proxy agent.

If duraclaw ever runs lightweight inference in the DO (e.g., summarization, routing decisions), Think becomes relevant. For now, the patterns to steal are:
- Tree history for session fork/rewind
- FTS5 for session search (roadmap Phase 3.3)
- Sub-agent RPC for multi-agent orchestration (roadmap Phase 10.5)

## @cloudflare/voice (v0.0.5, experimental)

Voice pipeline for Cloudflare Agents.

### Architecture

- **WebRTC** audio from client → nearest CF edge (Opus codec, echo cancellation)
- **Pipeline:** STT → LLM → TTS with interruption detection and turn-taking

### Built-in Workers AI providers (no API keys)

| Type | Model |
|------|-------|
| STT (batch) | `@cf/deepgram/nova-3` |
| STT (streaming) | `@cf/deepgram/nova-3` via WebSocket |
| TTS | `@cf/deepgram/aura-1` |
| VAD | `@cf/pipecat-ai/smart-turn-v2` |

### Third-party providers

- `@cloudflare/voice-deepgram` (alternative streaming STT)
- `@cloudflare/voice-elevenlabs` (premium TTS)
- `@cloudflare/voice-twilio` (telephony)

### API

**Server mixins:**
- `withVoice` — full voice agent: buffering, VAD, STT, LLM, TTS streaming, interruption. Override `onTurn(transcript, context)`.
- `withVoiceInput` — STT-only (dictation/transcription)

**Client:**
- `useVoiceAgent` React hook (status, transcripts, audio metrics, mute, startCall/endCall)
- `useVoiceInput` for STT-only
- `VoiceClient` vanilla JS for framework-agnostic use

**Hooks:** `onCallStart`, `onCallEnd`, `onInterrupt`, `beforeTranscribe`, `afterTranscribe`, `beforeSynthesize`, `afterSynthesize`

### Relevance

Not relevant for coding agents. Relevant if baseplane wants to add voice to ChipAgent — but baseplane currently uses Gemini Live API directly, not CF voice.

## @cloudflare/ai-chat / AIChatAgent (v0.4.0)

Mid-tier chat agent. Extends base Agent, adds persistent chat with streaming.

### What it provides over base Agent

| Feature | Description |
|---------|-------------|
| **Auto message persistence** | Messages stored in DO SQLite automatically |
| **Resumable streaming** | Chunks buffer during disconnect, replay on reconnect |
| **Multi-client broadcast** | All connected WebSocket clients get updates |
| **Tool support** | Server-side (auto), client-side (browser APIs), human-in-loop approval |
| **Concurrency** | Strategies: queue (default), latest, merge, drop, debounce |
| **Data parts** | Typed JSON alongside text (citations, progress, token usage) |

### Key API

- Override `onChatMessage(onFinish, options)` — return streaming Response
- `this.messages` — current UIMessage[] array
- `saveMessages()` — explicit persist
- `maxPersistedMessages` — cap storage
- Client: `useAgentChat` React hook

### v0.4.0 changes

- Renamed `durableStreaming` to `unstable_chatRecovery`
- All 4 chat turn paths wrapped in `runFiber` when enabled
- Fixed abort controller leaks

### Relevance

**This is the sweet spot for duraclaw's SessionAgent.** If SessionAgent extended AIChatAgent:
- Message persistence → free (delete custom storedToUIMessages + manual SQL)
- Resumable streaming → free (delete WsChatTransport reconnect logic)
- Multi-client broadcast → free (delete custom broadcast code)
- Tool approval → built in (delete custom tool-approval HTTP endpoints)
- Client: `useAgentChat` replaces `useChat` + custom `WsChatTransport`

**The catch:** AIChatAgent assumes it runs inference via `onChatMessage()` returning `streamText().toUIMessageStreamResponse()`. SessionAgent is a relay — it proxies to the VPS gateway. The `onChatMessage()` override would need to open a WS to the gateway and pipe GatewayEvents back as UIMessageChunks. This is doable but non-trivial.

## Base Agent (agents@0.10.0) — New Features

### Durable fibers (v0.10.0)

```typescript
await this.runFiber('session-relay', async () => {
  // Long-running work that survives DO eviction
  await this.stash({ checkpoint: 'connected' })
  // ... relay gateway events
})
```

Recovery via `onFiberRecovered(ctx)`. This is directly useful for gateway relay — if the DO hibernates mid-session, the fiber resumes.

### Scheduling improvements

- `schedule(delaySeconds, callback, payload)` — one-time
- `scheduleEvery(intervalSeconds, callback, payload)` — recurring (idempotent in onStart)
- `queue(callback, payload)` — immediate background work

### MCP client integration

```typescript
this.mcp.addServer('tools', 'https://mcp.example.com')
const tools = await this.mcp.getTools()
```

Relevant if duraclaw exposes the gateway's capabilities as MCP tools.

## Current Usage

### Baseplane

- **ChipAgent** extends `Agent` (not AIChatAgent — converged onto AIChatAgent *patterns* but imports base class)
- **CodingAgent** extends `Agent` — pure relay, doesn't run inference
- Neither uses Think or Voice packages
- Voice handled via Gemini Live API directly

### Duraclaw

- **SessionAgent** extends `Agent<Env, SessionState>`
- Custom message persistence (manual SQL)
- Custom WsChatTransport for AI SDK integration
- Custom broadcast logic
- Scheduled reconnection via Agent's alarm system

## Recommendations

### For duraclaw's SessionAgent

1. **Stay on base Agent for now.** AIChatAgent migration is valuable but not urgent — it requires reworking the gateway relay into `onChatMessage()` return shape. Do this when building Phase 1-2 UI, not before.

2. **Use durable fibers for gateway relay.** `runFiber('gateway-session', ...)` gives free crash recovery for the VPS WebSocket connection. This replaces the custom `reconnectVps` scheduling.

3. **Steal Think's patterns without extending Think:**
   - Tree history → implement in DO SQLite for session fork/rewind
   - FTS5 → add when building session search (Phase 3.3)
   - Sub-agent RPC → consider for multi-agent orchestration (Phase 10.5)

### For baseplane's CodingAgent

4. **Consider AIChatAgent migration.** CodingAgent already has message persistence and broadcast — AIChatAgent would simplify that code. The `onChatMessage()` override proxies to cc-gateway the same way SessionAgent would.

5. **Voice via CF SDK vs Gemini Live.** ChipAgent currently uses Gemini Live directly. `@cloudflare/voice` is v0.0.5 (experimental) but provides edge-located WebRTC + built-in STT/TTS without API keys. Worth a spike when voice is next on baseplane's roadmap.

### For the "drop-in" question

6. **Both DOs should converge on AIChatAgent.** If both SessionAgent and CodingAgent extend AIChatAgent:
   - Same message format (UIMessage)
   - Same client hook (useAgentChat)
   - Same tool approval pattern
   - The UI components become truly portable between repos
