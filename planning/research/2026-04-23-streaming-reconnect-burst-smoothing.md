---
date: 2026-04-23
topic: Smoothing the streaming UX — jumpy on reconnect from message burst
type: feasibility
status: complete
github_issue: null
related_issues: [14, 38, 42, 69, 75]
items_researched: 3
---

# Research: Smoothing streaming UX under reconnect-burst

## Context

User report: "the streaming experience is currently jumpy on reconnect from
message burst." On WS reconnect (runner→DO or browser→DO), queued events
flush faster than the renderer can animate, producing visible layout /
scroll / text jank.

Three parallel Explore agents mapped (a) burst sources and sizes, (b) the
client render cost surface, and (c) prior-art smoothing techniques. This
doc is the synthesis.

Adjacent prior work — do not duplicate:
- `planning/research/2026-04-23-streaming-incomplete-messages-cursor-audit.md`
  — focuses on message **loss** (missing tail); recommends the client-side
  seq-gap path already shipped in PR #77. This doc focuses on **smoothness**
  (too much arrives too fast), which is a different failure mode.
- `planning/research/2026-04-21-do-topology-collapse-connection-manager.md`
  — the connection manager landed; not the source of the jitter.
- Spec #75 shipped the frame-drop recovery path; the burst-smoothness axis
  was out-of-scope there.

Classification: **feasibility / brainstorm** — the shape of the problem is
already known from code; the research question is which mitigation stack
to pick.

## Scope

Three deep-dive tracks:

1. **Burst inventory** — where events "bunch" across runner / DO /
   client, and worst-case burst sizes per layer.
2. **Render pipeline cost** — where a burst translates into visible jank
   (layout thrash, scroll snap, markdown re-parse, missed frames).
3. **Smoothing techniques** — menu of options (server-side coalescing,
   client-side pacing, CSS) with prior-art URLs and Duraclaw fit.

## Findings

### 1. Burst inventory — the pipeline preserves every delta

Every layer faithfully amplifies 1 SDK token → 1 event → 1 broadcast →
1 commit → 1 Streamdown re-parse. There is **zero coalescing anywhere**.

| # | Source | File:line | Worst-case | Already coalesced? |
|---|--------|-----------|------------|--------------------|
| 1 | Runner emits `partial_assistant` per SDK `content_block_delta` / `thinking_delta` | `packages/session-runner/src/claude-runner.ts:539-547` | 50–500 events/sec | **No** |
| 2 | `BufferedChannel.attachWebSocket` replays every queued event in a sync loop | `packages/shared-transport/src/buffered-channel.ts:168-196` | 10 000 events / 50 MB (ring cap) | **No** |
| 3 | DO `safeUpdateMessage` broadcasts on every event; 1 event → 1 `synced-collection-delta` frame | `apps/orchestrator/src/agents/session-do.ts:4358-4452` | Unbounded; scales with (1) and (2) | **No** — the 10s debounce there is on `last_event_ts` liveness flush, not on message broadcasts |
| 4 | DO `replayMessagesFromCursor` pages 500 rows × `chunkOps` 256 KiB | `apps/orchestrator/src/agents/session-do.ts:1873-1936` | ~30 frames for a 1 500-row gap | **Yes (implicit)** — emits current row only, not every historical tick |
| 5 | `chunkOps` fragments large payloads | `apps/orchestrator/src/lib/chunk-frame.ts:15-34` | 10–50 frames per 500-row page | N/A (mechanical split) |
| 6 | Client frame buffer replay at subscribe | `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:127-189` | 50+ frames at 5 s TTL | **No** (tight-loop dispatch) |
| 7 | No WS `bufferedAmount` backpressure anywhere | — | unlimited | **No** |

**Asymmetry that points at the fix:** source #4 (DO cursor replay) is
smooth-by-design because it emits **one row per message** (the current
text), not every intermediate `partial_assistant`. Source #3 (DO live
broadcast) is *not* coalesced, so a single runner reconnect in source #2
amplifies back through #3 as thousands of WS frames to the client. One
well-placed coalesce on the DO's broadcast path collapses both the
reconnect-replay burst **and** the live 500-tok/s hammer.

### 2. Render pipeline — where the jump becomes visible

Path: `WS frame → dispatchSessionFrame → messagesCollection begin/commit →
useLiveQuery → ChatThread → VirtualizedMessageList → ChatMessageRow.memo
→ MessageResponse → Streamdown`.

