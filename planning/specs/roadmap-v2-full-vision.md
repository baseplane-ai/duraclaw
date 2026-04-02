---
title: "Duraclaw v2 — Full Vision Roadmap"
date: 2026-04-01
status: draft
scope: epic
interview: complete (5 rounds, 20 questions)
---

# Duraclaw v2: AI Agent Orchestration Platform

## Vision

Duraclaw evolves from a Claude Code web UI into a **multi-provider AI agent orchestration platform** — accessible from any device with full mobile parity, live multi-session streaming dashboards, push notifications, SDK-level session snapshots/rollback, and a local-first data layer. The long-term destination is a platform that orchestrates any AI coding agent (Claude, Codex, Gemini, etc.), not just Claude Code.

**North star:** Full mobile sessions — run, monitor, approve, and interact with Claude Code sessions from your phone with the same quality as desktop.

---

## Interview-Derived Constraints & Decisions

These answers shape every design decision in the roadmap:

| Decision | Answer | Impact |
|---|---|---|
| **User scope** | Single-user now, multi-user later | User scoping in data models from day 1, but no RBAC/team features yet |
| **Primary device** | All devices equally | Mobile-first responsive from the start, not an afterthought |
| **Concurrency** | 6+ heavy parallelism | Dashboard is a core feature, not a nice-to-have. Rich streaming tiles. |
| **Build sequence** | Manual parallel first, orchestration last | Ship multi-session manual control before automation/scheduling |
| **Attention model** | Layered: toasts + attention queue + click-through | Multiple interaction patterns for different urgency levels |
| **Notification triggers** | Blocked + completed + errors | No noise from routine progress. Three event types only. |
| **Dashboard tiles** | Rich: live streaming output | Full streaming in every visible tile. Optimize later if needed. |
| **Permission model** | Smart defaults from Claude Code | bypassPermissions for SDK, mandatory approvals for dangerous ops only |
| **Chat input** | Phased CLI parity over time | Image paste + file upload first, then slash commands, then @ mentions |
| **Code rendering** | Lower priority, file click-to-view with diffs later | Syntax highlighting is nice-to-have. Focus on file viewer + diffs. |
| **Session rollback** | Message-level with option to rewind message or message+code | SDK snapshot control — rewind conversation AND optionally revert code state |
| **Search** | Session summary semantic search, full-text later | Semantic search on summaries first, FTS5 across messages later |
| **Mobile priority** | Full session interaction | Not just monitoring — full prompt/response/approval from phone |
| **Cost tracking** | Session + weekly limits/usage only | Simple cost display, not a full analytics dashboard |
| **Settings** | Dedicated settings page | One place for all configuration |
| **File browser** | Inline file changes + simple file viewer with diffs | Not a full IDE — just see what changed and view files |
| **Integrations** | GitHub issue/PR linking + kata session state | Read kata state (mode/phase/tasks) in session view |
| **Templates/automation** | Configs managed by Claude Code in-project, not needed in UI now | Skip template system for now |
| **Offline/native** | Capacitor with local SQLite. TanStack DB + SQLite for web | Server-primary architecture with local cache layer |
| **Tile streaming** | Full streaming, optimize later | All visible tiles get real-time WS streams |
| **Kata integration** | Status + task list (read-only) | Show mode, phase, task list with completion states |
| **Rollback scope** | SDK snapshot control for conversation + code state | Depends on SDK capabilities for snapshotting session + worktree state |
| **Auth** | Full suite: OAuth, 2FA, magic link, API tokens, timeout, reset | Better Auth supports all of these via plugins |
| **Theming** | Dark + light + system auto | Three modes, no custom accent colors needed |
| **Long-term vision** | Platform for AI agents (multi-provider) | Architecture must abstract the executor/agent layer for future providers |
| **Dream feature** | Full mobile sessions | This is THE priority — everything mobile must be first-class |

---

## What Exists Today (Shipped)

