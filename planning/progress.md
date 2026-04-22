# Duraclaw v2 — Progress Tracker

> Updated 2026-04-21. GH#37 session live-state collapse shipped (PR #39) — single `agent_sessions` synced-collection row replaces `sessionLiveStateCollection`, `useDerivedStatus` retired. GH#16 Chain UX epic shipped (chain tabs, kanban board with project filter, mode-enter reset, worktree checkout). GH#18 kata_state emission fix. GH#12 TanStack DB unification. Kanban board mobile layout fix. Issue #27 VPS session discovery shipped prior.

**Status key:** `not-started` | `spec` | `in-progress` | `done`

## Verification Tracking Rule

- `done` means the implementation plus the needed verification updates for that roadmap item have landed.
- `pnpm verify:smoke` is the shared baseline only. Each subphase should add or extend targeted verification as new behavior ships.
- The implementing agent should wire those checks into `scripts/verify/` and root `pnpm verify:*` commands, then save evidence under `.kata/verification-evidence/` before changing status to `done`.
- If a roadmap item is difficult to automate immediately, record the blocker explicitly and add the closest real API/browser proof available instead of silently skipping verification.

---

## Active Execution Path

> These are the approved specs and new work items driving actual development. The Phase 1-10 roadmap below remains the vision — these specs accelerate it by building infrastructure that multiple phases need.

### Infrastructure Specs (approved, ready for implementation)

| # | Name | Status | Spec | Blocks |
|---|------|--------|------|--------|
| 13 | SDK Feature Expansion | done | [13-sdk-feature-expansion.md](specs/13-sdk-feature-expansion.md) | #16 pluggable gateway, Phase 3 rollback |
| 16 | Pluggable Agent Gateway | done | [0016-pluggable-agent-gateway.md](specs/0016-pluggable-agent-gateway.md) | Multi-provider support |
| 15 | Unified Tauri Tray App | spec | [0015-unified-tray-packaging.md](specs/0015-unified-tray-packaging.md) | Distribution/packaging |
| 24 | UX Ergonomics | done | [24-ux-ergonomics.md](specs/24-ux-ergonomics.md) | — |
| 12 | Cass Session API | spec | [12-cass-session-api.md](specs/12-cass-session-api.md) | — |
| 27 | VPS Session Discovery | done | [27-vps-session-discovery.md](specs/27-vps-session-discovery.md) | — |
| 29 | Mobile Cards + Nav Cleanup (11.1-11.2) | not-started | — | — |
| 30 | Cmd+K Fuzzy Finder + Keyboard Nav (11.3-11.4) | not-started | — | #29 (cards exist first) |
| 31 | Mobile Swipe + Live Card Previews (11.5-11.6) | not-started | — | #29 |
| 38 | AskUserQuestion Gate Fix | done | [38-askuserquestion-gate-fix.md](specs/38-askuserquestion-gate-fix.md) | — |
| GH#12 | Client Data Layer Unification (TanStack DB) | done | — | — |
| GH#16 | Chain UX Epic | done | [16-chain-ux.md](specs/16-chain-ux.md) | — |
| GH#18 | kata_state Emission Fix | done | — | GH#16 P4 |

### Chain UX (GH#16) — Kanban Board + Chain Tabs + Mode Reset

