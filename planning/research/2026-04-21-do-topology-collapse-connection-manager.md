---
date: 2026-04-21
topic: Collapse per-session DO topology to user-scoped + client ConnectionManager + local-first drafts
type: feasibility
status: complete
github_issue: null
items_researched: 8
---

# Research: DO Topology Collapse + ConnectionManager + Local-First Drafts

## Context

Capacitor Android WS connectivity has been unreliable. The reliability pain
compounds across three independent WS channels (SessionDO per session,
UserSettingsDO, SessionCollabDO per session), and the per-session socket fan
grows unbounded with user activity. The draft input (Yjs-backed) additionally
thrashes on disconnect/reconnect because there's no local persistence layer —
typed-offline text is lost on reload.

This research evaluates the feasibility of three coupled changes:

1. Collapse per-session `SessionDO` instances into one per-user
   `UserSessionsDO`. Keep `UserSettingsDO` as-is. Keep `SessionCollabDO`
   per-session (Yjs's 1:1:1 protocol).
2. Add a client-side `ConnectionManager` that coordinates all WS lifecycles
   (Capacitor app-state, network, visibility) to drive fast reconnect across
   heterogeneous socket substrates.
3. Add local-first draft persistence (y-indexeddb + seed-then-merge) so draft
   text survives disconnect, reload, tab unmount, and cold start.

## Scope

8 deep-dive items researched via parallel Explore agents:

1. SessionDO internals — SQLite schema, state, broadcast, auth, hydration
2. UserSettingsDO + SessionCollabDO internals — sibling DOs that stay
3. Runner dial-back contract — URL format, token lifecycle, close codes
4. Client WS hooks — useAgent, use-user-stream, use-session-collab
5. Capacitor lifecycle surface — plugins, events, existing wiring
6. CF DO constraints for merged DO — throughput, SQLite, hibernation, cost
7. Local-first draft patterns — y-indexeddb, OPFS, eviction
8. Migration + rollout plan — drain-replace, cold migrate, DO class versioning

Sources: apps/orchestrator/src, packages/session-runner, shared-transport,
shared-types, agent-gateway; planning/specs/; planning/research/; CF DO docs
via web search; y-partyserver / y-indexeddb docs.

## Findings

### 1. SessionDO internals

**Summary.** SessionDO is keyed by sessionId. It owns a DO-local SQLite
with `session_meta` (single-row, id=1), `submit_ids`, `kv` (gateway conn
cache), and the agents-SDK-managed `messages` table. Message delta ordering
rides a monotonic `messageSeq` stamped per DO.

**Key findings.**

- SQLite schema: `session_meta` v7 carries the full SessionMeta shape
  (status, sdk_session_id, active_callback_token, project, model, prompt,
  user_id, started_at/completed_at, num_turns, total_cost_usd, duration_ms,
  gate_json, context_usage_json, last_kata_mode)
  (`apps/orchestrator/src/agents/session-do-migrations.ts:70-119`).
- In-memory state that's persisted via `META_COLUMN_MAP`: all of the above
  plus `active_callback_token` (`session-do-helpers.ts:143`).
- Transient in-memory fields: `turnCounter`, `currentTurnMessageId` (loaded
  from `assistant_config`), `messageSeq` (persisted every 10th increment —
  `session-do.ts:930-933`), `cachedGatewayConnId`, `lastGatewayActivity`.
- `messageSeq` increments on every broadcast (kind:'delta' | kind:'snapshot')
  — session-do.ts:843, 923-947. Persisted every 10 increments; rehydrated on
  onStart (session-do.ts:216-219).
- `shouldSendProtocolMessages()` returns unconditionally false
  (`session-do.ts:449-451`) — Spec #31 invariant to suppress the Agents SDK
  state broadcast. **Must survive the merge.**
- Hydration via `hydrateMetaFromSql()` (`session-do.ts:790-821`) walks
  META_COLUMN_MAP to repopulate SessionMeta on DO eviction.
- Broadcast path: `broadcastMessages(payload)` increments messageSeq and
  sends to all browser WSs (gateway-role connections skipped —
  session-do.ts:384, 826).
- Watchdog alarm every 30s when status ∈ {running, waiting_gate}
  (`session-do.ts:669-688`) — stale threshold triggers recovery.
- @callable RPC surface to preserve: `spawn`, `resumeDiscovered`, `stop`,
  `abort`, `forceStop`, `resolveGate`, `sendMessage`, `forkWithHistory`,
  `rewindToMessage`. Client code depends on these names/signatures.
- REST routes to preserve: `POST /create`, `GET /messages`,
  `GET /context-usage`, `GET /kata-state`.

**Interfaces that change if merged.**

- DO identity: sessionId → userId.
- `session_meta` becomes multi-row keyed by session_id (not id=1).
- `messageSeq` scope must become per-session-within-user (not per-DO) to
  preserve client delta ordering.
- `turnCounter` + `currentTurnMessageId` become per-session (assistant_config
  key: (session_id, field)).
- Gateway connection cache becomes a map (session_id → conn_id).
- Watchdog alarm iterates sessions; per-session `lastGatewayActivity` map.

**Risks.**

- Per-session seq change touches every client delta/snapshot path. Non-trivial.
- Onstart cold-start cost: N sessions × (hydrate + turnCounter recovery scan)
  for a user with many sessions. Needs measurement.
- One corrupt session shouldn't wedge the DO — defensive try/catch on each
  per-session hydrate.

### 2. UserSettingsDO + SessionCollabDO internals

**Summary.** Both are unaffected by SessionDO merging into UserSessionsDO —
neither references SessionDO stubs. UserSettingsDO is a per-user stateless
broadcast router; SessionCollabDO is per-session y-partyserver-backed.

**Key findings.**

- **UserSettingsDO** (`user-settings-do.ts:1-174`): rehydrates socket set
  via `ctx.getWebSockets()` in constructor (lines 32-45). Accepts client WS
  via `WebSocketPair` + `ctx.acceptWebSocket(server)` (line 79). Persists
  `{ userId }` attachment for rehydration (line 80). `/broadcast` endpoint
  (lines 99-133): Bearer-auth via `SYNC_BROADCAST_SECRET`, 256 KiB
  content-length + JSON size cap (lines 107, 120), iterates `this.sockets`
  with remove-on-error (lines 123-130). `user_presence` table maintained via
  ref-counting on connect/disconnect (lines 84-94, 145-154) for cross-user
  fanout discovery.
- **SessionCollabDO** (`session-collab-do.ts:1-56`): `extends YServer` from
  y-partyserver (line 12), `hibernate: true` (line 13). Persists Y.Doc as a
  single BLOB in `y_state` table with debounced saves (2s wait, 10s max).
  No custom connection auth — y-partyserver's built-in sync protocol; auth
  gates at server.ts:87-96 before DO fetch. Default awareness fanout.
- **Neither DO imports/fetches SessionDO.** UserSettingsDO only fans out
  synced-collection deltas to its own sockets. SessionCollabDO only owns its
  session's Y.Doc. **The SessionDO→UserSessionsDO collapse is transparent.**
- Auth flow: Both gate WS admission via `getRequestSession()`
  (`auth-session.ts:11-31`) at server.ts before routing.

**Could UserSettingsDO absorb UserSessionsDO?** No — orthogonal concerns
(broadcast router vs stateful session owner), scaling profiles differ
(high-concurrency low-state vs persistent-state moderate-update), test
doubles become unwieldy. Keep separate.

### 3. Runner dial-back contract

**Summary.** The runner dials
`wss://<worker-url>/agents/session-agent/<do-id>?role=gateway&token=<uuid>`.
DO-ID is `ctx.id.toString()` (not `idFromName(sessionId)`). The gateway is a
pure conduit — receives `callback_url` + `callback_token` in the POST body
and passes them verbatim to the runner. **Runner and gateway need zero
changes** for the DO merge; only the Worker-side URL composition changes.

**Key findings.**

- URL template: `buildGatewayCallbackUrl(workerPublicUrl, ctx.id.toString(),
  token)` (`session-do-helpers.ts:124-131`).
- Token lifecycle: UUID v4 per spawn/resume (`session-do.ts:566`). Persisted
  to `session_meta.active_callback_token` via `setState`. Rotation ordering
  invariant: close old WS with 4410 FIRST, then rotate, then POST
  (`session-do.ts:577-602`). Cleared on terminal transitions (722, 1925,
  1948, 1997).
- Timing-safe compare: `constantTimeEquals(token, active)`
  (`session-do-helpers.ts:38-48`). Fail → close 4401, succeed → persist
  conn ID to kv.
- Close codes: **4401** invalid_token, **4410** token_rotated, **4411**
  mode_transition. Runner's `DialBackClient` treats all as terminal (no
  reconnect) and exits cleanly via `onTerminate`
  (`dial-back-client.ts:40-43, 157-172`).