| Capability | Status |
|---|---|
| Session create/stream/abort/resume | Done |
| useChat + WsChatTransport (AI SDK) | Done |
| useAgent real-time state sync (CF Agents SDK) | Done |
| Tool approval (allow/deny) | Done |
| User question prompt (AskUserQuestion) | Done |
| Reasoning blocks (collapsible) | Done |
| Markdown rendering (react-markdown) | Done |
| Code block copy | Done |
| Project grouping + sidebar | Done |
| Auth (email/password, Better Auth + D1) | Done |
| File change detection (backend) | Done |
| Session resume with history replay | Done |
| Cost/duration/turns in header | Done |

---

## Phase 0: Foundation (Pre-requisite)

> Fix bugs, upgrade deps, establish mobile-first layout. Everything else builds on this.

### 0.1 Bug Fixes (P0)

- [ ] Fix hard-coded `'pending-question'` tool_call_id — use actual ID from gateway event
- [ ] Fix double history load race (chat-view.tsx + session-do onConnect)
- [ ] Fix tool approval sync — await RPC before updating AI SDK state
- [ ] Wire existing dashboard.tsx to `/` route
- [ ] Add logout button to sidebar

### 0.2 Dependency Upgrades (P0)

- [ ] TanStack Start ^1.121 → ~1.167 (breaking: validator→inputValidator, getWebRequest→getRequest)
- [ ] Agents SDK ^0.7 → 0.9 (reactive state, typed RPC via stub proxy, Zod v4)
- [ ] Better Auth ^1.2 → 1.5.6 (native D1 — drop Drizzle adapter entirely)
- [ ] Claude Agent SDK → 0.2.89 (session mgmt APIs, forkSession, taskBudget, startup())
- [ ] React 19.1 → 19.2 (`<Activity>` for session switching, `useEffectEvent`)

### 0.3 Mobile-First Layout Foundation (P0)

Every subsequent feature is built responsive from day 1. This phase establishes the shell:

- [ ] **Responsive shell** — 3-tier breakpoints: mobile (<640), tablet (640-1024), desktop (>1024)
- [ ] **dvh units** — replace all `h-screen` with `100dvh` (Safari fix)
- [ ] **Safe area insets** — `env(safe-area-inset-*)` for notched devices
- [ ] **Touch targets** — minimum 44px on all interactive elements
- [ ] **Mobile sidebar** — hamburger → slide-out drawer with swipe-to-dismiss
- [ ] **Bottom navigation (mobile)** — Sessions / Dashboard / Settings tabs

### 0.4 Claude Code CLI Parity — Core (P0)

- [ ] **Full AskUserQuestion flow** — rich question rendering, free-text + multi-choice, input validation
- [ ] **Permission request detail** — show tool name, file path, command to execute (match CLI verbosity)
- [ ] **Model display** — active model in session header
- [ ] **Context window usage** — token usage bar using `getContextUsage()` from SDK
- [ ] **Live cost display** — running cost during session + per-session total
- [ ] **Turn counter** — visible turn count

---

## Phase 1: Chat Quality + Mobile Chat (Parallel track)

> Make the single-session chat experience excellent on every device.

### 1.1 Input Fundamentals

- [ ] **Auto-growing textarea** — grows with content, max 50% viewport, internal scroll after
- [ ] **Enter to send, Shift+Enter newline** — user preference toggle in settings
- [ ] **Auto-scroll** — scroll to bottom on new content, pause on user scroll-up, "jump to bottom" FAB
- [ ] **Typing/thinking indicator** — animated dots before first chunk arrives
- [ ] **Message timestamps** — subtle relative timestamps, full datetime on hover/tap

### 1.2 File Change Display (Inline)

The backend already broadcasts `file_changed` events. This phase surfaces them:

- [ ] **Inline file change cards** — show in chat flow: "Edited `src/auth.ts` (Edit tool)"
  - Click to expand: show file contents with syntax highlighting
  - Later: show diff view (Phase 3 rendering)