Shipped via PR #17 (squash-merged) + GH#18 fix. Four sub-features:

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 3B | Chain Tab Surface | done | D1-backed chain tabs one-per-issue (userTabsCollection). Sidebar groups sessions under chain nodes with 5-dot pipeline indicator. `/chain/:issueNumber` route renders vertical timeline of mode sessions. Auto-opens on session spawn when `kataIssue` is set. |
| 3C | Mode-Enter Session Reset | done | `handleModeTransition` in SessionDO closes runner WS with code `4411 mode_transition`, waits 5s, builds preamble from prior session context, respawns in new mode. Emitter path: session-runner watches `.kata/sessions/` state.json, emits `KataStateEvent` over dial-back WS (GH#18 fix). |
| 3D | Kanban Board (`/board`) | done | Swim lanes by issue type (enhancement/bug/other). 6-column pipeline: backlog → research → planning → impl → verify → done. Column derived from latest session's kataMode + issue open/closed state. Drag-to-advance with single-step adjacency rule + precondition gates. Project filter dropdown scopes board to chains with sessions in a specific worktree. Horizontal scroll layout for mobile (min-w-180px columns, snap scroll). |
| 3E | Worktree Checkout | done | D1 `worktree_reservations` table (migration 0009). Code-touching modes (implementation/verify/debug/task) acquire exclusive worktree lock via `/api/chains/:issue/checkout`. 409 conflict with force-release modal. Checkout auto-runs on advance. |

### Agent-Orch Drop-In (new — accelerates Phases 1-3)

Port baseplane's agent-orch UI + extract shared ai-elements package. Replaces building Phases 1-3 from scratch.

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| A.1 | Extract ai-elements package | done | P2 in #17. 32 components in packages/ai-elements. |
| A.2 | SessionDO gateway relay | done | P3 in #17. Raw GatewayEvent relay, unified gate handling, @callable RPC. Fixed: onMessage delegates to super for RPC dispatch; WS route handles /agents/ path. |
| A.3 | Copy agent-orch UI components | done | P4 in #17. 11 components in features/agent-orch/. |
| A.4 | Rewrite data hooks | done | P5 in #17. useCodingAgent + useAgentOrchSessions backed by ProjectRegistry DO. Fixed: getMessages derives from events table (messages table was never populated). |
| A.5 | Voice input (withVoiceInput) | not-started | STT mixin on SessionAgent for mobile gate approval + prompts. |
| A.6 | Durable fibers for gateway relay | not-started | Replace custom reconnectVps with runFiber() crash recovery. |

### How Specs Map to Roadmap Phases

| Spec / Work Item | Roadmap phases it covers |
|------------------|-------------------------|
| #13 SDK Expansion | Phase 3.2 (rollback), 3.2b (compaction), 3.4 (new session options), 5.4 (executor abstraction foundation) |
| #16 Pluggable Gateway | Phase 5.4 (executor abstraction), 10.3 (multi-provider) |
| #15 Tray App | Phase 9 (deployment/packaging), distribution story |
| Agent-orch drop-in (A.1-A.4) | Phase 1 (chat quality), 2 (dashboard/sidebar), 3.5 (image upload) |
| GH#12 Client Data Unification | Phase 8.1 (TanStack DB) |
| GH#16 Chain UX | Phase 2 (dashboard — kanban board), 3 (session management — chain tabs, mode reset), 5.3 (kata state — emission fix) |
| Voice input (A.5) | Phase 1.3 (mobile chat experience) |
| AIChatAgent migration (A.2) | Phase 1.4 (error handling — resumable streaming, auto-reconnect) |
| #24 UX Ergonomics | Phase 2.5-2.6 (workspaces, tabs), 4 (notifications), 6.1+6.3 (settings, theming), 7.4 (command palette) |

---

## Phase 0: Foundation

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 0.1 | Bug Fixes | done | [p0-foundation.md](specs/p0-foundation.md) |
| 0.1b | Session Ownership | done | [p0-foundation.md](specs/p0-foundation.md) |
| 0.1c | Drop Start → SPA | done | [p0-foundation.md](specs/p0-foundation.md) |
| 0.1d | CI Pipeline | done | [p0-foundation.md](specs/p0-foundation.md) |
| 0.1e | DO SQLite Schema Versioning | done | [p0-foundation.md](specs/p0-foundation.md) |
| 0.2 | Dependency Upgrades | done | [p0-foundation.md](specs/p0-foundation.md) |
| 0.3 | Mobile-First Layout | done | [p0-foundation.md](specs/p0-foundation.md) |
| 0.4 | CLI Parity — Core | done | [p0-foundation.md](specs/p0-foundation.md) |

> Phase 0 is complete. See `.kata/verification-evidence/phase-p0-foundation-2026-04-03.md`.

## Phase 1: Chat Quality + Mobile Chat

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 1.1 | Input Fundamentals | done | Shipped in A.3 — PromptInput with enter-to-send, image paste. |
| 1.2 | File Change Display (Inline) | done | Shipped in A.3 — ChatThread renders file_changed events inline. |
| 1.3 | Mobile Chat Experience | in-progress | Responsive components shipped in A.3. Voice input (A.5) still pending. |
| 1.4 | Error Handling | in-progress | SessionDO relay + reconnect shipped in A.2. Durable fibers (A.6) still pending. |

## Phase 2: Multi-Session Dashboard

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 2.1 | Dashboard Layout | done | Shipped in A.3 — AgentOrchPage with SessionSidebar + session grouping by project. |
| 2.2 | Attention Queue | done | Shipped in A.3 — Gate state visible in sidebar status badges. |
| 2.3 | Session Status Indicators | done | Shipped in A.3 — SessionMetadataHeader with status, elapsed timer, WS dot. Replaced by StatusBar in #24. |
| 2.4 | Cost Tracking | done | Shipped in A.3 — Cost/duration display in SessionMetadataHeader. Moved to StatusBar in #24. |
| 2.5 | Workspace Grouping | done | #24. Auto-detect workspaces by repo_origin, workspace selector in sidebar, per-workspace defaults. |
| 2.6 | Agent Tabs | done | #24. Tab bar with Cmd+T/W/1-9 shortcuts, localStorage persistence. |

## Phase 3: Session Management

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 3.1 | Session Operations | done | Rename/tag dialogs + fork menu in sidebar. Migration v5 adds title/tag columns. Fork proxies to gateway. VP 7/7 pass. |
| 3.2 | Session Rollback / Rewind | done | Rewind button on message hover (HistoryIcon + label + tooltip). `useCodingAgent.rewind()` wired. VP verified. |
| 3.2b | Context Compaction | done | Interrupt button + context usage bar in header. DO RPC wired to gateway. VP 6/6 pass. |
| 3.3 | Session History | done | Date-grouped sidebar, summary search, /history page with sort/filter/pagination. FTS5 deferred. |
| 3.4 | New Session Dialog | done | Shipped in A.3 — SpawnAgentForm with project list from gateway. |
| 3.5 | Image Paste + File Upload | done | Shipped in A.3 — MessageInput with paste, file picker, ContentBlock support. |

## Phase 4: Push Notifications + PWA

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 4.1 | Push Notifications (Web Push) | done | #22 + #24. VAPID keys, subscription management, gate/completion/error notifications with action buttons. |
| 4.2 | In-App Notification System | done | #22 + #24. NotificationBell + drawer, notification preferences, service worker click handling. |
| 4.3 | PWA Shell | done | #22. vite-plugin-pwa, manifest, service worker with precache + push handler. |

## Phase 5: File Viewer + Integrations

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 5.1 | Inline File Viewer | not-started | — |
| 5.2 | GitHub Integration | not-started | — |
| 5.3 | Kata Session State | done | Shipped in A.3 — KataStatePanel shows mode, phase, completed phases. |
| 5.4 | Executor Abstraction Layer | done | #16 adapter registry shipped. Claude, Codex, OpenCode adapters. Codex verified with OAuth. |

## Phase 6: Settings + Auth + Theming

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 6.1 | Dedicated Settings Page | done | #24. Settings page with Account, Defaults (permission/model/budget/thinking/effort), Notifications, Appearance sections. user_preferences table in ProjectRegistry DO. |
| 6.2 | Auth Enhancements | not-started | — |
| 6.3 | Theming | done | #24. Appearance section in settings with theme (light/dark/system) and sidebar variant selectors. |

## Phase 7: Advanced Chat Features

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 7.2 | Slash Commands | not-started | — |
| 7.3 | Input History | not-started | — |
| 7.4 | Command Palette | done | #24. Cmd+K palette with fuzzy search over sessions, projects, actions, navigation. Built on cmdk. |

## Phase 8: Data Layer + Offline

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 8.1 | TanStack DB Integration (Web) | done | GH#12. Unified client data layer on TanStack DB collections. Session live state, messages, agent sessions, and chains all served from OPFS-persisted collections. Retired manual hydrate/optimistic/replace reconciliation. |
| 8.2 | Offline Capabilities | not-started | — |
| 8.3 | Capacitor Native Shell | not-started | — |

## Phase 9: Backend Hardening

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 9.1 | Observability | not-started | — |
| 9.2 | Lifecycle & Cleanup | not-started | — |

## Phase 10: Platform Evolution

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 10.1 | AI SDK v7 Migration | not-started | — |
| 10.2 | Dynamic Workers Research | not-started | — |
| 10.3 | Executor Registry + Multi-Provider | done | #16 shipped. Claude + Codex verified live. Spawn form has model selector with agent routing. |
| 10.4 | Multi-Model Support | not-started | — |
| 10.5 | Agent Orchestration | not-started | Sub-agent RPC pattern from Think |

## Phase 11: UX Overhaul — Session-Centric Navigation

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 11.1 | Mobile Session Cards + Active Strip | not-started | Card-based mobile layout, active strip, @use-gesture/react |
| 11.2 | Navigation Cleanup | not-started | Kill Dashboard/workspace/History duplication, filter chips |
| 11.3 | Cmd+K Session Fuzzy Finder | not-started | Desktop keyboard-first switching, cmdk-based |
| 11.4 | Keyboard Navigation Shortcuts | not-started | Cmd+[/], Cmd+Shift+A |
| 11.5 | Mobile Swipe-Between-Sessions | not-started | Edge swipe in detail view, scroll-snap carousel |
| 11.6 | Live Session Card Previews | not-started | Streaming output on cards, inline answer from card |

---

## Quick Wins (anytime)

| # | Name | Status |
|---|------|--------|
| 1 | Wire dashboard.tsx to `/` route | done |
| 2 | Add logout button | done |
| 3 | Enter-to-send in textarea | done | PromptInput from ai-elements |
| 4 | Auto-scroll to bottom | done | ConversationScrollButton from ai-elements |
| 5 | Empty state for "no sessions" | done | ConversationEmptyState + sidebar empty state |
| 6 | File change events in chat | done | ChatThread renders file_changed inline |
| 7 | Cost/duration in sidebar items | done | SessionMetadataHeader shows cost + duration |
| 8 | Tooltip on StatusDot | done | WS status dot with title tooltip |
| 9 | Typing indicator | done | Bounce animation in ChatThread |
| 10 | Message timestamps | not-started | SessionListItem shows relative time, but not per-message |
| 11 | First-run empty states | done | Sidebar + conversation empty states |

> Quick wins 3-9, 11 shipped via agent-orch drop-in (A.3).

> Verification gap results: see `planning/research/2026-04-11-verification-gaps.md` and commits `3e7db96..b7c9da3`.