| Cost hotspot | File:line | Notes |
|--------------|-----------|-------|
| **Streamdown full re-parse on every delta** | `apps/orchestrator/src/features/agent-orch/ChatThread.tsx:497` uses `MessageResponse` which wraps Streamdown | No incremental-parse mode in use; walks the whole document tree and regenerates React elements per delta |
| **`MessageResponse` memo doesn't skip during streaming** | memo compares `children === nextProps.children`; streaming text always grows, so comparator returns false | The memo is dead code for the streaming path |
| **ResizeObserver pin-to-bottom races virtualizer measurement** | `Conversation.tsx:174-191`; `pinNow` runs in rAF; virtualizer `measureElement` is async | Scroll snaps to estimate-based position, then rows measure, then list expands — visible scroll jumps |
| **Settle gate is mount-only** | `ChatThread.tsx:953-989` — "after settle we NEVER re-hide" | Suppresses mount jank but not reconnect-burst jank |
| **Syntax highlighting (code blocks)** | Streamdown `@streamdown/code` plugin | Re-highlights on every delta if a code block is present |
| **TanStack DB auto-batches in same microtask** | `packages/shared-transport` WS delivery → `begin/commit` | Good when frames arrive in a single microtask; doesn't help when frames arrive across many microtasks (the reconnect burst case) |

Positive: the row id stays constant during a streaming turn, so the
collection sees an `update` rather than delete+insert (smoother React
reconciliation). But the re-parse cost above dominates.

**Visualisation of the reconnect moment today:**

1. WS reattaches. BufferedChannel replay fires 200 `partial_assistant`
   events into the DO in <100 ms.
2. DO broadcasts 200 `synced-collection-delta` frames to the client.
3. Client commits 200 times (possibly merged across microtasks, but
   typically 10–40 distinct React renders).
4. Each render re-parses the full message markdown in Streamdown.
5. ResizeObserver fires intermittently; scroll snaps several times.
6. User sees the message text "flicker" upward as growing text pushes
   content, scroll chases, markdown nodes re-mount.

### 3. Smoothing techniques — prior art & fit