- [ ] **File change summary** — at end of assistant turn, summary card: "Changed 3 files"

### 1.3 Mobile Chat Experience

Since full mobile sessions is the dream feature, chat must work perfectly on phone:

- [ ] **Keyboard-aware input** — chat input stays above virtual keyboard, no content push
- [ ] **Bottom sheet for approvals** — tool permissions and questions appear as bottom sheets
  - Drag handle, swipe to dismiss
  - Stacks above keyboard when answering questions
- [ ] **Mobile-optimized code blocks** — horizontal scroll with momentum, tap to expand full-width
- [ ] **Touch message actions** — long-press message for copy/retry menu (instead of hover)
- [ ] **Responsive message layout** — full-width on mobile, max-width constrained on desktop

### 1.4 Error Handling

- [ ] **Error boundaries** — per-component: ChatView, MessageBubble, ToolPart, Sidebar
- [ ] **Toast notification system** — non-blocking alerts for errors, copy confirmation, state changes
  - Position: top-center on desktop, bottom on mobile (above input)
- [ ] **Auto-reconnect** — exponential backoff on WS disconnect (1s, 2s, 4s, 8s, max 30s)
- [ ] **Connection status indicator** — banner when disconnected, auto-retry with manual retry button

---

## Phase 2: Multi-Session Dashboard

> The core differentiator — live multi-session monitoring and control.

### 2.1 Dashboard Layout

- [ ] **Grid view** — 2-6 session tiles in responsive grid
  - Desktop: 2x3 or 3x2 grid
  - Tablet: 2x2 or 1-column scrollable
  - Mobile: 1-column with compact tiles, swipe between sessions
- [ ] **Tile content — rich with live streaming:**
  - Session title + project
  - Status indicator (streaming / waiting / idle / finished / error)
  - Live streaming output — last ~10 lines of assistant text, updating in real-time
  - Cost + turn count
  - "Needs attention" badge for permission/question
- [ ] **Click/tap tile to expand** — full session view slides in
- [ ] **Quick-return** — back button or swipe to return to dashboard without losing place

### 2.2 Attention Queue

Layered notification model (toasts → attention queue → full context):

- [ ] **Attention queue panel** — persistent sidebar section (desktop) or pull-down sheet (mobile)
  - Ordered by time: newest first
  - Each item: session name + what's needed + context snippet
  - Example: "baseplane-dev3 needs permission: `Edit src/database.ts`"
  - Example: "baseplane-dev1 is asking: 'Should I use Redis or Memcached?'"
- [ ] **Inline action buttons** — approve/deny/answer directly from queue without switching sessions
  - For permissions: Allow / Deny buttons right in the queue item
  - For questions: text input with send button, or tap to expand to full session
- [ ] **Toast layer** — non-blocking toasts pop up on new attention items
  - Tap toast → jump to session or open attention queue
  - Auto-dismiss after 8 seconds
- [ ] **Badge counts** — sidebar session items show badge when needing input

### 2.3 Session Status Indicators

- [ ] **Status indicators** with color + icon (not color-only, a11y compliant):
  - Streaming: blue pulse + play icon
  - Waiting (needs input): amber + bell icon
  - Idle: gray + pause icon
  - Finished: green + check icon
  - Error: red + X icon
- [ ] **Live session tickers in sidebar:**
  - "dev1: Editing auth.ts (turn 4, $0.23)"
  - "dev3: Needs permission"
  - Compact one-liner per session

### 2.4 Cost Tracking

- [ ] **Per-session cost** — visible in tile and session header
- [ ] **Running total** — sum of all active session costs in dashboard header
- [ ] **Weekly usage** — simple weekly total in settings or dashboard
- [ ] **Session budget limit** — set max cost per session, auto-abort when reached
- [ ] **Weekly budget limit** — alert (toast + notification) when weekly spend crosses threshold

---

