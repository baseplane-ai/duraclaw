# Research: Session Tab Loading — Post-D1/TanStack-Merge Trace & Lag Analysis

**Date:** 2026-04-18
**Classification:** Feature research (diagnostic) — map current session-tab load path end-to-end, identify why the TanStack DB cache appears to lag the live WebSocket stream, and surface concrete improvements.
**Status:** Research complete — no code changes proposed beyond recommendations.
**Related specs:** `planning/specs/7-d1-partykit-migration.md` (the "D1 migration / TanStack DB merge" the user referenced — p4 "Client collections + OPFS race fix" shipped in April).

---

## TL;DR

The April D1/TanStack merge (spec #7) **did not move messages into a reactive collection**. It moved session-summary / tab / user-prefs metadata into D1 with PartyKit invalidation fanout, fixed the OPFS-init race, and unified `sessionsCollection` → `agentSessionsCollection`. Messages kept their pre-merge shape: a `LocalOnlyCollection` that is **write-behind-only** from the live WS stream and **read-once-on-mount** into React `useState`. The UI renders off that React state, not off the collection.

That architecture produces the exact "cache is stale / lags streaming" feel the user describes, for five concrete reasons — all documented below with file:line citations. The largest single fix is to make `messagesCollection` a **reactive source** (render via `useLiveQuery`) and delete the one-shot seed + local `setMessages` tree; the WS handler becomes a pure `collection.insert` call and the OPFS cache is always current with the render.

---

## 1. Entry point

| Step | File : line | What happens |
|---|---|---|
| 1 | `apps/orchestrator/src/routes/_authenticated/index.tsx:6-14` | Dashboard route; accepts `?session=<id>` search param. |
| 2 | `apps/orchestrator/src/routes/_authenticated/session.$id.tsx:18` | Legacy `/session/:id` is a redirect shim — converts path param to `?session=`. |
| 3 | `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx:28-32` | Reads `useSessionsCollection()` (which is `agentSessionsCollection` under a re-export). |
| 4 | `AgentOrchPage.tsx:45-61` | Deep-link effect: validates the session exists in the collection before calling `openTab()`. |
| 5 | Selected tab renders the session view, which instantiates `useCodingAgent(agentName)` — `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:92`. |

The user-visible "tab loading" is primarily steps 3–5.

---

## 2. Collection wiring (the merge outcome)

### 2a. `agentSessionsCollection` — the tab bar / session list

- `apps/orchestrator/src/db/agent-sessions-collection.ts:25-39` — `queryCollectionOptions` wrapping `GET /api/sessions`, `refetchInterval: 30_000`, `staleTime: 15_000`, OPFS-persisted (schema v3).
- `apps/orchestrator/src/db/sessions-collection.ts:1-8` — compat re-export kept for p4→p5 migration; TODO to delete.
- Post-merge invalidation channel (spec #7 p3/p4): `src/hooks/use-invalidation-channel.ts` — usePartySocket connects to `UserSettingsDO` (now a PartyKit Server) and on `{type:'invalidate',collection:'agent_sessions'}` calls `collection.utils.refetch()`. **This path is used by mutation endpoints, not by the live session's WS stream** — it's what keeps the tab bar fresh when *another* device changes things.

### 2b. `messagesCollection` — the chat-body cache

- `apps/orchestrator/src/db/messages-collection.ts:31-52` — **`localOnlyCollectionOptions`**. No `queryFn`, no sync adapter. This is a browser-only ring; the DO has no D1 messages table.
- `apps/orchestrator/src/hooks/use-messages-collection.ts:11-36` — `useLiveQuery` over the whole collection, filtered to `sessionId` in a `useMemo`, sorted by `createdAt` in JS.
- 30-day eviction (`messages-collection.ts:55-78`).

**This is the asymmetry.** The spec #7 merge treated messages as out of scope — only the *metadata* collections got the D1 + PartyKit-invalidation treatment.

---

## 3. Streaming path

Three parallel write paths feed the message UI. The render source is React `useState`, not the collection.

### 3a. WS push → React state + cache-behind

`use-coding-agent.ts:226-323` — `onMessage` handler on the `useAgent` socket:

| Wire event | Effect on React state | Effect on collection |
|---|---|---|
| `{type:'message', message}` (231-262) | `setMessages(upsert)` | `cacheMessage()` → `messagesCollection.insert` |
| `{type:'messages', messages}` bulk (265-281) | `setMessages(replace)`, flips `hydratedRef` | per-row `cacheMessage()` |
| `{type:'gateway_event', event}` (284-319) | `setEvents`, `setKataState`, `setContextUsage`, `setSessionResult` | — |

### 3b. RPC pull on first state broadcast

`use-coding-agent.ts:195-220` — inside `onStateUpdate`, on first fire only:
- `conn.call('getMessages', [{session_hint}])` → server returns the DO's in-memory history
- On empty + `sdk_session_id` set → single 500 ms retry (line 206-212, comment at 190-194 explains the cold-DO race).
- Hydrated messages are both `setMessages`'d and cache-behind written (`hydrateMessages` at 327-349).

### 3c. Cache-first seed (one-shot, at mount)

`use-coding-agent.ts:143-163` — `useMessagesCollection(agentName)` is read reactively, but the result is only copied into React state **once**, gated by `cacheSeededRef.current`. After the first copy, subsequent collection changes do **not** propagate to the UI — the UI is now owned by `setMessages`.

### 3d. Server-side broadcast ordering (DO)

`apps/orchestrator/src/agents/session-do.ts`:
- `appendMessage()` (persist to in-memory `this.session`) → `broadcastMessage()` (emit `{type:'message'}`) — append-then-broadcast, consistent across writers.
- On new WS connect: sends one `{type:'messages'}` with *current in-memory history*. **If the DO is cold, this is empty.**
- `hydrateFromGateway()` (session-do.ts:637-801) appends transcript rows fetched from the gateway into `this.session` but **does not broadcast** — it only materializes state for the next `getMessages` RPC reply.

---

## 4. Where the lag comes from

Five distinct staleness windows, in descending severity:

### L1. Collection is *not* the render source (structural)

`use-coding-agent.ts:147-163` copies the collection into `useState` exactly once, then the WS stream mutates both `setMessages` and the collection in parallel. The cache-behind `.insert()` on the OPFS SQLite is **not on the UI render path** — it happens *after* the render that already showed the new message. Any delay in the OPFS write (contention, WAL checkpointing, tab backgrounded) makes the collection legitimately lag what the eye already saw. On a tab switch a few seconds later you observe the cache behind live stream.

### L2. One-shot cache-first seed (`cacheSeededRef`)

`use-coding-agent.ts:149` — `if (cachedMessages.length > 0 && !cacheSeededRef.current && !hydratedRef.current)`. If the OPFS SQLite hydrates *after* the first render (still empty at render 1, populated at render 2), the seed never fires because `hydratedRef` may have flipped in the meantime. Result: the persisted cache is silently ignored on that mount. Subsequent OPFS changes also never update the UI because the collection is read but its updates are never mirrored back to `setMessages`.

### L3. Cold-DO RPC race (documented, mitigated)

`use-coding-agent.ts:190-212` documents this honestly: first `getMessages` RPC can return `[]` because `hydrateFromGateway` hasn't finished populating `this.session`. Mitigated by a single 500 ms retry. But:
- `hydrateFromGateway` writes to in-memory state *without broadcasting*, so any peer tab/device connected during hydration sees empty until *some subsequent* event triggers a broadcast.
- Retry is limited to one and gated on `sdk_session_id`; on slow gateways it's still possible to land with `hydratedRef=false` for longer than feels right.

### L4. Status mirror to `agentSessionsCollection` skips when absent

`use-coding-agent.ts:179` — `if (sessionsCollection.has(agentName))`. If the user opens a just-spawned tab before `/api/sessions` has refetched (15–30 s cadence), the WS bridge **drops** the status write. The tab bar shows stale status until the next QueryCollection refetch pulls it from D1. For a fresh `execute`, that can be 15 s.

### L5. Per-event cache-behind writes during streaming bursts

`use-coding-agent.ts:254-260` fires `messagesCollection.insert` on every `{type:'message'}`. Streaming deltas (`partial_assistant` from `thinking_delta` / `text_delta`) can come in dozens per second; each is an OPFS SQLite transaction. There is no batching. Even if L1 is fixed, the collection-as-source reactivity can visibly jitter behind the actual stream during fast bursts.

---

## 5. TODOs / comments already in the tree

| Where | Note |
|---|---|
| `src/db/sessions-collection.ts:1-3` | `TODO(#7 p5): delete this file` — compat shim; not a lag bug. |
| `src/db/agent-sessions-collection.ts:5-6` | Schema v3 drops post-refactor stale rows cleanly. |
| `src/db/db-instance.ts:10-13` | Documents the OPFS race that **was** fixed in p4 (don't read a mutable `persistence` export at module load). |
| `use-coding-agent.ts:190-194` | Documents L3 (the cold-DO RPC race) and why the retry exists. |
| `use-coding-agent.ts:172-178` | Documents why the WS bridge uses `utils.writeUpdate` instead of `.update()` on the QueryCollection. |
| `planning/specs/7-d1-partykit-migration.md` p4 | The "merge" the user remembers — client-collections + OPFS race fix. Explicitly scoped **not** to include messages. |

No open FIXME for the streaming-vs-collection lag. It's an unflagged design gap, not a bug.

---

## 6. Recommendations (ranked)

**R1. Flip `messagesCollection` to the render source.** Delete the `setMessages` React state in `useCodingAgent`; have the session view read `useMessagesCollection(sessionId)` directly. WS `onMessage` becomes a single `messagesCollection.insert(...)` / upsert. This is the largest single win: L1 disappears (collection *is* the view), L2 disappears (no seed gate), and OPFS cache is inherently current. The optimistic-user-message pattern (line 506-528) moves to a `createTransaction` with an `optimistic: true` flag the way TanStack DB already supports.

**R2. Broadcast on hydrate (DO side).** After `hydrateFromGateway` appends, broadcast `{type:'messages', messages: session.getHistory()}` to all connected WS clients on this DO. Kills L3 entirely — the 500 ms retry gate and `hasExistingSession` branch in `onStateUpdate` can be deleted. Peer tabs/devices get the fill too.

**R3. Upsert the WS-bridge status mirror.** Change `use-coding-agent.ts:179` from `if (sessionsCollection.has(agentName))` to an insert-or-update. Better: have the DO push the session summary over PartyKit invalidation right after spawn, so the QueryCollection refetch runs on event, not on 15 s timer. Kills L4.

**R4. Batch cache-behind writes (only needed if R1 not done).** Coalesce high-frequency `partial_assistant` inserts in a microtask queue and flush once per animation frame. Relieves L5.

**R5. Persist messages to D1 + add a shape-based sync.** The true structural fix. Make messages a real synced TanStack DB collection, backed by a `messages` table in D1 written from the DO's append path, read via a Query or Electric-shape collection. WS stream becomes a live-update fast path; the collection remains authoritative. Lets the sidebar show "last message" previews, cross-device history, offline-read. Large lift — propose as spec #8.

**R6. Telemetry before/after.** Add two `performance.mark`s — `ws.message.received` and `collection.message.rendered` — so the lag delta is measurable. Today the complaint is qualitative; make it numeric so the fix is gated on evidence.

---

## 7. Scope of the April merge (what the user remembers)

From `planning/specs/7-d1-partykit-migration.md`:

- **In scope:** `agent_sessions` / `user_tabs` / `user_preferences` → D1 + Drizzle; `UserSettingsDO` → PartyKit fanout; client collections + OPFS race fix; tab-bar join; delete ProjectRegistry at cutover.
- **Out of scope:** message storage. Messages remained in the DO's in-memory Session tree and the on-disk SDK transcript the gateway owns.

So the user's instinct is correct on the ground-truth: the merge made the *session list* and *tab bar* feel snappier and consistent, but the *message body* was not modernized at the same time. R1 + R2 are the highest-value follow-ups in the same architectural direction.

---

## Citations

- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:92-349` — the hook wiring everything together.
- `apps/orchestrator/src/db/messages-collection.ts:31-52` — LocalOnlyCollection shape.
- `apps/orchestrator/src/hooks/use-messages-collection.ts:11-36` — live-query read path.
- `apps/orchestrator/src/db/agent-sessions-collection.ts:25-59` — QueryCollection + OPFS persist.
- `apps/orchestrator/src/db/db-instance.ts:27-54` — `dbReady` top-level-await contract.
- `apps/orchestrator/src/agents/session-do.ts:637-801, 1411-1458` — `hydrateFromGateway`, `getMessages`, `appendMessage` then `broadcastMessage`.
- `planning/specs/7-d1-partykit-migration.md` p3–p4 — the merge the user is comparing against.

---

## 8. Debug-route prototype plan (for R1)

Stated intent (2026-04-18 follow-up): prove that `messagesCollection` can be the sole render source in an **isolated debug route** before touching `useCodingAgent` / `AgentOrchPage` / the production message renderer.

Note on framing: `useAgent`'s built-in `state` sync (SessionState auto-broadcast from the Agents SDK) already gives us live-reactive session metadata without a collection. The thesis for R1 is to do the **same thing for messages** — but since the SDK doesn't push the message list as `state` (custom `onMessage` events instead), we bridge via `messagesCollection` and render reactively off `useLiveQuery`.

### 8.1 Scope (what the debug route does / doesn't touch)

| Status | File |
|---|---|
| **ADD** | `apps/orchestrator/src/routes/_authenticated/debug.session-collection.tsx` — TanStack Start route at `/debug/session-collection?session=<id>`, dev-gated (`import.meta.env.DEV` or `DEBUG_ROUTES` flag). |
| **ADD** | `apps/orchestrator/src/features/agent-orch/use-coding-agent-collection.ts` — prototype hook: same `useAgent` connection, no `useState<SessionMessage[]>`, collection-only read path. |
| **ADD** | `apps/orchestrator/src/features/agent-orch/debug/CollectionMessageView.tsx` — minimal message list component that reads `useMessagesCollection(sessionId)` directly. |
| **ADD** | `apps/orchestrator/src/features/agent-orch/debug/lag-probe.ts` — `performance.mark` helpers (`ws.received`, `collection.inserted`, `dom.painted`) and a console-table dumper. |
| **UNCHANGED** | `use-coding-agent.ts`, `AgentOrchPage.tsx`, `messages-collection.ts` (extend only if a primitive is missing — use the existing `.insert` / `.update` / `.delete` API first). |

### 8.2 Hook shape (`use-coding-agent-collection.ts`)

```
function useCodingAgentCollection(agentName: string) {
  // 1. Read path: live-query the collection as the sole message source.
  const { messages } = useMessagesCollection(agentName)

  // 2. WS: same useAgent subscription, but onMessage writes to the collection.
  const connection = useAgent<SessionState>({
    agent: 'session-agent',
    name: agentName,
    onStateUpdate: (s) => {
      setState(s)                         // keep SDK state reactive as-is
      if (!hydratedRef.current) {
        hydrateMessagesToCollection(conn) // fills via getMessages RPC → collection
      }
    },
    onMessage: (evt) => {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === 'message')  upsertMessage(parsed.message)
      if (parsed.type === 'messages') bulkUpsert(parsed.messages)
      // gateway_event / kata / context_usage stay in local state for prototype
    },
  })

  // 3. Write path: upsert-by-id into the collection.
  const upsertMessage = (m: SessionMessage) => {
    if (messagesCollection.has(m.id)) messagesCollection.update(m.id, (d) => Object.assign(d, toRow(m, agentName)))
    else                              messagesCollection.insert(toRow(m, agentName))
  }

  // 4. Optimistic send: insert tagged row, reconcile on echo, delete on failure.
  const sendMessage = async (content) => {
    const optId = `usr-optimistic-${Date.now()}`
    messagesCollection.insert({ id: optId, sessionId: agentName, role: 'user', parts, optimistic: true })
    const res = await connection.call('sendMessage', [content])
    if (!res.ok) messagesCollection.delete(optId)
    // happy path: server echo arrives via onMessage; echo carries real id;
    // reconciler deletes the optimistic row when a non-optimistic user row
    // with matching content shows up (or within 2s timeout).
  }

  return { messages, state, sendMessage, ... }
}
```

Key differences from production `useCodingAgent`:
- **Zero `useState` for messages** — line 95 (`const [messages, setMessages]`) and the cache-first seed effect (lines 147-163) disappear.
- **No `cacheSeededRef` / `knownEventUuidsRef` / `optimisticIdsRef`** — the collection *is* the set; dedup is inherent via `getKey`.
- **Upsert semantics** replace the `setMessages(prev → upserted)` reducer dance on every `onMessage`.
- **Optimistic rollback** via `.delete(optId)` rather than filtering React state.

### 8.3 Renderer (`CollectionMessageView.tsx`)

- Takes `messages: SessionMessage[]` from the hook.
- Each row is a memoized `<MessageItem>` keyed on `message.id` so `partial_assistant` updates only re-render the streaming row.
- No virtualisation for the prototype — we want full-list reactivity to be the benchmark baseline.
- A small footer strip renders the lag-probe numbers live (p50/p95 ws→paint delta for the current session).

### 8.4 Verification checklist (drives the prototype's go/no-go)

| # | Scenario | Expected |
|---|---|---|
| V1 | Cold OPFS (incognito) | First paint empty → WS `{type:'messages'}` populates collection → list appears in one frame. |
| V2 | Warm OPFS | First paint shows cached rows before WS connects. |
| V3 | 30-turn streaming `partial_assistant` burst | Only the streaming row re-renders; list-wide render count matches turn count, not delta count. |
| V4 | Optimistic send happy path | Optimistic row appears in the same tick as the user hit enter; server echo replaces it without visual flash. |
| V5 | Optimistic send failure (mock `__mockSendFailure`) | Optimistic row removed within 200 ms. |
| V6 | Tab switch to another session | Query re-filters instantly; zero message bleed from previous session. |
| V7 | Two browser tabs to the same session | Both render identical list; WS events upsert idempotently; no dupes. |
| V8 | Cold-DO RPC race | `getMessages` returns empty → 500 ms retry still works → collection fills on retry → UI reacts without rerunning `useEffect` boilerplate. |
| V9 | Streaming burst under throttled CPU (4×) | Collection-backed render stays within 16 ms frame budget; measure p95 `ws.received → dom.painted` delta. |
| V10 | 30-day eviction | `evictOldMessages()` on mount deletes stale rows; UI reacts (rows disappear). |

### 8.5 Risks to surface early (before going prod-wide)

| Risk | Mitigation in the prototype |
|---|---|
| `useLiveQuery` re-runs filter+sort in JS on every insert — O(n) on 1000+ rows. | Measure V9 at realistic history depth (replay a long session). If p95 > 16 ms, add a paginated/windowed query (last 200 + lazy older) before R1 lands in prod. |
| LocalOnlyCollection may not support atomic transactions for insert+delete (optimistic reconcile). | Confirm against `@tanstack/db` docs; fall back to sequenced `.delete` + `.insert` with a short reconcile window. |
| Optimistic-vs-echo ID reconciliation — server picks a different id than the optimistic `usr-optimistic-*`. | Keep an in-memory `optimistic → echoed` map in the hook for ~2 s; delete the optimistic row when the echo arrives. Collection dedup handles the rest. |
| OPFS write throughput under streaming bursts (L5 in §4). | Add a microtask batcher in the prototype (`queueMicrotask(flush)`) as an opt-in flag; verify V9 with/without. |
| `useAgent` reconnect path may re-fire `{type:'messages'}` bulk → duplicate inserts. | Already handled by upsert-by-id; verify explicitly in V7. |

### 8.6 Parked for future prototypes (not in this route)

- **DO-side broadcast-on-hydrate (R2)** — can be prototyped in a parallel feature branch against the DO; completely orthogonal to the client debug route.
- **`agentSessionsCollection` status mirror via `useAgent.state` subscriber** — fold once R1 lands; small diff, not worth a separate route.
- **D1-backed messages (R5)** — wait for R1 signal before proposing as spec #8. If R1's perf numbers are good enough, R5 becomes strictly an "offline + cross-device" win, not a latency fix.

### 8.7 Go/no-go criteria for promoting R1 to the main route

Promote if **all** of V1–V10 pass AND the debug-route p95 `ws.received → dom.painted` is **within 20% of the current `setMessages` baseline** at equivalent history depth. Otherwise, iterate on the paginated-query fallback before merging.
