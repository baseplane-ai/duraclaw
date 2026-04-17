---
type: research
classification: feasibility-study
status: draft
created: 2026-04-17
workflow: RE-13eb-0417
related:
  - planning/research/2026-04-16-state-management-audit.md
  - planning/specs/0008-yjs-blocknote-realtime-docs-sync.md
---

# Yjs for Tab Metadata + Chat Input Sync — Feasibility Study

## Prompt

> "The chat input sync is not working and continuously shows previously submitted
> messages. What if we converted the entire tab sync into Yjs rather than trying
> to do manual syncing? The metadata becomes Yjs and the input box becomes a Yjs
> doc — this is all natively supported in Durable Objects."

## TL;DR

- **The bug is real and small.** Stale drafts resurface because of a race between
  synchronous `localStorage` clear and the 500 ms debounced collection write in
  `saveDraft()`. It can be fixed in ~10 lines without touching transport.
- **Yjs on Durable Objects is a supported pattern** (community libraries
  `napolab/y-durableobjects` and `TimoWilhelm/yjs-cf-ws-provider`), but it is
  **not "natively supported"** by Cloudflare — the Agents SDK we already use
  only syncs **JSON state via `setState()`**; Yjs binary updates would have to
  live alongside it.
- **Full migration is a 2–3 week refactor**, adds ~40 KB client bundle, and
  replaces a working tab sync in order to fix a bug that does not require it.
- **Recommended path: fix the draft race now; revisit Yjs only if/when
  BlockNote realtime docs (spec 0008) land** — that is the feature that would
  justify the Yjs infra, and at that point tabs + drafts come along for free.
- **If we want the “Yjs mental model” without the library**, we can get 90 %
  of the win by giving drafts a **Lamport / updatedAt clock** so last-writer-
  wins becomes deterministic across tabs. That's ~30 lines.

---

## 1. Current State

### 1.1 Tab metadata sync (working)

- `UserSettingsDO extends Agent<Env, UserSettingsState>` — one DO per user.
  State: `{ tabs, activeTabId, drafts }`.
  (`apps/orchestrator/src/agents/user-settings-do.ts:16–26`)
- Writes: `@callable()` RPCs + HTTP `/api/user-settings/tabs` routes persist
  to the DO's SQLite, then `this.setState(...)` triggers an automatic WS
  broadcast to every connected client.
- Reads: clients mount `useAgent()` (agents SDK v0.11), receive
  `onStateUpdate`, then call `tabsCollection.utils.refetch()` — TanStackDB
  reconciles the diff into the UI.
- localStorage seed gives cold-start paint before the WS is up
  (`use-user-settings.tsx:110–134`).

No Yjs, no BroadcastChannel, no SharedWorker. The Agents SDK WS fanout is the
only cross-tab channel. **This works.** The f3ef859 / e543fb4 commits show
reorder was the last piece and it syncs cleanly.

### 1.2 Chat input sync (the bug)

Two-tier write in `saveDraft()` (`use-user-settings.tsx:365–407`):

```ts
// Tier 1: synchronous
localStorage.setItem(`draft:${tabId}`, text)   // or removeItem if empty
// Tier 2: debounced 500 ms
tabsCollection.update(tabId, d => { d.draft = text })
```

Read order in `getDraft()` (`use-user-settings.tsx:409–422`): localStorage
first, collection fallback.

**Failure mode**
1. User types "hello" → localStorage `hello`, timer T armed for collection write.
2. User submits ~200 ms later → `saveDraft(tabId, '')` runs immediately,
   clears localStorage and (per the code) *cancels* the existing timer.
3. … **but** the clear path also calls `applyToCollection()` synchronously,
   which writes `draft = undefined`. Good.
4. The race that actually hurts: in Tab B (second browser tab), the
   `onStateUpdate` broadcast from the `hello` write can arrive **after** the
   clear broadcast if the DO fires them out of order under load, or if Tab B
   refetches mid-stream. TanStackDB `refetch()` is a full GET — whichever
   response arrives last wins, and the server row may still carry `hello` if
   the clear landed in a separate transaction that hasn't committed yet.
5. A third pathway: on reload, `localStorage` is empty, `getDraft` falls
   through to `allItems.find(...).draft`, which is the last value the server
   ever persisted — if a submit happened while offline, the server never
   got the clear, so it re-hydrates the stale string.

All three variants produce the user-visible symptom: "continuously shows
previously submitted messages."

### 1.3 Why this matters for the Yjs question

The bug is **not a conflict-resolution problem**. It's a
write-order / last-writer-ambiguity problem. Yjs *would* fix it (CRDT merge
of an empty replacement is deterministic), but so would a monotonic clock
on every draft write.

---

## 2. Yjs-on-DO landscape (April 2026)

