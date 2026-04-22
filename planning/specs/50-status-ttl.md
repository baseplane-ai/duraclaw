---
initiative: 50-status-ttl
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 50
created: 2026-04-22
updated: 2026-04-22
phases:
  - id: p1
    name: "DO last_event_ts tracking + D1 migration (mostly pre-built — verify + reconcile)"
    tasks:
      - "VERIFY migration 0017_last_event_ts.sql already present (apps/orchestrator/migrations/0017_last_event_ts.sql) — `ALTER TABLE agent_sessions ADD COLUMN last_event_ts INTEGER`"
      - "VERIFY `lastEventTs: integer('last_event_ts')` already in agentSessions schema (apps/orchestrator/src/db/schema.ts:168)"
      - "VERIFY `bumpLastEventTs()` already wired at session-do.ts:1638 + called at L3296 (dispatch entry, BEFORE legacy-event drop in B9 per ordering gotcha)"
      - "VERIFY `flushLastEventTsToD1()` already at session-do.ts:1654 + called at lifecycle transitions (L713, L1005, L2564, L3306, L3489, L3523, L3661, L3720, L3808)"
      - "RENAME `LAST_EVENT_FLUSH_DEBOUNCE_MS` → `LAST_EVENT_FLUSH_THROTTLE_MS` at session-do.ts:233 and fix misleading 'debounced'/'debounce' comments in the same region — the existing implementation is already a leading-edge throttle, only the naming is wrong"
      - "AUDIT flushLastEventTsToD1() error handling: if it doesn't already catch + re-arm on D1 write failure, add the try/catch per the Implementation Hints snippet"
      - "AUDIT call-site parity: confirm broadcastSessionRow is invoked after every D1 write so clients see last_event_ts propagate via synced-collection delta (not only on next full page load)"
    test_cases:
      - "Send a message on a fresh session; verify D1 row gets a non-null `last_event_ts` within 11s"
      - "Trigger 200 partial_assistant events in a 3s burst; verify D1 receives at most 1 flush (throttle holds)"
      - "Verify lifecycle events (result, error) bypass throttle and flush immediately"
      - "Simulate a D1 write failure inside flushLastEventTsToD1 (mock env.AUTH_DB to reject once); assert the throttle timer is cleared + re-armed and the next event triggers a retry"
  - id: p2
    name: "Client TTL derivation + reader swap (ship ≥24h after P1)"
    depends_on: p1
    soak_window: "24h — every session must have accumulated at least one post-P1 flush so the null-fallback in deriveStatus (B3 step 3) is inert for live sessions. Without the soak, a P1 flush bug is invisible because every row hits the fallback path and renders the server's status unchanged."
    tasks:
      - "Create apps/orchestrator/src/lib/derive-status.ts exporting `deriveStatus(row: AgentSessionRow, nowTs: number): SessionStatus` and `TTL_MS = 45_000`"
      - "Create apps/orchestrator/src/lib/use-now.ts: `NowProvider` context + `useNow(): number` hook with a single 10s `setInterval` at app root"
      - "Mount `<NowProvider>` in apps/orchestrator/src/routes/__root.tsx"
      - "Swap 8 reader sites from `session.status` to `deriveStatus(session, useNow())`: StatusBar, SessionListItem, SessionCardList, ActiveStrip, SessionSidebar, SessionHistory, nav-sessions, ChainTimelineRow"
      - "Add vitest unit tests in apps/orchestrator/src/lib/derive-status.test.ts covering: terminal short-circuit (archived/error), stale TTL → idle, fresh TTL → returns row.status, null last_event_ts → returns row.status (pre-migration rows)"
    test_cases:
      - "derive-status.test.ts: all cases pass"
      - "Start a session, kill the runner on VPS (SIGKILL), wait 46s — sidebar row transitions from `Running` → `Idle` without any further server roundtrip"
      - "Typecheck + biome pass across all modified reader sites"
  - id: p3
    name: "Cleanup: delete dead events + trap door"
    depends_on: p2
    tasks:
      - "Delete HEARTBEAT_INTERVAL_MS, startHeartbeat(), and the heartbeat emit call from packages/session-runner/src/claude-runner.ts (L17-18 + L140-149)"
      - "Delete HeartbeatEvent type from packages/shared-types/src/index.ts (L167-170) and remove from the GatewayEvent union (L142)"
      - "Delete SessionStateChangedEvent type from packages/shared-types/src/index.ts (L234-238) and its GatewayEvent union entry"
      - "Delete session_state_changed emission from packages/session-runner/src/claude-runner.ts L589-601"
      - "In apps/orchestrator/src/agents/session-do.ts: (a) remove `case 'heartbeat': break` at L3824 — no longer reachable from the runner but kept harmless until B9 covers it; (b) remove `session_state_changed` from the default-branch comment list at L3874 (the default `broadcastGatewayEvent(event)` fallthrough stays for other event types)"
      - "VERIFY B9 tolerant-drop infrastructure already exists (session-do.ts:1673-1676 `handleLegacyEvent` + dedupe set at L234-239) — no new code needed, just confirm the dispatch default-branch routes `heartbeat` / `session_state_changed` through it after step (a)"
      - "Delete the skip-recovery trap door at apps/orchestrator/src/agents/session-do.ts:797-799 — the `if (result.body.state === 'running') { console.log(...); return; }` branch inside `maybeRecoverAfterGatewayDrop` (starts at L786); let recovery proceed to `recoverFromDroppedConnection()` unconditionally when the gateway reports `state === 'running'`"
    test_cases:
      - "Typecheck passes with HeartbeatEvent + SessionStateChangedEvent removed from the union"
      - "session-do.test.ts: simulate receiving an old-runner heartbeat frame → DO logs warning once, no throw, session state unchanged"
      - "Manual: deploy P3 while a long-running runner from pre-P3 code is live; verify runner continues to exit cleanly and DO ignores its dead events"