Sources:
- Vercel AI SDK `experimental_throttle` — [PR #2182](https://github.com/vercel/ai/pull/2182), [discussion #6129](https://github.com/vercel/ai/discussions/6129). Defaults 50 ms; throttles `onUpdate` in `useChat`. Same idea as our DO-side coalesce but on the consumer side.
- Streamdown — [streamdown.ai](https://streamdown.ai/), [github/vercel/streamdown](https://github.com/vercel/streamdown). **Already in stack** via `@duraclaw/ai-elements`.
- use-stick-to-bottom — [github/stackblitz-labs/use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom). Spring-velocity scroll anchoring; pairs well with a virtualizer.
- React 19 `useDeferredValue` — [react.dev](https://react.dev/reference/react/useDeferredValue). Yields during bursts; intermediate renders are skipped.
- `overflow-anchor: auto` — [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-anchor). Prevents scroll jump on content insertion before the anchor.
- `content-visibility: auto` — [web.dev CLS](https://web.dev/articles/optimize-cls). Skips off-screen rendering/layout cost.
- Anti-rec: typewriter / token-drip (`react-type-animation`, Motion
  Typewriter, `FlowToken`) — adds latency, confuses "agent thinking" vs
  "waiting" states.

## Comparison

| Technique | Bucket | Effort | Impact | Duraclaw fit | Notes |
|-----------|--------|--------|--------|--------------|-------|
| DO per-messageId broadcast throttle (16 ms) | server coalesce | **S** | **H** | ★★★ | One-layer fix; kills both burst #2→#3 amplification and live source #1 in one change |
| BufferedChannel replay-coalesce on `attachWebSocket` | transport coalesce | S | M | ★★★ | Belt-and-suspenders; cheap; reduces runner→DO bandwidth on long dropouts |
| `useDeferredValue` over streaming text prop | client pacing | S | M | ★★★ | Free with React 19; Streamdown parses become low-priority |
| `use-stick-to-bottom` | client scroll | S | M | ★★ | Drop-in replacement for ResizeObserver pin |
| `overflow-anchor: auto` + `content-visibility: auto` | CSS | **S** | L | ★★ | Free, safe; layered on top of scroll fix |
| Streamdown incremental-parse mode | render | M | M | ★ | Streamdown's incremental API needs a feasibility spike; uncertain fit |
| `startTransition` around delta apply | client pacing | M | L | ★ | TanStack DB already auto-batches; marginal benefit |
| Adopt Vercel `useChat` for `experimental_throttle` | architecture | **L** | M | ✗ | Duraclaw uses Agents SDK `useAgent`, not `useChat` — throttle idea is valid but implement server-side |
| Typewriter / token-drip | client fake-smooth | L | L | ✗ | Anti-rec — agent chat, not demo UX |
| View Transitions API | CSS | M | L | ✗ | Designed for route transitions; breaks scroll positioning |

## Recommendations

Ranked by effort × impact. Compose 1 + 2 + 3 + 4 for a full stack; each
is independently shippable.

### 1. [Biggest win — ship first] DO per-message broadcast throttle

Add a 16 ms per-`messageId` coalesce window inside the DO broadcast path
for `partial_assistant` updates. Keep only the latest text in the window;
broadcast once at window-end. Lossless because `partial_assistant` is
cumulative (row id stable, text grows monotonically) — intermediates add
no information a client can't derive from the latest.

Where: `apps/orchestrator/src/agents/session-do.ts` around
`safeUpdateMessage`'s broadcast call (near line 4444). Non-partial events
(`assistant` finalise, `tool_result`, `result`, `ask_user`,
`permission_request`) must **not** be throttled — they carry turn-final
semantics.

Impact: 60 Hz ceiling on client re-renders during streaming. Kills the
runner-reconnect amplification (10 000 queued partials → at most ~60
broadcasts/sec on flush) and the live-stream hammer (500 tok/s → 60/s)
in one change. Zero client-side changes required.

Risk: minimal. If the throttle flushes on `assistant`/`result` (always do
this — see "non-partial events" above), no turn ends in a stale state.

### 2. BufferedChannel replay-coalesce

On `attachWebSocket`, scan the buffer once and collapse consecutive
`partial_assistant` entries for the same `messageId` to the last one
before the replay loop. Net bandwidth reduction on long runner→DO
dropouts. Keeps the DO broadcast path (#1) simple by not relying on
downstream coalescing alone.

Where: `packages/shared-transport/src/buffered-channel.ts:168-196`.

Risk: the buffer currently is opaque `serialized` strings — coalescing
requires parsing. Either parse on `send()` and store a typed ring, or
add a parallel `lastPartialIndexByMessageId: Map<string, number>` and
null out earlier indices at send-time.

### 3. `useDeferredValue` on the streaming text prop

In `MessageResponse` / the part that passes `text` to Streamdown, wrap
the text with `useDeferredValue`. React 19 will de-prioritise Streamdown
re-parse during bursts; input / scroll stay responsive.

Where: `apps/orchestrator/src/features/agent-orch/ChatThread.tsx:497`
area (the `MessageResponse` call site), or inside `MessageResponse`
itself in `packages/ai-elements`.

Risk: negligible. The deferred value lags the real value by <1 frame
under pressure; unnoticeable.

### 4. `use-stick-to-bottom` + CSS anti-thrash

Replace the ResizeObserver → rAF scroll-pin in `Conversation.tsx` with
`use-stick-to-bottom`'s spring anchor. Add
`overflow-anchor: auto; content-visibility: auto;` to the message list
container.

Impact: removes the visible scroll snap during bursts. Low-risk, isolated
to one component.

### Anti-recommendations

- **Typewriter / token-drip** — adds latency; hides the "agent is
  thinking vs typing" distinction a multi-turn agent chat needs.
- **Adopting Vercel `useChat` for `experimental_throttle`** — same idea
  as #1 but further from the source; requires reworking the
  TanStack-DB-driven sync. Implement the server-side coalesce instead.
- **Client-side `setTimeout` coalescing over WS frames** — defers the
  symptom but the WS event queue still runs on the main thread; React
  re-renders still pile up.
- **Snapshot-RPC-on-reconnect for smoothing** — already shipped for
  gap detection (#75); forcing it on every reconnect costs a round-trip
  and doesn't address the broadcast-amplification root cause.

## Open questions

1. **Is 16 ms the right window?** Lower bound = 60 Hz renderer ceiling.
   Higher (e.g. 50 ms like Vercel's default) is less CPU but user might
   perceive less "live" streaming. Worth A/B-ing 16/33/50 ms on real
   sessions. Parameterise as an env constant.
2. **Does Streamdown have an incremental-parse mode we're not using?**
   Agent #2 reports full re-parse per delta; worth a follow-up spike on
   the Streamdown API surface. If yes, combining that with #1 would
   drop CPU further.
3. **`canonical_turn_id` and coalesce interaction** — the throttle key
   must be `messageId`, not `turn_id`, to avoid merging distinct
   assistant messages within a turn. Verify against
   `safeUpdateMessage` / `safeAppendMessage` id discipline.
4. **Mobile (Capacitor) WebView event-loop behavior** — does the same
   burst cause worse jank on Android WebView? If so, #3 `useDeferredValue`
   matters more there. Measure with the `Capacitor/Console` logcat tap
   from CLAUDE.md before/after.
5. **Interaction with PR #77's seq-gap recovery** — a `requestSnapshot`
   on reconnect now pulls a whole-message row. With throttle (#1) the
   broadcast rate is lower, so seq gaps should be rarer, but confirm
   the snapshot RPC doesn't bypass the throttle.

## Next steps

1. Open a feat spec for **DO per-message broadcast throttle** (rec #1)
   with B-IDs covering: throttle window, flush on turn-final events,
   unit tests for coalesce correctness (text monotonicity preserved),
   and a VP step that replays a 1 000-partial sequence and asserts
   ≤70 broadcasts.
2. Prototype #3 `useDeferredValue` on a branch; verify no visible lag
   on a typical turn with one test user.
3. Spike #2 (BufferedChannel coalesce) behind a feature flag; ship after
   #1 lands so we can measure each independently.
4. CSS + `use-stick-to-bottom` (#4) as a small follow-up PR after #1.

---

## Addendum: settle jitter — the "everything is tied to the live query" axis

The burst discussion above focuses on **rate**: too many events arriving
per unit time. The other half of the reconnect-jump experience is
**structural coupling**: the whole chat rendering tree is subscribed to
one `useLiveQuery(messagesCollection)`, so *every* `begin/commit` — burst
or not — re-renders the entire `ChatThread → virtualizer →
ResizeObserver → scroll pin` chain.

### Evidence in the codebase

`apps/orchestrator/src/hooks/use-messages-collection.ts:71-77` literally
documents the failure mode:

> `useLiveQuery` re-emits on every sync event (REST cold-load → WS
> snapshot burst → WS first delta fire in rapid succession on session
> mount); without this guard each emission produces a fresh sorted array

The guard (the `signature` in the same file, lines 98-111) is keyed on
`[length, per-row id, parts.length, trailing text length]`. It absorbs
**redundant** emits (same content re-broadcast) but not **genuine
growth** — every `partial_assistant` tick grows the trailing text, the
signature changes, a new `messages` array reference is produced,
ChatThread re-renders, the virtualizer re-measures, scroll-pin
recomputes. The "everything settling" jitter is exactly this chain
firing once per emit.

The existing mount-settle gate in `ChatThread.tsx:957-989` masks this on
first paint — `visibility: hidden` until `scrollHeight` is stable for
2 rAFs — but is explicitly **mount-only**: "after settle we NEVER
re-hide." The comment acknowledges the trade-off directly: "otherwise
every `partial_assistant` tick would flicker the whole chat."

So the gate protects first-mount thrash but is **disarmed during
reconnect** — which is structurally identical to mount (the collection
churns through a rapid cold-load → subscribe-replay → live-delta-fire
sequence), just with a non-empty starting state.

### Root-cause framing

Three distinct churn sources fire inside the reconnect settle window:

1. **OPFS hydrate replay** — persisted cache re-emits rows at sync start
   (`messages-collection.ts:98-127` applies them through `begin/commit`).
2. **Subscribe:messages cursor replay** — DO pages 500 rows, each page
   becoming 1+ frames, each frame a separate commit
   (`session-do.ts:1873-1936`).
3. **Live-delta resumption** — the first `partial_assistant` of the
   in-flight turn lands, and subsequent ones continue at 50–500 Hz.

Each commit fires `useLiveQuery` → `useMessagesCollection`'s `useMemo`
→ new `messages` reference → ChatThread render → virtualizer O(n)
offset recompute → ResizeObserver scroll-pin. The DO throttle (rec #1)
shrinks source #3; it does nothing for #1 and #2. The settle window
stays noisy.

### Fix direction — reduce coupling, not just rate

#### 5. [Highest-leverage addendum rec] Reconnect settle gate

Extend the mount-only settle in `ChatThread.tsx` to re-engage on a
reconnect signal (from `connectionManager` — specifically the
`hasConnectedOnce && subsequent open` transition already tracked in
`use-coding-agent.ts`). Semantics:

- On reconnect-open: set `isSettled = false`, hide list with
  `visibility: hidden`.
- Re-run the same rAF loop watching `scrollHeight` for 2 stable frames,
  with a hard 200 ms ceiling (same `SETTLE_FALLBACK_MS`).
- Reveal once stable. User sees "previous view → final view" with no
  intermediate flicker.

Cost: ~30 lines, all in `ChatThread.tsx`. Zero change to the data
layer. Masks the entire settle storm for #1–#3, orthogonally to rate.

Risk: if a new partial starts streaming *during* the settle window,
user waits ≤200 ms for the first character. Acceptable — matches
first-mount UX today.

#### 6. Decouple the tail from the history

Architectural fix: render the *in-progress assistant row* from a
different subscription than the historical list. Two variants:

- **6a (pragmatic).** Selector-based `useLiveQuery` — TanStack DB's
  query builder supports projections; query the collection for "rows
  whose `id` matches the active streaming message" separately from
  "all other rows." Two queries → two subscribers → only the tail
  subscription fires on text growth. History stays stable.
- **6b (cleaner).** Ref-tracked `currentStreamingRow` updated directly
  by the WS dispatcher, bypassing `messagesCollection` for the hot row.
  The streaming bubble subscribes via `useSyncExternalStore`. When the
  turn finalises (`result` event), the final row is written back to
  the collection and the ref is cleared. History only touched on turn
  boundaries.

6a is the shippable choice. 6b is cleaner but requires atomic "final
write + ref clear" sequencing to avoid flicker at the handoff.

Impact: ChatThread / virtualizer only re-render on **structural**
changes (new turns, branch-navigate) — not on every token. Scroll pin
stops chasing text growth. "Everything is tied to the live query"
coupling is broken.

#### 7. `useDeferredValue` on the messages array (broader scope)

Already in the main stack as rec #3 — scoped there to the Streamdown
text prop only. Extending it to the **whole `messages` array** passed
into `VirtualizedMessageList` would let React 19 de-prioritise
virtualizer recompute during bursts. Compared to rec #5:

- Rec #5 is hard hide → reveal, masks completely.
- Rec #7 is a soft yield, keeps the list visible but accepts stale
  intermediates.

These compose — use #5 for reconnect, #7 for in-flight bursts.

#### 8. Suppress scroll-pin during settle

If rec #5 is in place, gate the pin on `isSettled`: do one final
scroll-to-bottom on reveal, not N scrolls during settle. Trivial add-on
to #5.

### Updated recommendation priority

Order for shipping, reflecting both rate and coupling axes:

1. **Rec #1 (DO broadcast throttle)** — cuts emit rate at the source.
2. **Rec #5 (reconnect settle gate)** — masks settle-window churn.
   *Lowest-effort structural fix; orthogonal to rec #1 — ship in the
   same PR wave.*
3. **Rec #3/#7 (`useDeferredValue`)** — soft yield for in-flight bursts.
4. **Rec #6a (selector-based tail/history split)** — the deep fix;
   ship after #1+#5 so we can measure what residual jitter remains.
5. **Rec #4/#8 (scroll + CSS polish)** — final polish layer.

Recs #5 and #6a are the two that **specifically answer the "everything
is tied to the live query" observation**; rec #1 alone does not.

### Open questions (addendum)

- Does TanStack DB's query DSL cleanly support the rec #6a selector
  (stable ref-identity when filter matches the same row), or do we
  need two collections?
- Does the existing signature guard in `use-messages-collection.ts`
  become a liability once the tail is on its own subscription? (It's a
  blunt dedupe; with structural decoupling it may be redundant.)
- Mobile WebView rAF cadence — does the 2-rAF stability check fire
  reliably on Android WebView, or do we need a longer fallback?

---

## Addendum B — Why duplicates replay on a *genuinely idle* session reconnect

Follow-up question: reconnect after a few minutes on an idle session
(no active streaming, no tool calls, no user turn pending) re-delivers
"the last few messages." Initial guess — active-turn `safeUpdateMessage`
touches during a gap — was **wrong**; the session is idle by construction.

### Hypotheses ruled out (code audit)

Deep sweep of `apps/orchestrator/src/agents/session-do.ts` and related
files (see methodology below) confirmed:

1. **No idle-path writes to message rows.** Every `safeUpdateMessage`
   / `safeAppendMessage` site is turn-active:
   - `:839` append path, fires on new row only
   - `:868` update path, fires only when text/parts change
   - All other call sites (gate resolve, tool_result, result finalise,
     abort, streaming deltas at `:4377/:4444/:4477`) gate on a
     turn-in-flight.
2. **`alarm()` is idle-safe for messages.** The handler at `:1392-1453`
   only touches `session_meta.last_event_ts` via
   `flushLastEventTsToD1()` (`:1403`). No `assistant_messages` or
   `user_messages` mutation.
3. **`onConnectInner()` is idle-safe.** The reconnect handler
   (`:916-978`) stores gateway conn id, broadcasts status, re-emits
   gate. Zero message-row writes.
4. **`hydrateFromGateway()` doesn't fire on idle reconnect.** It runs
   only during *active recovery* after a runner-side crash/restart —
   not on a browser tab coming back from Cloudflare's ~70 s WS idle-close.
5. **The replay query is strict-greater, not >=.** `session-do.ts:1894`
   uses `modified_at > ${cursor.modifiedAt} OR (= AND id > cursor.id)`,
   so it never re-replays the cursor row itself. The keyset composite
   is correct.

If no server-side write bumps `modified_at` during idle, and the query
is strict-greater, then **the server query would return zero rows for
a truthfully-up-to-date cursor**. Logical conclusion: the client's
cursor is systematically *behind* the server's true max.

### The client-side staleness axis

`computeTailCursor` (`apps/orchestrator/src/db/messages-collection.ts:231`)
iterates the in-memory collection and picks `max(modifiedAt)` with id
tiebreak. For that value to lag the server, one of the following has to
hold:

**B1. Final turn-boundary `modified_at` bump never lands in the client
row.** In the `result` handler (`session-do.ts` around `:4477`), a
terminal `safeUpdateMessage` bumps `modified_at` on the finalised
assistant row. If that broadcast races the status-frame-goes-idle path
(see cursor-audit §2 — no atomicity across the two channels) *and* the
frame is dropped because the WS closes mid-flush, the server row is at
`T_final` while the client row is at `T_final − ε`. The very next
reconnect replays the delta. Consistent with "last few messages" —
it's specifically the finalised tail of the last turn, not arbitrary
history.

**B2. TanStack DB `deepEquals` skips a `modified_at`-only update.**
The insert→update shim at `messages-collection.ts:120-124` converts
duplicate-key inserts to updates. But at the collection layer,
TanStack DB's sync apply uses `deepEquals` to elide no-op updates. If
a post-finalisation server bump sends a row whose only diff from what
the client already has is `modifiedAt`, the update *may* get elided —
leaving the client cursor behind. Needs verification against the
vendored `@tanstack/db` apply path. If confirmed, this is a root-cause
bug: cursor precision requires `modifiedAt` to always round-trip
through the cache, but the cache's loopback guard is defensively
elision-happy.

**B3. OPFS persistence debounce loses the final bump.** The
`@tanstack/browser-db-sqlite-persistence` layer batches writes. If the
tail row's final `modifiedAt` update arrives in the last window before
the tab backgrounds and Cloudflare closes the WS, the in-memory
collection has the fresh value but the OPFS write didn't fire (or
wasn't flushed). Note: for a *still-alive* tab this doesn't matter —
in-memory is authoritative for `computeTailCursor`. B3 only bites on
page reload / session-switch-and-back, **not on a pure WS reconnect**.
So B3 is unlikely to explain the idle-reconnect symptom, but it would
explain "reload-after-idle shows duplicate replay."

**B4. Last broadcast is not flushed before WS idle-close.** Cloudflare
closes the DO-side socket after ~70 s idle with no keepalive (the old
app-level ping was removed in spec #50, per the cursor-audit doc). If
the DO sends the final `modified_at` bump broadcast but the CF edge
has already half-closed the socket, the frame is silently dropped on
the wire. This is a sibling of B1 but mechanistically different: B1 is
tab-side WS-close during flush, B4 is edge-side WS-close before flush
lands.

### Ranking

| Hypothesis | Requires | Mechanistic fit to symptom | Prob |
|------------|----------|----------------------------|------|
| B1 (flush race at turn end) | Last bump fires after WS begins closing | High — explains "last few" exactly | Medium-High |
| B2 (deepEquals elision of modifiedAt-only update) | TanStack DB apply elides by content | High if confirmed — every final bump is a candidate | Medium |
| B4 (CF edge closes before flush) | No app-level keepalive (confirmed in #50) | Medium — overlaps B1 | Medium |
| B3 (OPFS debounce) | Page reload, not pure reconnect | Low — wrong scenario | Low |

B1/B2/B4 are not mutually exclusive — B2 would explain why the final
`modified_at` bump is *structurally* at risk of being lost by the cache
even when the wire delivers it; B1/B4 would explain why the wire
sometimes doesn't even deliver it.

### What to do before shipping a fix

Because three plausible mechanisms survive the audit, the next step is
**ground-truth instrumentation**, not another hypothesis. Minimal diff:

1. **Server: log cursor + rows returned in `replayMessagesFromCursor`**
   (`session-do.ts:1873`):
   ```
   console.log('[SessionDO:replay-cursor]', {
     sessionId: this.sessionId,
     cursor, rowCount: rows.length,
     minModifiedAt: rows[0]?.modified_at,
     maxModifiedAt: rows.at(-1)?.modified_at,
   })
   ```
   On a truly-idle reconnect this should log `rowCount: 0`. If it logs
   `rowCount > 0`, we've proved the cursor is stale and the replay is
   earned (server did have newer rows).

2. **Client: log cursor at subscribe time**
   (`use-coding-agent.ts` WS-open handler, the site that calls
   `connection.send({type:'subscribe:messages', sinceCursor})`):
   ```
   console.log('[client:subscribe-messages]', {
     sessionId, sinceCursor,
     collectionSize: messagesCollection.size,
     trueMaxInMemory: /* recompute without the OPFS layer */,
   })
   ```

3. **Correlation**: if server logs `rowCount: N > 0` for cursor `T` and
   the client's in-memory max at subscribe time was ALSO `T` (not
   `T + Δ`), then B2/B3 are out — the client legitimately never saw
   rows newer than `T`, implicating **B1 or B4** (flush race).
   Conversely, if the client's in-memory max was `T + Δ` but the sent
   cursor was still `T`, the bug is in `computeTailCursor` itself or in
   the WS-send ordering against the live commit.

4. **Cheap confirmation experiment for B4**: add the WS keepalive
   app-level ping removed in #50 (originally sketched in the
   cursor-audit doc). If idle-reconnect duplicates disappear without
   any other change, B4 was a contributor.

### Proposed follow-ups (conditional on diagnostic)

- If B1/B4: re-add the keepalive ping (spec #50 reversal) **and**
  queue a post-WS-close "broadcast retry buffer" on the DO for the
  last N message frames, flushed on next onConnect before the subscribe
  replay runs. Effectively, the DO becomes a tiny BufferedChannel
  mirror of the runner's.
- If B2: patch the insert→update shim to *force* the update through
  when only `modifiedAt` / `modified_at` differs — bypass `deepEquals`
  loopback elision for cursor-critical timestamp fields. Either a
  wrapper around `write()` or a synthetic content-diff that keeps
  deepEquals honest.
- If B3: add an `onBeforeUnload` / `visibilitychange` OPFS flush so
  the persistence layer drains before the tab backgrounds.

### Where this lands vs. the original recommendation stack

The duplicate-replay bug is **orthogonal to the streaming-burst jitter**
the main doc is about. Rate + coupling fixes (recs #1, #5, #6a) smooth
the visual experience regardless of whether duplicates are being sent.
But fixing B1/B2/B4 reduces the *size of the burst itself* on idle
reconnect — net effect: a jitter fix stack without the root-cause fix
just hides the symptom; root-cause + jitter stack is additive.

Recommend: ship the diagnostic logs first (1 PR, no user-visible
change), collect ≥1 occurrence, then pick the fix that matches the
data. Don't guess again.

### Methodology note

This addendum's conclusions come from a full-file audit of
`session-do.ts` (call-site enumeration of `safeUpdateMessage` /
`safeAppendMessage` / raw `UPDATE assistant_messages` SQL), plus
targeted reads of `messages-collection.ts`, `use-coding-agent.ts`,
`session-do-migrations.ts`, and the
`@tanstack/browser-db-sqlite-persistence` wrapper. No hypothesis in
the ranking above is supported by runtime data yet — they are all
code-shape inferences pending the diagnostic logs above.