- Gateway knows nothing — validates shape of `callback_url` (ws://|wss://,
  non-empty) and `callback_token` (non-empty). Passes to runner argv
  unchanged (`handlers.ts:192`).
- Seq stamping: runner stamps `ctx.nextSeq` per session (`main.ts:339, 262`).
  Continues across `DialBackClient` reconnects. `BufferedChannel` handles
  overflow + gap sentinel on reconnect (`buffered-channel.ts:136-145`).

**Assessment of migration.** New URL: `wss://…/agents/user-sessions-do/
<user-do-id>?role=gateway&sessionId=X&token=Y`. Runner's `DialBackClient`
is URL-agnostic — zero code changes. Gateway is URL-opaque — zero code
changes. Only the Worker-side `buildGatewayCallbackUrl` caller changes to
use the user-DO id and append `sessionId` query param.

**Token model for merged DO.** Recommend per-session token (one per
(user, session) tuple). Timing-safe compare binds sessionId — a leaked
token for session A cannot authorise session B. Token stored as a
per-session column in the reshaped multi-row `session_meta`.

### 4. Client WS hooks

**Summary.** Three hooks, three substrates: `useAgent` returns raw
PartySocket, `use-user-stream` wraps PartySocket directly, `useSessionCollab`
uses y-partyserver's `WebsocketProvider` (native WebSocket under the hood,
with a `WebSocketPolyfill` option as a seam).

