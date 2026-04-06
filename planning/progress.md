# Duraclaw v2 — Progress Tracker

> Auto-generated from `specs/roadmap-v2-full-vision.md` on 2026-04-02.
> Subphase is the unit of tracking. Individual items live in spec files.

**Status key:** `not-started` | `spec` | `in-progress` | `done`

## Verification Tracking Rule

- `done` means the implementation plus the needed verification updates for that roadmap item have landed.
- `pnpm verify:smoke` is the shared baseline only. Each subphase should add or extend targeted verification as new behavior ships.
- The implementing agent should wire those checks into `scripts/verify/` and root `pnpm verify:*` commands, then save evidence under `.kata/verification-evidence/` before changing status to `done`.
- If a roadmap item is difficult to automate immediately, record the blocker explicitly and add the closest real API/browser proof available instead of silently skipping verification.

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

> 2026-04-03: `0.1`, `0.1b`, `0.1c`, and `0.1e` landed with real verification via `pnpm verify:smoke` plus `pnpm verify:session:ownership`. Evidence: `.kata/verification-evidence/phase-p0-foundation-2026-04-03.md`.
> 2026-04-03: `0.1d` landed with a repo-managed pre-commit gate (`.git-hooks/pre-commit` + `pnpm precommit`) and targeted verification via `pnpm verify:ci`. Evidence: `.kata/verification-evidence/phase-p0-foundation-2026-04-03.md`.
> 2026-04-03: `0.2` completed with the orchestrator on `agents@^0.9.0`, `vite@^8.0.3`, `@cloudflare/vite-plugin@^1.31.0`, current React/Better Auth/Wrangler pins, and green build/test/smoke verification. Evidence: `.kata/verification-evidence/phase-p0-foundation-2026-04-03.md`.
> 2026-04-03: `0.3` completed with the responsive shell, bottom tabs, mobile sessions drawer, safe-area spacing, touch-target sizing, and no-overflow `320px` browser coverage via `pnpm verify:mobile-shell`. Evidence: `.kata/verification-evidence/phase-p0-foundation-2026-04-03.md`.
> 2026-04-03: `0.4` completed with typed AskUserQuestion controls, richer tool detail rendering, session header metadata, and authenticated HTTP-backed interaction actions verified via `pnpm verify:session:interaction`. Evidence: `.kata/verification-evidence/phase-p0-foundation-2026-04-03.md`.
> Phase 0 is complete. Remaining roadmap work begins at Phase 1.

## Phase 1: Chat Quality + Mobile Chat

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 1.1 | Input Fundamentals | not-started | — |
| 1.2 | File Change Display (Inline) | not-started | — |
| 1.3 | Mobile Chat Experience | not-started | — |
| 1.4 | Error Handling | not-started | — |

## Phase 2: Multi-Session Dashboard

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 2.1 | Dashboard Layout | not-started | — |
| 2.2 | Attention Queue | not-started | — |
| 2.3 | Session Status Indicators | not-started | — |
| 2.4 | Cost Tracking | not-started | — |

## Phase 3: Session Management

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 3.1 | Session Operations | not-started | — |
| 3.2 | Session Rollback / Rewind | not-started | — |
| 3.2b | Context Compaction | not-started | — |
| 3.3 | Session History | not-started | — |
| 3.4 | New Session Dialog | not-started | — |
| 3.5 | Image Paste + File Upload | not-started | — |

## Phase 4: Push Notifications + PWA

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 4.1 | Push Notifications (Web Push) | not-started | — |
| 4.2 | In-App Notification System | not-started | — |
| 4.3 | PWA Shell | not-started | — |

## Phase 5: File Viewer + Integrations

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 5.1 | Inline File Viewer | not-started | — |
| 5.2 | GitHub Integration | not-started | — |
| 5.3 | Kata Session State | not-started | — |
| 5.4 | Executor Abstraction Layer | not-started | — |

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

| Sub | Name | Status | Spec |
|-----|------|--------|------|
| 10.1 | AI SDK v7 Migration | not-started | — |
| 10.2 | Dynamic Workers Research | not-started | — |
| 10.3 | Executor Registry + Multi-Provider | not-started | — |
| 10.4 | Multi-Model Support | not-started | — |
| 10.5 | Agent Orchestration | not-started | — |

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
