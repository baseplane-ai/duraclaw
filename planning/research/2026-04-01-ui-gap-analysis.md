---
date: 2026-04-01
topic: UI gap analysis and SDK underutilization audit
status: complete
github_issue: null
---

# Research: UI Gap Analysis & SDK Convergence

## Context

Deep audit of the Duraclaw orchestrator UI to identify every missing feature,
responsiveness gap, and SDK underutilization. The goal is to build a prioritized
roadmap and identify quick wins from properly leveraging the SDKs we already depend on.

## Questions Explored

1. What mobile/responsive gaps exist?
2. What chat input features are missing (slash commands, file attachments, etc.)?
3. What message rendering capabilities are absent (markdown, syntax highlighting)?
4. What session management features are needed (history, search, export)?
5. How much of Vercel AI SDK are we actually using?
6. How much of CF Agents SDK are we actually using?
7. What backend capabilities exist but aren't exposed in the UI?

---

## Findings

### 1. Mobile Responsiveness

| Gap | Detail |
|-----|--------|
| Sidebar doesn't collapse on mobile | Fixed `w-70` (280px), no `lg:hidden` or drawer pattern |
| No mobile nav | No hamburger menu, bottom nav, or swipe gestures |
| Chat input not mobile-optimized | No safe-area-inset, keyboard pushes content up |
| Touch targets too small | Buttons/badges use `text-xs`/`text-sm` without min 44px tap targets |
| No viewport height fix | Uses `h-screen` which breaks on mobile Safari (100vh issue) |
| Login page uses inline styles | Completely non-responsive |
| No `md:` breakpoint usage | Only `sm:` and `lg:` used, gap in tablet range |

**Needs:** Mobile-first sidebar drawer, `dvh` units, responsive text scaling, touch-friendly spacing, bottom sheet for tool approvals.

### 2. Chat Input Features

| Gap | Detail |
|-----|--------|
| No slash commands | Plain textarea only, no `/model`, `/abort`, `/clear` etc. |
| No file attachments | Can't drag-drop or browse files into prompt |
| No command palette | No `Cmd+K` or similar quick-action UI |
| No input history | Can't arrow-up to recall previous prompts |
| No auto-resize | Textarea is fixed `min-h-[80px]`, doesn't grow with content |
| No multi-line shortcut hint | Users don't know Ctrl+Enter sends |
| No @ mentions | Can't reference files/tools inline |
| Enter vs Shift+Enter | Currently only Ctrl/Cmd+Enter sends — should support Enter to send |

### 3. Message Rendering

| Gap | Detail |
|-----|--------|
| No markdown rendering | Messages shown as `whitespace-pre-wrap` plain text |
| No syntax highlighting | Code blocks are raw `<pre>` tags |
| No image rendering | Images in responses not displayed |
| No link detection | URLs not clickable |
| No copy button | Can't copy code blocks or messages |
| No diff view | File edits shown as raw JSON, not visual diffs |
| Tool results are raw JSON | `<pre>` with JSON dump, not formatted |
| No reasoning/thinking blocks | Claude's extended thinking not surfaced |

### 4. Session History & Management

| Gap | Detail |
|-----|--------|
| No full history view | No dedicated page to browse all past sessions |
| No session search | Can't search across session messages |
| No session delete | No way to remove sessions from UI |
| No session rename/tag | Only auto-generated summary, no user labels |
| No session export | Can't download conversation as markdown/JSON |
| No pagination | All messages loaded at once (scalability issue) |
| No session forking | Can't branch from a point in conversation |
| No session sharing | No shareable links |
| Sidebar finished sessions | Grouped but no date grouping (today/yesterday/last week) |

### 5. Backend Capabilities Not Exposed in UI

| Backend Feature | Protocol Support | UI Status |
|-----------------|-----------------|-----------|
| System prompt override | `ExecuteCommand.system_prompt` | Not in new session dialog |
| Tool whitelisting | `ExecuteCommand.allowed_tools` | Not in UI |
| Turn limit | `ExecuteCommand.max_turns` | Not in UI |
| Budget limit | `ExecuteCommand.max_budget_usd` | Not in UI |
| Project file browser | `GET /projects/{name}/files` | API exists, not in UI |
| Git status per file | `GET /projects/{name}/git-status` | API exists, not shown |
| File change events | `FileChangedEvent` streamed | Not displayed in chat |
| Session resume | `ResumeCommand` fully supported | UI just shows "idle" |
| SDK summary | Stored in `SessionState.summary` | Not prominently shown |
| Cost/duration tracking | In header during session | Not in history view |