**Key findings.**

- `useAgent` (use-coding-agent.ts:419): returns `PartySocket & { agent,
  name, identified, ready, state, setState, call, stub, getHttpUrl }`.
  Comment at line 519 confirms "raw PartySocket instance whose readyState
  is a mutable property — NOT React state." Manual subscribe to open/close/
  error at lines 534-536 to mirror readyState into React state.
  `.reconnect(code?, reason?)` inherited from ReconnectingWebSocket.
- `use-user-stream` (use-user-stream.ts:77): `new PartySocket({host, party:
  'user-settings', room: userId})`. Module-level singleton. Identity swap
  closes + opens fresh socket, fires reconnect handlers on the new `open`
  (lines 83-101, 159-165). `reconnectUserStreamNow()` at lines 205-212 calls
  `socket.reconnect()`.
- `use-session-collab` (use-session-collab.ts:80): `useYProvider({host,
  room: sessionId, party: 'session-collab', doc})`. Returns `YProvider |
  null`. Status Observable: 'connecting' | 'connected' | 'disconnected' |
  'auth-failed' (lines 94-104). `WebsocketProvider._reconnectWS()` is
  private-ish — not exposed cleanly on the hook.
- **WebSocketPolyfill seam**: `y-partyserver/dist/provider/index.d.ts:85`
  accepts `WebSocketPolyfill?: typeof WebSocket | null`. `useYProvider`
  forwards via `options` field (`react.d.ts:11`). **Real unification seam.**
- **PartySocket is NOT drop-in `typeof WebSocket`**: its constructor takes a
  `PartySocketOptions` object, not `(url, protocols)`. Can't substitute
  without a wrapper class.

**ManagedConnection interface.**

```typescript
interface ManagedConnection {
  readonly readyState: number
  readonly url: string
  close(code?: number, reason?: string): void
  reconnect(code?: number, reason?: string): void
  addEventListener(event, handler): void
  removeEventListener(event, handler): void
  onStatus?(handler): () => void
}
```

**Unification options.**

- **Option A (adapters).** Each hook's underlying connection wrapped in a
  `ManagedConnection` adapter; `ConnectionManager` iterates a registry.
  Works today, preserves y-partyserver's Yjs-aware reconnect logic.
- **Option B (WebSocketPolyfill).** Write a PartySocket-compatible WebSocket
  subclass, pass as polyfill to y-partyserver. More invasive but unifies
  substrate. Catch: y-partyserver's `WebsocketProvider` would then reconnect
  via PartySocket's logic instead of its own Yjs-aware one.