---

## Overview

Session status in the sidebar gets stuck at `running` when a runner crashes silently between lifecycle transitions — the push-driven state machine has no self-healing pull loop, so a missed event sticks forever. This spec replaces client-side trust in D1 `status` with a TTL predicate over a new `last_event_ts` column: when no event has been received for >45s, the client derives `idle` regardless of what D1 says. Server-side queries (active-filter, history sort, chain summaries) keep using D1 `status` as a denormalized mirror — this is a render-layer fix, not a schema replacement.

## Feature Behaviors

### B1: `last_event_ts` bumped on every GatewayEvent

**Core:**
- **ID:** `last-event-ts-bump`
- **Trigger:** Any `GatewayEvent` arrives at the SessionDO's channel handler (partial_assistant, assistant, tool_use, tool_result, result, ask_user, permission_request, task_started, rate_limit, etc.) or the runner sends any message over the dial-back WS.
- **Expected:** DO updates an in-memory `lastEventTs = Date.now()` synchronously before any other event handling. The field shadows — but does not replace — the existing `lastActivity` column.
- **Verify:** Unit test in `session-do.test.ts` — feed a synthetic `partial_assistant` event; assert `do.lastEventTs` advances to within 5ms of `Date.now()`.

**Source:** `apps/orchestrator/src/agents/session-do.ts:1638` (`bumpLastEventTs()` implementation) + `:3296` (call site at entry of `handleGatewayEvent`, explicitly placed before B9's legacy-event drop).

#### Data Layer
- New column: `agent_sessions.last_event_ts INTEGER` (nullable; epoch ms)
- No index — only owning DO writes, readers fetch full row

### B2: Throttled D1 flush + synced-collection broadcast

**Core:**
- **ID:** `last-event-ts-flush`
- **Trigger:** Lifecycle transition (session.init / result / stopped / error / gate open / gate close / onClose / maybeRecoverAfterGatewayDrop completion) **OR** the 10s throttle timer fires while events are arriving.
- **Expected:** DO writes `last_event_ts` to D1 (`UPDATE agent_sessions SET last_event_ts = ? WHERE id = ?`) and fans out a `SyncedCollectionOp<'update'>` frame by calling `broadcastSessionRow(env, ctx, sessionId, 'update')` (`apps/orchestrator/src/lib/broadcast-session.ts`). The helper performs a **read-after-write**: it re-SELECTs the full `agent_sessions` row by id after the caller's UPDATE commits, so the broadcast payload automatically carries the just-written `last_event_ts` with no additional plumbing. On D1 write failure, catch the error, log once, and re-arm the throttle so the next event retries — don't rely on only the next lifecycle event to self-heal.
- **Verify:** Integration test — feed 200 partial_assistant events in 3s of fake time; assert D1 receives exactly one flush (the throttled one at +10s). Feed a `result` event; assert D1 receives an immediate flush (bypass throttle). Inspect `broadcastSessionRow` call args to confirm the payload carries the new `last_event_ts` value. Mock `env.AUTH_DB.prepare(...).run()` to throw once; assert the throttle timer is cleared + re-armed and the next event triggers a retry flush.

**Source:** `apps/orchestrator/src/agents/session-do.ts:1654` (`flushLastEventTsToD1()`) + `:233` (`LAST_EVENT_FLUSH_DEBOUNCE_MS` constant — rename to `LAST_EVENT_FLUSH_THROTTLE_MS` in P1 per the naming-cleanup task). Lifecycle call sites: L713, L1005, L2564, L3306, L3489, L3523, L3661, L3720, L3808.

#### Data Layer
- Reuses existing `broadcastSessionRow` path (spec #37) — no new broadcast channel. The helper's read-after-write SELECT ensures `last_event_ts` is included in every fanout frame.

### B3: Client TTL derivation predicate

**Core:**
- **ID:** `derive-status-ttl`
- **Trigger:** Any component calls `deriveStatus(row, nowTs)` — typically from `useSession(id)` → `deriveStatus(session, useNow())`.
- **Expected:** Predicate order (first match wins):
  1. `row.archived === true` → `'archived'`
  2. `row.error != null` → server's `row.status` (terminal, DO already set it to `'idle'` with errorCode)
  3. `row.last_event_ts == null` → `row.status` (pre-migration fallback, no TTL data available)
  4. `(nowTs - row.last_event_ts) > 45_000` → `'idle'` (TTL stale override)
  5. default → `row.status` (server-authoritative within TTL)
- **Verify:** Vitest suite `derive-status.test.ts` covers each branch with fixture rows. TTL boundary asserted at 45000ms exactly — `<= 45000` returns server status, `> 45000` returns idle. `archived: true` wins over everything including `error`.

**Source:** `apps/orchestrator/src/lib/derive-status.ts` (new).

#### UI Layer
- No new components; predicate is stateless and pure
- Exported `TTL_MS = 45_000` constant so reader sites can log or test against it without magic numbers

### B4: Shared `useNow()` tick provider

**Core:**
- **ID:** `use-now-provider`
- **Trigger:** `<NowProvider>` mounts at app root; any descendant calls `useNow()`.
- **Expected:** A single `setInterval(() => setNowTs(Date.now()), 10_000)` runs per session, writes to a React context. `useNow()` returns the current context value. Renders triggered only when the interval fires — not on every `Date.now()` read.
- **Verify:** RTL test — mount `<NowProvider>` with `vi.useFakeTimers()`; assert `useNow()` returns same value across advances <10s and advances when time crosses 10s boundary. Mount two children; assert both re-render from one interval (not one each).

**Source:** `apps/orchestrator/src/lib/use-now.ts` (new), mounted from `apps/orchestrator/src/routes/__root.tsx`.

#### UI Layer
- Provider has no UI (passthrough children)
- React context value is the raw `nowTs: number`

### B5: Reader sites swap from `session.status` to `deriveStatus`

**Core:**
- **ID:** `reader-swap`
- **Trigger:** Any render of a component that displays session status.
- **Expected:** Eight files swap `session.status` (or `session.status ?? 'idle'`, etc.) to `deriveStatus(session, nowTs)` where `nowTs` comes from `useNow()`. `deriveDisplayStateFromStatus` signature stays the same — input is still a `SessionStatus`, provenance changes only.
- **Verify:** Grep for `session\.status|row\.status` scoped to the render layer only — `apps/orchestrator/src/components/**/*.{ts,tsx}` and `apps/orchestrator/src/features/**/*.{ts,tsx}` — returns zero hits after P2. Server-side modules (`agents/`, `api/`, `db/`, `lib/broadcast-*`, `lib/chains.ts`) legitimately continue to read `row.status` and are NOT in scope for this grep. Manual axi walkthrough: start session, SIGKILL runner on VPS, observe sidebar row transition to `Idle` within 45–55s with no page reload.

**Source:** 8 files: `apps/orchestrator/src/components/status-bar.tsx`, `apps/orchestrator/src/features/agent-orch/{SessionListItem,SessionCardList,SessionHistory,SessionSidebar,ActiveStrip}.tsx`, `apps/orchestrator/src/components/layout/nav-sessions.tsx`, `apps/orchestrator/src/features/chain/ChainTimelineRow.tsx`.

#### UI Layer
- No visual change in happy path (status still reads correct)
- Visual change in stuck-bug path: sidebar row visibly transitions from `Running` → `Idle` after 45s of silence instead of staying on `Running` forever

### B6: Delete `maybeRecoverAfterGatewayDrop` skip-recovery trap door

**Core:**
- **ID:** `delete-skip-trap-door`
- **Trigger:** Runner WS close event fires on the DO.
- **Expected:** `maybeRecoverAfterGatewayDrop` no longer contains the `if (result.body.state === 'running') return;` early return at `session-do.ts:771`. Recovery proceeds unconditionally, probing the gateway and either clearing the callback token or re-minting for resume as appropriate.
- **Verify:** session-do.test.ts — simulate onClose while state is `running`; assert the gateway probe runs (mock `fetch` assertion) rather than short-circuiting. Pre-existing stuck-bug repro (kill runner mid-turn) no longer wedges server `status` at `running` — D1 reaches `idle` via the recovery path, not just via client TTL.

**Source:** `apps/orchestrator/src/agents/session-do.ts:797-799` (inside `maybeRecoverAfterGatewayDrop`, which starts at L786). The earlier "L771" in the issue / pre-v2 draft was off by ~26 lines — L771 lives inside the unrelated `logError` method.

### B7: Delete `HeartbeatEvent`

**Core:**
- **ID:** `delete-heartbeat`
- **Trigger:** N/A — code deletion.
- **Expected:** `HEARTBEAT_INTERVAL_MS`, `startHeartbeat()`, and the heartbeat emit call are removed from `packages/session-runner/src/claude-runner.ts`. `HeartbeatEvent` type removed from `packages/shared-types/src/index.ts` and from the `GatewayEvent` union. DO's heartbeat handler branch removed.
- **Verify:** Grep `HeartbeatEvent` across repo returns zero hits in `packages/` and `apps/` (only in `planning/` historical docs). Typecheck passes. Old in-flight runner sending a heartbeat frame post-deploy is handled by B9 (tolerant drop).

**Source:**
- `packages/session-runner/src/claude-runner.ts:17-18, 140-149`
- `packages/shared-types/src/index.ts:167-170` + `GatewayEvent` union entry
- `apps/orchestrator/src/agents/session-do.ts:3823-3825` — `case 'heartbeat': break` (no-op handler, delete with B9 in place)

### B8: Delete `SessionStateChangedEvent`

**Core:**
- **ID:** `delete-session-state-changed`
- **Trigger:** N/A — code deletion.
- **Expected:** `SessionStateChangedEvent` type removed from shared-types and the `GatewayEvent` union. Runner's emission at `packages/session-runner/src/claude-runner.ts:589-601` deleted. In `session-do.ts`, `session_state_changed` is currently handled by the default broadcaster branch at L3873-3876 (alongside `rewind_result`, `rate_limit`, `task_*`); after deletion it simply stops appearing on the wire, so the only DO-side change is removing it from the comment list at L3874 (the default-branch code itself stays — it still serves the other event types).
- **Verify:** Grep `session_state_changed|SessionStateChangedEvent` returns zero hits in `packages/` and `apps/orchestrator/src/`. Typecheck passes. Post-P3 runner never emits the event, so the default-branch fallthrough never fires for it.

**Source:**
- `packages/shared-types/src/index.ts:234-238`
- `packages/session-runner/src/claude-runner.ts:589-601`
- `apps/orchestrator/src/agents/session-do.ts:3873-3876` (default-branch comment only — no dedicated handler exists today)

### B9: Tolerant drop for dead events from rolling old runners

**Core:**
- **ID:** `tolerant-legacy-drop`
- **Trigger:** A runner spawned pre-P3 sends a `heartbeat` or `session_state_changed` frame to a post-P3 DO during the deploy window.
- **Expected:** DO's channel event dispatcher logs `[session-do] dropped legacy event type=<heartbeat|session_state_changed> sessionId=<id>` **once per DO instance per event type** (not per event — use a Set), then discards the frame. No throw. Session state is unchanged by the drop. Runner continues to exit cleanly on its own terminal conditions.
- **Verify:** session-do.test.ts — feed a synthetic `{type:'heartbeat'}` frame post-deletion of the handler; assert: (a) DO does not throw, (b) console log fires once, (c) a second `heartbeat` frame in the same DO instance does NOT log again, (d) `do.lastEventTs` still bumps (B1 runs before dispatch so legacy frames still signal liveness).

**Source:** Scaffolding already present — `apps/orchestrator/src/agents/session-do.ts:234-239` (dedupe Set) + `:1672-...` (`handleLegacyEvent`). P3 wires `heartbeat` / `session_state_changed` from the dispatch switch's default branch (L3873) into `handleLegacyEvent` as the `case 'heartbeat'` at L3824 is deleted and the runner-side emissions stop.

## Non-Goals

- **Dropping the `status` column from D1.** Server-side queries (`/api/sessions/active`, `/api/sessions/history` sort/filter, `chains.buildChainRow`) continue to read it. The user pain was client-side sticky `running`; the server is allowed to carry brief staleness for sort/filter purposes. A future issue can unify this if server-side TTL becomes valuable.
- **Adding `callback_token_active` to D1.** DO-internal `active_callback_token` is documented as "token-intent, not runner-liveness" — external consumers needing true liveness continue to use the gateway probe (`GET /sessions/:id/status`). No D1 mirror.
- **Session-state observability side-car.** The `session_state_changed` event is deleted outright (B8), not wired as a read-only log. If SDK/TTL drift becomes a real concern later, a new spec can re-add with explicit acceptance criteria.
- **Unifying the three `ACTIVE_STATUSES` constants** defined with different values in `api/index.ts`, `ActiveStrip.tsx`, and `advance-chain.ts`. Out of scope — noted for a follow-up spec.
- **Backfilling `last_event_ts` for pre-migration rows.** Left NULL; the predicate's null-safety (B3 step 3) falls back to server `row.status` for those rows until they next receive an event and naturally populate. Simpler migration, no window of incorrect derivations during backfill.
- **Per-component tick timers.** `useNow()` is the only tick source app-wide; no component creates its own `setInterval` for TTL rendering.

## Verification Plan

### Pre-deploy (local, per-phase)

**After P1:**
```bash
cd /data/projects/duraclaw-dev2
pnpm --filter @duraclaw/orchestrator typecheck
pnpm --filter @duraclaw/orchestrator test
pnpm drizzle-kit check                       # migration 0017 schema parity
scripts/verify/dev-up.sh                     # start orch + gateway
```
- Sign in to `http://localhost:$VERIFY_ORCH_PORT`, start a new session (any project).
- Run `wrangler d1 execute duraclaw-auth --local --command "SELECT id, status, last_event_ts FROM agent_sessions ORDER BY created_at DESC LIMIT 1"`.
- **Expected:** `last_event_ts` is a non-null epoch-ms integer within 11 seconds of the session starting.
- Send a message; observe D1 row again after the assistant reply completes.
- **Expected:** `last_event_ts` advanced.

**After P2:**
```bash
pnpm --filter @duraclaw/orchestrator test -- derive-status
pnpm --filter @duraclaw/orchestrator test -- use-now
pnpm --filter @duraclaw/orchestrator typecheck
```
- UI smoke: start session, observe `Running` badge. In a second terminal:
  ```bash
  ssh vps
  sudo pkill -9 -f 'session-runner.*<session-id>'
  ```
- **Expected:** Within 45–55 seconds the sidebar row transitions to `Idle` / gray circle (no page reload required). No server-side action — pure client TTL.

**After P3:**
```bash
/usr/bin/grep -r 'HeartbeatEvent\|SessionStateChangedEvent\|session_state_changed' \
  apps/ packages/ --include='*.ts' --include='*.tsx'
# → empty (planning/ hits are fine)

pnpm --filter @duraclaw/orchestrator typecheck
pnpm --filter @duraclaw/session-runner build
pnpm --filter @duraclaw/orchestrator test -- session-do
```
- session-do.test.ts includes B9 test: legacy frame dropped with single log.

### Post-deploy (prod dura.baseplane.ai)

1. Sign in at `https://dura.baseplane.ai/login` with the `agent.verify+prod` test user — full email + password in the worktree-local `.env.test-users.prod` (see CLAUDE.md "Test user credentials (prod, ...)" section). If that file is missing from this worktree, copy it from `/data/projects/duraclaw/.env.test-users.prod`.
2. Start a new session on any available project; type a message.
3. Observe the sidebar tile shows `Running` during streaming, transitions to `Idle` within ~2 seconds of the final assistant turn (matches today's behaviour — regression check).
4. Start a second session, send a long message (triggers multi-second streaming).
5. While streaming is in-flight, SSH to VPS: `sudo pkill -9 -f 'session-runner.*<session-id>'`.
6. **Expected:** Sidebar row transitions from `Running` → `Idle` within 45–55s of the kill, with no page reload.
7. Refresh the browser. **Expected:** Sidebar re-renders, still shows `Idle` (server-authoritative `status` was also corrected via B6's recovery path).
8. Query D1 for the session: `wrangler d1 execute duraclaw-auth --remote --command "SELECT id, status, last_event_ts FROM agent_sessions WHERE id = '<id>'"`.
9. **Expected:** Row has `status = 'idle'` (server-authoritative correction via B6 maybeRecoverAfterGatewayDrop probe), `last_event_ts` stale by >45s relative to `SELECT unixepoch() * 1000`.

## Implementation Hints

### Key Imports

```ts
// derive-status.ts
import type { AgentSessionRow } from '~/db/schema'
import type { SessionStatus } from '~/lib/types'

// use-now.ts
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// session-do.ts (P1 additions) — helper is `broadcastSessionRow`, not `Update`
import { broadcastSessionRow } from '~/lib/broadcast-session'

// migration 0017
// No imports — pure SQL DDL
```

### Code Patterns

**Predicate shape (derive-status.ts):**
```ts
export const TTL_MS = 45_000

export function deriveStatus(row: AgentSessionRow, nowTs: number): SessionStatus {
  if (row.archived) return 'archived'
  if (row.error != null) return row.status as SessionStatus  // terminal
  if (row.lastEventTs == null) return row.status as SessionStatus  // pre-migration
  if (nowTs - row.lastEventTs > TTL_MS) return 'idle'
  return row.status as SessionStatus
}
```

**Provider shape (use-now.ts) — hydration-safe:**
```ts
const NowContext = createContext<number>(0)

export function NowProvider({ children }: { children: ReactNode }) {
  // Initialize to 0 on both server and client so SSR + hydration agree.
  // The first useEffect tick on the client flips to Date.now(); until that
  // runs (typically <16ms after hydration), deriveStatus sees lastEventTs
  // as "in the future" relative to nowTs=0 and returns the server status —
  // which is the correct fallback during the brief pre-hydration window.
  const [now, setNow] = useState(0)
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>
}

export function useNow(): number {
  return useContext(NowContext)
}
```

**Reader-site swap shape (before/after):**
```tsx
// Before
const session = useSession(sessionId)
const display = deriveDisplayStateFromStatus(session?.status, wsReadyState)

// After
const session = useSession(sessionId)
const nowTs = useNow()
const effectiveStatus = session ? deriveStatus(session, nowTs) : undefined
const display = deriveDisplayStateFromStatus(effectiveStatus, wsReadyState)
```

**Throttled flush (session-do.ts) — leading-edge throttle, NOT debounce:**
```ts
private lastEventTs = 0
private flushTimer: ReturnType<typeof setTimeout> | null = null
private readonly FLUSH_THROTTLE_MS = 10_000

// Called on every GatewayEvent received (BEFORE any event-type dispatch,
// so legacy frames from B9's tolerant-drop path still signal liveness).
private bumpLastEventTs() {
  this.lastEventTs = Date.now()
  // Throttle semantics: if a timer is already armed, just absorb this event.
  // The timer will flush the latest lastEventTs when it fires.
  if (this.flushTimer) return
  this.flushTimer = setTimeout(() => {
    this.flushTimer = null
    void this.flushLastEventTsToD1()
  }, this.FLUSH_THROTTLE_MS)
}

private async flushLastEventTsToD1() {
  if (this.flushTimer) {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }
  try {
    await this.db
      .update(agentSessions)
      .set({ lastEventTs: this.lastEventTs })
      .where(eq(agentSessions.id, this.sessionId))
    // broadcastSessionRow re-SELECTs the full row, so last_event_ts is
    // included in the synced-collection delta automatically. The helper
    // wraps broadcastSyncedDelta in ctx.waitUntil internally.
    await broadcastSessionRow(this.env, this.ctx, this.sessionId, 'update')
  } catch (err) {
    console.warn('[session-do] last_event_ts flush failed, re-arming', err)
    // Re-arm so the next bumpLastEventTs() triggers a fresh timer. Without
    // this, a transient D1 blip would wedge the flush path until the next
    // lifecycle transition.
    this.flushTimer = null
  }
}
```

**Migration 0017 shape (pattern from 0016):**
```sql
-- GH#50: add last_event_ts for client-side TTL status derivation.
-- Nullable; pre-migration rows fall through to server status until they
-- next receive an event and populate naturally.
ALTER TABLE `agent_sessions` ADD COLUMN `last_event_ts` INTEGER;
```

**Legacy-event tolerant drop (session-do.ts, B9):**
```ts
private loggedLegacyEventTypes = new Set<string>()

private handleLegacyEvent(type: string, sessionId: string) {
  if (!this.loggedLegacyEventTypes.has(type)) {
    console.warn(`[session-do] dropped legacy event type=${type} sessionId=${sessionId}`)
    this.loggedLegacyEventTypes.add(type)
  }
}

// in the main event dispatch default branch:
if (evt.type === 'heartbeat' || evt.type === 'session_state_changed') {
  this.handleLegacyEvent(evt.type, this.sessionId)
  return
}
```

### Gotchas

- **`last_event_ts` column type mismatch with `last_activity`.** The existing `lastActivity` column is TEXT (ISO string); `last_event_ts` is INTEGER (epoch ms). They're separate by design — `lastActivity` is indexed for sidebar sort and writes rarely (lifecycle transitions only); `last_event_ts` writes every 10s during streaming. Don't conflate them, don't backfill one from the other in migration 0017.
- **`bumpLastEventTs` must run BEFORE the legacy-event drop in B9.** Otherwise a stray heartbeat from an old runner wouldn't refresh liveness during the rollout window, and the session would flap `Running` → `Idle` in clients with P2 shipped.
- **`useNow()` hydration safety.** TanStack Start renders some components server-side. Using `useState(() => Date.now())` as the initializer would produce different values on server vs. client and trigger React's hydration-mismatch warning. The spec's pattern initializes `useState(0)` on both sides and flips to `Date.now()` inside `useEffect` (client-only). Also note that the `createContext` default must be `0`, not `Date.now()` — otherwise components that render *without* a `NowProvider` ancestor (e.g., isolated test mounts) see a non-zero SSR default and the same mismatch reappears. Short window where `nowTs === 0` during hydration is fine: `deriveStatus` sees `(0 - lastEventTs) < TTL` always false, falls through to `row.status`, which is the SSR-correct value.
- **`deriveStatus` and `null` status.** `row.status` has `.notNull().default('running')` — so it can't actually be null from the DB. But `useSession(sessionId)` can return `undefined` before hydration. Handle in call sites with `session ? deriveStatus(session, nowTs) : undefined`, not inside `deriveStatus`.
- **Rollout order is captured in P2's `depends_on: p1` + `soak_window: 24h`** — don't collapse P1+P2 into a single deploy. The null-safe fallback in B3 step 3 means nothing *breaks* if P2 ships early, but the TTL override stays inert for every pre-migration row and hides any P1 flush bug behind silent "server status unchanged" rendering until rows organically populate.
- **B9 scaffolding is already live (pre-P3).** The dedupe Set + `handleLegacyEvent` method already exist in session-do.ts (committed during the same earlier groundwork that shipped `bumpLastEventTs` / `flushLastEventTsToD1`). P3's only B9 task is wiring the dispatch default branch to route `heartbeat` / `session_state_changed` through `handleLegacyEvent` once the dedicated `case 'heartbeat'` at L3824 is removed. No new deploy-ordering constraint — B9 is effectively already running, waiting for P3 to redirect into it.
- **Don't use `strftime('%s')` to backfill.** Migration stays NULL; predicate handles the null case. Avoids SQLite timezone / ISO-parse quirks in the migration.
- **Drizzle TypeScript column access.** In schema.ts, `integer('last_event_ts')` returns a `number | null` field accessible as `row.lastEventTs` (camelCase via Drizzle). The SQL column name is `last_event_ts` (snake_case). Predicate code uses the camelCase field.

### Reference Docs

- **Drizzle ORM SQLite `ALTER TABLE`** — https://orm.drizzle.team/docs/migrations — column additions are auto-detected if schema.ts is updated before running `drizzle-kit generate`; we're hand-writing the migration so this is FYI only.
- **Cloudflare D1 migrations** — https://developers.cloudflare.com/d1/reference/migrations/ — `wrangler d1 migrations apply` for local; prod deploys via infra pipeline.
- **React context + `setInterval` pattern** — https://react.dev/reference/react/useEffect#synchronizing-with-an-external-system — canonical cleanup pattern for the `NowProvider`.
- **Existing spec #37** — `planning/specs/37-session-state-collapse.md` — sets the precedent for synced-collection mirrors; `broadcastSessionRow` helper (`apps/orchestrator/src/lib/broadcast-session.ts`) is the read-after-write broadcast path we reuse.
- **Prior art: `ReconnectableChannel` + `DialBackClient`** — `packages/shared-transport/` — reference for why `HeartbeatEvent` is dead (WS reconnect is handled by these, not application-level pings).
