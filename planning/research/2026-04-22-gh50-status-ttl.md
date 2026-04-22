---
date: 2026-04-22
topic: Derive session status from liveness TTL (GH#50)
type: feasibility
status: complete
github_issue: 50
items_researched: 6
---

# Research: Derive session status from liveness TTL

## Context

User reports session status is unreliable — a currently-running session is
stuck at `running` and never transitions to `idle`. Investigation traced
this to the push-driven state machine in `SessionDO`: status is an
event-sourced field mirrored to D1, and any missing / skipped / crashed
transition leaves a sticky value with no self-healing pull loop.

Spec #37 already consolidated status into the D1-synced
`sessionsCollection` (one reactive row per session, OPFS-persisted via
TanStack DB). That collapsed the earlier dual-source mess
(`messagesCollection`-derived vs. `useSession(...)?.live.status`) but
did not change the underlying question — **status is still whatever the
last `syncStatusToD1(...)` call wrote.** If a branch misses a write,
status is wrong until the next push.

The proposal in GH#50: stop storing `status` in D1. Store only the
inputs needed to derive it (`last_event_ts`, `callback_token_active`,
terminal markers for `archived`/`error`/`stopped`), and let every
consumer fold those inputs into a status via a pure predicate. Make the
system self-healing by construction: a stale `last_event_ts` → the
derivation produces `idle` / `disconnected` without anyone having to
push an event.

Classification: **feasibility study** — is the TTL-based derivation
tractable, what's the blast radius, and can we do it cleanly in one
issue?

## Scope

**Items researched** (6, deep-dived in parallel via Explore agents):

1. All current `syncStatusToD1` call sites and transitions in
   `SessionDO` + client reader sites for `session.status`
2. Session-runner event cadence and proof that `last_event_ts` can be
   kept fresh enough for a TTL predicate
3. D1 schema: can `lastActivity` double as `last_event_ts`, or do we
   need a new column?
4. Client derivation shape: where `deriveStatus(row, nowTs)` should
   live, how to keep it reactive, and the `useNow()` tick strategy
5. `active_callback_token` lifecycle — can we mirror a
   `callback_token_active` bit to D1 without stuck-token scenarios?
6. Broadcast cadence — how often `last_event_ts` should fan out through
   `broadcastSyncedDelta` without hammering UserSettingsDO

**Sources:**
- `apps/orchestrator/src/agents/session-do.ts` (3700+ LOC DO)
- `apps/orchestrator/src/lib/display-state.ts`
- `apps/orchestrator/src/db/schema.ts`
- `apps/orchestrator/src/db/collections/sessions.ts`
- `packages/session-runner/src/{main,claude-runner}.ts`
- `packages/agent-gateway/src/{server,reaper}.ts`
- `packages/shared-types/src/index.ts`
- `planning/specs/37-session-state-collapse.md`
- `planning/specs/13-sdk-feature-expansion.md` (B12 `session_state_changed`)

## Findings

### 1. Reader / writer map for `session.status`

- **20 `syncStatusToD1` call sites in `SessionDO`**, covering the
  transition matrix: mint (`running`) · result (`idle`) · stopped
  (`idle`) · error (`idle` with errorCode) · onClose /
  `maybeRecoverAfterGatewayDrop` (`idle`) · explicit
  stop/abort/force-stop (`idle`) · `ask_user` /
  `permission_request` (`waiting_gate`) · `resolve-gate` (`running`).
- **Known gap** — the stuck bug reproduces through
  `maybeRecoverAfterGatewayDrop` at `session-do.ts:771`:
  `if (result.body.state === 'running') return;` skips recovery with
  no re-probe timer, leaving status at `running` indefinitely when
  the runner crashes mid-turn.
- **Catch-all at ~L3765** re-broadcasts `session_state_changed` from
  the runner but never acts on it (no D1 write, no status touch) —
  the event is a no-op observability frame today.
- **Reader sites (~20):** `StatusBar`, `SessionListItem`,
  `SessionCardList`, tab bar, filter / sort in sidebar,
  `deriveDisplayStateFromStatus`, and a handful of inferred-state
  reads inside `use-coding-agent.ts`. All go through
  `useSession(sessionId)` → `session.status` today. Refactor surface:
  swap `session.status` → `deriveStatus(session, now)` at every site;
  `~150–200 LOC` net.

### 2. Runner event cadence — can we TTL off `last_event_ts`?

- Session-runner writes its meta file (`{id}.meta.json`) every
  **10s** (`META_INTERVAL_MS`) and bumps `ctx.meta.last_activity_ts`
  on every `send()`.
- `HeartbeatEvent` fires every **15s** from `startHeartbeat`
  (`claude-runner.ts:140`) while the query is active. User clarified
  heartbeat is **legacy dead code** (pre-dial-back relic;
  `DialBackClient` + `BufferedChannel` cover drop detection now).
  Recommendation: **delete `HeartbeatEvent`**, rely on real events.
- Real events flow at far higher cadence during a turn
  (`partial_assistant` deltas arrive every few hundred ms from
  streaming text). For an *idle but connected* runner (waiting on
  `queue.waitForNext()`), no events flow at all. That's the case
  TTL+heartbeat was guarding.
- **Without heartbeat**, the runner-idle-but-connected case will have
  no `last_event_ts` bump. We have two choices:
  (a) resurrect a lightweight periodic "alive" ping from the runner
  (not `HeartbeatEvent` by name — a new `alive` frame, or re-use
  `session_state_changed` when SDK emits `idle`); or
  (b) accept that client-derived status goes `idle` after TTL even
  while runner is technically alive (which is actually correct — the
  user cares "is work happening?" not "is the runner process up?").
- **TTL recommendation: 45s** (3× the old 15s heartbeat cadence gives
  generous headroom for network jitter + meta write delay).

### 3. D1 schema changes

- `agent_sessions.lastActivity` is **indexed with `userId`** as the
  sidebar sort key (most-recent-first). We cannot repurpose it as
  `last_event_ts` — sort order would thrash every 10s.
- **Add a new column:** `last_event_ts INTEGER` (nullable during
  migration; non-null post-backfill). No index — only the owning DO
  writes it, readers fetch the whole row.
- **Optional column:** `callback_token_active INTEGER` (0/1) — see
  Item 5. User chose to keep this bit and document its semantics as
  "token-intent, not runner-liveness" rather than add watchdogs.
- **Drop column:** `status` — replaced by client derivation. Migration
  sequence: (1) add `last_event_ts` + `callback_token_active`; (2)
  backfill; (3) client shipped reading derived status with
  server-`status` fallback; (4) drop `status` column in a follow-up
  migration once the fallback is gone. Safe rollout.
- **Terminal markers stay:** `archived`, `error`/`errorCode`. These
  aren't TTL-derivable; they're explicit terminal rows. Derivation
  predicate consults them first.

### 4. Client-side derivation shape

- Canonical helper: `deriveStatus(row: AgentSessionRow, nowTs: number):
  SessionStatus` in `apps/orchestrator/src/lib/derive-status.ts`.
- Predicate order (first match wins):
  1. `row.archivedAt != null` → `'archived'`
  2. `row.error != null` → `'error'` (terminal, frozen)
  3. `row.gatePending != null` → `'waiting_gate'`
  4. `row.callback_token_active && (nowTs - row.last_event_ts) < TTL`
     → `'running'`
  5. `(nowTs - row.last_event_ts) < TTL` → `'idle'` (connected but
     idle — token cleared on completion)
  6. otherwise → `'disconnected'`
- **Reactivity:** TanStack DB row updates re-render automatically.
  The TTL boundary crossing needs a `useNow()` tick (45s-period
  `setInterval` via a small context provider) so rows that didn't
  update cross the TTL edge and re-render too. Use a single shared
  timer at the app root, not per-component, to keep the render budget
  predictable.
- **Update `deriveDisplayStateFromStatus`:** no signature change —
  status is still the input; only its provenance changes. Existing
  `wsReadyState !== OPEN → DISCONNECTED` override stays.

### 5. `callback_token_active` D1 mirror — stuck-token scenarios

Two stuck scenarios exist today if we naively mirror the DO's
`active_callback_token` nullability to D1:

- **Case A — `result` keeps token set.** Intentional: after
  `type=result` the DO marks status `idle` but keeps the token set so
  the runner (still blocked on `queue.waitForNext()`) can re-dial if
  the WS bounces mid-idle. If the runner dies silently between
  `result` and the next turn, the D1 bit stays `1` forever.
- **Case B — eviction restores stale token.** On DO rehydrate,
  `hydrateMetaFromSql()` (`session-do.ts:1042`) restores
  `active_callback_token` from the SQLite `session_meta` row without
  re-checking with the gateway. If the runner died during the
  eviction window, the token is zombie-valid until someone tries to
  use it.

**User's resolution:** document `callback_token_active` as
"token-intent, not runner-liveness." Any server-side caller that
needs true liveness (e.g., `sendMessage`'s orphan-detection branch)
already queries the gateway's `GET /sessions/:id/status`, which is the
real source of truth. The client derivation predicate (Item 4) pairs
the bit with the `last_event_ts` TTL check — so a stuck token + stale
TTL correctly derives `idle`, not `running`. The bit's value is
strictly "if a runner is up, this token is valid" — not "a runner is
up." Document in code comments on the schema column and in the DO
method that writes it.

### 6. Broadcast cadence

- Writing `last_event_ts` to D1 on **every runner event** (potentially
  hundreds per second during streaming) and fanning out via
  `broadcastSyncedDelta` would hammer UserSettingsDO — each sync
  frame round-trips through `/broadcast` on the user's DO.
- **Two-tier strategy:**
  - **Tier 1 (server state):** DO keeps an in-memory `last_event_ts`
    bumped on every event — no D1 write, no broadcast.
  - **Tier 2 (D1 + broadcast):** DO flushes `last_event_ts` to D1
    and broadcasts a synced-collection delta **only** on lifecycle
    transitions (init, result, gate open/close, error, onClose) **or**
    at most every 10s (rate-limited via `setTimeout` debounce).
- Client behaviour with Tier 2 cadence: `last_event_ts` refreshes ~
  every 10s during active streaming. The 45s TTL gives 3 refresh
  windows of slack before the client would flip to `idle`. Safe.
- Idle-connected case (runner waiting on `waitForNext()`): no events
  → no bump. Client correctly derives `idle` ~45s after the last
  `result`. **This is the desired behaviour** and sidesteps needing
  a revived heartbeat.

### Observability side-car: `session_state_changed`

Per user decision — wire the existing (currently-ignored)
`session_state_changed` event emitted by the runner
(`claude-runner.ts:589-601`) as a **read-only observability log** in
P2 of the spec. SessionDO logs the transitions it receives (console +
optional structured log) but does not act on them for status
derivation. This lets us compare SDK-reported state vs. TTL-derived
state in flight and gives us a tripwire if the two diverge badly.
No D1 column, no client exposure.

## Comparison

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Status quo** (event-sourced `status` in D1) | No migration; works when every branch writes | 20 write sites, any missed transition sticks forever; the current bug | Reject |
| **Guardrail** (keep `status`, add TTL watchdog) | Small diff, low risk | Still two sources of truth; stuck-state class not eliminated | Rejected by user ("go back to original") |
| **TTL-derived** (drop `status`, predicate) | Self-healing; one source of truth (`last_event_ts`); stuck states structurally impossible | ~150–200 LOC refactor across readers; requires `useNow()` tick; needs careful migration | **Recommended + chosen** |

## Questions answered

- Q: Can we reuse `lastActivity` as `last_event_ts`? → **No** (L35 of
  `schema.ts`), it's indexed for sidebar sort; high-frequency writes
  would thrash the index. Add a new column.
- Q: Do we need to revive heartbeat? → **No.** Real events cover the
  active case; idle-connected correctly derives `idle` after TTL.
- Q: Is `callback_token_active` reliable enough to drive `running` vs.
  `idle`? → **Not on its own.** It's always paired with the
  `last_event_ts` TTL check in the predicate. Documented as
  "token-intent, not runner-liveness."
- Q: How often do we broadcast `last_event_ts`? → **Lifecycle
  transitions + ≤10s debounce.** In-memory bump on every event, D1
  write + fanout only on the slower cadence.
- Q: Where does `deriveStatus` live? → `apps/orchestrator/src/lib/
  derive-status.ts`; called from every reader site
  (`useSession(...)`, sidebar, StatusBar, tabs).
- Q: Does `session_state_changed` drive status? → **No, side-car
  only.** Observability log in the DO to tripwire TTL vs. SDK drift.

## Recommendations

Ship the full TTL-derived plan from the GH#50 issue body. Concrete
phases:

1. **P1 — schema + DO state.** Migration 0017: add `last_event_ts`
   (INTEGER, nullable), `callback_token_active` (INTEGER, 0/1).
   Backfill `last_event_ts` from `lastActivity`. Add DO in-memory
   `last_event_ts` + debounced flush (10s, plus every lifecycle
   transition). Mirror `active_callback_token` nullability to the new
   bit. Keep `status` column for now; the DO still writes it.
2. **P2 — client derivation + side-car.** Add `derive-status.ts`,
   `useNow()` tick provider, swap ~20 reader sites to
   `deriveStatus(session, nowTs)`. Wire `session_state_changed` into
   a DO observability log (console + future structured log channel).
   `status` in D1 is still written but no longer read.
3. **P3 — cleanup.** Delete `HeartbeatEvent` (legacy). Stop writing
   `status` to D1. Follow-up migration 0018 drops the column.
   Delete `syncStatusToD1` helper. Delete
   `maybeRecoverAfterGatewayDrop`'s skip-recovery trap door — with
   TTL, the skip is benign (status flips to idle naturally).

## Open questions

- None that block the spec — user has made all 3 major scope calls
  (full replacement, side-car yes, Case A/B neither).

## Next Steps

- **P1 interview** — use `/kata-interview` to confirm phase
  ordering, migration rollout plan (backfill strategy), and whether
  any external consumers outside the app read `agent_sessions.status`
  directly (e.g., reporting queries) that would need migration
  coordination.
- **P2 spec writing** — produce `planning/specs/50-status-ttl.md`
  with B-IDs for each phase and acceptance criteria per behavior.
- **P3 review** via `/kata-spec-review`.
- **P4 close** — commit + push to main.