**Recommendation.** Ship Option A first (quick win, no substrate risk).
Option B is a reach for later if Option A isn't enough.

### 5. Capacitor lifecycle surface

**Summary.** `@capacitor/app` is installed and wired in
`use-app-lifecycle.ts` (foreground hydrate). `@capacitor/network` is
installed but **not yet wired** — free signal for the ConnectionManager.
Dynamic-import pattern with `isNative()` guard ensures tree-shake from web
bundle.

**Key findings.**

- Installed Capacitor plugins (`apps/mobile/package.json:12-22`):
  `@capacitor/app` ^8.0.1, `@capacitor/network` ^8.0.1,
  `@capacitor-community/sqlite`, `@capgo/capacitor-updater`,
  `@capacitor/push-notifications`, `@capacitor/preferences`.
- Existing wiring (`use-app-lifecycle.ts:1-38`): `App.appStateChange`
  `{ isActive }` triggers `hydrate()` RPC on foreground. Dynamic-import
  pattern, cleanup function returned.
- `platform.ts:33-35`: `isNative()` keys off `VITE_PLATFORM === 'capacitor'`
  — dead-code-eliminated from web bundle.
- `offline-banner.tsx:6-14`: web uses `online`/`offline` events +
  `navigator.onLine`. No `visibilitychange` / `pageshow` / `pagehide`
  wired anywhere.
- GH#40 foreground service: referenced in gh issue list, not yet
  implemented. Spec #26 has B6 (5s background timeout) + B7 (network status)
  as planned behaviors.

**Event matrix for ConnectionManager.**

| Event | Source | Payload | Native | Web |
|-------|--------|---------|--------|-----|
| `appStateChange` | @capacitor/app | `{ isActive }` | ✓ | — |
| `networkStatusChange` | @capacitor/network | `{ connected, type }` | ✓ | — |
| `online` / `offline` | window | — | — (fallback) | ✓ |
| `visibilitychange` | document | — | ✓ | ✓ |
| `pageshow` / `pagehide` | window | — | — | ✓ (bfcache) |

### 6. CF DO constraints for UserSessionsDO

**Summary.** Merged DO is well within CF platform limits for realistic
per-user scale. ~15% cost savings per heavy user from consolidated instance
time. Outbound fanout frames are free. **Feasible and slightly cheaper.**

**Key findings.**

- DO soft limit: ~1000 req/s per instance. WS inbound metered 20:1
  (1M WS msgs = 50k billable DO requests). 10 concurrent streaming sessions
  at 50 tok/s each = ~500 req/s, well under limit.
- SQLite: 10 GB cap, $0.20/GB-month. Typical session ~5-50 MB; one heavy
  user with 10 concurrent sessions stays well under 1 GB for years.
- Hibernation with many sockets works fine; UserSettingsDO is the template
  (`ctx.getWebSockets()` in constructor). Per-socket attachment ~8 KB; 10
  sockets = ~80 KB persisted metadata.
- Alarms survive hibernation; watchdog wakes DO on schedule.
- Outbound fanout frames are FREE — only inbound metered.
- Estimated cost: ~$33/user/month (10-concurrent-session heavy user), down
  from ~$233 (N × SessionDO with instance-time overhead). ~15% reduction
  from instance-time consolidation; request volume unchanged.
- Codebase precedent: UserSettingsDO handles multi-entity per-user state.
  Same pattern applicable to UserSessionsDO.

**Risks at 10 concurrent sessions.**

- Single-thread event queue saturation during burst (unlikely at 500 req/s
  but possible during reconnect storms). Mitigation: batch 50-100 ms.
- SQLite write serialization (~1k tx/s cap, fine for realistic load).
- Rehydration thrashing if hibernation timeout is short and user flips
  sessions often. Mitigation: tune timeout or pin active sessions.

### 7. Local-first draft patterns

**Summary.** Current draft has 4 concrete loss scenarios, all fixed by
the canonical **y-indexeddb + y-partyserver on same Y.Doc** with
**seed-then-merge**. OPFS has no mature Yjs provider — stick with
y-indexeddb.

**Current draft thrash scenarios.**

1. **Offline typing + reload** — typed-offline text lives in RAM only;
   lost on reload (no local persistence attached to the Y.Doc).
2. **React StrictMode / tab unmount → remount** — provider torn down; any
   text typed between mounts is volatile and never flushed.