## Phase 3: Session Management

> Full lifecycle control for sessions.

### 3.1 Session Operations

- [ ] **Session rename** — click-to-edit title in sidebar and header (→ SDK `renameSession()`)
- [ ] **Session delete** — with confirmation, removes from registry and DO
- [ ] **Session tagging** — colored tags/labels (→ SDK `tagSession()`)
- [ ] **Session export** — download as Markdown or JSON

### 3.2 Session Rollback / Rewind

This is a priority feature. Message-level rollback with optional code state revert:

- [ ] **Message-level rewind** — right-click/long-press any message → "Rewind to here"
  - Everything after that message is discarded
  - Session continues from that point
  - Uses SDK session snapshot/restore if available
- [ ] **Rewind options:**
  - "Rewind conversation only" — rolls back chat, code stays as-is
  - "Rewind conversation + code" — rolls back chat AND reverts file changes to their state at that message
  - Code rewind requires: tracking git state (commit SHA) at each message boundary
  - Gateway command: `git stash` current changes, `git checkout <sha>` to restore state
- [ ] **Rewind confirmation** — show what will be lost: "Discard 5 messages and 3 file changes?"
- [ ] **Undo rewind** — keep a reference to the rewound state so you can un-rewind within the same session

### 3.3 Session History

- [ ] **Date-grouped sidebar** — Today / Yesterday / This Week / This Month / Older
- [ ] **Session summary search** — search across session summaries (semantic if feasible, otherwise substring)
  - SDK provides `SessionState.summary` — index these
- [ ] **Full history page** — paginated list of all sessions
  - Sort by: date, cost, duration, turns
  - Filter by: project, status, model, date range
- [ ] **Full-text search (later)** — FTS5 across all message content in DO SQLite

### 3.4 New Session Dialog

- [ ] **Model selector** — dropdown with model info (name, speed tier, cost estimate)
- [ ] **Project/worktree picker** — select target project with git status preview
- [ ] **Budget limit** — dollar input with presets ($1, $5, $10, unlimited)
- [ ] **Max turns** — slider with presets (10, 50, 100, unlimited)
- [ ] **Effort level** — low/medium/high/max selector (→ SDK `EffortLevel`)
- [ ] **Quick start** — sidebar "+" button per project → new session with defaults

Note: System prompt editor and tool allowlist are lower priority — Claude Code configs live in-project (CLAUDE.md), managed by Claude Code itself. No need to duplicate that in the UI.

---

## Phase 4: Push Notifications + PWA

> Never miss when Claude needs input. Works from lock screen.

### 4.1 Push Notifications (Web Push API)

- [ ] **Service worker registration** — register SW on first visit
- [ ] **Push subscription** — prompt user to enable notifications on first session create
- [ ] **Notification triggers** (three event types only, no noise):
  1. **Blocked** — permission request or AskUserQuestion (always notify)
  2. **Completed** — session finished (success or failure)
  3. **Error** — session encountered fatal error
- [ ] **Notification content:**
  - Title: session name
  - Body: "Needs permission to edit auth.ts" / "Asking: which DB?" / "Completed (8 turns, $0.82)"
  - Click → deep link to session view
- [ ] **Notification actions (Notification Actions API):**
  - Permission requests: "Allow" / "Deny" buttons directly on notification
  - Questions: "Open" button to jump to session and type answer
- [ ] **Backend: DO → Push service:**
  - SessionDO detects pending_permission / pending_question / result state transitions
  - Sends push via Web Push protocol (need push subscription storage in D1)
  - CF Workers supports Web Push via `fetch()` to push endpoint

### 4.2 In-App Notification System

- [ ] **Notification bell** — header icon with unread count badge (red dot + number)
- [ ] **Notification drawer** — slide-out panel (right side desktop, bottom sheet mobile)
  - Chronological list of all notifications
  - Mark as read, dismiss individual, clear all
