---
date: 2026-04-01
topic: Duraclaw product roadmap — full state audit and prioritized plan
status: complete
github_issue: null
---

# Duraclaw Product Roadmap

## Current State — What Actually Exists

### Architecture (Working)
```
Browser (React 19 + TanStack Start RC)
  ↓ PartySocket (state sync) + WebSocket (chat stream)
SessionDO (Durable Object, SQLite messages, full state machine)
  ↓ WebSocket (GatewayCommand/GatewayEvent)
cc-gateway (Bun, Claude Agent SDK v0.2.42)
  ↓ SDK query()
Claude (via Anthropic API)
```

### Codebase Size
- **Orchestrator:** ~1,575 lines across 13 TSX/CSS files (UI) + ~700 lines backend (DOs + routes)
- **cc-gateway:** ~600 lines (server + session handling)
- **shared-types:** ~150 lines (protocol definitions)

---

## Feature Inventory

### What WORKS End-to-End

| Feature | UI | Backend | Gateway | Status |
|---------|-----|---------|---------|--------|
| Create new session | NewSessionDialog | SessionDO.create() | execute command | **DONE** |
| Stream messages | useChat + WsChatTransport | Gateway event relay | partial_assistant | **DONE** |
| Render markdown | react-markdown + remark-gfm | — | — | **DONE** |
| Tool call display | ToolPart (7-state FSM) | Chunk translation | tool_result events | **DONE** |
| Tool approval | Allow/Deny buttons | submitToolApproval RPC | permission-response | **DONE** |
| Question/answer | QuestionPrompt component | submitAnswers RPC | answer command | **DONE** |
| Reasoning blocks | ReasoningPart (collapsible) | Chunk passthrough | — | **DONE** |
| Session state sync | useAgent() real-time | setState() broadcast | — | **DONE** |
| Session list | ProjectSidebar | ProjectRegistry DO | — | **DONE** |
| Project grouping | ProjectFolder (expandable) | listSessionsByProject | — | **DONE** |
| Session abort | Confirm + POST /abort | AbortController | abort command | **DONE** |
| Copy code blocks | Hover copy button | — | — | **DONE** |
| Auth (email/password) | Login page | Better Auth + D1 | — | **DONE** |
| File change detection | — | file_changed broadcast | postToolUse hook | **DONE** (backend only) |
| Session resume | History replay on reconnect | SQLite message replay | resume command | **DONE** |
| Search sessions | Client-side filter | — | — | **DONE** |

### What's PARTIALLY Done

| Feature | What Exists | What's Missing |
|---------|------------|----------------|
| Dashboard page | `dashboard.tsx` (396 lines, tabs, grid) | **Not wired to / route** — index.tsx ignores it |
| Session metrics | Header shows cost/duration/turns | Not in history view, no aggregation |
| Auto-scroll | — | No auto-scroll to newest message |
| Session status display | StatusBadge + StatusDot | No tooltip, color-only (a11y issue) |
| Error handling | SDK errors → error events → inline display | No error boundaries, no retry, no toast |
| File changes | Backend broadcasts events | **UI doesn't render file changes** |
| Streaming indicator | Pulsing cursor in text-part | No typing indicator before first chunk |

### What's MISSING Entirely

| Category | Missing Features |
|----------|-----------------|
| **Auth** | Logout button, password reset, session timeout, OAuth providers |
| **Mobile** | No responsive layout, no drawer sidebar, no touch targets, no dvh units |
| **Session mgmt** | No delete, no rename/tag, no export, no forking, no date grouping |
| **Chat input** | No auto-resize textarea, no Enter-to-send, no slash commands, no file attachment, no input history |
| **Rendering** | No syntax highlighting (shiki/prism), no diff view, no image rendering |
| **Settings** | No settings page, no theme toggle, no default model, no notification prefs |
| **Accessibility** | No ARIA labels, no focus trap in dialogs, no keyboard nav, no screen reader support |
| **Polish** | No toast system, no empty states, no onboarding, no error boundaries, no PWA manifest |
| **Backend** | No session cleanup/pruning, no rate limiting, no RBAC, no monitoring/metrics |
| **Reconnection** | No auto-reconnect on WS drop, no offline indicator with retry button |