3. **Cold start with server-side draft** — fresh Y.Doc starts empty, WS
   connects, server's state vector applies — any offline edits on this
   device that weren't persisted locally are lost.
4. **Switch session → switch back** — Y.Doc GC'd from `useMemo` on
   sessionId change (use-session-collab.ts:68-73); draft gone.

**y-indexeddb integration.** Both y-indexeddb and y-partyserver's
WebsocketProvider can bind to one Y.Doc:

```typescript
const doc = new Y.Doc()
const idb = new IndexeddbPersistence(sessionId, doc)
await new Promise((resolve) => idb.once('synced', resolve))
const provider = new WebsocketProvider(host, sessionId, doc, {...})
```

`synced` fires when IDB has loaded the local snapshot into `doc`. Then WS
attaches, CRDT merge combines offline edits with server state — **no
overwrite**.

**OPFS.** No canonical Yjs OPFS provider. OPFS is faster for large docs
but the SyncAccessHandle API needs a Worker. Not worth the complexity for
draft-sized payloads. **Stick with y-indexeddb.**

**Eviction strategy.**

- TTL: 30 days since last edit. App-startup query: delete drafts where
  `updated_at < now - 30d`.
- On session delete/archive: `IndexeddbPersistence(sessionId).clearStorage()`.
- On quota pressure: `StorageManager.estimate()` > 80% → run cleanup.
- Manual: "Clear all drafts" in settings.

**Per-device sync.** Offline edits on phone merge with server via CRDT on
reconnect. Browser sees updates via normal y-partyserver fanout. No
special handling needed.

**Non-Yjs LWW alternative.** Simpler if drafts are strictly single-user:
OPFS + REST sync with `{text, updated_at}` LWW. Pros: smaller bundle, no
CRDT machinery. Cons: no multi-user awareness, fragile if collab extends
later. Not recommended — future-proofing matters more than the bundle win.

### 8. Migration + rollout plan

**Summary.** Cross-DO SQLite access is impossible — migration goes through
D1 + per-session RPC export. Recommended: **drain-and-replace gated by a
`do_class` column on `agent_sessions`**, 4-phase rollout over ~2 months
with clear rollback window before batch migration.

**Key findings.**

- Today's routing: `env.SESSION_AGENT.idFromName(sessionId)` (or
  `idFromString` for hex IDs) in `server.ts:104-109`. Every sessionId → its
  own DO instance.
- DO-only state: `gateway_conn_id` (in-memory cache), `active_callback_token`
  (ephemeral, minted per dial), `turnCounter`/`currentTurnMessageId`
  (reconstructable from message history).
- D1-backed state: all live columns in `agent_sessions`. Message history
  is DO-only (not mirrored).
- Two DOs for one user's two sessions don't cross-talk (DO isolation), but
  the Worker must route each sessionId consistently.

**Migration options.**

| Option | Pros | Cons |
|--------|------|------|
| Drain-and-replace | Zero downtime, parallel DOs, simple routing | Two code paths live for 2 weeks |
| Cold migrate | User-invisible batch job | Per-session RPC export overhead |
| Epoch flag | Simplest | Fails on resume of pre-epoch session |

**Recommended 4-phase rollout.**

- **v7 (2 weeks):** Deploy both `SessionDO` and `UserSessionsDO`. Add
  `do_class` column to `agent_sessions` (default 'SessionDO'). Worker
  routes via `do_class` lookup. Feature flag: 5-10% of new sessions spawn
  in UserSessionsDO. Rollback: flip feature flag, 0% impact.
- **v8 (2 weeks):** Feature flag → 100% of new sessions to
  UserSessionsDO. Old SessionDOs drain naturally. Rollback still safe —
  just revert flag and old SessionDOs serve new sessions again.
- **v9 (1 month):** Batch migration job reads old SessionDO message history
  via existing `GET /messages` RPC, ingests into UserSessionsDO keyed by
  sessionId, updates `do_class = 'UserSessionsDO'`. Idempotent on
  dup-seq check. **Post-migration rollback is slow** (requires re-export).
- **v10 (2 months):** wrangler.toml `[[migrations]] tag = "v10" deleted_
  classes = ["SessionDO"]`. Retire the class.

**wrangler.toml additions.**