### 6. Real-Time & Connection

| Gap | Detail |
|-----|--------|
| No auto-reconnect | Browser WS transport has no retry logic |
| No offline indicator | Only a red banner, no retry button |
| No optimistic updates | Messages appear only after server confirms |
| Polling every 3-5s | State polling wastes bandwidth; should use WS events |
| No typing indicator | No visual cue while Claude is "thinking" before streaming |
| No progress for long tools | Tool blocks just show "running..." with no progress |

### 7. Settings & Configuration

| Gap | Detail |
|-----|--------|
| No user settings page | Can't configure default model, theme, etc. |
| No per-session settings | Can't adjust system prompt, tools, limits mid-session |
| No notification preferences | No sound/desktop notifications when session needs input |
| No keyboard shortcut config | Fixed keybindings |
| No theme toggle | Hardcoded dark, no light mode |

### 8. Accessibility

| Gap | Detail |
|-----|--------|
| No ARIA labels | Custom components lack accessibility attrs |
| No focus trapping | Dialogs don't trap focus |
| Color-only status | Status dots rely solely on color |
| No keyboard nav | Can't navigate messages/tools with keyboard |
| No screen reader support | Live regions not used for streaming |
| No reduced motion | Animations play regardless of user preference |

### 9. Polish & UX

| Gap | Detail |
|-----|--------|
| No toast notifications | Errors shown inline only |
| No loading spinners | Only skeleton loaders |
| No empty states | Blank screens when no sessions/messages |
| No onboarding | No first-run guidance |
| No error boundaries | Component crashes show blank screen |
| Duplicated NewSessionDialog | Exists in both dashboard.tsx and project-sidebar.tsx |
| No favicon/PWA manifest | Basic browser tab only |
| No virtual scrolling | All messages rendered (DOM perf issue at scale) |

---

## SDK Underutilization

### Vercel AI SDK — `ai@6.0.142` + `@ai-sdk/react@3.0.144`

**Status: In package.json but ZERO imports anywhere in the codebase.**

Everything in chat-view.tsx is hand-rolled. The AI SDK provides all of this for free:

| Hand-built (~400 lines) | AI SDK equivalent |
|---|---|
| `DisplayMessage` (1 flat type) | `UIMessage` with 8+ part types (text, reasoning, file, tool, data, sources) |
| `ToolCallBlock` with 2 states (running/completed) | `UIToolInvocation` with 7-state FSM: input-streaming → input-available → approval-requested → approval-responded → output-available / output-error / output-denied |
| Manual `useState` for messages, streaming, tools, permissions | `useChat()` hook manages all state |
| Custom `UIStreamChunk` protocol (hand-rolled, ~15 types) | `UIMessageChunk` with 23+ typed chunks + Zod validation |
| No file support | `FileUIPart` + `convertFileListToFileUIParts()` |
| No reasoning/thinking blocks | `ReasoningUIPart` with streaming state |
| No source citations | `SourceUrlUIPart`, `SourceDocumentUIPart` |
| ~300 lines of chunk parsing in chat-view.tsx | `processUIMessageStream` auto-aggregates |
| Manual permission prompt | `approval-requested` state + `addToolApprovalResponse()` |
| No data parts | `DataUIPart<CustomType>` + schema validation |

**Key insight:** AI SDK provides a `ChatTransport` interface. We implement it over our
WebSocket, and `useChat()` handles everything client-side. The transport interface:

```typescript
interface ChatTransport<UI_MESSAGE extends UIMessage> {
  sendMessages(messages: UI_MESSAGE[], options?: any): Promise<ReadableStream<UIMessageChunk>>;
  reconnect(request: PrepareReconnectToStreamRequest): Promise<ReadableStream<UIMessageChunk>>;
}
```

We don't need HTTP — we make our WS emit `UIMessageChunk` format, wrap it in a
ReadableStream, and `useChat()` handles message aggregation, tool states, streaming,
and all UI state management.

### CF Agents SDK — `agents@0.7`

**Status: Using ~20% of capabilities.**

What we use:
- `Agent` base class with generics (`Agent<Env, SessionState>`)
- `this.setState()` / `this.state` for state management
- `this.getConnections()` / `Connection` for client broadcast
- `onStart()`, `onConnect()`, `onMessage()`, `onRequest()` lifecycle hooks
- `this.sql` for SQLite queries
- `this.schedule()` for one reconnection task