- [ ] **Notification preferences page** — in settings:
  - Toggle per event type (blocked/completed/error)
  - Sound on/off
  - Push on/off

### 4.3 PWA Shell

- [ ] **Web app manifest** — installable on home screen
  - Icons (192px, 512px), splash screen, theme-color
  - `display: standalone` (no browser chrome)
  - `orientation: any`
- [ ] **Service worker** — cache app shell + static assets for instant load
- [ ] **Offline indicator** — banner when disconnected with retry button
- [ ] **App shortcuts** — long-press icon: "New Session", "Dashboard"

### 4.4 Capacitor Native Shell (Later)

- [ ] **Capacitor project setup** — wrap web app in native iOS/Android container
- [ ] **Local SQLite** — Capacitor SQLite plugin for offline session cache
- [ ] **Native push notifications** — Firebase Cloud Messaging (Android) + APNs (iOS)
- [ ] **Native share sheet** — share session content via native OS share
- [ ] **Biometric auth** — Face ID / Touch ID for app access

---

## Phase 5: File Viewer + Integrations

> See what Claude changed. Link sessions to external systems.

### 5.1 Inline File Viewer

- [ ] **File change cards in chat** — when a tool edits/creates/reads a file:
  - Compact card: icon + filename + action ("edited", "created", "read")
  - Click to expand: file contents with basic syntax highlighting
  - For edits: show unified diff with +/- line highlighting
- [ ] **File viewer panel** — slide-out or modal showing full file content
  - Syntax highlighting (shiki, lazy-loaded)
  - Line numbers
  - Copy button
  - "Open in session" — reference this file in a follow-up prompt
- [ ] **Turn summary** — end of each assistant turn: "Changed 3 files, ran 2 commands"
  - Expandable to show list of all tool actions

### 5.2 GitHub Integration

- [ ] **Link session to GitHub issue** — in session settings or via command:
  - "This session works on issue #123"
  - Show issue title + status in session header
  - Session summary posted as issue comment on completion
- [ ] **Create PR from session** — button in completed session view:
  - Gateway runs `gh pr create` in the worktree
  - PR body auto-filled with session summary
  - Link back to Duraclaw session in PR description
- [ ] **GitHub status in sidebar** — show linked issue/PR for each session

### 5.3 Kata Session State

- [ ] **Kata status panel** — in session view, show:
  - Current kata mode (planning, implementation, research, etc.)
  - Current phase
  - Task list with completion status checkboxes (read-only)
- [ ] **Data source:** Read from `.kata/` directory in the project worktree via gateway
  - Gateway endpoint: `GET /projects/{name}/kata-state`
  - Returns: mode, phase, tasks array
- [ ] **Refresh:** poll on session reconnect, or subscribe to file_changed events on `.kata/` files

---

## Phase 6: Settings + Auth + Theming

> Full configuration and authentication.

### 6.1 Dedicated Settings Page

- [ ] **Route:** `/settings` with tabbed layout
- [ ] **General tab:**
  - Default model selector
  - Default effort level
  - Default budget limit
  - Default max turns
- [ ] **Appearance tab:**
  - Theme: dark / light / system (three-way toggle)
  - Font size: small / medium / large
- [ ] **Notifications tab:**
  - Push notifications: enable/disable
  - Per-event toggles: blocked, completed, error
  - Sound: on/off
- [ ] **Account tab:**
  - Profile info (email, name)
  - Change password
  - Connected OAuth accounts
  - 2FA management
  - API tokens
  - Logout
- [ ] **Data tab:**
  - Export all sessions (JSON)
  - Clear session history
  - Storage usage display

### 6.2 Auth Enhancements (Full Suite)

Better Auth supports all of these via plugins:

- [ ] **Logout button** — in sidebar and settings (P0, should be in Phase 0)
- [ ] **GitHub OAuth** — `@better-auth/plugin-github`
- [ ] **Google OAuth** — `@better-auth/plugin-google`
- [ ] **Magic link login** — `@better-auth/plugin-magic-link` (passwordless)
- [ ] **Password reset** — `@better-auth/plugin-password-reset`
- [ ] **Session timeout** — configurable expiry in Better Auth config
- [ ] **2FA/TOTP** — `@better-auth/plugin-totp`
- [ ] **API tokens** — `@better-auth/plugin-api-key` for programmatic access (future CLI companion)

### 6.3 Theming

- [ ] **Dark mode** — current default, polish and complete
- [ ] **Light mode** — full light theme (all components)
- [ ] **System auto** — `prefers-color-scheme` media query, auto-switch
- [ ] **Persistence** — save preference in D1 user settings, apply on load via cookie/SSR

---

## Phase 7: Advanced Chat Features (Phased CLI Parity)

> Progressive enhancement of the chat input toward full CLI parity.

### 7.1 Image Paste + File Upload

- [ ] **Paste image** — Cmd/Ctrl+V to paste screenshots into chat
  - Convert to FileUIPart, display preview in input area
  - Upload to gateway on send
- [ ] **File upload** — click attach button or drag-drop files onto chat
  - File picker dialog (filtered by useful types: code, text, images)
  - Progress indicator for upload
  - Display file preview in input area before sending
- [ ] **Image rendering in responses** — display base64 and URL images inline

### 7.2 Slash Commands

- [ ] **Command autocomplete** — type `/` to trigger popup with fuzzy search
- [ ] **Built-in commands:**
  - `/model <name>` — switch model mid-session
  - `/abort` — abort current session
  - `/clear` — clear display (not session history)
  - `/compact` — trigger context compaction
  - `/cost` — show session cost breakdown
  - `/help` — show available commands
- [ ] **Interception:** commands handled in ChatTransport.sendMessages() before reaching server

### 7.3 Input History

- [ ] **Arrow-up recall** — press up-arrow in empty input to recall previous prompts
- [ ] **Per-session history** — stored in memory, cleared on session switch
- [ ] **Cycle through** — up/down arrows to navigate history

### 7.4 Command Palette

- [ ] **Cmd+K** — quick action palette
  - Switch session by name
  - Create new session
  - Search sessions
  - Navigate to settings
  - Toggle theme
- [ ] **Fuzzy search** — filter actions and sessions as you type

---

## Phase 8: Data Layer + Offline

> Local-first cache with TanStack DB for web, Capacitor SQLite for native.

### 8.1 TanStack DB Integration (Web)

Architecture: **server-primary, local cache** — DO is source of truth, client caches for fast loads and basic offline.

- [ ] **TanStack DB setup** — SQLite via OPFS (Origin Private File System) in browser
- [ ] **Cached entities:**
  - Session list with metadata (title, project, status, cost, dates)
  - Recent messages per session (last 50)
  - User settings/preferences
  - Notification state
- [ ] **Sync strategy:**
  - On connect: pull latest from DO, update local cache
  - On mutation: write to DO first, update local on success
  - On disconnect: serve from cache, queue writes for replay

### 8.2 Offline Capabilities

- [ ] **Offline session browsing** — view cached session list and recent messages
- [ ] **Queued actions** — queue new session creation and messages while offline
- [ ] **Sync on reconnect** — replay queued actions when connection restored
- [ ] **Staleness indicators** — show "last synced: 5m ago" when serving from cache

---

## Phase 9: Backend Hardening

> Production reliability and observability.

### 9.1 Observability

- [ ] **Structured logging** — in SessionDO and API routes
- [ ] **Session metrics** — creation rate, error rate, avg duration, avg cost
- [ ] **Gateway health monitoring** — periodic health check from orchestrator, show status

### 9.2 Lifecycle & Cleanup

- [ ] **Session pruning alarm** — DO alarm to prune sessions >30 days (configurable)
- [ ] **Graceful DO eviction recovery** — re-establish gateway WS on DO restart
- [ ] **Connection cleanup** — detect and close zombie WS connections