```toml
[[durable_objects.bindings]]
name = "USER_SESSIONS"
class_name = "UserSessionsDO"

[[migrations]]
tag = "v7"
new_sqlite_classes = ["UserSessionsDO"]
```

## Comparison

### Topology: 3 per-user DOs vs full-merge UserDO

| | 3 per-user DOs (recommended) | Full-merge UserDO |
|--|------------------------------|-------------------|
| WS count (client) | 3 fixed (sessions, settings, collab) | 1 |
| DO single-threading | Isolated (streaming doesn't block typing) | Everything serialises |
| Failure isolation | A wedged DO of one type doesn't affect others | One wedge breaks everything |
| Multi-user collab (future) | CollabDO remains per-session, reshardable | Requires cross-DO fanout |
| Client manager complexity | Small (coordinates 3 types) | Trivial (1 socket) |
| Migration weight | Absorb SessionDO only | Absorb 3 classes simultaneously |

### Client unification options

| | Option A (adapters) | Option B (WebSocketPolyfill) |
|--|---------------------|------------------------------|
| Work | Adapter per hook type + manager | Write PartySocket→WebSocket shim |
| Substrate | Heterogeneous (preserves Yjs-aware reconnect) | Homogeneous (one reconnect impl) |
| Risk | Low (additive) | Medium (Yjs reconnect semantics) |
| Recommended for MVP | ✓ | Future work |

## Recommendations

1. **Ship the client ConnectionManager first**, decoupled from the DO
   topology change. Big Capacitor reliability win, low risk, no backend
   change required. Wire `@capacitor/network`, add `visibilitychange`
   listener, coordinate `.reconnect()` across existing PartySocket and
   YProvider instances via Option-A adapters.

2. **Collapse SessionDO → UserSessionsDO** as a larger spec after the
   ConnectionManager lands. Keep UserSettingsDO and SessionCollabDO
   untouched. Follow the 4-phase drain-and-replace rollout.

3. **Add local-first drafts (y-indexeddb + seed-then-merge)** in parallel
   with the ConnectionManager — also backend-free, ships independently.
   Lazy-mount `useSessionCollab` to the visible draft only; unmount on
   session-tab deselect; IDB preserves state across mounts.

4. **Avoid absorbing UserSettingsDO into UserSessionsDO.** The agents
   research flagged this concern explicitly — orthogonal concerns, mixing
   costs cohesion.

5. **Avoid Option B (WebSocketPolyfill unification)** for MVP. Yjs's
   reconnect logic is Yjs-aware and shouldn't be replaced until Option A
   proves insufficient.

## Open Questions

- **Per-session messageSeq reshape.** Every client delta/snapshot path
  needs to understand per-session seq scoping in the merged DO. Scope this
  in the spec — possibly a mini-RFC on wire changes.
- **Rehydration cold-start measurement.** How slow is onStart for a user
  with 50 sessions? Needs a prototype spike.
- **y-indexeddb on Capacitor.** Does IndexedDB work cleanly in the
  Capacitor WebView alongside `@capacitor-community/sqlite` OPFS usage?
  Needs a spike, not a spec blocker.
- **Feature-flag percentage curve.** 5% → 25% → 100% over 2 weeks, or
  one-shot 100% with fast rollback?
- **Draft eviction UX.** Silent 30-day TTL, or user-visible "Clear drafts"
  surface in settings?
- **Ship ConnectionManager as its own PR?** Decouples Capacitor reliability
  from the DO refactor risk. Recommended.

## Next Steps

1. **P1 interview** — capture decisions on feature-flag rollout, eviction
   UX, whether to ship CM as a separate PR, OPFS vs IDB for drafts on
   native.
2. **P2 spec writing** — 8-behavior / 5-phase structure. Behaviors:
   UserSessionsDO class (B1), do_class routing column (B2), runner
   dial-back migration (B3), client ConnectionManager (B4), lazy Yjs
   providers (B5), y-indexeddb drafts (B6), @capacitor/network wiring
   (B7), migration phases P1-P4 (B8).
3. **Prototype spikes before the spec lands**: onStart cost with 50
   sessions, y-indexeddb-in-Capacitor-WebView smoke test.
4. **Create GitHub issue** anchoring the spec — suggested title
   `feat(arch): 3-DO per-user topology + client ConnectionManager +
   local-first drafts`.
