---
title: "Duraclaw v2 Roadmap — Critical Review"
date: 2026-04-01
reviewer: Research agents (3x parallel) + synthesis
scope: roadmap-v2-full-vision.md
verdict: Strong feature vision, weak engineering foundation
---

# Duraclaw v2 Roadmap — Critical Review

## Executive Summary

The feature vision is well-sequenced and interview-driven. The build order (manual parallel → automation) is correct. But the roadmap is **entirely product-focused** with critical engineering infrastructure missing. Three categories of holes: dependency chain gaps that will force rework, technology bets with unverified assumptions, and conspicuous absences that competitors already ship.

---

## RED FLAGS (Fix Before Building)

### 1. Session ownership is in Phase 9 — should be Phase 0

`SessionDO` has **zero user-scoping today**. The `onRequest` handler serves `/state`, `/messages`, `/abort` to anyone who can construct the DO ID. No `userId` on `SessionState`, no auth check on `onConnect`. Every feature in Phases 0-8 builds on unscoped sessions. Retrofitting ownership in P9 means touching every RPC method, migrating DO SQLite, and updating the registry index.

**Fix:** Add `userId` to `SessionState` and basic ownership checks in P0. The field costs nothing; the retrofit costs weeks.

### 2. SPA migration in Phase 8 will break 7 phases of work

The codebase currently uses SSR features: `useLocation()` for SSR-safe route detection, `createServerFn` for API routes, server-side auth checks via Better Auth session cookies. Phase 8 says "set `ssr: false`" — but that breaks every server function, every server-side auth check, every `getRequest()` usage. Seven phases of features built assuming SSR is available.

**Fix:** Decide SPA vs SSR in Phase 0 and commit. Straddling both for 8 phases guarantees rework. Given single-user + auth-gated + no SEO need, SPA-first is the right call — but make it now, not in P8.

### 3. No testing story whatsoever

Zero mention of unit tests, integration tests, E2E tests, CI/CD, or staging across all 11 phases. Shipping 11 phases incrementally to production without CI is reckless. Competitors (Devin, Copilot coding agent) run self-review, security scanning, and automated tests.

**Fix:** Add CI pipeline and basic smoke tests as a Phase 0 prerequisite.

### 4. No data migration strategy

Eleven phases of schema evolution across DO SQLite, D1, and eventually TanStack DB — no migration tooling, versioning, or backward compatibility plan. What happens to existing sessions when P3 adds rollback metadata?

**Fix:** Versioned DO SQLite schemas with forward-compatible columns, defined in Phase 0.

---

## DEPENDENCY CHAIN GAPS

### 5. Executor abstraction (P5) comes after rollback (P3) — will force rewrite

Phase 3.2 implements rollback by calling SDK methods directly. Phase 5.4 defines `AgentExecutor` that wraps those same methods (`forkSession`, `rewindFiles`). P3 builds tight SDK coupling, P5 refactors it.

**Options:** Either move the interface definition to P3 (before rollback) or accept rollback gets rewritten.

### 6. Push notifications (P4) depend on settings (P6)

P4.2 acknowledges this: "depends: Phase 6 settings page; implement as standalone panel until then." That standalone panel is throwaway work. Push subscription management needs persistent user preferences — but there's no user settings storage until P6.

**Fix:** Pull user settings *storage* (not the full settings page) into P4.

### 7. Rate limiting (P1) has no backend specified

CF Workers have no shared mutable state between requests except DOs or KV. Rate limiting via SessionRegistry DO creates a bottleneck. Rate limiting via KV has ~60s eventual consistency. The mechanism choice affects DO architecture from P0.

**Fix:** Specify the rate-limiting backend in P0 infrastructure decisions.

### 8. Context window / compaction is deferred to Phase 10 — way too late

`/compact` is a Phase 7 slash command that "depends on AI SDK v7 compaction API" (Phase 10). Long sessions hitting context limits is a daily pain point *today*. Claude Code CLI handles compaction now.

**Fix:** Add a manual "summarize and continue" compaction strategy in Phase 1, independent of AI SDK v7.

---

## TECHNOLOGY BETS — Verified Status