What we ignore:

| Manual approach | Agents SDK provides |
|---|---|
| Poll session state every 3s via `fetch` | `useAgent()` React hook — automatic real-time state sync |
| No WS auto-reconnect on client | Built-in connection management with reconnect |
| `ProjectRegistry extends DurableObject` (raw) | Could extend `Agent` for state sync |
| Manual `broadcastToClients()` iteration | SDK handles connection broadcasting |
| No scheduled alarms or cron | `schedule()` available but only used once |

**Key insight:** `useAgent()` gives us real-time `SessionState` sync on the client.
Kill the 3-second polling. ProjectRegistry could also extend Agent so the sidebar
gets real-time session list updates without polling.

---

## Recommendations

### Convergence Strategy

**Layer 1: AI SDK for chat protocol + client state**
- SessionDO emits `UIMessageChunk` instead of custom `UIStreamChunk`
- Implement `ChatTransport` over existing WebSocket
- Replace all manual useState in chat-view.tsx with `useChat()`
- Gain: tool state machine, file parts, reasoning blocks, streaming aggregation

**Layer 2: Agents SDK for real-time state sync**
- Use `useAgent()` on client for SessionState — kill 3s polling
- Convert ProjectRegistry to extend Agent for sidebar sync
- Gain: auto-reconnect, real-time updates, less bandwidth

**Layer 3: Build features on the new foundation**
- File attachments via `FileUIPart` + gateway upload endpoint
- Tool approvals via SDK's approval state machine
- Markdown rendering on `TextUIPart.text`
- Slash commands intercepted in `ChatTransport.sendMessages()`

### What Gets Eliminated

- `ws-transport.ts` — replaced by `ChatTransport` implementation (~110 lines)
- ~300 lines of chunk parsing in chat-view.tsx
- All manual `useState` for messages/streaming/tools/permissions
- Custom `UIStreamChunk` / `BrowserCommand` types
- The 3-second polling interval
- Manual `broadcastToClients()` helper

### What Stays

- SessionDO as server-side relay (still needed for DO persistence + gateway WS)
- Gateway protocol (`GatewayEvent`/`GatewayCommand`) — SDK-to-VPS, unrelated
- SQLite message storage in DO (persistence layer)
- Custom tool result rendering (SDK gives data, we render)

---

## Priority Implementation Order

### Phase 1 — SDK Convergence (Foundation)
1. SessionDO emits `UIMessageChunk` protocol
2. Implement `ChatTransport` over WebSocket
3. Replace chat-view.tsx with `useChat()`
4. Adopt `useAgent()` for real-time state sync
5. Convert ProjectRegistry to extend Agent

### Phase 2 — Core Chat Quality
6. Markdown rendering + syntax highlighting
7. Auto-growing textarea + Enter to send
8. Copy button on code blocks
9. Structured tool result display
10. File change events shown inline
11. Reasoning/thinking block rendering

### Phase 3 — Mobile & Responsive
12. Sidebar → mobile drawer with hamburger
13. `dvh` units, safe-area-inset
14. Touch-optimized spacing
15. Bottom sheet for permissions/questions
16. Responsive breakpoints throughout

### Phase 4 — Chat Features
17. Slash command system
18. File attachment/drag-drop
19. Input history (arrow-up recall)
20. Auto-reconnect with exponential backoff

### Phase 5 — Session Management
21. Full history page with search/filter
22. Session delete/rename/tag
23. Date-grouped sidebar sections
24. Session export (markdown)
25. Expose budget/turn limits in new session dialog

### Phase 6 — Polish
26. Toast notification system
27. Empty states & onboarding
28. Accessibility pass (ARIA, focus, keyboard)
29. Error boundaries
30. Settings page (default model, theme toggle)

---

## Open Questions

- Should we keep SQLite message storage in SessionDO alongside AI SDK message state, or let the SDK be the sole source of truth?
- Does `ChatTransport` support bidirectional streams (for tool approvals mid-stream), or do we need a parallel channel?
- Can `useAgent()` and `useChat()` coexist on the same WS connection, or do they need separate connections?
- What's the migration path for existing sessions stored in the old `UIStreamChunk` format?

## Next Steps

Create implementation spec for Phase 1 (SDK Convergence) — this is the foundation everything else builds on.
