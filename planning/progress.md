# Duraclaw v2 — Progress Tracker

> Updated 2026-04-10. Reflects actual execution path — approved specs + agent-orch drop-in alongside the original phase roadmap.

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
| 13 | SDK Feature Expansion | spec | [13-sdk-feature-expansion.md](specs/13-sdk-feature-expansion.md) | #16 pluggable gateway, Phase 3 rollback |
| 16 | Pluggable Agent Gateway | spec | [0016-pluggable-agent-gateway.md](specs/0016-pluggable-agent-gateway.md) | Multi-provider support |
| 15 | Unified Tauri Tray App | spec | [0015-unified-tray-packaging.md](specs/0015-unified-tray-packaging.md) | Distribution/packaging |
| 12 | Cass Session API | spec | [12-cass-session-api.md](specs/12-cass-session-api.md) | — |

### Agent-Orch Drop-In (new — accelerates Phases 1-3)

Port baseplane's agent-orch UI + extract shared ai-elements package. Replaces building Phases 1-3 from scratch.

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| A.1 | Extract ai-elements package | not-started | 5,238 lines from baseplane, zero coupling. Shared between repos. |
| A.2 | AIChatAgent migration | not-started | SessionAgent extends AIChatAgent. Eliminates ~300 LOC custom transport. |
| A.3 | Copy agent-orch UI components | not-started | 1,653 lines GREEN+YELLOW from baseplane. GateResolver, ChatThread, Sidebar, etc. |
| A.4 | Rewrite data hooks | not-started | ~350 lines. Replace DataForge with SessionRegistry DO. |
| A.5 | Voice input (withVoiceInput) | not-started | STT mixin on SessionAgent for mobile gate approval + prompts. |
| A.6 | Durable fibers for gateway relay | not-started | Replace custom reconnectVps with runFiber() crash recovery. |

### How Specs Map to Roadmap Phases

| Spec / Work Item | Roadmap phases it covers |
|------------------|-------------------------|
| #13 SDK Expansion | Phase 3.2 (rollback), 3.2b (compaction), 3.4 (new session options), 5.4 (executor abstraction foundation) |
| #16 Pluggable Gateway | Phase 5.4 (executor abstraction), 10.3 (multi-provider) |
| #15 Tray App | Phase 9 (deployment/packaging), distribution story |
| Agent-orch drop-in (A.1-A.4) | Phase 1 (chat quality), 2 (dashboard/sidebar), 3.5 (image upload) |
| Voice input (A.5) | Phase 1.3 (mobile chat experience) |
| AIChatAgent migration (A.2) | Phase 1.4 (error handling — resumable streaming, auto-reconnect) |

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
| 1.1 | Input Fundamentals | not-started | Covered by A.3 (ai-elements PromptInput) |
| 1.2 | File Change Display (Inline) | not-started | Covered by A.3 (ChatThread file_changed rendering) |
| 1.3 | Mobile Chat Experience | not-started | Covered by A.3 (responsive components) + A.5 (voice input) |
| 1.4 | Error Handling | not-started | Covered by A.2 (AIChatAgent resumable streaming) + A.6 (durable fibers) |

## Phase 2: Multi-Session Dashboard

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 2.1 | Dashboard Layout | not-started | Covered by A.3 (SessionSidebar, session list) |
| 2.2 | Attention Queue | not-started | Gate state visible in sidebar via A.3 |
| 2.3 | Session Status Indicators | not-started | Covered by A.3 (SessionMetadataHeader, status badges) |
| 2.4 | Cost Tracking | not-started | Covered by A.3 (cost display in header) |

## Phase 3: Session Management

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 3.1 | Session Operations | not-started | Depends on #13 (rename, tag endpoints) |
| 3.2 | Session Rollback / Rewind | not-started | Depends on #13 (rewind command). UI: fork button in A.3 ChatThread. |
| 3.2b | Context Compaction | not-started | Depends on #13 (interrupt, context usage commands) |
| 3.3 | Session History | not-started | FTS5 pattern from Think — implement in DO SQLite |
| 3.4 | New Session Dialog | not-started | Covered by A.3 (SpawnAgentForm) |
| 3.5 | Image Paste + File Upload | not-started | Covered by A.3 (MessageInput with ContentBlock) |

## Phase 4: Push Notifications + PWA

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 4.1 | Push Notifications (Web Push) | not-started | — |
| 4.2 | In-App Notification System | not-started | — |
| 4.3 | PWA Shell | not-started | — |

## Phase 5: File Viewer + Integrations

| Sub | Name | Status | Notes |
|-----|------|--------|-------|
| 5.1 | Inline File Viewer | not-started | — |
| 5.2 | GitHub Integration | not-started | — |
| 5.3 | Kata Session State | not-started | Covered by A.3 (KataStatePanel) |
| 5.4 | Executor Abstraction Layer | not-started | Foundation in #13, full abstraction in #16 |

## Phase 6: Settings + Auth + Theming

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 6.1 | Dedicated Settings Page | not-started | — |
| 6.2 | Auth Enhancements | not-started | — |
| 6.3 | Theming | not-started | — |

## Phase 7: Advanced Chat Features

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 7.2 | Slash Commands | not-started | — |
| 7.3 | Input History | not-started | — |
| 7.4 | Command Palette | not-started | — |

## Phase 8: Data Layer + Offline

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 8.1 | TanStack DB Integration (Web) | not-started | — |
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
| 10.3 | Executor Registry + Multi-Provider | not-started | #16 ships the gateway adapter layer |
| 10.4 | Multi-Model Support | not-started | — |
| 10.5 | Agent Orchestration | not-started | Sub-agent RPC pattern from Think |

---

## Quick Wins (anytime)

| # | Name | Status |
|---|------|--------|
| 1 | Wire dashboard.tsx to `/` route | done |
| 2 | Add logout button | done |
| 3 | Enter-to-send in textarea | not-started |
| 4 | Auto-scroll to bottom | not-started |
| 5 | Empty state for "no sessions" | not-started |
| 6 | File change events in chat | not-started |
| 7 | Cost/duration in sidebar items | not-started |
| 8 | Tooltip on StatusDot | not-started |
| 9 | Typing indicator | not-started |
| 10 | Message timestamps | not-started |
| 11 | First-run empty states | not-started |

> Quick wins 3-11 are largely covered by the agent-orch drop-in (A.3) which includes auto-scroll, file change display, cost in sidebar, streaming indicators, and timestamps.