### Known Bugs / Race Conditions

| Bug | Location | Severity |
|-----|----------|----------|
| Double history load on resume | chat-view.tsx:282 + session-do onConnect | Medium — can cause duplicate messages |
| Tool approval race condition | chat-view.tsx:296-304 — AI SDK + RPC not synchronized | Medium — can show wrong state |
| Hard-coded question tool_call_id | chat-view.tsx:311 `'pending-question'` | High — wrong ID sent to gateway |
| No model validation on session create | API route accepts any string | Low |
| Stale body in ChatTransport | AI SDK bug #13464 | Medium — dynamic state can be stale |

---

## Dependency Versions (Current vs Latest)

| Package | Current | Latest | Gap | Breaking? |
|---------|---------|--------|-----|-----------|
| `@tanstack/react-start` | ^1.121.0 | 1.167.16 | **46 versions** | YES — multiple renames |
| `agents` (CF) | ^0.7.0 | 0.9.0 | 2 minors | YES — Zod v4, `call` change |
| `better-auth` | ^1.2.0 | 1.5.6 | 3 minors | YES — Drizzle adapter extracted |
| `@anthropic-ai/claude-agent-sdk` | ^0.2.42 | 0.2.89 | **47 patches** | Minor — new APIs only |
| `ai` (Vercel) | ^6.0.142 | 6.0.142 | Current | — |
| `react` | ^19.1.0 | 19.2.4 | 1 minor | No |
| `vite` | ^7.0.0 | **8.0.3** | 1 major | BLOCKED by TanStack Start |

---

## Product Roadmap — Prioritized Phases

### Phase 0: Foundation Fixes (Pre-requisite)
> Fix bugs and upgrade dependencies before building features.