| Bet | Verdict | Risk |
|-----|---------|------|
| **TanStack DB v0.6 + OPFS** | Confirmed cross-tab OPFS bug ([#948](https://github.com/TanStack/db/issues/948)) — mutating tab + first tab see changes, others don't. Directly hits multi-tab dashboard use case. | **HIGH** |
| **@pushforge/builder** | Exists, maintained, TS-first, zero-dep, CF Workers examples in docs. Single maintainer is only risk. | **LOW** |
| **Capacitor + SPA TanStack Start** | SPA mode documented and supported. Known rough edge: SSR code still bundles even when unused. Real risk is auth rearchitecture (server cookies → client-side tokens), not the framework. | **MEDIUM** |
| **DO SQLite 10GB limit** | Confirmed per CF docs. Correct, no pruning needed. But storage billing at $0.20/GB-month may motivate cleanup eventually. | **LOW** |
| **Claude Agent SDK APIs** | `forkSession`, `rewindFiles`, `enableFileCheckpointing`, `listSubagents`, `getSubagentMessages` all documented and shipped. SDK is pre-1.0 but Anthropic has been additive. | **LOW** |

**Key takeaway:** TanStack DB is the riskiest bet. The cross-tab bug is a direct hit on the multi-session monitoring use case. Mitigation: use IndexedDB-backed VFS instead of OPFS, or spike early before committing in P8.

---

## CONSPICUOUS ABSENCES

### 9. No plugin/extension or MCP integration story

Cursor has 30+ plugins (Atlassian, Datadog, GitLab). Devin integrates with 20+ tools (Linear, Jira, Slack, Sentry). Duraclaw plans exactly two integrations: GitHub and Kata. The executor abstraction is good architecture, but there's no MCP server integration story for the orchestrator side.

### 10. No self-review or quality gates on agent output

Devin runs its own tests and records video demos. Copilot coding agent self-reviews with security scanning before opening PRs. Duraclaw has no concept of validating what Claude produced — no lint-on-complete, no test-on-complete, no diff review workflow. The Phase 5 file viewer is passive viewing, not active review.

### 11. Accessibility is tokenistic

"Not color-only status indicators" (P2) is the only a11y mention. No keyboard navigation plan, no ARIA landmarks, no screen reader testing, no focus management for slide-out panels and bottom sheets. Mobile-first without accessibility-first is incomplete.

### 12. No deployment/release strategy

How do you ship 11 phases incrementally? No feature flags, no canary deployments, no rollback plan for bad deploys. Gateway and worker must deploy in sync but there's no versioning protocol for the WebSocket contract between them.

### 13. No performance budgets for the dashboard

6 concurrent WebSocket streams with live rendering. No target frame rates, no memory budgets, no bandwidth estimates. The backpressure section (P2.1) mentions IntersectionObserver and navigator.connection but defines no thresholds. Concrete targets needed: e.g., <16ms frame time with 6 streams, <50MB memory per tile.

---

## RECOMMENDED ACTIONS

| Priority | Action | Current Phase | Move To |
|----------|--------|---------------|---------|
| **P0** | Add `userId` to SessionState + ownership checks | P9 | P0 |
| **P0** | Decide SPA vs SSR permanently | P8 | P0 |
| **P0** | Add CI pipeline + basic smoke tests | Missing | P0 |
| **P0** | Define DO SQLite schema versioning strategy | Missing | P0 |
| **P1** | Add manual compaction/summarize flow | P10 | P1 |
| **P1** | Specify rate-limiting backend | Missing | P0-P1 |
| **P3** | Move AgentExecutor interface definition before rollback | P5 | P3 |
| **P4** | Pull user settings storage (not page) into P4 | P6 | P4 |
| **P8** | Spike TanStack DB cross-tab behavior before committing | P8 | P0 spike |
| **Later** | Define a11y standards and keyboard nav plan | Missing | P0-P1 |
| **Later** | Define WS protocol versioning for gateway↔worker | Missing | P0 |
| **Later** | Consider MCP/plugin extensibility story | Missing | P5 |

---

## What's Done Well

Credit where due — the roadmap gets several things right:

- **Interview-driven constraints** — every phase traces back to a specific user decision
- **Security pulled forward** — XSS in P0, rate limiting in P1, audit in P2 (better than most roadmaps)
- **"Manual parallel first, automation last"** — correct sequencing for a single-dev project
- **Quick wins list** — practical, shippable in hours, good morale fuel
- **Resolved technical questions** — the research on SDK APIs, push libraries, and DO limits was thorough and mostly accurate
- **Mobile-first from P0** — not an afterthought
- **Explicit build sequence with rationale** — rare to see "why this order" documented

The vision is ambitious but coherent. The gaps are all in engineering infrastructure, not product thinking.