| Library | Transport | Persistence | Hibernation | Status |
|---|---|---|---|---|
| [`napolab/y-durableobjects`](https://github.com/napolab/y-durableobjects) | WS via Hono | in-memory + DO storage | **no** hibernation | active |
| [`TimoWilhelm/yjs-cf-ws-provider`](https://github.com/TimoWilhelm/yjs-cf-ws-provider) | WS | R2 snapshot + DO partial updates, 30 s vacuum | **yes** (`ctx.acceptWebSocket`) | active |
| [`@mininjin/y-durable-objects`](https://www.npmjs.com/package/@mininjin/y-durable-objects) | WS | SQLite | partial | niche |
| Hand-rolled on Agents SDK | WS (existing) | DO SQLite | inherited from Agents SDK | N/A |

Key findings from [Cloudflare Agents — store & sync state](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/):

- `setState()` is **JSON only**. Binary Yjs updates cannot ride the built-in
  state channel — they need a separate message type or separate WS.
- No first-party Yjs primitive exists. All Yjs-on-DO implementations are
  community.
- The 2026-04-07 compat flag `web_socket_auto_reply_to_close` is relevant
  only for ping/close behaviour, not sync semantics.

### 2.1 What "native support" actually means

The user's claim "this is all natively supported in Durable Objects" is
approximately correct for the **transport and persistence primitives** (WS
hibernation + SQLite / R2) but is **not** correct for Yjs itself — no
Cloudflare library ships Yjs. The ecosystem is 3 community libraries, none
with first-party support commitments.

---

## 3. Migration shape — if we did this

### 3.1 Server (`UserSettingsDO`)

- Keep `Agent<Env, UserSettingsState>` as the HTTP/RPC surface.
- Add a second concern: a `Y.Doc` held in memory, with:
  - `Y.Map` `tabs` (keyed by tab id) — replaces the tabs array.
  - `Y.Map` `drafts` (keyed by tab id, value is `Y.Text`) — replaces the draft strings.
  - `Y.Array` `tabOrder` — replaces the `position` column (CRDT-native ordering is the whole point).
- WS upgrade path: a new `/api/user-settings/y` endpoint that speaks the
  y-protocols sync/awareness framing.
- Persistence: `Y.encodeStateAsUpdate(doc)` snapshotted to DO SQLite every
  N updates or on alarm; partial updates appended in a `y_updates` table.
  On cold start, replay snapshot + updates.
- Hibernation: must switch to `ctx.acceptWebSocket()` explicitly — the
  Agents SDK base class does not expose hibernation for the WS it owns,
  so the Yjs WS has to be a separate upgrade path. This is the biggest
  architectural wart.

### 3.2 Client

- Replace `useAgent()` state channel usage for tabs/drafts with a custom
  `YDurableObjectsProvider` (or adapt TimoWilhelm's). Keeps `useAgent()`
  for the session state broadcasts (those are fine as JSON).
- Textarea binds to `yDrafts.get(tabId)` via `y-react` / `yjs-react-input`
  or a manual `observe` + `onChange`. Caret position is preserved by Yjs.
- Tab list reads from `yTabs.toJSON()` with an observer. TanStackDB
  collection is **removed** for this feature (or kept as a read mirror,
  which is worst of both worlds — don't).
- Bundle cost: `yjs` ~30 KB gz, `y-protocols` ~5 KB, provider ~5 KB. Call
  it **~40 KB gzipped** on a page that's currently ~110 KB gzipped.

### 3.3 Migration steps (order matters)

1. Ship the Y.Doc alongside existing state, dual-write for one release.
2. Flip reads to Yjs behind a feature flag, keep writes dual.
3. Verify cross-tab merge in staging under offline / flaky network.
4. Remove TanStackDB collection path + localStorage seed.
5. Remove `setState` tabs/drafts fields from `UserSettingsState`.

**Estimate: 2–3 weeks for one engineer**, including the hibernation
refactor and a test harness for Yjs merge scenarios.

---

## 4. Trade-off matrix

| Dimension | Keep current + fix bug | Full Yjs migration | Lamport-clock compromise |
|---|---|---|---|
| Fixes reported bug | ✅ | ✅ | ✅ |
| Offline edits merge cleanly | ❌ (last-write wins) | ✅ | ⚠️ (deterministic LWW — usually fine for drafts) |
| Concurrent typing in same draft across 2 tabs | ❌ (overwrite) | ✅ (character merge) | ❌ |
| Bundle cost | 0 | +~40 KB gz | 0 |
| DO storage cost | unchanged | +snapshot + updates log | unchanged |
| Infra complexity | unchanged | +Yjs WS path, +snapshot alarm, +hibernation refactor | +1 field |
| Lines changed | ~10 | ~600–900 | ~30 |
| Risk of regression on working tab reorder | 0 | medium (full rewrite) | 0 |
| Reuses if BlockNote realtime (spec 0008) ships | n/a | ✅ (same Y.Doc infra) | n/a |
| Reversibility | trivial | expensive | trivial |

### 4.1 The "concurrent typing" column is load-bearing

This is the only dimension where Yjs is uniquely valuable. Ask: **do two
tabs ever type into the same draft at the same time in our product?**
In Duraclaw a tab = a session = a worktree. Two browser tabs showing the
same session and both typing into the same chat input is possible but
rare (user on two devices drafting the same prompt). If the answer is
"basically never," the CRDT character-merge isn't paying its keep.

---

## 5. Recommended path

### 5.1 Now — fix the bug (task mode, ~1 session)

Three small changes in `use-user-settings.tsx` and `user-settings-do.ts`:

1. **Stamp every draft with a monotonic `updatedAt`** (Date.now() is
   fine per-user because the DO serializes writes). Store it alongside
   `draft` in the tab row.
2. **Server-side LWW guard** in `saveDraft` RPC: reject an incoming
   `draft` whose `updatedAt` is ≤ the stored one. Kills the "late
   debounce wins over explicit clear" race at the source.
3. **On reload, trust the server**, not localStorage, unless the
   localStorage entry has a newer `updatedAt`. This kills the
   "offline clear never reached server" replay.

The clear-on-submit path already runs immediately; it just needs to be
authoritative. A clock makes it so.

### 5.2 Later — reconsider Yjs when spec 0008 starts

`planning/specs/0008-yjs-blocknote-realtime-docs-sync.md` already plans
to bring Yjs into the stack for realtime markdown docs. Wait for the
BlockNote PoC in p1 of that spec to land. At that point:

- The provider choice (`yjs-cf-ws-provider` vs custom) will already be
  made for docs.
- The hibernation-compatible WS path already exists.
- Tabs + drafts become a 200-line port on top of proven infrastructure,
  not a speculative greenfield.

### 5.3 Not recommended — migrate now

- Pays full cost (2–3 wk, +40 KB, infra split) to solve a 10-line bug.
- Duplicates infra that spec 0008 will need to build correctly anyway,
  risking a second rewrite.
- Loses the working TanStackDB collection path for tabs with no behavioural gain
  (tabs don't have concurrent-edit semantics).

---

## 6. Addendum: Multiplayer Chat Changes Everything

**Update (2026-04-17):** The answer to § 4.1's load-bearing question is
**yes — multiplayer chat is a desired feature**. This changes the
recommendation.

### 6.1 What multiplayer chat means for Duraclaw

In the current model, a session = a worktree = a single user's
conversation with Claude. "Multiplayer" extends this to:

- **Collaborative prompt drafting**: Multiple humans co-author a prompt
  before sending it to the agent. Character-level merge, cursors visible.
- **Shared session watching**: Multiple users see the agent's streaming
  response in real time (already works via `broadcastToClients()`).
- **Awareness/presence**: "Alice is typing…", cursor positions, who's
  online in this session. Ephemeral state, not persisted.

The first bullet — co-authoring a prompt — is the use case that *only*
Yjs solves cleanly. LWW clocks can't merge two people typing into the
same textarea at once.

### 6.2 AI agent as a Yjs peer

A compelling pattern from [ElectricSQL's April 2026 post](https://electric-sql.com/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs):
the AI agent itself connects as a **server-side `Y.Doc` peer**. In
Duraclaw's architecture:

1. `SessionAgent DO` holds the canonical `Y.Doc` for the session.
2. Browser clients connect via y-websocket provider → DO WS.
3. The VPS executor's streaming response writes into a `Y.Text` in the
   doc as tokens arrive — the agent is just another cursor.
4. Human users see tokens appear in real time via CRDT sync, not
   a separate `assistant` event broadcast. **One transport for
   everything.**

This eliminates the current dual-path problem where:
- Message history is `broadcastToClients()` JSON.
- Drafts are `tabsCollection` → TanStackDB → refetch.
- Tab metadata is `setState()` → `onStateUpdate`.

All three become CRDT state on one `Y.Doc` per session + one `Y.Doc`
for user settings.

### 6.3 Awareness protocol (ephemeral, free)

Yjs awareness is **not part of the persistent doc** — it's a gossip
protocol riding the same WS connection:

```ts
awareness.setLocalStateField('user', {
  name: 'alice',
  color: '#e06c75',
})
awareness.setLocalStateField('cursor', {
  anchor: Y.createRelativePositionFromTypeIndex(ytext, 42),
  head: Y.createRelativePositionFromTypeIndex(ytext, 47),
})
```

When a user disconnects, their awareness state vanishes automatically.
Zero storage cost, zero cleanup logic. Libraries like
[`y-presence`](https://github.com/nimeshnayaju/y-presence) give React
hooks: `useSelf()`, `useUsers()`.

### 6.4 Revised architecture sketch

```
SessionAgent DO (1 per session)
├── Y.Doc "session"
│   ├── Y.Array<Y.Map>  messages    # full chat history (CRDT)
│   ├── Y.Text           draft      # collaborative prompt input
│   └── Y.Map            meta       # status, model, cost, etc.
├── Awareness
│   └── { user, cursor, typing }    # ephemeral per-connection
└── SQLite
    ├── y_snapshot (periodic)        # Y.encodeStateAsUpdate()
    └── y_updates  (append-only)     # incremental since snapshot

UserSettingsDO (1 per user)
├── Y.Doc "settings"
│   ├── Y.Array<Y.Map>  tabs       # tab list + order (CRDT)
│   └── Y.Map            prefs     # theme, layout, etc.
└── SQLite
    ├── y_snapshot
    └── y_updates

Browser
├── YWebSocketProvider → SessionAgent DO  (per active tab)
├── YWebSocketProvider → UserSettingsDO   (singleton)
└── awareness on both connections
```

### 6.5 Revised cost / benefit

| Dimension | LWW clock fix (§ 5.1) | Yjs migration for multiplayer |
|---|---|---|
| Fixes the draft bug | ✅ | ✅ |
| Multiplayer prompt co-authoring | ❌ | ✅ |
| Awareness ("Alice is typing…") | ❌ | ✅ (free with awareness protocol) |
| Agent streaming as CRDT peer | ❌ | ✅ (single transport) |
| Eliminates dual sync paths | ❌ | ✅ (no more setState + collection + localStorage) |
| Bundle cost | 0 | +~40 KB gz |
| Effort | ~1 session | ~3 weeks |
| Reuses for spec 0008 (BlockNote) | ❌ | ✅ (shared Y-on-DO infra) |

### 6.6 Revised recommendation

With multiplayer chat confirmed as a desired feature:

1. **Fix the draft race now** (§ 5.1, ~10 lines) — users are hitting
   this today and it's a 1-session fix.
2. **Spec the Yjs migration as a feature** — don't bolt it on
   incrementally. Write a spec covering:
   - `SessionAgent` Y.Doc schema (messages, draft, meta)
   - `UserSettingsDO` Y.Doc schema (tabs, prefs)
   - WS upgrade path (separate from Agents SDK `setState` WS)
   - Persistence strategy (snapshot + update log in DO SQLite)
   - Awareness UX (typing indicators, cursor colors)
   - Agent-as-CRDT-peer for streaming responses
   - Migration from current `broadcastToClients` + TanStackDB
3. **Sequence with spec 0008**: Yjs-on-DO infra ships first (this
   feature), BlockNote realtime docs (0008) layers on top. The order
   reverses from the original recommendation because multiplayer chat
   justifies the infra independently.

---

## 7. Open questions (updated)

1. ~~Is concurrent same-draft editing a real use case?~~ **Yes —
   multiplayer chat is desired.**
2. Should the agent's streaming tokens go through the Y.Doc (agent-as-
   peer) or remain a separate broadcast? The CRDT path is cleaner but
   adds latency from encode/decode. Needs a PoC benchmark.
3. Auth model for multiplayer: who can join a session? Is it per-project
   ACL, invite link, or open to all org members?
4. Ordering guarantee: Yjs `Y.Array` for messages preserves insertion
   order, but does the CRDT merge handle the case where two users send
   messages "simultaneously"? (Yes — concurrent inserts at different
   positions are deterministic, but two inserts at the *same* index
   produce an arbitrary-but-consistent tiebreak.)
5. Should the Yjs migration be one spec or split into "Yjs infra on DO"
   + "multiplayer chat UX"?

## Sources

- [napolab/y-durableobjects](https://github.com/napolab/y-durableobjects)
- [TimoWilhelm/yjs-cf-ws-provider](https://github.com/TimoWilhelm/yjs-cf-ws-provider)
- [Cloudflare Agents — Store and sync state](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/)
- [Cloudflare Durable Objects — WebSocket hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [y-websocket](https://github.com/yjs/y-websocket)
- [Yjs Awareness docs](https://docs.yjs.dev/getting-started/adding-awareness)
- [y-presence — React hooks for Yjs awareness](https://github.com/nimeshnayaju/y-presence)
- [AI agents as CRDT peers with Yjs — ElectricSQL](https://electric-sql.com/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs)
- Local: `apps/orchestrator/src/agents/user-settings-do.ts`
- Local: `apps/orchestrator/src/hooks/use-user-settings.tsx`
- Local: `planning/specs/0008-yjs-blocknote-realtime-docs-sync.md`
- Local: `planning/research/2026-04-16-state-management-audit.md`