**0A. Bug fixes** (1-2 days)
- [ ] Fix hard-coded `'pending-question'` tool_call_id → use actual ID from gateway event
- [ ] Fix double history load race condition → deduplicate or use single source
- [ ] Fix tool approval sync → await RPC before updating AI SDK state
- [ ] Wire dashboard.tsx to `/` route (it exists but isn't used!)
- [ ] Add logout button to sidebar

**0B. Dependency upgrades** (2-3 days)
- [ ] TanStack Start ^1.121 → ~1.167 (breaking: `validator` → `inputValidator`, `getWebRequest()` → `getRequest()`, response modes removed)
- [ ] Agents SDK ^0.7 → 0.9 (breaking: Zod v4, `call` is instance property)
- [ ] Better Auth ^1.2 → 1.5.6 (breaking: Drizzle adapter → `@better-auth/drizzle-adapter`, native D1 option)
- [ ] Claude Agent SDK ^0.2.42 → 0.2.89 (non-breaking, new session APIs)
- [ ] React 19.1 → 19.2 (non-breaking, gains `<Activity>`, `useEffectEvent`)
- [ ] Note: Vite stays at 7 — TanStack Start doesn't support Vite 8 yet

**0C. Auth hardening** (1 day)
- [ ] Add logout button + signOut handler
- [ ] Configure session expiry in Better Auth
- [ ] Add password reset flow (Better Auth supports it)

---

### Phase 1: Core Chat Quality
> Make the primary experience feel polished and professional.

**1A. Chat input improvements** (1-2 days)
- [ ] Auto-growing textarea (replace fixed `min-h-[80px]`)
- [ ] Enter to send, Shift+Enter for newline (currently only Ctrl/Cmd+Enter)
- [ ] Typing/thinking indicator before first chunk arrives
- [ ] Auto-scroll to bottom on new messages
- [ ] Scroll position persistence when scrolling up

**1B. Message rendering** (1-2 days)
- [ ] Syntax highlighting for code blocks (shiki or prism — language detection from markdown fence)
- [ ] File change events rendered inline (data available from backend, UI not subscribed)
- [ ] Tool execution time display in ToolPart
- [ ] Image rendering in responses
- [ ] Better JSON display for tool inputs/outputs (collapsible tree instead of raw JSON)

**1C. Error handling** (1 day)
- [ ] React error boundaries around ChatView, MessageBubble, ToolPart
- [ ] Toast notification system (for errors, copy confirmation, session events)
- [ ] Retry mechanism for failed messages
- [ ] Connection lost indicator with reconnect button

---

### Phase 2: Session Management
> Unlock the session APIs the Claude Agent SDK now provides.

**2A. Session history** (2-3 days)
- [ ] Full history page (wire dashboard.tsx or new route) with search/filter
- [ ] Date-grouped sidebar sections (Today / Yesterday / Last Week / Older)
- [ ] Session cost/duration visible in sidebar and history
- [ ] Pagination for message loading (currently loads all at once)

**2B. Session operations** (1-2 days)
- [ ] Session delete (UI + ProjectRegistry.removeSession)
- [ ] Session rename/tag (leverage SDK `renameSession()` / `tagSession()`)
- [ ] Session forking (leverage SDK `forkSession()`)
- [ ] Session export as markdown

**2C. New session dialog improvements** (1 day)
- [ ] Expose system prompt editor
- [ ] Expose tool allowlist
- [ ] Expose turn limit (`maxTurns`)
- [ ] Expose budget limit (`maxBudgetUsd`)
- [ ] Context usage display (leverage `getContextUsage()`)

---

### Phase 3: Mobile & Responsive
> Make it usable on tablets and phones.

**3A. Layout** (2-3 days)
- [ ] Sidebar → collapsible drawer on mobile (hamburger menu)
- [ ] `dvh` units instead of `h-screen` (Safari 100vh fix)
- [ ] Safe-area-inset for notched devices
- [ ] Responsive breakpoints throughout (add `md:` coverage)
- [ ] Touch-friendly tap targets (minimum 44px)

**3B. Mobile interactions** (1-2 days)
- [ ] Bottom sheet for tool approvals and questions
- [ ] Swipe to dismiss sidebar
- [ ] Mobile-optimized login page (currently uses inline styles)
- [ ] Keyboard-aware input (avoid content push on mobile)

---

### Phase 4: Power Features
> Features for power users and teams.

**4A. Slash commands** (2 days)
- [ ] Command palette / autocomplete in textarea
- [ ] `/model` — switch model mid-session
- [ ] `/abort` — quick abort
- [ ] `/clear` — clear display (not session)
- [ ] Extensible via `ChatTransport.sendMessages()` interception

**4B. File attachment** (2 days)
- [ ] Drag-drop files into chat
- [ ] File upload endpoint on gateway
- [ ] `FileUIPart` rendering in messages

**4C. Input history** (0.5 days)
- [ ] Arrow-up to recall previous prompts
- [ ] Per-session or global history

**4D. Auto-reconnect** (1 day)
- [ ] Exponential backoff on WS disconnect
- [ ] Visual indicator during reconnection
- [ ] Queue messages during reconnect

---

### Phase 5: Settings & Configuration
> User preferences and system configuration.

**5A. Settings page** (1-2 days)
- [ ] Default model selection
- [ ] Theme toggle (dark/light — currently hardcoded dark)
- [ ] Default system prompt
- [ ] Notification preferences (desktop notifications when session needs input)

**5B. OAuth providers** (1 day)
- [ ] GitHub OAuth (Better Auth supports it)
- [ ] Google OAuth

**5C. Authorization** (1-2 days)
- [ ] Session ownership (only creator can access)
- [ ] Project-level permissions
- [ ] Rate limiting per user

---

### Phase 6: Accessibility & Polish
> Production-quality UX.

**6A. Accessibility** (2-3 days)
- [ ] ARIA labels on all interactive elements (Dialog, sidebar buttons, status dots)
- [ ] Focus trap in Dialog component
- [ ] Keyboard navigation for message list, session tree, tool approvals
- [ ] `aria-live` regions for streaming messages (screen reader support)
- [ ] `prefers-reduced-motion` media query for animations
- [ ] Color + icon for status (not color-only)

**6B. Polish** (2 days)
- [ ] Empty states (no sessions, no messages, new user)
- [ ] Onboarding / first-run guidance
- [ ] Loading skeletons for all data-fetching views
- [ ] PWA manifest + favicon
- [ ] Virtual scrolling for large message lists (DOM performance)
- [ ] Deduplicate NewSessionDialog (exists in both dashboard.tsx and project-sidebar.tsx)

---

### Phase 7: Backend Hardening
> Production reliability.

**7A. Observability** (1-2 days)
- [ ] Structured logging in SessionDO and routes
- [ ] Session metrics (creation rate, error rate, avg duration, avg cost)
- [ ] Gateway health monitoring from orchestrator

**7B. Cleanup & lifecycle** (1 day)
- [ ] Scheduled alarm to prune old sessions (>30 days)
- [ ] Session storage quotas per user
- [ ] Graceful session recovery when DO evicts

**7C. Multi-region** (research spike)
- [ ] Evaluate Dynamic Workers as cc-gateway replacement
- [ ] D1 read replication for auth
- [ ] Geographic DO placement hints

---

### Phase 8: AI SDK v7 Migration (When Stable)
> Adopt when v7 leaves beta (~2-3 months).

- [ ] Migrate `ai@6` → `ai@7` (ESM-only, renames)
- [ ] Adopt `@ai-sdk/react@4` (useChat v2)
- [ ] Adopt tool output streaming (real-time progress for long tools)
- [ ] Adopt compaction API (infinite conversation length)
- [ ] Adopt ModelMessage persistence format (simplify DO SQLite storage)
- [ ] Adopt tool input editing during approval
- [ ] Migrate to Vite 8 (when TanStack Start adds support — 10-30x faster builds)

---

## Effort Estimates

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| **Phase 0: Foundation** | 4-6 days | None — do first |
| **Phase 1: Chat Quality** | 4-5 days | Phase 0 |
| **Phase 2: Session Mgmt** | 4-6 days | Phase 0 |
| **Phase 3: Mobile** | 3-5 days | Phase 1 |
| **Phase 4: Power Features** | 5-6 days | Phase 1 |
| **Phase 5: Settings** | 3-5 days | Phase 1 |
| **Phase 6: A11y & Polish** | 4-5 days | Phase 1 |
| **Phase 7: Backend** | 3-4 days | Phase 0 |
| **Phase 8: SDK v7** | 3-4 days | v7 stable release |

**Phases 1-7 can be parallelized** — they're independent after Phase 0.
Phase 3+4+5+6 are UI-only. Phase 7 is backend-only. Phase 2 bridges both.

---

## Quick Wins (< 1 hour each)

1. Wire dashboard.tsx to `/` route (it's already built!)
2. Add logout button to sidebar
3. Enter-to-send in textarea
4. Auto-scroll to bottom on new messages
5. Empty state for "no sessions" in sidebar
6. File change events display in chat (backend already broadcasts them)
7. Session cost/duration in sidebar session items
8. Tooltip on StatusDot

---

## Strategic Decisions Needed

1. **Vite 8**: It's out now but TanStack Start doesn't support it. Upgrade when TS adds compat, or switch frameworks?
2. **Dynamic Workers**: CF's new beta could replace the VPS executor. Worth a research spike? Would eliminate server management entirely.
3. **Better Auth native D1 vs Drizzle**: Upgrade to native D1 dialect (simpler) or keep Drizzle adapter (schema tooling)?
4. **AI SDK v7 timeline**: Beta is at 55 releases in 27 days. When do we jump?
5. **Multi-user**: Is Duraclaw single-user (Ben's tool) or multi-user (team product)? This affects Phase 5C (auth/permissions) priority.