### 9.3 Security

- [ ] **Session ownership** — enforce creator-only access (prep for multi-user)
- [ ] **Input sanitization** — prevent XSS in rendered markdown/HTML
- [ ] **Rate limiting** — per-user on session creation and API endpoints
- [ ] **Audit logging** — log all permission approvals and session operations

---

## Phase 10: Platform Evolution

> Architectural moves toward the multi-provider AI agent platform.

### 10.1 AI SDK v7 Migration (When Stable)

- [ ] `ai@6` → `ai@7` (ESM-only, renames)
- [ ] `@ai-sdk/react@4` (useChat v2)
- [ ] **Tool output streaming** — real-time progress for long-running tools
- [ ] **Compaction API** — infinite conversation length
- [ ] **ModelMessage persistence** — simplify DO SQLite storage
- [ ] **Tool input editing during approval** — edit what the tool will do before approving
- [ ] Vite 8 migration (when TanStack Start compatible)

### 10.2 Dynamic Workers Research

- [ ] **Research spike:** CF Dynamic Workers as VPS executor replacement
  - Can Claude Agent SDK run in a Dynamic Worker? (Node.js compat, process spawning)
  - Cost comparison: Dynamic Workers pricing vs VPS
  - Latency: cold start impact on session experience
  - Sandboxing: each session in its own worker for isolation
- [ ] **Hybrid mode:** Dynamic Workers for simple/short tasks, VPS for complex (large repos, custom tools)

### 10.3 Executor Abstraction Layer

Prep for multi-provider future:

- [ ] **Abstract executor interface:**
  ```typescript
  interface AgentExecutor {
    execute(config: SessionConfig): AsyncIterable<AgentEvent>
    resume(sessionId: string): AsyncIterable<AgentEvent>
    abort(sessionId: string): void
    answer(sessionId: string, answer: string): void
    getCapabilities(): ExecutorCapabilities
  }
  ```
- [ ] **Claude Code executor** — current cc-gateway, implements interface
- [ ] **Future executors:** Codex, Gemini Code Assist, custom agents
- [ ] **Executor registry** — configure multiple executors, route sessions by model/capability

### 10.4 Multi-Model Support

- [ ] **Model router** — Haiku for quick tasks, Sonnet for standard coding, Opus for complex architecture
- [ ] **Model switching mid-session** — change model without losing context (if SDK supports)
- [ ] **Model comparison** — run same prompt on 2 models, compare outputs side by side

### 10.5 Agent Orchestration (Multi-Agent)

- [ ] **Supervisor pattern** — planning agent spawns worker agents across worktrees
  - Visual: tree view of agent hierarchy
  - Real-time status per sub-agent
- [ ] **Agent-to-agent coordination** — via agent-mail MCP or native DO messaging
- [ ] **Subagent visibility** — leverage SDK's `listSubagents()` / `getSubagentMessages()`

---

## Feature Comparison: Claude Code CLI vs Duraclaw v2

| Feature | CC CLI | Duraclaw Today | Duraclaw v2 |
|---|---|---|---|
| Text chat | Yes | Yes | Yes |
| Tool execution | Yes | Yes | Yes |
| Tool approval | Yes | Yes | Yes + smart defaults |
| AskUserQuestion | Yes | Yes | Yes + rich mobile UI |
| Reasoning display | Yes | Yes | Yes |
| File editing | Yes | Yes (gateway) | Yes + inline diff view |
| Markdown render | Yes (term) | Yes | Yes |
| Syntax highlight | Yes (term) | No | Yes (shiki, lazy) |
| Session resume | Yes | Yes | Yes |
| Session rollback | No | No | Yes (message + code state) |
| Multi-session | No (1 term) | Yes (multi-DO) | Yes + live dashboard |
| Cost tracking | Yes | Yes (per-session) | Yes + weekly limits |
| Notifications | No | No | Yes (push + in-app) |
| Mobile | No | No | Yes (full sessions) |
| Offline | No | No | Yes (cached sessions) |
| Search | Yes (local) | Yes (filter) | Yes (semantic + FTS) |
| File browser | Yes (tools) | No | Yes (inline viewer) |
| GitHub integration | Yes (tools) | No | Yes (issue/PR linking) |
| Kata integration | No (separate) | No | Yes (status + tasks) |
| Slash commands | Yes | No | Yes |
| File attachment | Yes | No | Yes |
| Image paste | Yes | No | Yes |
| Settings page | CLAUDE.md | No | Yes (dedicated) |
| Themes | No | No | Yes (dark/light/system) |
| Auth suite | N/A | Email only | OAuth + 2FA + magic link |
| Multi-provider | No | No | Yes (future: Codex, Gemini) |

---

## Build Sequence

The explicit build order based on interview decisions:

```
Phase 0: Foundation
  Bug fixes + dep upgrades + mobile-first layout + CLI parity
  ↓
Phase 1: Chat Quality + Mobile Chat (parallel)
  Input fundamentals + file change display + mobile chat UX + error handling
  ↓
Phase 2: Multi-Session Dashboard (THE differentiator)
  Grid view with live streaming tiles + attention queue + cost tracking
  ↓
Phase 3: Session Management
  Rename/delete/tag + ROLLBACK/REWIND + history + search
  ↓
Phase 4: Push Notifications + PWA
  Web Push + in-app notifications + PWA manifest + service worker
  ↓
Phase 5: File Viewer + Integrations
  Inline file viewer with diffs + GitHub issue/PR + kata state
  ↓
Phase 6: Settings + Auth + Theming
  Dedicated settings page + full auth suite + dark/light/system
  ↓
Phase 7: Advanced Chat (phased CLI parity)
  Image paste + file upload + slash commands + input history + Cmd+K
  ↓
Phase 8: Data Layer + Offline
  TanStack DB local cache + offline session browsing + Capacitor native
  ↓
Phase 9: Backend Hardening
  Observability + lifecycle + security
  ↓
Phase 10: Platform Evolution
  AI SDK v7 + Dynamic Workers + executor abstraction + multi-model + multi-agent
```

**Key sequencing decisions:**
- Mobile-first layout is in Phase 0, not Phase 6 — everything is responsive from the start
- Dashboard (Phase 2) before session management (Phase 3) — manual parallel control first
- Notifications (Phase 4) before file viewer (Phase 5) — never miss blocked sessions
- Advanced chat features (Phase 7) are later — basics first, CLI parity phased in over time
- Orchestration/automation is Phase 10 — manual parallel first, automation last

---

## Quick Wins (< 1 hour each, do anytime)

1. Wire dashboard.tsx to `/` route (already built!)
2. Add logout button
3. Enter-to-send in textarea
4. Auto-scroll to bottom on new messages
5. Empty state for "no sessions"
6. File change events in chat (backend sends them, UI ignores them)
7. Cost/duration in sidebar session items
8. Tooltip on StatusDot (title attr)
9. Typing indicator (pulsing dots)
10. Message timestamps

---

## Open Technical Questions

1. **SDK snapshot/rollback capability** — Does Claude Agent SDK support session state snapshots? Need to verify before designing Phase 3.2 rollback feature. May need to build on top of git commits per turn.
2. **Web Push from CF Workers** — Can Durable Objects send Web Push notifications? Need to verify crypto APIs available in Workers for VAPID signing.
3. **TanStack DB maturity** — TanStack DB is brand new. Research spike needed before committing to Phase 8 architecture. Fallback: plain IndexedDB with custom sync.
4. **Capacitor + TanStack Start** — Does Capacitor work with SSR frameworks? May need SPA mode for native builds.
5. **Executor abstraction cost** — How much abstraction is needed now vs when the second provider actually arrives? Risk of premature abstraction.
